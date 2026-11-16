import { parseArgs } from "node:util";
import {
  downloadSubtitle, encodeQrLines, isSubtitleError, loadPrompts, loginWithQr, polishTranscript, redact, SubtitleError,
  type FetchLike,
} from "@fukangz/core-bilibili-subtitles";
import { createStageClient } from "./client.js";
import { configPath, loadCliConfig, requireModelConfig, saveModelConfig, showConfig, type CliConfig, type ModelConfig } from "./config.js";
import { question, requireTerminal, type TerminalInput, type TerminalOutput } from "./terminal.js";
import { configQueue, credentialsFile, migrateLegacyCookie, readCredentials, writeCredentials } from "./credentials.js";

export interface CliRuntime {
  cwd: string;
  configFile: string;
  stdin: TerminalInput;
  stdout: TerminalOutput;
  stderr: TerminalOutput;
  fetch: FetchLike;
  signal?: AbortSignal;
}
const HELP = `bili-subs - 下载已有 B 站中文字幕并按需润色\n\n用法：\n  bili-subs config\n  bili-subs config show\n  bili-subs config test\n  bili-subs login\n  bili-subs download <BV或链接> [--page N] [--out DIR]\n  bili-subs polish <原始字幕.md> [--out FILE]\n\nCLI 只读用户级配置；配置与 Cookie 不与 Pi 共用。\nconfig test 和 polish 会产生模型用量及可能的费用。\n`;

type CliValues = { page?: string; out?: string };

export async function runCli(argv: string[], overrides: Partial<CliRuntime> = {}): Promise<number> {
  const runtime: CliRuntime = { cwd: process.cwd(), configFile: configPath(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, fetch: globalThis.fetch, ...overrides };
  let secrets: string[] = [];
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { page: { type: "string" }, out: { type: "string" }, help: { type: "boolean", short: "h" } },
    });
    if (values.help || positionals.length === 0) { runtime.stdout.write(HELP); return 0; }
    const [command, target, ...extra] = positionals;
    if (extra.length) invalid("参数过多");
    const credentialFile = credentialsFile(runtime.configFile);
    const config = await loadCliConfig(runtime.configFile);
    let cookie: import("@fukangz/core-bilibili-subtitles").CookieConfig | undefined;
    if (command === "download" || command === "login") {
      await migrateLegacyCookie(runtime.configFile, credentialFile, runtime.signal);
    }
    if (command === "download") cookie = await readCredentials(credentialFile);
    secrets = [config.polish.apiKey, ...Object.values(cookie ?? {})].filter((value): value is string => Boolean(value));
    const result = await dispatchCommand(command, target, values, config, runtime, credentialFile, cookie);
    if ("warnings" in result && Array.isArray(result.warnings)) {
      for (const warning of result.warnings) runtime.stderr.write(`警告：${redact(String(warning), secrets)}\n`);
    }
    runtime.stdout.write(`${renderResult(result)}\n`);
    return 0;
  } catch (error) {
    const parseArgsError = isParseArgsError(error);
    const failure = isSubtitleError(error) ? error : new SubtitleError(
      parseArgsError ? "INVALID_INPUT" : "MODEL_ERROR",
      parseArgsError ? "命令参数无效，请运行 bili-subs --help" : "操作失败",
    );
    const usageNote = failure.usage
      ? `（截至失败已报告用量：${JSON.stringify(failure.usage)}；${failure.usageStatus === "partial" ? "部分" : "完整"}）`
      : "（未收到用量报告，不能据此判断是否计费）";
    const safeMessage = `${redact(repairHint(failure), secrets)}${failure.usageStatus || failure.usage ? usageNote : ""}`.replace(/\x1b/g, "");
    runtime.stderr.write(`${safeMessage}\n`);
    return ["INVALID_INPUT", "INVALID_CONFIG", "AUTH_REQUIRED", "LOGIN_EXPIRED", "MODEL_AUTH_REQUIRED", "MODEL_NOT_FOUND", "MODEL_REQUEST_REJECTED", "POLISH_LANGUAGE_UNSUPPORTED"].includes(failure.code) ? 2 : 1;
  }
}
async function dispatchCommand(command: string, target: string | undefined, values: CliValues, config: CliConfig, runtime: CliRuntime, credentialFile: string, cookie: import("@fukangz/core-bilibili-subtitles").CookieConfig | undefined): Promise<object> {
  switch (command) {
    case "config": return runConfig(target, values, config, runtime);
    case "login": return runLogin(target, values, runtime, credentialFile);
    case "download": return runDownload(target, values, config, runtime, cookie);
    case "polish": return runPolish(target, values, config, runtime);
    default: return invalid(`未知命令：${command}`);
  }
}

