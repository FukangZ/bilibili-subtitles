import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);
const documents = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "GLOSSARY.md", ...["core", "pi", "cli", "dsh"].map((name) => `packages/${name}/README.md`)];

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
    const text = (await readFile(url, "utf8")).replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
    for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
      const href = match[1];
      if (/^(https?:|#)/.test(href)) continue;
      const target = new URL(href.split("#")[0], url);
      await assert.doesNotReject(() => access(target), `${document}: ${href}`);
    }
  }
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
