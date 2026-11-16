import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { passthroughQueue } from "@fukangz/core-bilibili-subtitles";
import { credentialPath, migratePiCookie, readPiCredentials, writePiCredentials } from "../src/credentials.ts";

const cookie = { SESSDATA: "session-secret", bili_jct: "csrf-secret", DedeUserID: "123" };

test("Pi 凭证单独保存、权限受限且拒绝符号链接", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-pi-credentials-"));
  try {
    const directory = path.join(root, "nested");
    const file = credentialPath(directory);
    await writePiCredentials(file, cookie);
    assert.deepEqual(await readPiCredentials(file), cookie);
    if (process.platform !== "win32") {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
    }
    const target = path.join(root, "target.json");
    await writeFile(target, "untouched");
    const link = path.join(root, "link.json");
    await symlink(target, link);
    await assert.rejects(() => writePiCredentials(link, cookie), /无法保存 Pi 用户级凭证/);
    assert.equal(await readFile(target, "utf8"), "untouched");
    await assert.rejects(() => readPiCredentials(link), /无法读取 Pi 用户级凭证/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("已有损坏凭证不会被登录或迁移覆盖，迁移优先保留独立凭证", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-pi-credential-recovery-"));
  try {
    const config = path.join(root, "bilibili-subtitles.json");
    const credential = credentialPath(root);
    const damaged = "{broken";
    await writeFile(credential, damaged);
    await assert.rejects(() => writePiCredentials(credential, cookie), /无法读取 Pi 用户级凭证/);
    assert.equal(await readFile(credential, "utf8"), damaged);

    const legacyCookie = { ...cookie, SESSDATA: "legacy-session" };
    const legacy = JSON.stringify({ cookie: legacyCookie, outputDir: "custom" });
    await writeFile(config, legacy);
    await assert.rejects(() => migratePiCookie(config, credential, passthroughQueue), /无法读取 Pi 用户级凭证/);
    assert.equal(await readFile(config, "utf8"), legacy);

    await rm(credential);
    const currentCookie = { ...cookie, SESSDATA: "current-session" };
    await writePiCredentials(credential, currentCookie);
    await migratePiCookie(config, credential, passthroughQueue);
    assert.deepEqual(await readPiCredentials(credential), currentCookie);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { outputDir: "custom" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Pi 迁移先验证独立凭证再移除旧 Cookie，失败时保留旧值", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-pi-migrate-"));
  try {
    const config = path.join(root, "bilibili-subtitles.json");
    const credential = credentialPath(root);
    const legacy = JSON.stringify({ cookie, outputDir: "custom" });
    await writeFile(config, legacy);
    const target = path.join(root, "target.json");
    await writeFile(target, "untouched");
    await symlink(target, credential);
    await assert.rejects(() => migratePiCookie(config, credential, passthroughQueue), /无法读取 Pi 用户级凭证/);
    assert.equal(await readFile(config, "utf8"), legacy);
    await rm(credential);
    await migratePiCookie(config, credential, passthroughQueue);
    assert.deepEqual(await readPiCredentials(credential), cookie);
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), { outputDir: "custom" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
