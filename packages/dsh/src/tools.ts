import {
  downloadSubtitle,
  isSubtitleError,
  loadPrompts,
  polishTranscript,
  redact,
  SubtitleError,
  type DownloadResult,
  type FetchLike,
  type PolishResult,
  type Usage,
} from "@fukangz/core-bilibili-subtitles";
import { toAppConfig, type ConfigSnapshot } from "./config.js";
import { readCookie, secretValues } from "./credentials.js";
import { createDshFileStore } from "./fs.js";
import type { DshContext, JsonSchemaNode, SandboxPolicyService, ToolDefinition, ToolRunContext } from "./host.js";
import { createStageClient, projectPolishError, resolveModel } from "./model.js";

export const DOWNLOAD_TOOL = "bilibili_download_subtitle";
export const POLISH_TOOL = "bilibili_polish_subtitle";

const LOGIN_HINT = "请在 dsh 插件设置页打开本插件，点击“扫码登录”";
const CONFIG_HINT = "请在 dsh 插件设置页检查本插件配置";

export interface ToolDeps {
  ctx: DshContext;
  config: () => ConfigSnapshot | undefined;
  fetch?: FetchLike;
}

const downloadParameters: JsonSchemaNode = {
  type: "object",
  properties: {
    source: { type: "string", description: "BV 号，或 https://www.bilibili.com/video/BV... 链接。不支持 b23.tv 短链。" },
    page: { type: "integer", description: "分P序号，从 1 开始。与链接里的 p 冲突则报错。缺省时使用链接中的 p，否则为第 1 分P。" },
    outputDir: {
      type: "string",
      description: "相对当前工作目录且不能超出该目录的输出目录。`.` 表示当前目录。默认使用 .subtitles。",
    },
  },
  required: ["source"],
  additionalProperties: false,
};

const polishParameters: JsonSchemaNode = {
  type: "object",
  properties: {
    transcriptPath: {
      type: "string",
      description: "原样传入 bilibili_download_subtitle 返回的 transcriptPath，保留空格、中文和标点，不要凭标题重建路径。仅接受原始字幕 Markdown，相对当前工作目录且不能超出该目录；不是 BV、视频链接、润色文章或旧 JSON。",
    },
    outputPath: {
      type: "string",
      description: "最终文章的相对文件路径，不能超出当前工作目录；当前目录示例：./文章.md。缺省时写到原始字幕旁边的 <文件名>.polished.md。已存在时自动编号，不覆盖。",
    },
  },
  required: ["transcriptPath"],
  additionalProperties: false,
};

const usageSchema: JsonSchemaNode = {
  type: "object",
  properties: {
    input: { type: "number" },
    output: { type: "number" },
    cacheRead: { type: "number" },
    cacheWrite: { type: "number" },
    reasoning: { type: "number" },
    totalTokens: { type: "number" },
  },
};

const downloadOutput: JsonSchemaNode = {
  type: "object",
  properties: {
    bvid: { type: "string" },
    title: { type: "string" },
    page: { type: "integer" },
    pageCount: { type: "integer" },
    pageTitle: { type: "string" },
    language: { type: "string" },
    languageName: { type: "string" },
    kind: { type: "string" },
    segmentCount: { type: "integer" },
    transcriptPath: { type: "string" },
  },
};

