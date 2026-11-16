import { isMap, isScalar, LineCounter, parseDocument, stringify } from "yaml";
import type { SubtitleCue, TrackKind } from "./bilibili.js";
import { SubtitleError } from "./errors.js";
import { isRecord } from "./guards.js";
import { bilibiliVideoUrl, parseBilibiliVideoUrl } from "./video-url.js";

export interface Segment {
  id: number;
  startSeconds: number;
  text: string;
}

export interface Transcript {
  schemaVersion: 1;
  kind: "bilibili-subtitle";
  bvid: string;
  aid?: number;
  cid?: number;
  page: number;
  pageCount: number;
  pageTitle: string;
  videoTitle: string;
  authorName?: string;
  authorMid?: number;
  publishedAt?: string;
  statsFetchedAt?: string;
  viewCount?: number;
  danmakuCount?: number;
  replyCount?: number;
  favoriteCount?: number;
  coinCount?: number;
  shareCount?: number;
  likeCount?: number;
  sourceUrl: string;
  language: string;
  languageName: string;
  trackKind: TrackKind;
  trackId: string;
  segments: Segment[];
}

export function normalizeCues(cues: readonly SubtitleCue[]): Segment[] {
  const segments: Segment[] = [];
  let previousStart = -1;
  for (const cue of cues) {
    const text = cue.content.replace(/\r\n|\r|\n/g, " ").trim();
    if (!text) continue;
    if (!Number.isFinite(cue.from) || !Number.isFinite(cue.to) || cue.from < 0 || cue.to < 0) {
      throw new SubtitleError("INVALID_RESPONSE", "字幕时间必须是有限非负数");
    }
    if (cue.to < cue.from) throw new SubtitleError("INVALID_RESPONSE", "字幕结束时间早于开始时间");
    if (cue.from < previousStart) throw new SubtitleError("INVALID_RESPONSE", "字幕时间顺序倒退");
    previousStart = cue.from;
    segments.push({
      id: segments.length + 1,
      startSeconds: Math.floor(cue.from),
      text,
    });
  }
  if (segments.length === 0) throw new SubtitleError("NO_SUBTITLE", "字幕正文是空的");
  return segments;
}

export function renderTranscriptMarkdown(transcript: Transcript): string {
  const metadata: Record<string, unknown> = {
    schemaVersion: transcript.schemaVersion,
    kind: transcript.kind,
    bvid: transcript.bvid,
    videoTitle: transcript.videoTitle,
    page: transcript.page,
    pageCount: transcript.pageCount,
    pageTitle: transcript.pageTitle,
    sourceUrl: transcript.sourceUrl,
    language: transcript.language,
    languageName: transcript.languageName,
    trackKind: transcript.trackKind,
    trackId: transcript.trackId,
    authorName: transcript.authorName,
    authorMid: transcript.authorMid,
    publishedAt: transcript.publishedAt,
    statsFetchedAt: transcript.statsFetchedAt,
    viewCount: transcript.viewCount,
    danmakuCount: transcript.danmakuCount,
    replyCount: transcript.replyCount,
    favoriteCount: transcript.favoriteCount,
    coinCount: transcript.coinCount,
    shareCount: transcript.shareCount,
    likeCount: transcript.likeCount,
    aid: transcript.aid,
    cid: transcript.cid,
  };
  const frontMatter = stringify(metadata, { schema: "core", lineWidth: 0, resolveKnownTags: false }).trimEnd();
  const lines = transcript.segments.map((segment) => `${formatCueTime(segment.startSeconds)} ${segment.text}`);
  return `---\n${frontMatter}\n---\n\n${lines.join("\n")}\n`;
}

export function parseTranscriptMarkdown(source: string): Transcript {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new SubtitleError("INVALID_INPUT", "不是原始字幕 Markdown：文件开头需要 YAML front matter");
  const yamlBody = match[1];
  const body = match[2];
  const yamlLineCount = yamlBody.length === 0 ? 0 : yamlBody.split("\n").length;
  const metadata = parseMetadata(yamlBody);
  const segments = parseCueBody(body, 3 + yamlLineCount);
  return { ...metadata, segments };
}

