import path from "node:path";
import { stringify } from "yaml";
import { isSubtitleError, SubtitleError } from "./errors.js";
import { isRecord, throwIfCancelled } from "./guards.js";
import type { ModelInfo, StageClient, StageRequest } from "./model.js";
import {
  nodeFileStore, passthroughQueue, resolveInsideCwd, toPosixRelative, writeNewFile, type FileStore, type MutationQueue,
} from "./store.js";
import { isChineseLanguage, parseTranscriptMarkdown, type Segment, type Transcript } from "./transcript.js";
import { bilibiliVideoUrl } from "./video-url.js";
import { addUsage, usageStatus, type Usage, type UsageStatus } from "./usage.js";

interface SectionRange {
  id: string;
  startSegmentId: number;
  endSegmentId: number;
  startSeconds: number;
}

export type OutlineSection = SectionRange & (
  | { kind: "intro" }
  | { kind: "chapter"; heading: string; level: 2 | 3 }
);

export interface Outline {
  title: string;
  sections: OutlineSection[];
}

export interface PolishResult {
  outputPath: string;
  transcriptPath: string;
  sectionCount: number;
  inputCount: number;
  model: string;
  thinking?: string;
  warnings: string[];
  usage?: Usage;
  usageStatus: UsageStatus;
}

export async function polishTranscript(input: {
  transcriptPath: string;
  outputPath?: string;
  cwd: string;
  model: ModelInfo;
  client: StageClient;
  prompts: { structure: string; polish: string };
  signal?: AbortSignal;
  queue?: MutationQueue;
  files?: FileStore;
  onProgress?: (message: string) => void;
}): Promise<PolishResult> {
  const files = input.files ?? nodeFileStore;
  const absolute = resolveInsideCwd(input.cwd, input.transcriptPath, "transcriptPath");
  const original = await readOriginal(files, absolute, input.signal);
  const transcript = parseTranscriptMarkdown(original.toString("utf8"));
  assertChinese(transcript);
  const desired = input.outputPath
    ? resolveInsideCwd(input.cwd, input.outputPath, "outputPath")
    : defaultPolishedPath(absolute);
  let spent: Usage | undefined;
  let attemptedCalls = 0;
  let reportedCalls = 0;
  const complete: StageClient["complete"] = async (request, signal) => {
    attemptedCalls += 1;
    try {
      const result = await input.client.complete(request, signal);
      if (result.usage) reportedCalls += 1;
      spent = addUsage(spent, result.usage);
      return result;
    } catch (error) {
      if (isSubtitleError(error) && error.usage) {
        reportedCalls += 1;
        spent = addUsage(spent, error.usage);
      }
      throw error;
    }
  };
  try {
    throwIfCancelled(input.signal);
    input.onProgress?.("正在分析全文结构");
    const structure = await runJsonStage(
      complete,
      "structure",
      input.prompts.structure,
      structureUser(transcript),
      (value) => validateStructure(value, transcript.segments),
      input.signal,
    );
    throwIfCancelled(input.signal);
    input.onProgress?.("正在润色全文");
    const prose = await runJsonStage(
      complete,
      "body",
      input.prompts.polish,
      polishUser(transcript, structure),
      (value) => validateBodies(value, structure),
      input.signal,
    );
    const warnings = [...input.model.warnings, ...shorteningWarning(transcript, prose)];
    const article = renderArticle(
      transcript,
      structure,
      prose,
      input.model,
      path.relative(path.dirname(desired), absolute).split(path.sep).join("/"),
    );
    const queue = input.queue ?? passthroughQueue;
    const articlePath = await queue(path.dirname(desired), async () => {
      throwIfCancelled(input.signal);
      const current = await readOriginal(files, absolute, input.signal);
      if (!current.equals(original)) throw new SubtitleError("INVALID_INPUT", "原始字幕在润色期间发生变化");
      return writeNewFile(desired, article, files, input.signal);
    });
    return {
      outputPath: toPosixRelative(input.cwd, articlePath),
      transcriptPath: toPosixRelative(input.cwd, absolute),
      sectionCount: structure.sections.length,
      inputCount: transcript.segments.length,
      model: input.model.label,
      thinking: input.model.thinking,
      warnings,
      usage: spent,
      usageStatus: usageStatus(reportedCalls, attemptedCalls),
    };
  } catch (error) {
    const failure = isSubtitleError(error) ? error : new SubtitleError("MODEL_ERROR", "润色失败");
    failure.usage = spent;
    failure.usageStatus = usageStatus(reportedCalls, attemptedCalls);
    throw failure;
  }
}

