import assert from "node:assert/strict";
import { test } from "node:test";
import { isSubtitleError } from "@fukangz/core-bilibili-subtitles";
import { parseTranscriptMarkdown, renderTranscriptMarkdown, type Transcript } from "@fukangz/core-bilibili-subtitles";

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    schemaVersion: 1,
    kind: "bilibili-subtitle",
    bvid: "BV1test",
    aid: 7,
    cid: 11,
    page: 1,
    pageCount: 1,
    pageTitle: "正片",
    videoTitle: "示例: \"视频\"",
    authorName: "作者",
    authorMid: 3,
    publishedAt: "2023-11-14T22:13:20.000Z",
    statsFetchedAt: "2024-01-01T00:00:00.000Z",
    viewCount: 100,
    danmakuCount: 2,
    replyCount: 3,
    favoriteCount: 4,
    coinCount: 5,
    shareCount: 6,
    likeCount: 7,
    sourceUrl: "https://www.bilibili.com/video/BV1test/?p=1",
    language: "zh-CN",
    languageName: "中文",
    trackKind: "human",
    trackId: "track-1",
    segments: [
      { id: 1, startSeconds: 0, text: "大家好" },
      { id: 2, startSeconds: 61, text: "下一句" },
      { id: 9, startSeconds: 7503, text: "超过九十九分钟" },
    ],
    ...overrides,
  };
}

test("front matter 与正文可以往返，id 按有效行重排", () => {
  const parsed = parseTranscriptMarkdown(renderTranscriptMarkdown(transcript()));
  assert.equal(parsed.videoTitle, "示例: \"视频\"");
  assert.equal(parsed.sourceUrl, "https://www.bilibili.com/video/BV1test/?p=1");
  assert.equal(parsed.authorName, "作者");
  assert.equal(parsed.authorMid, 3);
  assert.equal(parsed.publishedAt, "2023-11-14T22:13:20.000Z");
  assert.equal(parsed.viewCount, 100);
  assert.equal(parsed.likeCount, 7);
  assert.equal(parsed.coinCount, 5);
  for (const key of ["statsFetchedAt", "danmakuCount", "replyCount", "favoriteCount", "shareCount"] as const) {
    assert.equal(parsed[key], transcript()[key]);
  }
  assert.deepEqual(
    parsed.segments.map((segment) => [segment.id, segment.startSeconds, segment.text]),
    [
      [1, 0, "大家好"],
      [2, 61, "下一句"],
      [3, 7503, "超过九十九分钟"],
    ],
  );
  assert.equal(JSON.stringify(parsed).includes("endSeconds"), false);
});

test("BOM、CRLF、空行和相同秒都可以解析", () => {
  const source = [
    "\uFEFF---",
    "schemaVersion: 1",
    "kind: bilibili-subtitle",
    "bvid: BV1test",
    "videoTitle: 示例",
    "page: 1",
    "pageCount: 1",
    "pageTitle: 正片",
    "sourceUrl: https://www.bilibili.com/video/BV1test/?p=1",
    "language: zh-CN",
    "languageName: 中文",
    "trackKind: ai",
    "trackId: t",
    "---",
    "",
    "00:01 第一句",
    "00:01 同一秒",
    "125:03 很久以后",
    "",
  ].join("\r\n");
  const parsed = parseTranscriptMarkdown(source);
  assert.deepEqual(
    parsed.segments.map((segment) => segment.text),
    ["第一句", "同一秒", "很久以后"],
  );
  assert.equal(parsed.segments[2]?.startSeconds, 7503);
  assert.equal(parsed.aid, undefined);
  for (const key of ["authorName", "authorMid", "publishedAt", "statsFetchedAt", "viewCount", "danmakuCount", "replyCount", "favoriteCount", "coinCount", "shareCount", "likeCount"] as const) {
    assert.equal(parsed[key], undefined);
    assert.equal(renderTranscriptMarkdown(parsed).includes(`${key}:`), false);
  }
});