async function runConfig(target: string | undefined, values: CliValues, config: CliConfig, runtime: CliRuntime): Promise<object> {
  if (values.page || values.out) invalid("config 不接受 --page 或 --out");
  if (target === "show") return { configFile: runtime.configFile, config: await showConfig(runtime.configFile) };
  if (target === "test") {
    const model = requireModelConfig(config.polish);
    runtime.stderr.write("正在测试模型连接，将产生少量模型用量及可能的费用\n");
    const client = createStageClient({ config: model, fetch: runtime.fetch, connectionTest: true });
    const response = await client.complete({ system: "Reply with OK only.", user: "Connection test." }, runtime.signal);
    return { model: model.model, api: model.api, message: "模型连接测试成功", usage: response.usage };
  }
  if (target) invalid("未知 config 子命令");
  requireTerminal(runtime);
  const ask = (label: string, hidden = false) => question(runtime, label, { hidden, signal: runtime.signal });
  const api = await ask(`协议 [${config.polish.api ?? "openai-completions"}]：`) || config.polish.api || "openai-completions";
  if (api !== "chat-completions" && api !== "responses" && api !== "openai-completions" && api !== "openai-responses" && api !== "anthropic-messages") invalid("协议必须为 openai-completions、openai-responses 或 anthropic-messages");
  const defaultBaseUrl = api === "anthropic-messages" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  const baseUrl = await ask(`baseUrl [${config.polish.baseUrl ?? defaultBaseUrl}]：`) || config.polish.baseUrl || defaultBaseUrl;
  const model = await ask(`模型 [${config.polish.model ?? "未配置"}]：`) || config.polish.model;
  const apiKey = await ask(`API key${config.polish.apiKey ? "（留空保留）" : ""}：`, true) || config.polish.apiKey;
  const contextWindowText = await ask(`contextWindow [${config.polish.contextWindow ?? "必填"}]：`);
  const contextWindow = contextWindowText ? positiveInteger(contextWindowText, "contextWindow") : config.polish.contextWindow;
  const maxTokensText = await ask(`maxTokens [${config.polish.maxTokens ?? "必填"}]：`);
  const maxTokens = maxTokensText ? positiveInteger(maxTokensText, "maxTokens") : config.polish.maxTokens;
  const reasoningEffortText = await ask("思考强度（minimal/low/medium/high/xhigh/max，可留空）：") || undefined;
  if (reasoningEffortText && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffortText)) invalid("思考强度必须是 pi-ai 支持的等级");
  const reasoningEffort = reasoningEffortText as ModelConfig["reasoningEffort"];
  const timeoutText = await ask(`超时毫秒 [${config.polish.timeoutMs}]：`);
  await saveModelConfig(runtime.configFile, { api, baseUrl, model, apiKey, contextWindow, maxTokens, reasoningEffort,
    timeoutMs: timeoutText ? positiveInteger(timeoutText, "timeoutMs") : config.polish.timeoutMs,
  }, runtime.signal);
  return { configFile: runtime.configFile, message: "已保存模型配置" };
}

async function runLogin(target: string | undefined, values: CliValues, runtime: CliRuntime, credentialFile: string): Promise<object> {
  if (target || values.out || values.page) invalid("login 不接受位置参数或输出选项");
  requireTerminal(runtime);
  const signal = runtime.signal ?? new AbortController().signal;
  let qrUrl: string | undefined;
  const cookie = await loginWithQr({ fetch: runtime.fetch, signal,
    onProgress(progress) {
      if (progress.state === "generating") { runtime.stderr.write("正在获取二维码\n"); return; }
      if (progress.state === "scanned") { runtime.stderr.write("已扫码，请在手机上确认\n"); return; }
      if (progress.url === qrUrl) return;
      qrUrl = progress.url;
      const { lines, width } = encodeQrLines(progress.url);
      if (runtime.stderr.columns && runtime.stderr.columns < width) throw new SubtitleError("INVALID_INPUT", `终端至少需要 ${width} 列，请放大窗口后重试`);
      runtime.stderr.write(`请用哔哩哔哩手机客户端扫码（Ctrl+C 取消）：\n${lines.join("\n")}\n`);
    },
  });
  await configQueue(runtime.configFile, () => writeCredentials(credentialFile, cookie, signal));
  return { configFile: credentialFile, message: "已保存 B 站登录状态" };
}

async function runDownload(target: string | undefined, values: CliValues, config: CliConfig, runtime: CliRuntime, cookie: import("@fukangz/core-bilibili-subtitles").CookieConfig | undefined): Promise<object> {
  if (!target) invalid("缺少 BV 号或视频链接");
  return downloadSubtitle({ source: target, page: values.page ? positiveInteger(values.page, "page") : undefined,
    outputDir: values.out, cwd: runtime.cwd, config, cookie, fetch: runtime.fetch, signal: runtime.signal,
    onProgress: (message) => runtime.stderr.write(`${message}\n`),
  });
}

async function runPolish(target: string | undefined, values: CliValues, config: CliConfig, runtime: CliRuntime): Promise<object> {
  if (!target) invalid("缺少原始字幕 Markdown 路径");
  if (values.page) invalid("polish 不接受 --page");
  const model = requireModelConfig(config.polish);
  return polishTranscript({ transcriptPath: target, outputPath: values.out, cwd: runtime.cwd,
    model: { label: model.model, thinking: model.reasoningEffort, warnings: [] },
    client: createStageClient({ config: model, fetch: runtime.fetch }), prompts: loadPrompts(), signal: runtime.signal,
    onProgress: (message) => runtime.stderr.write(`${message}\n`),
  });
}

function isParseArgsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS");
}

function renderResult(result: object): string {
  return Object.entries(result).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join("\n");
}
function repairHint(error: SubtitleError): string {
  if (["AUTH_REQUIRED", "LOGIN_EXPIRED"].includes(error.code)) return `${error.message}；请运行 bili-subs login`;
  if (["MODEL_AUTH_REQUIRED", "MODEL_NOT_FOUND"].includes(error.code)) return `${error.message}；请运行 bili-subs config`;
  return error.message;
}
function positiveInteger(text: string, label: string): number {
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) invalid(`${label} 必须为正整数`);
  return Number(text);
}
function invalid(message: string): never { throw new SubtitleError("INVALID_INPUT", message); }