async function runJsonStage<T>(
  complete: StageClient["complete"],
  stage: NonNullable<StageRequest["context"]>["stage"],
  system: string,
  user: string,
  validate: (value: unknown) => { value?: T; errors: string[] },
  signal?: AbortSignal,
): Promise<T> {
  let requestUser = user;
  let errors: string[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await complete({ system, user: requestUser, context: { stage, attempt: attempt === 0 ? 1 : 2 } }, signal);
    const parsed = parseModelJson(result.text);
    const checked = parsed.ok ? validate(parsed.value) : { errors: ["响应不是合法 JSON"] };
    if (checked.errors.length === 0 && checked.value !== undefined) return checked.value;
    errors = checked.errors;
    if (attempt === 0) {
      throwIfCancelled(signal);
      requestUser = `${user}\n\n上一次输出没有通过校验：\n${errors.map((error) => `- ${error}`).join("\n")}\n\n请只重新输出 JSON。上一次输出：\n${truncate(result.text, 4000)}`;
    }
  }
  throw new SubtitleError("INVALID_MODEL_OUTPUT", `模型输出两次都未通过校验：${errors.join("；")}`, {
    diagnostic: { stage, attempt: 2, operation: "validate", reason: "invalid_output" },
  });
}

export function validateStructure(value: unknown, segments: readonly Segment[]): { value?: Outline; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(value)) return { errors: ["顶层必须是对象"] };
  const title = typeof value.title === "string" ? value.title.trim() : "";
  if (!title) errors.push("title 必须是非空字符串");
  if (!Array.isArray(value.sections) || value.sections.length === 0) {
    return { errors: [...errors, "sections 必须是非空数组"] };
  }
  const starts: number[] = [];
  const outlineSections: OutlineSection[] = [];
  value.sections.forEach((item, index) => {
    if (!isRecord(item)) {
      errors.push(`第 ${index + 1} 节不是对象`);
      starts.push(Number.NaN);
      return;
    }
    const start = item.startSegmentId;
    const validStart = typeof start === "number" && Number.isInteger(start) && start >= 1 && start <= segments.length;
    if (!validStart) errors.push(`第 ${index + 1} 节的 startSegmentId 不存在`);
    starts.push(validStart ? start : Number.NaN);
    const base = validStart ? {
      id: `section-${index + 1}`,
      startSegmentId: start,
      endSegmentId: segments.length,
      startSeconds: segments[start - 1].startSeconds,
    } : undefined;
    if (item.kind === "intro") {
      if (index !== 0) errors.push("intro 只能是第一节");
      if (base) outlineSections.push({ ...base, kind: "intro" });
      return;
    }
    if (item.kind !== "chapter") {
      errors.push(`第 ${index + 1} 节的 kind 无效`);
      return;
    }
    const heading = typeof item.heading === "string" ? item.heading.trim() : "";
    if (!heading) errors.push(`第 ${index + 1} 节缺少 heading`);
    if (item.level !== 2 && item.level !== 3) errors.push(`第 ${index + 1} 节的 level 只能是 2 或 3`);
    if (base && heading && (item.level === 2 || item.level === 3)) {
      outlineSections.push({ ...base, kind: "chapter", heading, level: item.level });
    }
  });
  if (starts[0] !== 1) errors.push("第一节必须从字幕 1 开始");
  for (let index = 1; index < starts.length; index += 1) {
    if (!(starts[index] > starts[index - 1])) errors.push("startSegmentId 必须严格递增");
  }
  if (errors.length > 0) return { errors };
  for (let index = 1; index < outlineSections.length; index += 1) {
    outlineSections[index - 1].endSegmentId = outlineSections[index].startSegmentId - 1;
  }
  return { value: { title, sections: outlineSections }, errors: [] };
}

export function validateBodies(
  value: unknown,
  outline: Outline,
): { value?: Array<{ id: string; text: string }>; errors: string[] } {
  if (!isRecord(value) || !Array.isArray(value.sections)) return { errors: ["sections 必须是数组"] };
  const expected = outline.sections.map((section) => section.id);
  const actual = value.sections.map((item) => (isRecord(item) && typeof item.id === "string" ? item.id : ""));
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    return { errors: [`sections 必须按顺序等于 ${expected.join("、")}`] };
  }
  const bodies: Array<{ id: string; text: string }> = [];
  const errors: string[] = [];
  value.sections.forEach((item, index) => {
    const text = isRecord(item) && typeof item.text === "string" ? item.text.trim() : "";
    if (!text) errors.push(`${expected[index]} 的 text 不能为空`);
    bodies.push({ id: expected[index], text });
  });
  return errors.length > 0 ? { errors } : { value: bodies, errors: [] };
}

