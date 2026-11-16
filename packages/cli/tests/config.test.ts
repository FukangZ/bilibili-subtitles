import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { configPath, loadCliConfig, saveModelConfig, showConfig } from "../dist/config.js";

const polish = { api: "openai-completions" as const, baseUrl: "https://models.example/v1", model: "demo", apiKey: "private-model-key", reasoningEffort: "high" as const, contextWindow: 128000, maxTokens: 32000, maxOutputTokens: 32000, timeoutMs: 600000 };

test("CLI 使用 XDG 用户配置，普通展示隐藏旧 Cookie，更新不会覆盖它", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-cli-config-"));
  const file = path.join(root, "nested", "config.json");
  try {
    assert.equal(configPath({ XDG_CONFIG_HOME: root }, "/unused"), path.join(root, "bili-subs", "config.json"));
    assert.equal(configPath({}, root), path.join(root, ".config", "bili-subs", "config.json"));
    assert.equal(configPath({ XDG_CONFIG_HOME: "relative" }, root), path.join(root, ".config", "bili-subs", "config.json"));
    await saveModelConfig(file, polish);
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    }
    const legacy = JSON.stringify({ cookie: { SESSDATA: "private-bili-cookie" }, outputDir: "custom", languagePreference: [], polish });
    await writeFile(file, legacy);
    const legacyConfig = await loadCliConfig(file);
    assert.equal("outputDir" in legacyConfig, false);
    assert.equal(await readFile(file, "utf8"), legacy);
    const visible = JSON.stringify(await showConfig(file));
    assert.doesNotMatch(visible, /private-model-key|private-bili-cookie/);
    assert.match(visible, /\[redacted\]/);
    await assert.rejects(() => saveModelConfig(file, { ...polish, model: "other" }), /请先运行 bili-subs login 完成迁移/);
    assert.equal(await readFile(file, "utf8"), legacy);

    await writeFile(file, JSON.stringify({ outputDir: "custom", languagePreference: [], polish }));
    await saveModelConfig(file, { ...polish, model: "other" });
    const config = await loadCliConfig(file);
    assert.equal(config.polish.model, "other");
    assert.equal("cookie" in config, false);
    assert.equal("outputDir" in config, false);
    assert.equal(config.polish.reasoningEffort, "high");
    const before = await readFile(file, "utf8");
    await assert.rejects(() => saveModelConfig(file, { ...polish, baseUrl: "https://user:pass@example.com" }), /INVALID_CONFIG/);
    assert.equal(await readFile(file, "utf8"), before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI 忽略旧润色输出 Token 配置，读取不改文件且显示和保存不再包含旧字段", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-cli-legacy-tokens-"));
  const file = path.join(root, "config.json");
  try {
    for (const maxOutputTokens of [32000, 0, -1, "invalid", null]) {
      const legacyPolish = { ...polish, maxOutputTokens };
      const legacy = JSON.stringify({ polish: legacyPolish });
      await writeFile(file, legacy);
      const config = await loadCliConfig(file);
      assert.equal("maxOutputTokens" in config.polish, false);
      assert.equal(config.polish.timeoutMs, 600000);
      assert.equal("maxOutputTokens" in (await showConfig(file) as { polish: object }).polish, false);
      assert.equal(await readFile(file, "utf8"), legacy);
      await saveModelConfig(file, legacyPolish);
      assert.equal("maxOutputTokens" in JSON.parse(await readFile(file, "utf8")).polish, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("保存配置拒绝损坏文件、符号链接与已取消任务，不留临时文件", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-cli-safe-"));
  try {
    const file = path.join(root, "config.json");
    await writeFile(file, "{invalid");
    await assert.rejects(() => saveModelConfig(file, polish), (error: unknown) => {
      assert.match(error instanceof Error ? error.message : "", /无法保存配置，原配置未更新/);
      return true;
    });
    assert.equal(await readFile(file, "utf8"), "{invalid");
    for (const content of ["null", "[]", "42"]) {
      await writeFile(file, content);
      await assert.rejects(() => saveModelConfig(file, polish), /配置必须是 JSON 对象/);
      assert.equal(await readFile(file, "utf8"), content);
    }
    const link = path.join(root, "link.json");
    await symlink(file, link);
    await assert.rejects(() => saveModelConfig(link, polish), (error: unknown) => {
      assert.match(error instanceof Error ? error.message : "", /配置必须是普通文件/);
      return true;
    });
    const cancelled = path.join(root, "cancelled.json");
    await assert.rejects(() => saveModelConfig(cancelled, polish, AbortSignal.abort()), /CANCELLED/);
    assert.deepEqual((await readdir(root)).sort(), ["config.json", "link.json"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