test("坏格式、错误 kind、非法秒、空正文和时间倒退会带行号失败", () => {
  assert.throws(() => parseTranscriptMarkdown("{ \"segments\": [] }\n"), /不是原始字幕 Markdown/);
  assert.throws(() => parseTranscriptMarkdown("---\nkind: bilibili-polished-article\nschemaVersion: 1\n---\n\n00:00 正文\n"), /润色文章/);
  assert.throws(() => parseTranscriptMarkdown(front({ schemaVersion: 2 })), /schemaVersion/);
  assert.throws(() => parseTranscriptMarkdown(`${front()}\n00:60 正文\n`), /第 16 行/);
  assert.throws(() => parseTranscriptMarkdown(`${front()}\n00:01\n`), /第 16 行的字幕正文是空的/);
  assert.throws(() => parseTranscriptMarkdown(`${front()}\n00:02 后\n00:01 前\n`), /第 17 行的时间早于前一条字幕/);
  assert.throws(() => parseTranscriptMarkdown("---\nevil: !!js/function x\n---\n\n00:00 正文\n"), /front matter 无法解析/);
});

test("sourceUrl 与 bvid 或分P矛盾时失败", () => {
  const source = front({ sourceUrl: "https://www.bilibili.com/video/BV1other/?p=1" });
  assert.throws(() => parseTranscriptMarkdown(`${source}\n00:00 正文\n`), /sourceUrl 与 bvid 不一致/);
  const page = front({ page: 2, pageCount: 2, sourceUrl: "https://www.bilibili.com/video/BV1test/?p=1" });
  assert.throws(() => parseTranscriptMarkdown(`${page}\n00:00 正文\n`), /分P与 page 不一致/);
  for (const sourceUrl of [
    "BV1test",
    "@https://www.bilibili.com/video/BV1test/?p=1",
    "ftp://www.bilibili.com/video/BV1test/?p=1",
    "https://b23.tv/BV1test",
  ]) {
    const invalid = front({ sourceUrl });
    assert.throws(() => parseTranscriptMarkdown(`${invalid}\n00:00 正文\n`), /sourceUrl/);
  }
  const malformedPage = front({ sourceUrl: "https://www.bilibili.com/video/BV1test/?p=0" });
  assert.throws(() => parseTranscriptMarkdown(`${malformedPage}\n00:00 正文\n`), /分P与 page 不一致/);
  const bothMismatch = front({ sourceUrl: "https://www.bilibili.com/video/BV1other/?p=0" });
  assert.throws(() => parseTranscriptMarkdown(`${bothMismatch}\n00:00 正文\n`), /sourceUrl 与 bvid 不一致/);
});

test("sourceUrl 保留完整链接，包括外层空白和普通查询参数", () => {
  for (const sourceUrl of [
    " https://www.bilibili.com/video/BV1test/?p=1 ",
    "http://m.bilibili.com/video/BV1test/",
    "https://bilibili.com/video/BV1test/?p=1&from=b23.tv",
  ]) {
    assert.equal(parseTranscriptMarkdown(`${front({ sourceUrl })}\n00:00 正文\n`).sourceUrl, sourceUrl);
  }
});

function front(overrides: Record<string, unknown> = {}): string {
  const fields = {
    schemaVersion: 1,
    kind: "bilibili-subtitle",
    bvid: "BV1test",
    videoTitle: "示例",
    page: 1,
    pageCount: 1,
    pageTitle: "正片",
    sourceUrl: "https://www.bilibili.com/video/BV1test/?p=1",
    language: "zh-CN",
    languageName: "中文",
    trackKind: "human",
    trackId: "t",
    ...overrides,
  };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return ["---", ...lines, "---", ""].join("\n");
}

test("解析错误是 SubtitleError，不会静默跳过坏行", () => {
  try {
    parseTranscriptMarkdown(`${front()}\n00:00 好\n坏行\n`);
    assert.fail("应该失败");
  } catch (error) {
    assert.equal(isSubtitleError(error), true);
    assert.match(error instanceof Error ? error.message : "", /第 17 行/);
  }
});