const polishOutput: JsonSchemaNode = {
  type: "object",
  properties: {
    outputPath: { type: "string" },
    transcriptPath: { type: "string" },
    sectionCount: { type: "integer" },
    inputCount: { type: "integer" },
    model: { type: "string" },
    thinking: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
    usage: usageSchema,
  },
};
export function createTools(deps: ToolDeps): ToolDefinition[] {
  return [
    {
      name: DOWNLOAD_TOOL,
      description: "下载一个分P的一条现有中文字幕为 Markdown，返回 transcriptPath。不支持弹幕或音视频下载。无中文字幕时报告原因，不改做媒体下载、语音识别或翻译。仅在用户要求润色或整理成文章时调用 bilibili_polish_subtitle。默认交付路径和简短统计，不主动读取全文，也不自行编辑产物；用户明确要求检查或讨论内容时可以读取相关内容，编辑仍须符合用户请求。登录与配置均在 dsh 插件设置页完成。",
      parameters: downloadParameters,
      output: { schema: downloadOutput, render: (_args, value) => [{ type: "text", text: renderDownload(value as DownloadResult) }] },
      async execute(args, exec) {
        const input = parseDownloadArgs(args);
        let secrets: string[] = [];
        try {
          const cookie = await readCookie(deps.ctx.credentials);
          secrets = secretValues(cookie);
          const config = toAppConfig(deps.config());
          const { cwd, files } = await workspace(deps.ctx, exec);
          return await downloadSubtitle({
            ...input,
            cwd,
            config,
            cookie,
            fetch: deps.fetch ?? globalThis.fetch,
            signal: exec.signal,
            files,
          });
        } catch (error) {
          throw expose(error, secrets);
        }
      },
    },
    {
      name: POLISH_TOOL,
      description: "仅在用户要求润色或整理成文章时，将原始字幕 Markdown 忠实润色成带视频时间链接的文章，返回 outputPath；不接受润色文章或旧 JSON，不做摘要或外语翻译。会调用模型并产生用量。默认交付路径和简短统计，不主动读取全文，也不自行编辑产物；用户明确要求检查或讨论内容时可以读取相关内容，编辑仍须符合用户请求。失败时报告分类和阶段，不因未知错误自行重复整条润色流程。登录与配置均在 dsh 插件设置页完成。",
      parameters: polishParameters,
      output: { schema: polishOutput, render: (_args, value) => [{ type: "text", text: renderPolish(value as PolishResult) }] },
      async execute(args, exec) {
        const input = parsePolishArgs(args);
        try {
          const config = toAppConfig(deps.config());
          const { selection, info } = resolveModel(config.polish, exec);
          const { cwd, files } = await workspace(deps.ctx, exec);
          const client = createStageClient({ llm: deps.ctx.llm, selection, exec, timeoutMs: config.polish.timeoutMs });
          return await polishTranscript({
            ...input,
            cwd,
            model: info,
            client,
            prompts: loadPrompts(),
            signal: exec.signal,
            files,
          });
        } catch (error) {
          throw exposePolish(error);
        }
      },
    },
  ];
}

async function workspace(ctx: DshContext, exec: ToolRunContext) {
  const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
  const policyService = ctx.fs.sandboxMode === undefined ? undefined : (ctx.get("sandboxPolicy") as SandboxPolicyService | undefined);
  const policy = policyService?.resolve(exec.agent ? { session: exec.agent.session } : {});
  return { cwd, files: createDshFileStore(ctx.fs, policy) };
}

function parseDownloadArgs(args: unknown): { source: string; page?: number; outputDir?: string } {
  const record = asRecord(args);
  rejectUnknown(record, ["source", "page", "outputDir"]);
  const source = record.source;
  if (typeof source !== "string" || !source.trim()) invalid("source 必须是非空字符串");
  const result: { source: string; page?: number; outputDir?: string } = { source };
  if (record.page !== undefined) {
    if (typeof record.page !== "number" || !Number.isInteger(record.page) || record.page < 1) invalid("page 必须是不小于 1 的整数");
    result.page = record.page;
  }
  if (record.outputDir !== undefined) {
    if (typeof record.outputDir !== "string" || !record.outputDir) invalid("outputDir 必须是非空字符串");
    result.outputDir = record.outputDir;
  }
  return result;
}

function parsePolishArgs(args: unknown): { transcriptPath: string; outputPath?: string } {
  const record = asRecord(args);
  rejectUnknown(record, ["transcriptPath", "outputPath"]);
  const transcriptPath = record.transcriptPath;
  if (typeof transcriptPath !== "string" || !transcriptPath) invalid("transcriptPath 必须是非空字符串");
  const result: { transcriptPath: string; outputPath?: string } = { transcriptPath };
  if (record.outputPath !== undefined) {
    if (typeof record.outputPath !== "string" || !record.outputPath) invalid("outputPath 必须是非空字符串");
    result.outputPath = record.outputPath;
  }
  return result;
}