export function isChineseLanguage(language: string): boolean {
  const value = language.toLowerCase();
  return value === "zh" || value.startsWith("zh-") || value.startsWith("ai-zh");
}

export function sourceUrlFor(bvid: string, page: number): string {
  return bilibiliVideoUrl(bvid, page);
}

export function formatCueTime(startSeconds: number): string {
  const whole = Math.max(0, Math.floor(startSeconds));
  const minutes = Math.floor(whole / 60);
  const seconds = whole % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function parseMetadata(yamlBody: string): Omit<Transcript, "segments"> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(yamlBody, {
    schema: "failsafe",
    version: "1.2",
    merge: false,
    uniqueKeys: true,
    strict: false,
    customTags: [],
    lineCounter,
    logLevel: "silent",
  });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem) {
    throw new SubtitleError("INVALID_INPUT", `字幕 front matter 无法解析${formatYamlLine(problem.linePos?.[0])}：${problem.message}`);
  }
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取 YAML";
    throw new SubtitleError("INVALID_INPUT", `字幕 front matter 无法解析：${message}`);
  }
  const contents = doc.contents;
  if (!isRecord(value) || !isMap(contents)) {
    throw new SubtitleError("INVALID_INPUT", "字幕 front matter 必须是映射");
  }
  const lineOf = (key: string): number | undefined => {
    for (const { key: node } of contents.items) {
      if (isScalar(node) && String(node.value) === key) {
        return node.range ? lineCounter.linePos(node.range[0]).line + 1 : undefined;
      }
    }
    return undefined;
  };
  const kind = value.kind;
  if (kind === "bilibili-polished-article") {
    throw new SubtitleError("INVALID_INPUT", `${atLine(lineOf("kind"))}这是润色文章，不是原始字幕。请传入下载得到的 transcript.md`);
  }
  if (kind !== "bilibili-subtitle") {
    throw new SubtitleError("INVALID_INPUT", `${atLine(lineOf("kind"))}kind 必须是 bilibili-subtitle`);
  }
  if (value.schemaVersion !== "1") {
    throw new SubtitleError("INVALID_INPUT", `${atLine(lineOf("schemaVersion"))}schemaVersion 必须是 1`);
  }
  const bvid = requiredString(value.bvid, "bvid");
  if (!/^BV[0-9A-Za-z]+$/.test(bvid)) throw new SubtitleError("INVALID_INPUT", "bvid 无效");
  const page = requiredInteger(value.page, "page");
  if (page < 1) throw new SubtitleError("INVALID_INPUT", "page 必须从 1 开始");
  const pageCount = requiredInteger(value.pageCount, "pageCount");
  if (pageCount < page) throw new SubtitleError("INVALID_INPUT", "pageCount 不能小于 page");
  const trackKind = value.trackKind;
  if (trackKind !== "human" && trackKind !== "ai" && trackKind !== "unknown") {
    throw new SubtitleError("INVALID_INPUT", `${atLine(lineOf("trackKind"))}trackKind 必须是 human、ai 或 unknown`);
  }
  const sourceUrl = requiredString(value.sourceUrl, "sourceUrl");
  assertSourceUrl(bvid, page, sourceUrl, lineOf("sourceUrl"));
  return {
    schemaVersion: 1,
    kind: "bilibili-subtitle",
    bvid,
    aid: optionalInteger(value.aid, "aid"),
    cid: optionalInteger(value.cid, "cid"),
    page,
    pageCount,
    pageTitle: requiredText(value.pageTitle, "pageTitle"),
    videoTitle: requiredText(value.videoTitle, "videoTitle"),
    authorName: optionalString(value.authorName, "authorName"),
    authorMid: optionalInteger(value.authorMid, "authorMid"),
    publishedAt: optionalString(value.publishedAt, "publishedAt"),
    statsFetchedAt: optionalString(value.statsFetchedAt, "statsFetchedAt"),
    viewCount: optionalInteger(value.viewCount, "viewCount"),
    danmakuCount: optionalInteger(value.danmakuCount, "danmakuCount"),
    replyCount: optionalInteger(value.replyCount, "replyCount"),
    favoriteCount: optionalInteger(value.favoriteCount, "favoriteCount"),
    coinCount: optionalInteger(value.coinCount, "coinCount"),
    shareCount: optionalInteger(value.shareCount, "shareCount"),
    likeCount: optionalInteger(value.likeCount, "likeCount"),
    sourceUrl,
    language: requiredString(value.language, "language"),
    languageName: requiredText(value.languageName, "languageName"),
    trackKind,
    trackId: requiredString(value.trackId, "trackId"),
  };
}

