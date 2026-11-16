import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

test("CLI depends on core, pi-ai, and Node while keeping the Pi Agent host optional", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@earendil-works/pi-ai", "@fukangz/core-bilibili-subtitles"]);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.bin["bili-subs"], "./dist/main.js");
  assert.ok(manifest.files.includes("skills/"));
  const skill = await readFile(path.join(root, "skills/bilibili-subtitles/SKILL.md"), "utf8");
  assert.match(skill, /^---\nname: bilibili-subtitles\ndescription: .+\n---/);
  assert.match(skill, /bili-subs download/);
  assert.match(skill, /bili-subs polish/);
  for (const entry of await readdir(path.join(root, "src"), { withFileTypes: true })) {
    assert.ok(entry.isFile(), `新增目录需要加入扫描: ${entry.name}`);
    const text = await readFile(path.join(root, "src", entry.name), "utf8");
    const source = ts.createSourceFile(entry.name, text, ts.ScriptTarget.Latest, true);
    const check = (specifier: string) => assert.ok(specifier.startsWith("node:") || specifier === "@fukangz/core-bilibili-subtitles" || specifier === "@earendil-works/pi-ai" || specifier.startsWith("@earendil-works/pi-ai/") || /^\.\/[\w-]+\.js$/.test(specifier), `${entry.name}: 非 CLI 依赖 ${specifier}`);
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        assert.ok(ts.isStringLiteral(node.moduleSpecifier));
        check(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
        assert.equal(node.arguments.length, 1);
        const argument = node.arguments[0]!;
        assert.ok(ts.isStringLiteral(argument));
        check(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.doesNotMatch(text, /@earendil-works\/pi-coding-agent/);
  }
});
