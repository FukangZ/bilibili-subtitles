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
const documentationHint = `仅当需要查看或修改插件配置项时，用 read 读取 ${JSON.stringify(documentationPath)}；正常调用与排错无需读取。`;
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
    `下载一个分P的一条现有中文字幕为 Markdown，返回 transcriptPath。不支持弹幕或音视频下载。${documentationHint}`,
  promptSnippet: "下载哔哩哔哩现有中文字幕。",
  promptGuidelines: [
    "用户请求下载字幕时，直接调用 bilibili_download_subtitle；仅在用户要求润色或整理成文章时，将返回的 transcriptPath 传给 bilibili_polish_subtitle。",
    "bilibili_download_subtitle 没有中文字幕时报告原因，不自行改做媒体下载、语音识别或翻译；默认交付路径和简短结果，不主动读取全文。",
  ],
  parameters: Type.Object({
    source: Type.String({ description: "BV 号，或 https://www.bilibili.com/video/BV... 链接。不支持 b23.tv 短链。" }),
    page: Type.Optional(Type.Number({ description: "分P序号，从 1 开始。与链接里的 p 冲突则报错。缺省时使用链接中的 p，否则为第 1 分P。" })),
    outputDir: Type.Optional(Type.String({ description: "相对当前工作目录且不能超出该目录的输出目录。`.` 表示当前目录。默认使用 .subtitles。" })),
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
    `将下载的中文字幕忠实润色成带视频时间链接的 Markdown 文章，返回 outputPath；不做摘要或外语翻译。会调用模型并产生用量。${documentationHint}`,
  promptSnippet: "将下载的中文字幕润色成文章。",
  promptGuidelines: [
    "bilibili_polish_subtitle 仅在用户要求润色、改写或整理成文章时调用；默认交付路径和简短结果，除非用户要求讨论内容，否则不读取全文。",
    "bilibili_polish_subtitle 报告能力限制时，说明原因，不自行另起翻译流程。",
  ],
  parameters: Type.Object({
    transcriptPath: Type.String({ description: "bilibili_download_subtitle 返回的原始字幕 Markdown 路径，相对当前工作目录且不能超出该目录；不是 BV、视频链接或润色文章。" }),
    outputPath: Type.Optional(Type.String({ description: "最终文章的相对文件路径，不能超出当前工作目录；当前目录示例：./文章.md。缺省时写到原始字幕旁边的 <文件名>.polished.md。已存在时自动编号，不覆盖。" })),
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
    return `${message}（用户配置位于 ~/.pi/agent/bilibili-subtitles.json）`;
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
