import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./preflight.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const names = ["core", "cli", "pi", "dsh"];
const required = {
  core: ["dist/index.js", "dist/index.d.ts", "prompts/structure.md", "prompts/polish.md"],
  cli: ["dist/main.js", "skills/bilibili-subtitles/SKILL.md"],
  pi: ["src/index.ts", "src/model.ts", "bilibili-subtitles.example.json"],
  dsh: ["dist/index.js", "dist/index.d.ts", "client.js", "cordis.patch.yml", "icon.svg", "locale/en.json", "locale/zh.json"],
};

// 只接受真实 pack 报告，禁止 dry-run 或缺失入口悄然降级成清单检查。
export function validatePackList(kind, files) {
  const paths = new Set(files.map((file) => file.path));
  for (const entry of ["package.json", "README.md", "LICENSE", ...required[kind]]) assert.ok(paths.has(entry), `${kind}: missing ${entry}`);
  for (const entry of paths) {
    const permitted = ["package.json", "README.md", "LICENSE"].includes(entry)
      || (kind === "core" && /^(dist\/.*\.(js|d\.ts)|prompts\/(structure|polish)\.md)$/.test(entry))
      || (kind === "cli" && /^(dist\/.*\.(js|d\.ts)|skills\/bilibili-subtitles\/SKILL\.md)$/.test(entry))
      || (kind === "pi" && /^(src\/.*\.ts|bilibili-subtitles\.example\.json)$/.test(entry))
      || (kind === "dsh" && /^(dist\/.*\.(js|d\.ts)|client\.js|cordis\.patch\.yml|icon\.svg|locale\/[^/]+\.json)$/.test(entry));
    assert.ok(permitted && !/(^|\/)(tests?|node_modules|\.subtitles|\.scratch)(\/|$)/.test(entry), `${kind}: unexpected distributed file ${entry}`);
  }
}

// npm run 可注入新版 npm 的 allow-scripts 配置，但子项目安装拒绝该环境参数。
// 仅净化子进程副本，仍由显式 --ignore-scripts 禁止 lifecycle，不修改宿主配置。
export function packageProcessEnv(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"));
}

export async function verifyPackages({ offline = false } = {}) {
  await runPreflight(["--offline"]);
  const temporary = await mkdtemp(path.join(tmpdir(), "bili-packages-"));
  const consumer = path.join(temporary, "consumer");
  const npmCli = process.env.npm_execpath;
  const environment = packageProcessEnv({ ...process.env, NODE_PATH: "" });
  const runNpm = (args, cwd) => {
    const options = { cwd, encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024, env: environment };
    return npmCli ? execFileSync(process.execPath, [npmCli, ...args], options) : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, options);
  };
  try {
    await mkdir(consumer);
    const packs = JSON.parse(runNpm(["pack", "--json", "--workspaces", "--ignore-scripts", "--pack-destination", temporary], root));
    assert.equal(packs.length, names.length);
    const dependencies = {};
    const summary = [];
    for (const kind of names) {
      const name = `@fukangz/${kind}-bilibili-subtitles`;
      const pack = packs.find((entry) => entry.name === name);
      assert.ok(pack, `Missing tarball: ${name}`);
      assert.ok(pack.size > 0 && pack.integrity);
      validatePackList(kind, pack.files);
      dependencies[name] = `file:${path.join(temporary, pack.filename)}`;
      summary.push({ name, version: pack.version, files: pack.files.length, integrity: pack.integrity });
    }
    // 四包均实际从 tgz 安装；根依赖把 core 关联到 tgz，不使用 workspace 或目录链接。
    await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module", dependencies }));
    runNpm(["install", ...(offline ? ["--offline"] : ["--prefer-offline"]), "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--fetch-retries=0", "--fetch-timeout=8000"], consumer);
    const license = await readFile(path.join(root, "LICENSE"), "utf8");
    for (const kind of names) {
      const directory = path.join(consumer, "node_modules/@fukangz", `${kind}-bilibili-subtitles`);
      assert.equal(await realpath(directory), directory, `${kind}: must be an installed directory, not a workspace link`);
      assert.equal(await readFile(path.join(directory, "LICENSE"), "utf8"), license);
      for (const file of required[kind]) assert.ok((await readFile(path.join(directory, file))).length > 0);
    }
    const probe = path.join(consumer, "probe.mjs");
    await writeFile(path.join(consumer, "probe.mjs"), await readFile(new URL("./package-probe.mjs", import.meta.url)));
    await writeFile(path.join(consumer, "package-boundary.mjs"), await readFile(new URL("./package-boundary.mjs", import.meta.url)));
    execFileSync(process.execPath, ["--check", probe], { cwd: consumer, encoding: "utf8", timeout: 15000 });
    const probeOutput = execFileSync(process.execPath, [probe], { cwd: consumer, encoding: "utf8", timeout: 15000, env: environment }).trim();
    const bin = path.join(consumer, "node_modules/.bin", process.platform === "win32" ? "bili-subs.cmd" : "bili-subs");
    const help = execFileSync(bin, ["--help"], { cwd: consumer, encoding: "utf8", timeout: 15000, env: { ...environment, HOME: consumer, XDG_CONFIG_HOME: path.join(consumer, "config") } });
    assert.match(help, /bili-subs/);
    assert.match(help, /download/);
    assert.match(help, /polish/);
    return { node: process.version, offline, packages: summary, checks: [probeOutput, "CLI installed bin --help: OK", "Pi/dsh installed files and all LICENSE copies: OK (not a host runtime test)"] };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--offline")) throw new Error("Usage: node scripts/verify-packages.mjs [--offline]");
  console.log(JSON.stringify(await verifyPackages({ offline: process.argv.includes("--offline") }), null, 2));
}
