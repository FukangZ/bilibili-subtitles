import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

export function selectRelease(tag, repositoryRoot = root) {
  const match = /^(core|pi|cli|dsh)-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag ?? "");
  if (!match || match[0] !== tag) throw new Error("Expected core-vX.Y.Z, pi-vX.Y.Z, cli-vX.Y.Z or dsh-vX.Y.Z");
  const directory = `packages/${match[1]}`;
  const version = `${match[2]}.${match[3]}.${match[4]}`;
  const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, directory, "package.json"), "utf8"));
  const workspace = `@fukangz/${match[1]}-bilibili-subtitles`;
  if (manifest.name !== workspace || manifest.private) throw new Error(`Invalid publish target: ${directory}`);
  if (manifest.version !== version) throw new Error(`Tag ${tag} does not match ${directory}/package.json version ${manifest.version}`);
  return { workspace, directory, version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = selectRelease(process.argv[2] ?? process.env.GITHUB_REF_NAME);
  if (process.env.GITHUB_OUTPUT) {
    for (const [key, value] of Object.entries(selected)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
  console.log(JSON.stringify(selected));
}
