import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.ts";

async function withConfig(run: (options: Parameters<typeof loadConfig>[0], userFile: string, projectFile: string) => Promise<void>) {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-pi-config-"));
  const agentDir = path.join(cwd, "agent");
  const project = path.join(cwd, ".pi");
  await mkdir(agentDir);
  await mkdir(project);
  try {
    await run({ agentDir }, path.join(agentDir, "bilibili-subtitles.json"), path.join(project, "bilibili-subtitles.json"));
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test("Pi 模型配置只读取用户级文件，忽略可信项目文件且不改写旧设置", async () => {
  await withConfig(async (options, userFile, projectFile) => {
    const legacy = JSON.stringify({ cookie: { SESSDATA: "test-secret" }, outputDir: "custom", languagePreference: [], polish: { provider: "user", model: "demo", thinking: "low", timeoutMs: 1000 } });
    await writeFile(userFile, legacy);
    await writeFile(projectFile, "{invalid");
    const config = await loadConfig(options);
    assert.deepEqual(config.polish, { provider: "user", model: "demo", thinking: "low", timeoutMs: 1000 });
    assert.equal("cookie" in config, false);
    assert.equal(await readFile(userFile, "utf8"), legacy);
    assert.equal(await readFile(projectFile, "utf8"), "{invalid");
    assert.equal("outputDir" in config, false);
    await writeFile(projectFile, JSON.stringify({ cookie: null }));
    assert.deepEqual((await loadConfig(options)).polish, config.polish);
  });
});

test("Pi 只校验用户配置的 provider/model 配对和 thinking", async () => {
  await withConfig(async (options, userFile, projectFile) => {
    for (const polish of [{ provider: "demo" }, { model: "demo" }, { thinking: "impossible" }, { provider: " " }, []]) {
      await writeFile(userFile, JSON.stringify({ polish }));
      await assert.rejects(() => loadConfig(options), /INVALID_CONFIG/);
    }
    await writeFile(userFile, JSON.stringify({ polish: { provider: "demo", model: "demo" } }));
    await writeFile(projectFile, JSON.stringify({ polish: { provider: "unpaired" } }));
    assert.equal((await loadConfig(options)).polish.provider, "demo");
  });
});
