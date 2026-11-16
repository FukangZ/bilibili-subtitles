import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { selectRelease } from "./release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const repository = "FukangZ/bilibili-subtitles";
const registry = "https://registry.npmjs.org/";
const coreName = "@fukangz/core-bilibili-subtitles";
const packages = ["core", "pi", "cli", "dsh"];
const readManifest = (directory, repositoryRoot) => JSON.parse(readFileSync(path.join(repositoryRoot, directory, "package.json"), "utf8"));

// 当前适配包仅使用稳定版 caret 范围；改用其他范围时须显式扩展预检与测试。
function acceptsCore(range, version) {
  const match = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(range ?? "");
  if (!match || match[0] !== range) throw new Error("core dependency must use a stable ^X.Y.Z range");
  const minimum = match.slice(1).map(Number);
  const current = version.split(".").map(Number);
  const firstNonZero = minimum.findIndex((value) => value !== 0);
  const ceilingIndex = firstNonZero === -1 ? 2 : firstNonZero;
  const lower = current.findIndex((value, index) => value !== minimum[index]);
  return (lower === -1 || current[lower] > minimum[lower])
    && current.slice(0, ceilingIndex).every((value, index) => value === minimum[index])
    && current[ceilingIndex] === minimum[ceilingIndex];
}

export function validateLocalRelease(tag, repositoryRoot = root) {
  const selected = selectRelease(tag, repositoryRoot);
  const manifest = readManifest(selected.directory, repositoryRoot);
  const license = readFileSync(path.join(repositoryRoot, "LICENSE"), "utf8");
  if (!license.startsWith("MIT License\n") || !license.includes("Copyright (c) 2026 FukangZ")) throw new Error("Root MIT LICENSE is missing or unexpected");
  if (manifest.license !== "MIT" || readFileSync(path.join(repositoryRoot, selected.directory, "LICENSE"), "utf8") !== license) throw new Error(`MIT license mismatch: ${selected.directory}`);
  if (readManifest(".", repositoryRoot).private !== true) throw new Error("Root package must remain private");
  if (manifest.repository?.type !== "git" || manifest.repository?.url !== `git+https://github.com/${repository}.git`
    || manifest.repository?.directory !== selected.directory
    || manifest.homepage !== `https://github.com/${repository}/tree/HEAD/${selected.directory}#readme`
    || manifest.bugs?.url !== `https://github.com/${repository}/issues`) throw new Error(`Repository identity is missing or mismatched: ${selected.directory}`);
  if (manifest.publishConfig?.access !== "public" || manifest.publishConfig?.registry !== registry) throw new Error(`Invalid publishConfig: ${selected.directory}`);
  let core;
  if (manifest.name !== coreName) {
    const coreManifest = readManifest("packages/core", repositoryRoot);
    core = selectRelease(`core-v${coreManifest.version}`, repositoryRoot);
    const range = manifest.dependencies?.[coreName];
    if (!acceptsCore(range, core.version)) throw new Error(`Local core ${core.version} does not satisfy ${range}`);
    core = { ...core, range };
  }
  return { ...selected, repository, ...(core ? { core } : {}) };
}

async function registryVersion(name, version, fetchImpl) {
  const url = `${registry}${encodeURIComponent(name)}/${version}`;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const metadata = await response.json();
    if (metadata.name !== name || metadata.version !== version
      || !metadata.dist?.tarball?.startsWith(registry)) throw new Error("Invalid package metadata");
    return metadata;
  } catch {
    // 不回显注册表响应或底层错误；匿名只读检查不读取 npm 认证配置。
    throw new Error(`Registry check failed for ${name}@${version} (8s limit; HTTP/JSON/network failure)`);
  }
}

async function verifyCoreArchive(metadata, fetchImpl) {
  try {
    const url = new URL(metadata.dist.tarball);
    if (url.protocol !== "https:" || url.host !== "registry.npmjs.org" || url.username || url.password || url.search || url.hash) throw new Error("Invalid archive URL");
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist.integrity ?? "")) throw new Error("Missing SHA-512 integrity");
    const response = await fetchImpl(url.href, { redirect: "error", signal: AbortSignal.timeout(8000) });
    if (!response.ok || !response.body) throw new Error("Archive unavailable");
    const maximum = 5 * 1024 * 1024;
    if (Number(response.headers.get("content-length")) > maximum) {
      await response.body.cancel();
      throw new Error("Archive too large");
    }
    let size = 0;
    const hash = createHash("sha512");
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maximum) throw new Error("Archive too large");
      hash.update(chunk);
    }
    if (!size || `sha512-${hash.digest("base64")}` !== metadata.dist.integrity) throw new Error("Archive integrity mismatch");
  } catch {
    throw new Error("Core registry archive check failed (HTTPS official URL, 8s limit, 5 MiB cap, SHA-512 required)");
  }
}

export async function preflightRelease(tag, { repositoryRoot = root, online = false, fetchImpl = globalThis.fetch, githubRepository } = {}) {
  const selected = validateLocalRelease(tag, repositoryRoot);
  if (!online) return { ...selected, mode: "offline" };
  if (githubRepository && githubRepository !== repository) throw new Error(`Publishing source must be ${repository}`);
  if (await registryVersion(selected.workspace, selected.version, fetchImpl)) throw new Error(`Already published: ${selected.workspace}@${selected.version}`);
  if (selected.core) {
    const metadata = await registryVersion(coreName, selected.core.version, fetchImpl);
    if (!metadata) throw new Error(`Publish and verify core@${selected.core.version} before this adapter; registry version is unavailable`);
    await verifyCoreArchive(metadata, fetchImpl);
  }
  return { ...selected, mode: "registry", checks: selected.core ? ["target version unpublished", "core registry metadata and archive SHA-512 verified"] : ["target version unpublished"], note: "Read-only registry check; not proof of registry installation, runtime compatibility or publish permission" };
}

export async function runPreflight(args, options = {}) {
  const modes = args.filter((arg) => ["--offline", "--registry"].includes(arg));
  const tags = args.filter((arg) => !arg.startsWith("--"));
  if (modes.length !== 1 || args.some((arg) => arg.startsWith("--") && !modes.includes(arg)) || tags.length > 1
    || (modes[0] === "--registry" && tags.length !== 1)) throw new Error("Usage: node scripts/preflight.mjs [package-vX.Y.Z] --offline | package-vX.Y.Z --registry");
  const repositoryRoot = options.repositoryRoot ?? root;
  const selectedTags = tags.length ? tags : packages.map((name) => `${name}-v${readManifest(`packages/${name}`, repositoryRoot).version}`);
  const results = [];
  for (const tag of selectedTags) results.push(await preflightRelease(tag, { ...options, online: modes[0] === "--registry" }));
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(await runPreflight(process.argv.slice(2), { githubRepository: process.env.GITHUB_REPOSITORY }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
