import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const packageDocuments = ["core", "pi", "cli", "dsh"].map((name) => `packages/${name}/README.md`);
const documents = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "GLOSSARY.md", ...packageDocuments];
const repositoryBlob = "https://github.com/FukangZ/bilibili-subtitles/blob/main/";
// 包 README 的图片走 jsDelivr 取仓库 main 分支文件；已发布版本会一直引用这些路径，不能改名或移动。
const repositoryCdn = "https://cdn.jsdelivr.net/gh/FukangZ/bilibili-subtitles@main/";

function links(text) {
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  return [...prose.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)].map((match) => match[1]);
}

async function addDocuments(directory) {
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    // docs/agents 是本地个人规则，不属于公共文档或测试输入。
    if (directory === "docs/" && entry.name === "agents") continue;
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) await addDocuments(`${path}/`);
    else if (entry.isFile() && entry.name.endsWith(".md")) documents.push(path);
  }
}
await addDocuments("docs/");

test("仓库文档的本地 Markdown 链接指向存在的文件", async () => {
  for (const document of documents) {
    const url = new URL(`../${document}`, import.meta.url);
    for (const href of links(await readFile(url, "utf8"))) {
      if (/^(https?:|#)/.test(href)) continue;
      const target = new URL(href.split("#")[0], url);
      await assert.doesNotReject(() => access(target), `${document}: ${href}`);
    }
  }
});

// 包 README 随 npm 发布后只剩包内文件；pi.dev、dsh 和本地 node_modules 不会改写相对链接。
test("包 README 的包外链接使用仓库 main 分支绝对地址、目标存在，且不链接 ADR", async () => {
  for (const document of packageDocuments) {
    const url = new URL(`../${document}`, import.meta.url);
    const packageRoot = new URL("./", url);
    for (const href of links(await readFile(url, "utf8"))) {
      assert.ok(!href.includes("docs/adr/"), `${document}: 包 README 不链接 ADR：${href}`);
      const repositoryPrefix = [repositoryBlob, repositoryCdn].find((prefix) => href.startsWith(prefix));
      if (repositoryPrefix) {
        const target = new URL(decodeURI(href.slice(repositoryPrefix.length).split("#")[0]), root);
        await assert.doesNotReject(() => access(target), `${document}: ${href}`);
      } else if (!/^(https?:|#)/.test(href)) {
        const target = new URL(href.split("#")[0], url);
        assert.ok(target.href.startsWith(packageRoot.href), `${document}: 包外链接需改为 ${repositoryBlob}…：${href}`);
      }
    }
  }
});

test("Pi 包画廊预览图指向仓库内存在的文件", async () => {
  const { pi } = JSON.parse(await readFile(new URL("packages/pi/package.json", root), "utf8"));
  assert.ok(pi.image.startsWith(repositoryCdn), `pi.image 需使用 ${repositoryCdn}…：${pi.image}`);
  await assert.doesNotReject(() => access(new URL(pi.image.slice(repositoryCdn.length), root)), pi.image);
});

test("README 原始字幕示例与独立合成夹具一致，真实 core 入口可解析并往返", async () => {
  const { parseTranscriptMarkdown, renderTranscriptMarkdown } = await import("@fukangz/core-bilibili-subtitles");
  const readme = await readFile(new URL("README.md", root), "utf8");
  const fixture = await readFile(new URL("packages/core/tests/fixtures/transcript.md", root), "utf8");
  const marker = "```markdown\n";
  const start = readme.indexOf(marker);
  assert.notEqual(start, -1);
  const end = readme.indexOf("```", start + marker.length);
  assert.notEqual(end, -1);
  const example = readme.slice(start + marker.length, end);
  assert.equal(example, fixture);
  for (const source of [example, fixture]) {
    const transcript = parseTranscriptMarkdown(source);
    assert.equal(transcript.kind, "bilibili-subtitle");
    assert.equal(transcript.schemaVersion, 1);
    assert.equal(transcript.bvid, "BV1example");
    assert.equal(transcript.page, 1);
    assert.equal(transcript.pageCount, 1);
    assert.equal(transcript.language, "zh-CN");
    assert.equal(transcript.segments.length, 17);
    assert.equal(transcript.segments[0].startSeconds, 0);
    assert.equal(transcript.segments.at(-1).startSeconds, 149);
    assert.deepEqual(parseTranscriptMarkdown(renderTranscriptMarkdown(transcript)), transcript);
  }
});
