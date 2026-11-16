import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { credentialsFile, migrateLegacyCookie, readCredentials, writeCredentials } from "../src/credentials.ts";
import { loadCliConfig, saveModelConfig } from "../dist/config.js";

const cookie = { SESSDATA: "session-secret", bili_jct: "csrf-secret", DedeUserID: "123" };
const polish = { api: "chat-completions" as const, baseUrl: "https://models.example/v1", model: "demo", apiKey: "private-model-key", contextWindow: 128000, maxTokens: 32000, timeoutMs: 600000 };

test("CLI 凭证单独保存、权限受限并拒绝符号链接", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-cli-credentials-"));
  try {
    const file = credentialsFile(path.join(root, "nested", "config.json"));
    await writeCredentials(file, cookie);
    assert.deepEqual(await readCredentials(file), cookie);
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    }
    const target = path.join(root, "target.json");
    await writeFile(target, "untouched");
    const link = path.join(root, "link.json");
    await symlink(target, link);
    await assert.rejects(() => writeCredentials(link, cookie), /无法保存 CLI 用户级凭证/);
    await assert.rejects(() => readCredentials(link), /无法读取 CLI 用户级凭证/);
    assert.equal(await readFile(target, "utf8"), "untouched");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("已有损坏凭证不会被登录或迁移覆盖，迁移优先保留独立凭证", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-cli-credential-recovery-"));
  try {
    const config = path.join(root, "config.json");
    const credential = credentialsFile(config);
    const damaged = "{broken";
    await writeFile(credential, damaged);
    await assert.rejects(() => writeCredentials(credential, cookie), /无法读取 CLI 用户级凭证/);
    assert.equal(await readFile(credential, "utf8"), damaged);

    const legacyCookie = { ...cookie, SESSDATA: "legacy-session" };
    const legacy = JSON.stringify({ cookie: legacyCookie, polish });
    await writeFile(config, legacy);
    await assert.rejects(() => migrateLegacyCookie(config, credential), /无法读取 CLI 用户级凭证/);
    assert.equal(await readFile(config, "utf8"), legacy);

    await rm(credential);
    const currentCookie = { ...cookie, SESSDATA: "current-session" };
    await writeCredentials(credential, currentCookie);
    await migrateLegacyCookie(config, credential);
    assert.deepEqual(await readCredentials(credential), currentCookie);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { polish });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI 迁移验证后删除旧 Cookie，失败时保留配置且配置更新不复制 Cookie", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-cli-migrate-"));
  try {
    const config = path.join(root, "config.json");
    const credential = credentialsFile(config);
    const legacy = JSON.stringify({ cookie, outputDir: "custom", polish });
    await writeFile(config, legacy);
    await assert.rejects(() => saveModelConfig(config, { ...polish, model: "changed" }), /请先运行 bili-subs login 完成迁移/);
    assert.equal(await readFile(config, "utf8"), legacy);
    const target = path.join(root, "target.json");
    await writeFile(target, "untouched");
    await symlink(target, credential);
    await assert.rejects(() => migrateLegacyCookie(config, credential), /无法读取 CLI 用户级凭证/);
    assert.equal(await readFile(config, "utf8"), legacy);
    await rm(credential);
    await migrateLegacyCookie(config, credential);
    assert.deepEqual(await readCredentials(credential), cookie);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { outputDir: "custom", polish });
    await saveModelConfig(config, { ...polish, model: "changed" });
    assert.equal("cookie" in await loadCliConfig(config), false);
    assert.equal((await readFile(config, "utf8")).includes("session-secret"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
