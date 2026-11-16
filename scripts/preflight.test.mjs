import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { preflightRelease, runPreflight, validateLocalRelease } from "./preflight.mjs";

const repository = new URL("../", import.meta.url);
const core = "@fukangz/core-bilibili-subtitles";
const manifests = Object.fromEntries(await Promise.all(["core", "cli", "pi", "dsh"].map(async (name) => [name, JSON.parse(await readFile(new URL(`packages/${name}/package.json`, repository), "utf8"))])));
const tag = (name) => `${name}-v${manifests[name].version}`;
const registry = "https://registry.npmjs.org/";
const url = (name) => `${registry}${encodeURIComponent(manifests[name].name)}/${manifests[name].version}`;
const archive = Buffer.from("mock core archive bytes");
const archiveUrl = `${registry}package/-/package.tgz`;
const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
const published = (name, dist = {}) => Response.json({ name: manifests[name].name, version: manifests[name].version, dist: { tarball: archiveUrl, integrity, ...dist } });
const missing = () => new Response(null, { status: 404 });

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "bili-preflight-"));
  try {
    await cp(new URL("LICENSE", repository), path.join(root, "LICENSE"));
    await cp(new URL("package.json", repository), path.join(root, "package.json"));
    for (const name of Object.keys(manifests)) {
      const directory = path.join(root, "packages", name);
      await cp(new URL(`packages/${name}/package.json`, repository), path.join(directory, "package.json"), { recursive: true });
      await cp(new URL(`packages/${name}/LICENSE`, repository), path.join(directory, "LICENSE"));
    }
    await run(root, async (name, mutate) => {
      const file = path.join(root, "packages", name, "package.json");
      const manifest = JSON.parse(await readFile(file, "utf8"));
      mutate(manifest);
      await writeFile(file, JSON.stringify(manifest));
    });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test("离线预检验证四包且不请求registry，显式参数避免误联网", async () => {
  const result = await runPreflight(["--offline"], { fetchImpl: () => { throw new Error("Unexpected network"); } });
  assert.equal(result.length, 4);
  assert.ok(result.every((entry) => entry.mode === "offline"));
  for (const args of [[], ["--registry"], [tag("core"), "--unknown"], [tag("core"), "--offline", "--registry"], [tag("core"), tag("cli"), "--offline"]]) {
    await assert.rejects(runPreflight(args), /Usage:/);
  }
});

test("发布来源身份缺失或不匹配必须在联网前拒绝，离线仍可检查", async () => {
  await assert.rejects(preflightRelease(tag("core"), { online: true, githubRepository: "other/repo", fetchImpl: () => assert.fail("must not fetch") }), /Publishing source/);
  await fixture(async (root, update) => {
    await update("core", (manifest) => { delete manifest.repository; });
    assert.throws(() => validateLocalRelease(tag("core"), root), /Repository identity/);
  });
});

test("许可副本和public registry元数据是离线门禁", async () => {
  await fixture(async (root, update) => {
    await update("core", (manifest) => { manifest.publishConfig.access = "restricted"; });
    assert.throws(() => validateLocalRelease(tag("core"), root), /Invalid publishConfig/);
  });
  await fixture(async (root) => {
    await writeFile(path.join(root, "packages/core/LICENSE"), "wrong");
    assert.throws(() => validateLocalRelease(tag("core"), root), /MIT license mismatch/);
  });
});

test("core依赖必须为包含构建版本的普通稳定caret范围", async () => {
  for (const range of ["workspace:*", "file:../core", "*", "^0.2.0", "^0.1.999", "^0.0.1"]) {
    await fixture(async (root, update) => {
      await update("cli", (manifest) => { manifest.dependencies[core] = range; });
      assert.throws(() => validateLocalRelease(tag("cli"), root), /core dependency|does not satisfy/);
    });
  }
  assert.equal(validateLocalRelease(tag("dsh")).core.range, manifests.dsh.dependencies[core]);
});

test("稳定caret范围保留主版本、零主版本和零次版本的边界", async () => {
  for (const [range, version, accepted] of [
    ["^1.2.3", "1.2.3", true], ["^1.2.3", "1.9.0", true],
    ["^1.2.3", "1.2.2", false], ["^1.2.3", "2.0.0", false],
    ["^0.2.3", "0.2.9", true], ["^0.2.3", "0.3.0", false],
    ["^0.0.3", "0.0.3", true], ["^0.0.3", "0.0.4", false],
    ["^0.0.0", "0.0.0", true], ["^0.0.0", "0.0.1", false],
  ]) {
    await fixture(async (root, update) => {
      await update("core", (manifest) => { manifest.version = version; });
      await update("cli", (manifest) => { manifest.dependencies[core] = range; });
      if (accepted) assert.equal(validateLocalRelease(tag("cli"), root).core.version, version);
      else assert.throws(() => validateLocalRelease(tag("cli"), root), /does not satisfy/);
    });
  }
});

test("首次core发布允许自身404，不要求已发布自身，也不查询适配包", async () => {
  const requests = [];
  const result = await preflightRelease(tag("core"), { online: true, fetchImpl: async (request, options) => {
    requests.push(request);
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { accept: "application/json" });
    assert.ok(options.signal instanceof AbortSignal);
    return missing();
  } });
  assert.equal(result.mode, "registry");
  assert.deepEqual(requests, [url("core")]);
});

