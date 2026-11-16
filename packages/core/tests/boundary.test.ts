import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import * as core from "@fukangz/core-bilibili-subtitles";
import { encodeQrLines, encodeQrModules, loadPrompts, redact } from "@fukangz/core-bilibili-subtitles";

const runtimeExports = [
  "SubtitleError", "addUsage", "downloadSubtitle", "encodeQrLines", "encodeQrModules",
  "isSubtitleError", "loadConfig", "loadPrompts", "loginWithQr", "parseTranscriptMarkdown",
  "passthroughQueue", "polishTranscript", "redact", "renderTranscriptMarkdown",
  "updateConfigFile", "usageStatus", "validateStructure", "zeroUsage",
];
const typeExports = [
  "AppConfig", "ConfigFile", "ConfigSources", "CookieConfig", "DownloadResult", "ErrorCode", "FetchLike", "FileStore",
  "LoadConfigOptions", "LoginCookie", "LoginProgress", "ModelInfo", "MutationQueue", "Outline", "OutlineSection",
  "PolishConfig", "PolishResult", "Prompts", "Segment", "StageClient", "StageRequest", "StageResult", "TrackKind",
  "Transcript", "Usage", "UsageCost", "UsageStatus",
];

const root = fileURLToPath(new URL("../", import.meta.url));

test("包根只暴露显式公共运行时导出，内部路径不可导入", async () => {
  assert.deepEqual(Object.keys(core).sort(), [...runtimeExports].sort());
  for (const subpath of ["dist/index.js", "dist/bilibili.js", "src/bilibili.ts"]) {
    await assert.rejects(import(`@fukangz/core-bilibili-subtitles/${subpath}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  }
});

test("编译后的公共声明保留全部签名关联类型，不暴露内部客户端类型", () => {
  const file = path.join(root, "dist/index.d.ts");
  const program = ts.createProgram([file], { module: ts.ModuleKind.NodeNext, noEmit: true, skipLibCheck: true });
  const source = program.getSourceFile(file);
  assert.ok(source);
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(source);
  assert.ok(module);
  const exported = checker.getExportsOfModule(module).map((symbol) => symbol.name).sort();
  assert.deepEqual(exported, [...runtimeExports, ...typeExports].sort());
});

test("core 源码只依赖本包、Node 和声明的运行时依赖，不依赖 Pi 或 CLI", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const dependencies = Object.keys(manifest.dependencies);
  assert.deepEqual(dependencies.sort(), ["qrcode-generator", "yaml"]);
  assert.equal(manifest.peerDependencies, undefined);
  assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./prompts/*"]);
  const sourceRoot = path.join(root, "src");
  for (const entry of await readdir(sourceRoot, { withFileTypes: true })) {
    assert.equal(entry.isFile(), true, `新源码目录需要加入边界扫描: ${entry.name}`);
    const file = path.join(sourceRoot, entry.name);
    const text = await readFile(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === "require")) {
        assert.equal(node.arguments.length, 1);
        const argument = node.arguments[0]!;
        assert.ok(ts.isStringLiteral(argument), `${entry.name}: 动态依赖必须可静态检查`);
        imports.push(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const specifier of imports) {
      if (specifier.startsWith("./")) {
        assert.ok(specifier.endsWith(".js"), `${entry.name}: ${specifier} 必须兼容编译后的 ESM`);
        assert.ok(!path.relative(sourceRoot, path.resolve(sourceRoot, specifier)).startsWith(".."));
      } else {
        assert.ok(specifier.startsWith("node:") || dependencies.includes(specifier), `${entry.name}: 非 core 依赖 ${specifier}`);
      }
    }
    assert.doesNotMatch(text, /\/bilibili-login|请使用 \/login|Pi 交互式|@earendil-works|ModelThinkingLevel/);
  }
});

test("内置提示词从编译包位置加载，二维码保持矩形，脱敏忽略空凭证", () => {
  const prompts = loadPrompts();
  assert.ok(prompts.structure.length > 100);
  assert.ok(prompts.polish.length > 100);
  const { lines, width } = encodeQrLines("https://passport.bilibili.com/test");
  const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
  assert.ok(plain.length > 10);
  assert.equal(new Set(plain.map((line) => line.length)).size, 1);
  assert.equal(plain[0]?.length, width);
  assert.equal(plain.length, Math.ceil(plain[0]!.length / 2));
  assert.ok(plain.every((line) => /^[ █▀▄]+$/.test(line)));
  const modules = encodeQrModules("https://passport.bilibili.com/test");
  assert.equal(modules.size + 8, width);
  assert.equal(modules.rows.length, modules.size);
  assert.ok(modules.rows.every((row) => /^[01]+$/.test(row) && row.length === modules.size));
  assert.equal(modules.rows[0]?.slice(0, 7), "1111111");
  assert.equal(redact("session=abc token=abc ok", ["", "abc"]), "session=[redacted] token=[redacted] ok");
});
