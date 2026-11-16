import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const globalModules = resolve(dirname(process.execPath), "../lib/node_modules");
const host = [
  join(globalModules, "@earendil-works/pi-coding-agent"),
  join(globalModules, "@agegr/pi-web/node_modules/@earendil-works/pi-coding-agent"),
].find((candidate) => existsSync(join(candidate, "package.json")));

if (!host) {
  console.log("未找到本机 Pi 安装，跳过 peer 链接");
  process.exit(0);
}

const require = createRequire(join(host, "package.json"));
const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const names = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-tui", "typebox"];
for (const name of names) {
  const target = name === "@earendil-works/pi-coding-agent" ? host : findPackageRoot(name);
  const destination = join(packageDirectory, "node_modules", name);
  mkdirSync(dirname(destination), { recursive: true });
  try {
    const stat = lstatSync(destination);
    if (!stat.isSymbolicLink()) {
      console.log(`${destination} 已存在且不是符号链接，未覆盖`);
      continue;
    }
    if (existsSync(destination)) continue;
    unlinkSync(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  symlinkSync(target, destination);
}

function findPackageRoot(name) {
  for (const modules of require.resolve.paths(name) ?? []) {
    const directory = join(modules, name);
    const file = join(directory, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === name) return directory;
  }
  throw new Error(`无法定位 ${name} 的本机安装`);
}