function parseCueBody(body: string, firstLine: number): Segment[] {
  const segments: Segment[] = [];
  let previous = -1;
  const lines = body.split("\n");
  lines.forEach((raw, index) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim() === "") return;
    const lineNumber = firstLine + index;
    const match = /^(\d{2,}):([0-5]\d)(?:[ \t]+(.*))?$/.exec(line);
    if (!match) throw new SubtitleError("INVALID_INPUT", `第 ${lineNumber} 行不是“分钟:秒 + 字幕”`);
    const text = match[3]?.trim() ?? "";
    if (!text) throw new SubtitleError("INVALID_INPUT", `第 ${lineNumber} 行的字幕正文是空的`);
    const startSeconds = Number(match[1]) * 60 + Number(match[2]);
    if (startSeconds < previous) throw new SubtitleError("INVALID_INPUT", `第 ${lineNumber} 行的时间早于前一条字幕`);
    previous = startSeconds;
    segments.push({ id: segments.length + 1, startSeconds, text });
  });
  if (segments.length === 0) throw new SubtitleError("INVALID_INPUT", "字幕正文是空的");
  return segments;
}

function assertSourceUrl(bvid: string, page: number, sourceUrl: string, line: number | undefined): void {
  const parsed = parseBilibiliVideoUrl(sourceUrl);
  if (!parsed.ok) {
    if (parsed.reason === "invalid-page" && parsed.bvid !== bvid) {
      throw new SubtitleError("INVALID_INPUT", `${atLine(line)}sourceUrl 与 bvid 不一致`);
    }
    const message = parsed.reason === "unrecognized"
      ? "sourceUrl 不是有效链接"
      : parsed.reason === "protocol"
        ? "sourceUrl 必须是 http 或 https"
        : parsed.reason === "host"
          ? "sourceUrl 必须是哔哩哔哩视频链接"
          : parsed.reason === "invalid-page"
            ? "sourceUrl 的分P与 page 不一致"
            : "sourceUrl 与 bvid 不一致";
    throw new SubtitleError("INVALID_INPUT", `${atLine(line)}${message}`);
  }
  if (parsed.bvid !== bvid) throw new SubtitleError("INVALID_INPUT", `${atLine(line)}sourceUrl 与 bvid 不一致`);
  if ((parsed.page ?? 1) !== page) throw new SubtitleError("INVALID_INPUT", `${atLine(line)}sourceUrl 的分P与 page 不一致`);
}

function formatYamlLine(position: { line: number } | undefined): string {
  return position ? `（第 ${position.line + 1} 行）` : "";
}

function atLine(line: number | undefined): string {
  return line === undefined ? "" : `第 ${line} 行：`;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new SubtitleError("INVALID_INPUT", `${label} 必须是非空字符串`);
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string") throw new SubtitleError("INVALID_INPUT", `${label} 必须是字符串`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new SubtitleError("INVALID_INPUT", `${label} 必须是整数`);
  }
  return Number(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function optionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredInteger(value, label);
}
