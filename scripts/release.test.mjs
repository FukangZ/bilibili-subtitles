import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { selectRelease } from "./release.mjs";

test("每种 tag 只选对应 workspace，版本来自该包而非根包", async () => {
  for (const name of ["core", "pi", "cli", "dsh"]) {
    const manifest = JSON.parse(await readFile(new URL(`../packages/${name}/package.json`, import.meta.url), "utf8"));
    assert.deepEqual(selectRelease(`${name}-v${manifest.version}`), {
      workspace: manifest.name, directory: `packages/${name}`, version: manifest.version,
    });
  }
});

test("拒绝旧 tag、未知包、预发布与错误版本", () => {
  for (const tag of [undefined, "v0.1.0", "root-v0.1.0", "pi-v0.1.0-beta.1", "core-v01.1.0", "cli-v0.1.0\n", "dsh-v0.1.0-rc.1", "core-v99999.0.0"]) {
    assert.throws(() => selectRelease(tag));
  }
});

test("错误包名和 private 包不能发布", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bili-release-"));
  try {
    await mkdir(path.join(root, "packages/core"), { recursive: true });
    for (const manifest of [{ name: "wrong", version: "0.1.0" }, { name: "@fukangz/core-bilibili-subtitles", version: "0.1.0", private: true }]) {
      await writeFile(path.join(root, "packages/core/package.json"), JSON.stringify(manifest));
      assert.throws(() => selectRelease("core-v0.1.0", root));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
