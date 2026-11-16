import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { register } from "../src/index.ts";
import { passthroughQueue } from "@fukangz/core-bilibili-subtitles";
import { parseTranscriptMarkdown } from "@fukangz/core-bilibili-subtitles";

test("工具定义使用精简说明并保留 Pi 调用与交付指引", () => {
  interface ToolMetadata {
    name: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: { properties: Record<string, { description?: string; minLength?: number }>; required?: string[] };
  }
  const tools: ToolMetadata[] = [];
  const commands: string[] = [];
  register({
    registerTool(tool: ToolMetadata) { tools.push(tool); },
    registerCommand(name: string) { commands.push(name); },
    on() {},
  } as unknown as ExtensionAPI);
  assert.deepEqual(commands, ["bilibili-login"]);
  assert.equal(tools.length, 2);
  const download = tools.find((tool) => tool.name === "bilibili_download_subtitle");
  const polish = tools.find((tool) => tool.name === "bilibili_polish_subtitle");
  assert.ok(download);
  assert.ok(polish);
  assert.equal(download.description, "下载 B 站视频指定分 P 的现有中文字幕，保存为 Markdown，返回 transcriptPath。");
  assert.equal(polish.description, "仅在用户要求润色或整理成文章时，将原始 B 站中文字幕忠实润色为带视频时间链接的 Markdown 文章，返回 outputPath。会产生模型用量。");
  const parameterDescriptions = (tool: ToolMetadata) => Object.fromEntries(
    Object.entries(tool.parameters.properties).map(([key, schema]) => [key, schema.description]),
  );
  assert.deepEqual(parameterDescriptions(download), {
    source: "BV 号或 bilibili.com/video/BV… 链接，不支持 b23.tv 短链。",
    page: "分 P 序号，从 1 开始。默认取链接中的 p，否则为 1；与链接中的 p 冲突时报错。",
    outputDir: "工作目录内的相对输出目录，默认 .subtitles；使用 . 表示当前目录。",
  });
  assert.deepEqual(parameterDescriptions(polish), {
    transcriptPath: "工作目录内的原始 B 站字幕 Markdown 相对路径。使用下载结果时，原样传入 transcriptPath，不要重建路径。",
    outputPath: "工作目录内的文章相对路径。省略时在原字幕旁生成 <文件名>.polished.md；已存在则自动编号。不要传空字符串。",
  });
  assert.deepEqual(download.parameters.required, ["source"]);
  assert.deepEqual(polish.parameters.required, ["transcriptPath"]);
  assert.equal(polish.parameters.properties.outputPath?.minLength, 1);
  assert.equal(download.promptSnippet, "下载哔哩哔哩现有中文字幕。");
  assert.equal(polish.promptSnippet, "将下载的中文字幕润色成文章。");
  assert.equal(download.promptGuidelines.length, 2);
  assert.equal(polish.promptGuidelines.length, 2);
  assert.match(download.promptGuidelines[0]!, /直接调用 bilibili_download_subtitle.*仅在用户要求润色或整理成文章时.*transcriptPath.*bilibili_polish_subtitle/);
  assert.match(download.promptGuidelines[1]!, /没有中文字幕时.*说明原因.*不自行改做媒体下载、语音识别或翻译/);
  assert.match(polish.promptGuidelines[0]!, /仅在用户要求润色、改写或整理成文章时调用/);
  assert.match(polish.promptGuidelines[1]!, /报告能力限制时.*说明原因.*不自行另起翻译流程/);
  for (const line of [download.promptGuidelines[1]!, polish.promptGuidelines[0]!]) {
    assert.match(line, /默认交付文件路径和简短结果.*不额外读取生成文件.*用户要求查看、检查或讨论内容时再读取/);
  }
});

test("自造多段原始字幕夹具可独立完成解析并检验章节起始时间", () => {
  const fixture = [
    "---",
    "schemaVersion: 1",
    "kind: bilibili-subtitle",
    "bvid: BV1fixture",
    "videoTitle: 本地测试字幕",
    "page: 1",
    "pageCount: 1",
    "pageTitle: 正片",
    "sourceUrl: https://www.bilibili.com/video/BV1fixture/?p=1",
    "language: zh-CN",
    "languageName: 中文",
    "trackKind: ai",
    "trackId: \"123\"",
    "---",
    "",
    "00:00 开场导语。",
    "00:35 第一章核心概念。",
    "01:42 第二章工程方案。",
    "02:50 赞助商口播。",
  ].join("\n");
  const transcript = parseTranscriptMarkdown(fixture);
  assert.equal(transcript.segments.length, 4);
  assert.equal(transcript.segments[1]?.startSeconds, 35);
  assert.equal(transcript.segments[2]?.startSeconds, 102);
  assert.equal(transcript.segments[3]?.startSeconds, 170);
});