function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== "object" || args === null || Array.isArray(args)) invalid("参数必须是对象");
  return args as Record<string, unknown>;
}

function rejectUnknown(record: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) invalid(`不支持的参数：${extra.join("、")}`);
}

function invalid(message: string): never {
  throw new Error(`INVALID_INPUT: ${message}`);
}

function exposePolish(error: unknown): Error {
  if (!isSubtitleError(error)) return expose(error, []);
  const projected = projectPolishError(error);
  let message = projected.message.replace(/^[A-Z_]+:\s*/, "");
  if (projected.code === "INVALID_CONFIG") message += `，${CONFIG_HINT}`;
  if (projected.usage) message += `（截至失败已报告用量：${formatUsage(projected.usage)}；${projected.usageStatus === "partial" ? "部分" : "完整"}）`;
  else if (["MODEL_ERROR", "MODEL_AUTH_REQUIRED", "RATE_LIMITED", "INPUT_TOO_LARGE", "MODEL_REQUEST_REJECTED", "OUTPUT_TRUNCATED", "INVALID_MODEL_OUTPUT", "CANCELLED"].includes(projected.code)) {
    message += "（未收到用量报告，不能据此判断是否计费）";
  }
  const publicError = new SubtitleError(projected.code, message, projected.details);
  if (projected.usage) publicError.usage = projected.usage;
  if (projected.usageStatus) publicError.usageStatus = projected.usageStatus;
  return publicError;
}

/** 转成宿主可展示的错误：消息以错误码开头，脱敏，附带登录提示与已产生的用量。 */
export function expose(error: unknown, secrets: string[]): Error {
  if (!isSubtitleError(error)) {
    if (error instanceof Error && error.message.startsWith("INVALID_INPUT: ")) return error;
    return new Error("MODEL_ERROR: 内部错误");
  }
  let message = redact(error.message.replace(/^[A-Z_]+:\s*/, ""), secrets);
  if (error.code === "AUTH_REQUIRED" || error.code === "LOGIN_EXPIRED") message += `，${LOGIN_HINT}`;
  if (error.code === "INVALID_CONFIG") message += `，${CONFIG_HINT}`;
  if (error.usage) message += `（已产生用量：${formatUsage(error.usage)}）`;
  const publicError = new SubtitleError(error.code, message, error.details);
  if (error.usage) publicError.usage = error.usage;
  if (error.usageStatus) publicError.usageStatus = error.usageStatus;
  return publicError;
}

export function formatUsage(usage: Usage): string {
  const parts = [`输入 ${usage.input}`, `输出 ${usage.output}`, `缓存读 ${usage.cacheRead}`];
  if (usage.cacheWrite) parts.push(`缓存写 ${usage.cacheWrite}`);
  if (usage.reasoning !== undefined) parts.push(`推理 ${usage.reasoning}`);
  parts.push(`合计 ${usage.totalTokens}`);
  return parts.join("，");
}

export function renderDownload(result: DownloadResult): string {
  return [
    "已下载字幕。",
    `标题：${result.title}`,
    `分P：${result.page}/${result.pageCount}${result.pageTitle ? `（${result.pageTitle}）` : ""}`,
    `语言：${result.language}（${result.languageName}，${result.kind}）`,
    `字幕条数：${result.segmentCount}`,
    `transcriptPath: ${result.transcriptPath}`,
  ].join("\n");
}

export function renderPolish(result: PolishResult): string {
  const lines = [
    "已生成润色文章。",
    `outputPath: ${result.outputPath}`,
    `transcriptPath: ${result.transcriptPath}`,
    `章节数：${result.sectionCount}`,
    `输入条数：${result.inputCount}`,
    `模型：${result.model}`,
  ];
  if (result.thinking) lines.push(`思考强度：${result.thinking}`);
  lines.push(`用量：${result.usage ? formatUsage(result.usage) : "未知"}（${result.usageStatus === "complete" ? "完整" : result.usageStatus === "partial" ? "部分" : "未报告"}）`);
  if (result.warnings.length > 0) lines.push(`警告：${result.warnings.join(" ")}`);
  return lines.join("\n");
}