test("已发布版本拒绝覆盖，不再探测core", async () => {
  const requests = [];
  await assert.rejects(preflightRelease(tag("cli"), { online: true, fetchImpl: async (request) => { requests.push(request); return published("cli"); } }), /Already published/);
  assert.deepEqual(requests, [url("cli")]);
});

test("适配包必须等待构建所用core版本可用，仅有更旧满足范围版本仍不够", async () => {
  const requests = [];
  await assert.rejects(preflightRelease(tag("cli"), { online: true, fetchImpl: async (request) => { requests.push(request); return missing(); } }), /Publish and verify core/);
  assert.deepEqual(requests, [url("cli"), url("core")]);
  const successfulRequests = [];
  const result = await preflightRelease(tag("dsh"), { online: true, fetchImpl: async (request, options) => {
    successfulRequests.push(request);
    if (request === archiveUrl) {
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      return new Response(archive);
    }
    return request === url("core") ? published("core") : missing();
  } });
  assert.deepEqual(successfulRequests, [url("dsh"), url("core"), archiveUrl]);
  assert.equal(result.mode, "registry");
  assert.equal(result.core.version, manifests.core.version);
  assert.ok(result.checks.includes("core registry metadata and archive SHA-512 verified"));
  assert.match(result.note, /not proof of registry installation/);
});

test("core归档完整性、404、超时及大小失败均阻止适配包且不重试", async () => {
  for (const archiveResponse of [
    () => new Response("wrong bytes"),
    missing,
    () => { throw new DOMException("mock timeout", "TimeoutError"); },
    () => new Response(archive, { headers: { "content-length": String(5 * 1024 * 1024 + 1) } }),
    () => new Response(new Uint8Array(5 * 1024 * 1024 + 1)),
  ]) {
    const requests = [];
    await assert.rejects(preflightRelease(tag("cli"), { online: true, fetchImpl: async (request) => {
      requests.push(request);
      if (request === url("cli")) return missing();
      if (request === url("core")) return published("core");
      return archiveResponse();
    } }), /Core registry archive check failed/);
    assert.deepEqual(requests, [url("cli"), url("core"), archiveUrl]);
  }
});

test("core归档非法网址与缺失integrity不得触发下载", async () => {
  for (const dist of [
    { tarball: "http://registry.npmjs.org/package.tgz" },
    { tarball: "https://evil.example/package.tgz" },
    { tarball: `${archiveUrl}?token=bad` },
    { tarball: `${archiveUrl}#fragment` },
    { integrity: undefined },
  ]) {
    let requests = 0;
    await assert.rejects(preflightRelease(tag("cli"), { online: true, fetchImpl: async (request) => {
      requests++;
      assert.ok(requests <= 2, "must reject before archive download");
      return request === url("cli") ? missing() : published("core", dist);
    } }), /Registry check failed|Core registry archive check failed/);
    assert.equal(requests, 2);
  }
});

test("registry错误无降级且不回显不可信正文或异常", async () => {
  for (const fetchImpl of [
    async () => new Response("secret response", { status: 503 }),
    async () => new Response("not JSON"),
    async () => { throw new Error("private network details"); },
    async () => Response.json({ name: "wrong", version: manifests.core.version }),
    async () => Response.json({ name: core, version: manifests.core.version, dist: { tarball: "https://evil.example/file.tgz" } }),
  ]) {
    await assert.rejects(preflightRelease(tag("core"), { online: true, fetchImpl }), (error) => {
      assert.match(error.message, /Registry check failed.*8s limit/);
      assert.doesNotMatch(error.message, /secret response|not JSON|private network|evil/);
      return true;
    });
  }
});