function usage(input = 2, output = 3): Usage {
  return { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "openai",
    model: "session-model",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

test("工具结果包含路径且不包含全文，失败用量可以从 tool_result 补回", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-tool-"));
  const agent = path.join(cwd, "agent");
  await mkdir(agent, { recursive: true });
  await writeFile(path.join(agent, "bilibili-subtitles.json"), JSON.stringify({ cookie: { SESSDATA: "secret-session" } }));
  const tools = new Map<string, {
    description: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (...args: never[]) => Promise<{ content: Array<{ text: string }>; details: unknown; usage?: Usage }>;
  }>();
  const handlers: Array<(event: { toolName: string; toolCallId: string; isError: boolean; usage?: Usage }) => { usage?: Usage } | undefined> = [];
  const calls: Array<{ id: string; options: { reasoning?: string; toolChoice?: string }; messages: number }> = [];
  let mode: "ok" | "truncate" | "auth" = "ok";
  const sessionModel = {
    id: "session-model",
    name: "session",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8000,
    maxTokens: 1000,
  };
  const fetch = async (url: string) => {
    if (url.includes("/view?")) {
      if (mode === "auth") return new Response(JSON.stringify({ code: -101, message: "secret-session" }));
      return new Response(JSON.stringify({ code: 0, data: { bvid: "BV1tool", aid: 1, title: "工具视频", desc: "", pic: "", pubdate: 1, duration: 2, owner: { mid: 1, name: "甲" }, pages: [{ cid: 5, page: 1, part: "正片", duration: 2 }] } }));
    }
    if (url.includes("/wbi/v2")) {
      return new Response(JSON.stringify({ code: 0, data: { subtitle: { subtitles: [{ id: 3, lan: "zh-CN", lan_doc: "中文", author_mid: 9, subtitle_url: "https://i0.hdslb.com/a.json" }] } } }));
    }
    return new Response(JSON.stringify({ body: [{ from: 0, to: 1, content: "UNIQUE_SUBTITLE_SENTENCE" }] }));
  };
  register({
    registerTool(tool: {
      name: string;
      description: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute: (...args: never[]) => Promise<{ content: Array<{ text: string }>; details: unknown; usage?: Usage }>;
    }) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    on(_event: string, handler: (event: { toolName: string; toolCallId: string; isError: boolean; usage?: Usage }) => { usage?: Usage } | undefined) {
      handlers.push(handler);
    },
  } as unknown as ExtensionAPI, { agentDir: agent, fetch: fetch as typeof fetch, queue: passthroughQueue });
  const ctx = {
    cwd,
    model: sessionModel,
    thinkingLevel: "off",
    isProjectTrusted: () => false,
    modelRegistry: {
      find: () => {
        throw new Error("不应查找显式模型");
      },
      hasConfiguredAuth: () => true,
      streamSimple: (model: { id: string }, context: { messages: unknown[] }, options: { reasoning?: string; toolChoice?: string }) => {
        calls.push({ id: model.id, options, messages: context.messages.length });
        if (mode === "truncate") return { result: async () => assistant("", { stopReason: "length", usage: usage(9, 8) }) };
        const text = calls.length === 1
          ? JSON.stringify({ title: "文章", sections: [{ kind: "chapter", heading: "只有一节", level: 2, startSegmentId: 1 }] })
          : JSON.stringify({ sections: [{ id: "section-1", text: "UNIQUE_POLISHED_SENTENCE" }] });
        return { result: async () => assistant(text) };
      },
    },
  } as unknown as ExtensionContext;
  try {
    const download = tools.get("bilibili_download_subtitle");
    assert.ok(download);
    const downloadSchema = JSON.stringify(download.parameters);
    assert.equal(downloadSchema.includes("\"language\""), false);
    assert.equal(downloadSchema.includes("\"force\""), false);
    assert.equal(download.description.includes("恰好"), false);
    assert.equal(download.promptGuidelines?.every((line) => line.includes("bilibili_download_subtitle")), true);
    const downloaded = await download.execute("dl-1" as never, { source: "BV1tool" } as never, undefined as never, undefined as never, ctx as never);
    assert.match(downloaded.content[0]!.text, /transcriptPath: /);
    assert.equal(downloaded.content[0]!.text.includes("UNIQUE_SUBTITLE_SENTENCE"), false);
    assert.equal(downloaded.content[0]!.text.includes("secret-session"), false);
    assert.equal(downloaded.content[0]!.text.includes("cached"), false);
    const transcriptPath = downloaded.content[0]!.text.split("\n").find((line) => line.startsWith("transcriptPath: "))?.slice("transcriptPath: ".length);
    assert.ok(transcriptPath);
    const polish = tools.get("bilibili_polish_subtitle");
    assert.ok(polish);
    const polishSchema = JSON.stringify(polish.parameters);
    assert.equal(polishSchema.includes("\"overwrite\""), false);
    assert.equal(polishSchema.includes("\"force\""), false);
    const polishParameters = JSON.parse(polishSchema);
    assert.equal(polishParameters.properties.outputPath.minLength, 1);
    assert.equal(polish.description.includes("恰好"), false);
    assert.equal(polish.promptGuidelines?.every((line) => line.includes("bilibili_polish_subtitle")), true);
    const credentialFile = path.join(agent, "bilibili-subtitles.credentials.json");
    const savedCredentials = await readFile(credentialFile, "utf8");
    await writeFile(credentialFile, "{broken");
    const polished = await polish.execute("po-1" as never, { transcriptPath } as never, undefined as never, undefined as never, ctx as never);
    assert.equal(await readFile(credentialFile, "utf8"), "{broken");
    await writeFile(credentialFile, savedCredentials);
    assert.match(polished.content[0]!.text, /outputPath: /);
    assert.equal(polished.content[0]!.text.includes("UNIQUE_POLISHED_SENTENCE"), false);
    assert.equal(polished.content[0]!.text.includes("cached"), false);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.id, "session-model");
    assert.equal(calls[0]?.options.reasoning, undefined);
    assert.equal(calls[0]?.messages, 1);
    assert.equal(ctx.model, sessionModel);
    const outputPath = polished.content[0]!.text.split("\n").find((line) => line.startsWith("outputPath: "))?.slice("outputPath: ".length);
    assert.ok(outputPath);
    const article = await readFile(path.join(cwd, outputPath), "utf8");
    assert.match(article, /UNIQUE_POLISHED_SENTENCE/);
    const transcript = parseTranscriptMarkdown(await readFile(path.join(cwd, transcriptPath), "utf8"));
    assert.equal(transcript.segments[0]?.text, "UNIQUE_SUBTITLE_SENTENCE");

    mode = "truncate";
    await assert.rejects(
      () => polish.execute("po-cut" as never, { transcriptPath } as never, undefined as never, undefined as never, ctx as never),
      /OUTPUT_TRUNCATED/,
    );
    const patched = handlers[0]?.({ toolName: "bilibili_polish_subtitle", toolCallId: "po-cut", isError: true });
    assert.equal(patched?.usage?.input, 9);
    assert.ok(patched?.usage?.cost);
    mode = "auth";
    await assert.rejects(
      () => download.execute("dl-auth" as never, { source: "BV1tool" } as never, undefined as never, undefined as never, ctx as never),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /AUTH_REQUIRED/);
        assert.match(error.message, /\/bilibili-login/);
        assert.doesNotMatch(error.message, /secret-session/);
        return true;
      },
    );

    const failingModel = {
      ...ctx,
      model: undefined,
      modelRegistry: {
        find: () => undefined,
        hasConfiguredAuth: () => false,
        streamSimple: () => {
          throw new Error("不应请求模型");
        },
      },
    } as unknown as ExtensionContext;
    await writeFile(path.join(agent, "bilibili-subtitles.json"), JSON.stringify({ polish: { provider: "openai", model: "missing" } }));
    await assert.rejects(
      () => polish.execute("po-missing" as never, { transcriptPath } as never, undefined as never, undefined as never, failingModel as never),
      /MODEL_NOT_FOUND/,
    );
    await writeFile(path.join(agent, "bilibili-subtitles.json"), JSON.stringify({ polish: { provider: "openai" } }));
    await assert.rejects(
      () => polish.execute("po-bad-cfg" as never, { transcriptPath } as never, undefined as never, undefined as never, failingModel as never),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /INVALID_CONFIG/);
        assert.match(error.message, /bilibili-subtitles\.json/);
        const expectedDocument = fileURLToPath(new URL("../README.md", import.meta.url));
        assert.ok(error.message.includes(`用 read 读取 ${JSON.stringify(expectedDocument)}`));
        return true;
      },
    );
    await assert.doesNotReject(() => access(fileURLToPath(new URL("../README.md", import.meta.url))));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
