import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowed = new Set(["@fukangz/core-bilibili-subtitles", "@deepseek-ai/schemastery"]);

test("dsh 包只依赖 core 和 schemastery，运行时不导入 dsh 宿主或 Pi", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@fukangz/core-bilibili-subtitles"]);
  assert.deepEqual(manifest.peerDependencies, { "@deepseek-ai/schemastery": "~3.19.0" });
  assert.equal(manifest.exports["./client"], "./client.js");
  assert.ok(manifest.engines.dsh);
  for (const file of ["dist/", "client.js", "cordis.patch.yml", "locale/", "icon.svg", "README.md"]) {
    assert.ok(manifest.files.includes(file), `files 缺少 ${file}`);
  }
  const patch = await readFile(path.join(root, manifest.dsh.bundle.patch), "utf8");
  assert.match(patch, /id: bilibili-subtitles/);
  assert.match(patch, new RegExp(`name: ['"]?${manifest.name}`));

  for (const entry of await readdir(path.join(root, "src"), { withFileTypes: true })) {
    assert.ok(entry.isFile(), `新增目录需要加入扫描: ${entry.name}`);
    const text = await readFile(path.join(root, "src", entry.name), "utf8");
    const source = ts.createSourceFile(entry.name, text, ts.ScriptTarget.Latest, true);
    const check = (specifier: string, typeOnly: boolean) => {
      // 类型导入会留在 .d.ts 中，同样不能引用未声明的宿主包
      assert.doesNotMatch(specifier, /^@earendil-works\/|^@deepseek-ai\/dsh-/, `${entry.name}: 引用宿主包 ${specifier}`);
      if (typeOnly) return;
      assert.ok(specifier.startsWith("node:") || allowed.has(specifier) || /^\.\/[\w-]+\.js$/.test(specifier), `${entry.name}: 非允许依赖 ${specifier}`);
    };
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text, Boolean(node.importClause?.isTypeOnly));
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        check(node.moduleSpecifier.text, node.isTypeOnly);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
        assert.fail(`${entry.name}: 不允许动态导入`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
});

test("client.js 是无构建的 ModuleLoader 脚本，不含 import 或 Cookie 字段", async () => {
  const client = await readFile(path.join(root, "client.js"), "utf8");
  assert.match(client, /__ModuleLoader__/);
  assert.doesNotMatch(client, /^\s*import\s/m);
  assert.doesNotMatch(client, /SESSDATA|bili_jct/);
});