export function renderArticle(
  transcript: Transcript,
  outline: Outline,
  bodies: readonly { id: string; text: string }[],
  model: ModelInfo,
  sourceTranscript: string,
): string {
  const metadata = {
    schemaVersion: 1,
    kind: "bilibili-polished-article",
    title: outline.title,
    videoTitle: transcript.videoTitle,
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
    bvid: transcript.bvid,
    page: transcript.page,
    pageTitle: transcript.pageTitle,
    source: transcript.sourceUrl,
    language: transcript.language,
    trackKind: transcript.trackKind,
    model: model.label,
    ...(model.thinking !== undefined ? { thinking: model.thinking } : {}),
    generatedAt: new Date().toISOString(),
    sourceTranscript,
  };
  const lines = [
    "---",
    stringify(metadata, { schema: "core", lineWidth: 0, resolveKnownTags: false }).trimEnd(),
    "---",
    "",
    `# ${outline.title}`,
    "",
  ];
  outline.sections.forEach((section, index) => {
    if (section.kind === "chapter") {
      lines.push(`${"#".repeat(section.level)} ${section.heading} ${jumpLink(transcript, section.startSeconds)}`, "");
    }
    lines.push(bodies[index].text, "");
  });
  return `${lines.join("\n").trim()}\n`;
}

function jumpLink(transcript: Transcript, startSeconds: number): string {
  const url = bilibiliVideoUrl(transcript.bvid, transcript.page, startSeconds);
  return `[▶ ${formatClock(startSeconds)}](${url})`;
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remain = whole % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
  return `${minutes}:${String(remain).padStart(2, "0")}`;
}

function shorteningWarning(transcript: Transcript, bodies: readonly { text: string }[]): string[] {
  const source = transcript.segments.reduce((total, segment) => total + segment.text.length, 0);
  const polished = bodies.reduce((total, body) => total + body.text.length, 0);
  if (source >= 200 && polished < source * 0.35) {
    return [`润色正文明显短于字幕（${polished}/${source} 字）。校验只能确认章节对齐，不能证明没有漏掉内容。`];
  }
  return [];
}

function structureUser(transcript: Transcript): string {
  const header = [
    `视频标题：${transcript.videoTitle}`,
    `分P标题：${transcript.pageTitle}`,
    `分P：${transcript.page}`,
    `来源：${transcript.sourceUrl}`,
    `语言：${transcript.language}`,
  ].join("\n");
  const lines = transcript.segments.map((segment) => `${segment.id}\t${segment.startSeconds}\t${segment.text}`).join("\n");
  return `${header}\n\n字幕：\n${lines}`;
}

function polishUser(transcript: Transcript, outline: Outline): string {
  return JSON.stringify(
    {
      title: outline.title,
      sections: outline.sections.map((section) => {
        const payload: { id: string; heading?: string; text: string } = {
          id: section.id,
          text: transcript.segments
            .slice(section.startSegmentId - 1, section.endSegmentId)
            .map((segment) => segment.text)
            .join("\n"),
        };
        if (section.kind === "chapter") payload.heading = section.heading;
        return payload;
      }),
    },
    null,
    2,
  );
}

function parseModelJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  try {
    return { ok: true, value: JSON.parse(fenced?.[1] ?? trimmed) as unknown };
  } catch {
    return { ok: false };
  }
}

function assertChinese(transcript: Transcript): void {
  if (!isChineseLanguage(transcript.language)) {
    throw new SubtitleError("POLISH_LANGUAGE_UNSUPPORTED", `第一版只润色中文字幕，不会把 ${transcript.language} 翻译成中文`);
  }
}

async function readOriginal(files: FileStore, filePath: string, signal?: AbortSignal): Promise<Buffer> {
  let bytes: Uint8Array;
  try {
    bytes = await files.readFile(filePath, signal);
  } catch (error) {
    if (isSubtitleError(error)) throw error;
    throwIfCancelled(signal);
    throw new SubtitleError("INVALID_INPUT", "无法读取 transcriptPath");
  }
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function defaultPolishedPath(transcriptPath: string): string {
  const extension = path.extname(transcriptPath);
  const stem = extension ? transcriptPath.slice(0, -extension.length) : transcriptPath;
  return `${stem}.polished.md`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…`;
}
