import assert from "node:assert/strict";
import { test } from "node:test";
import { packageProcessEnv, validatePackList } from "./verify-packages.mjs";
import { isPiHostPackage } from "./package-boundary.mjs";

// 这些是契约夹具，不调用 npm；实际 tgz 安装由 verify:packages 独立执行。
const core = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts", "prompts/structure.md", "prompts/polish.md"];
const files = (paths) => paths.map((path) => ({ path }));

test("隔离安装允许 CLI 的 pi-ai 客户端，但拒绝 Pi 宿主 peer", () => {
  assert.equal(isPiHostPackage("@earendil-works/pi-ai"), false);
  assert.equal(isPiHostPackage("@earendil-works/pi-coding-agent"), true);
  assert.equal(isPiHostPackage("@earendil-works/pi-tui"), true);
});
test("npm子进程仅移除allow_scripts配置，保留原对象和无关字段", () => {
  const original = Object.freeze({ npm_config_allow_scripts: "first", NPM_CONFIG_ALLOW_SCRIPTS: "second", Npm_Config_Allow_Scripts: "third", PATH: "/bin", npm_config_cache: "/tmp/cache", npm_config_ignore_scripts: "true" });
  const result = packageProcessEnv(original);
  assert.deepEqual(result, { PATH: "/bin", npm_config_cache: "/tmp/cache", npm_config_ignore_scripts: "true" });
  assert.notEqual(result, original);
  assert.equal(original.npm_config_allow_scripts, "first");
  assert.equal(original.NPM_CONFIG_ALLOW_SCRIPTS, "second");
  assert.equal(original.Npm_Config_Allow_Scripts, "third");
});

test("pack清单必须具有公共入口提示词和许可", () => {
  assert.doesNotThrow(() => validatePackList("core", files(core)));
  for (const required of ["LICENSE", "dist/index.js", "prompts/structure.md"]) {
    assert.throws(() => validatePackList("core", files(core.filter((entry) => entry !== required))), /missing/);
  }
});

test("意外测试用户输出与配置文件不能进入包", () => {
  for (const unexpected of ["tests/boundary.test.ts", "dist/tests/fixture.js", ".subtitles/input.md", ".scratch/ticket.md", ".npmrc", "credentials.json", "node_modules/yaml/index.js"]) {
    assert.throws(() => validatePackList("core", files([...core, unexpected])), /unexpected distributed file/);
  }
});
