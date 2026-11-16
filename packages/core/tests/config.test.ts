import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig, updateConfigFile } from "@fukangz/core-bilibili-subtitles";

async function withConfig(run: (root: string, file: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "bili-config-"));
  try { await run(root, path.join(root, "config.json")); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("core 配置不读取 Cookie；旧语言和输出目录设置无效且读取不改写文件", async () => {
  await withConfig(async (root, userFile) => {
    const projectFile = path.join(root, "project.json");
    const legacy = JSON.stringify({ cookie: { SESSDATA: "user-secret" }, outputDir: "from-user", languagePreference: [] });
    await writeFile(userFile, legacy);
    const config = await loadConfig({ userFile, projectTrusted: false });
    assert.equal("cookie" in config, false);
    assert.deepEqual(config, { polish: { timeoutMs: 120_000 } });
    assert.equal(await readFile(userFile, "utf8"), legacy);
    await writeFile(projectFile, JSON.stringify({ cookie: null }));
    await assert.rejects(() => loadConfig({ userFile, projectTrusted: true, projectFile }), /INVALID_CONFIG/);
  });
});

test("普通配置更新保留权限、拒绝符号链接且可原子读改写", async () => {
  await withConfig(async (root, file) => {
    await updateConfigFile({ file, label: "用户级", update: () => ({ outputDir: "first" }) });
    await updateConfigFile({ file, label: "用户级", update: (existing) => ({ ...existing, outputDir: "second" }) });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { outputDir: "second" });
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
    const target = path.join(root, "target.json");
    await writeFile(target, "{}");
    const link = path.join(root, "link.json");
    await symlink(target, link);
    await assert.rejects(() => updateConfigFile({ file: link, label: "用户级", update: () => ({}) }), /INVALID_CONFIG/);
    assert.equal(await readFile(target, "utf8"), "{}");
    const broken = path.join(root, "broken.json");
    await writeFile(broken, "{invalid");
    await assert.rejects(() => updateConfigFile({ file: broken, label: "用户级", update: () => ({}) }), /INVALID_CONFIG/);
    assert.equal(await readFile(broken, "utf8"), "{invalid");
    assert.deepEqual((await readdir(root)).sort(), ["broken.json", "config.json", "link.json", "target.json"]);
  });
});

test("core 扩展只接收信任判定后的配置，通用写入仍支持取消", async () => {
  await withConfig(async (root, userFile) => {
    const projectFile = path.join(root, "project.json");
    await writeFile(userFile, JSON.stringify({ polish: { custom: "user" } }));
    await writeFile(projectFile, JSON.stringify({ polish: { custom: "project" } }));
    for (const projectTrusted of [false, true]) {
      const config = await loadConfig({ userFile, projectFile, projectTrusted, extend: ({ user, project }) => {
        assert.equal(Boolean(project), projectTrusted);
        return { custom: ((project ?? user)?.polish as { custom: string }).custom };
      } });
      assert.equal(config.polish.custom, projectTrusted ? "project" : "user");
    }
    const controller = new AbortController();
    await assert.rejects(() => updateConfigFile({
      file: path.join(root, "cancelled.json"), label: "用户级", signal: controller.signal,
      update: () => { controller.abort(); return {}; },
    }), /CANCELLED/);
    assert.deepEqual((await readdir(root)).sort(), ["config.json", "project.json"]);
    await assert.rejects(() => readFile(path.join(root, "cancelled.json")), { code: "ENOENT" });
  });
});

test("core 只校验仍受支持的配置字段，忽略旧语言和输出目录字段", async () => {
  await withConfig(async (_root, userFile) => {
    const defaults = await loadConfig({ userFile, projectTrusted: false });
    assert.deepEqual(defaults, { polish: { timeoutMs: 120_000 } });
    assert.equal(defaults.polish.timeoutMs, 120_000);
    for (const value of [{ polish: { timeoutMs: 0 } }, { polish: [] }]) {
      await writeFile(userFile, JSON.stringify(value));
      await assert.rejects(() => loadConfig({ userFile, projectTrusted: false }), /INVALID_CONFIG/);
    }
    await writeFile(userFile, JSON.stringify({ outputDir: " ", languagePreference: [] }));
    assert.deepEqual(await loadConfig({ userFile, projectTrusted: false }), { polish: { timeoutMs: 120_000 } });
  });
});
