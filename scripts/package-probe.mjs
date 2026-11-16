import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isPiHostPackage } from "./package-boundary.mjs";
import * as core from "@fukangz/core-bilibili-subtitles";

const here = fileURLToPath(new URL("./", import.meta.url));
const prompts = core.loadPrompts();
for (const [file, content] of [["structure.md", prompts.structure], ["polish.md", prompts.polish]]) {
  const url = import.meta.resolve("@fukangz/core-bilibili-subtitles/prompts/" + file);
  assert.ok((await realpath(fileURLToPath(url))).startsWith(here));
  assert.equal(await readFile(new URL(url), "utf8"), content);
  assert.ok(content.length > 100);
}
assert.equal(typeof core.polishTranscript, "function");
assert.equal(typeof core.downloadSubtitle, "function");
await assert.rejects(import("@fukangz/core-bilibili-subtitles/dist/index.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
const skill = await readFile(new URL("node_modules/@fukangz/cli-bilibili-subtitles/skills/bilibili-subtitles/SKILL.md", import.meta.url), "utf8");
assert.match(skill, /^---\nname: bilibili-subtitles\n/);
assert.ok(skill.includes("bili-subs download") && skill.includes("bili-subs polish"));
// 扫描安装树，确保 npm 没有自动补装 Pi peers，也不存在绕回工作区的依赖链接。
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    const child = directory + "/" + entry.name;
    assert.ok(!entry.isSymbolicLink(), "Unexpected dependency link: " + child);
    if (entry.isDirectory()) await inspect(child);
    else if (entry.name === "package.json") {
      const manifest = JSON.parse(await readFile(child, "utf8"));
      assert.ok(!isPiHostPackage(manifest.name), "Pi host unexpectedly installed");
    }
  }
}
await inspect(here + "node_modules");
console.log("core ESM, public prompts, CLI Skill and no-Pi install: OK");
