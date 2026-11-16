import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  defineTool,
  getAgentDir,
  withFileMutationQueue,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import {
  downloadSubtitle, isSubtitleError, loadPrompts, polishTranscript, redact, SubtitleError,
  type DownloadResult, type PolishResult, type FetchLike, type MutationQueue,
} from "@fukangz/core-bilibili-subtitles";
import { registerLoginCommand } from "./login-command.ts";
import { createStageClient, resolveSelection } from "./model.ts";
import { toPiUsage } from "./usage.ts";
import { credentialPath, migratePiCookie, readPiCredentials } from "./credentials.ts";

const documentationPath = fileURLToPath(new URL("../README.md", import.meta.url));
const prompts = loadPrompts();
const failureUsage = new Map<string, Usage>();

interface RuntimeDeps {
  agentDir?: string;
  fetch?: FetchLike;
  queue?: MutationQueue;
}

let runtime: RuntimeDeps = {};

const downloadTool = defineTool({
  name: "bilibili_download_subtitle",
  label: "下载哔哩哔哩字幕",
  description:
    "下载 B 站视频指定分 P 的现有中文字幕，保存为 Markdown，返回 transcriptPath。",
  promptSnippet: "下载哔哩哔哩现有中文字幕。",
  promptGuidelines: [
    "用户请求下载字幕时，直接调用 bilibili_download_subtitle；仅在用户要求润色或整理成文章时，将返回的 transcriptPath 传给 bilibili_polish_subtitle。",
    "bilibili_download_subtitle 没有中文字幕时，说明原因，不自行改做媒体下载、语音识别或翻译；默认交付文件路径和简短结果，不额外读取生成文件；用户要求查看、检查或讨论内容时再读取。",
  ],
  parameters: Type.Object({
    source: Type.String({ description: "BV 号或 bilibili.com/video/BV… 链接，不支持 b23.tv 短链。" }),
    page: Type.Optional(Type.Number({ description: "分 P 序号，从 1 开始。默认取链接中的 p，否则为 1；与链接中的 p 冲突时报错。" })),
    outputDir: Type.Optional(Type.String({ description: "工作目录内的相对输出目录，默认 .subtitles；使用 . 表示当前目录。" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    let configSecrets: string[] = [];
    try {
      const { config, cookie } = await loadRuntimeConfig(true);
      configSecrets = secretValues(cookie);
      const result = await downloadSubtitle({
        source: params.source,
        page: params.page,
        outputDir: params.outputDir,
        cwd: ctx.cwd,
        config,
        cookie,
        fetch: runtime.fetch ?? globalThis.fetch,
        signal,
        queue: runtime.queue ?? withFileMutationQueue,
        onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: { progress: message } }),
      });
      return { content: [{ type: "text", text: renderDownload(result) }], details: result };
    } catch (error) {
      throw expose(toolCallId, error, configSecrets);
    }
  },
});

const polishTool = defineTool({
  name: "bilibili_polish_subtitle",
  label: "润色哔哩哔哩字幕",
  description:
    "仅在用户要求润色或整理成文章时，将原始 B 站中文字幕忠实润色为带视频时间链接的 Markdown 文章，返回 outputPath。会产生模型用量。",
  promptSnippet: "将下载的中文字幕润色成文章。",
  promptGuidelines: [
    "bilibili_polish_subtitle 仅在用户要求润色、改写或整理成文章时调用；默认交付文件路径和简短结果，不额外读取生成文件；用户要求查看、检查或讨论内容时再读取。",
    "bilibili_polish_subtitle 报告能力限制时，说明原因，不自行另起翻译流程。",
  ],
  parameters: Type.Object({
    transcriptPath: Type.String({ description: "工作目录内的原始 B 站字幕 Markdown 相对路径。使用下载结果时，原样传入 transcriptPath，不要重建路径。" }),
    outputPath: Type.Optional(Type.String({ minLength: 1, description: "工作目录内的文章相对路径。省略时在原字幕旁生成 <文件名>.polished.md；已存在则自动编号。不要传空字符串。" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    let configSecrets: string[] = [];
    try {
      const { config } = await loadRuntimeConfig();
      const selection = resolveSelection({
        configuredProvider: config.polish.provider,
        configuredModel: config.polish.model,
        configuredThinking: config.polish.thinking,
        sessionModel: ctx.model ?? undefined,
        sessionThinking: ctx.thinkingLevel ?? "off",
        findModel: (provider, id) => ctx.modelRegistry.find(provider, id),
        hasConfiguredAuth: (model) => ctx.modelRegistry.hasConfiguredAuth(model),
      });
      const client = createStageClient({
        selection,
        timeoutMs: config.polish.timeoutMs,
        signal,
        streamSimple: (model, context, options) => ctx.modelRegistry.streamSimple(model, context, options),
      });
      const result = await polishTranscript({
        transcriptPath: params.transcriptPath,
        outputPath: params.outputPath,
        cwd: ctx.cwd,
        model: {
          label: `${selection.model.provider}/${selection.model.id}`,
          thinking: selection.effectiveThinking,
          warnings: selection.warnings,
        },
        client,
        prompts,
        signal,
        queue: runtime.queue ?? withFileMutationQueue,
        onProgress: (message) => onUpdate?.({ content: [{ type: "text", text: message }], details: { progress: message } }),
      });
      return {
        content: [{ type: "text", text: renderPolish(result) }],
        details: result,
        ...(result.usage ? { usage: toPiUsage(result.usage) } : {}),
      };
    } catch (error) {
      throw expose(toolCallId, error, configSecrets);
    }
  },
});

export function register(pi: ExtensionAPI, overrides: RuntimeDeps = {}): void {
  runtime = overrides;
  pi.registerTool(downloadTool);
  pi.registerTool(polishTool);
  pi.on("tool_result", (event) => {
    if (event.toolName !== polishTool.name && event.toolName !== downloadTool.name) return undefined;
    if (!event.isError || event.usage) return undefined;
    const usage = failureUsage.get(event.toolCallId);
    failureUsage.delete(event.toolCallId);
    return usage ? { usage } : undefined;
  });
  registerLoginCommand(pi, {
    agentDir: overrides.agentDir ?? getAgentDir(),
    fetch: overrides.fetch ?? globalThis.fetch,
    queue: overrides.queue ?? withFileMutationQueue,
  });
}

export default function (pi: ExtensionAPI): void {
  register(pi);
}

function rememberFailureUsage(toolCallId: string, usage: Usage | undefined): void {
  if (usage) failureUsage.set(toolCallId, usage);
}

async function loadRuntimeConfig(includeCookie = false) {
  const agentDir = runtime.agentDir ?? getAgentDir();
  const configFile = path.join(agentDir, "bilibili-subtitles.json");
  const config = await loadConfig({ agentDir });
  if (!includeCookie) return { config, cookie: undefined };
  const credentialFile = credentialPath(agentDir);
  await migratePiCookie(configFile, credentialFile, runtime.queue ?? withFileMutationQueue);
  return { config, cookie: await readPiCredentials(credentialFile) };
}

function expose(toolCallId: string, error: unknown, secrets: string[]): Error {
  const publicError = isSubtitleError(error)
    ? new SubtitleError(error.code, repairHint(error.code, redact(error.message.replace(/^[A-Z_]+:\s*/, ""), secrets)), error.details)
    : new SubtitleError("MODEL_ERROR", "内部错误");
  if (isSubtitleError(error) && error.usage) publicError.usage = error.usage;
  if (isSubtitleError(error) && error.usageStatus) publicError.usageStatus = error.usageStatus;
  rememberFailureUsage(toolCallId, publicError.usage ? toPiUsage(publicError.usage) : undefined);
  return publicError;
}

function secretValues(cookie: import("@fukangz/core-bilibili-subtitles").CookieConfig | undefined): string[] {
  return Object.values(cookie ?? {}).filter((value): value is string => Boolean(value && value.length >= 4));
}

function repairHint(code: string, message: string): string {
  if (code === "AUTH_REQUIRED" || code === "LOGIN_EXPIRED") {
    return `${message}，请在 Pi 交互式终端中运行 /bilibili-login`;
  }
  if (code === "INVALID_CONFIG") {
    return `${message}（用户配置位于 ~/.pi/agent/bilibili-subtitles.json）；配置说明：用 read 读取 ${JSON.stringify(documentationPath)}。`;
  }
  return message;
}

function renderDownload(result: DownloadResult): string {
  return [
    "已下载字幕。",
    `标题：${result.title}`,
    `分P：${result.page}/${result.pageCount}${result.pageTitle ? `（${result.pageTitle}）` : ""}`,
    `语言：${result.language}（${result.languageName}，${result.kind}）`,
    `字幕条数：${result.segmentCount}`,
    `transcriptPath: ${result.transcriptPath}`,
  ].join("\n");
}

function renderPolish(result: PolishResult): string {
  const lines = [
    "已生成润色文章。",
    `outputPath: ${result.outputPath}`,
    `transcriptPath: ${result.transcriptPath}`,
    `章节数：${result.sectionCount}`,
    `输入条数：${result.inputCount}`,
    `模型：${result.model}`,
    `thinking：${result.thinking}`,
  ];
  if (result.usage) lines.push(`用量：${JSON.stringify(result.usage)}（${result.usageStatus === "complete" ? "完整" : result.usageStatus === "partial" ? "部分" : "未知"}）`);
  else lines.push("用量：未知（未收到报告）");
  if (result.warnings.length > 0) lines.push(`警告：${result.warnings.join(" ")}`);
  return lines.join("\n");
}
