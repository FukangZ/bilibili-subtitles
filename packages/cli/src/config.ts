import { homedir } from "node:os";
import path from "node:path";
import { loadConfig, SubtitleError, updateConfigFile, type AppConfig, type ConfigFile, type ConfigSources } from "@fukangz/core-bilibili-subtitles";
import { configQueue } from "./credentials.js";

export type ModelApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export interface ModelConfig {
  api?: ModelApi | "chat-completions" | "responses";
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  contextWindow?: number;
  maxTokens?: number;
}
export type CliConfig = AppConfig<ModelConfig>;
export type ReadyModelConfig = Required<Pick<ModelConfig, "api" | "baseUrl" | "model" | "apiKey" | "contextWindow" | "maxTokens">> & ModelConfig & { api: ModelApi; timeoutMs: number };

export function configPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const directory = env.XDG_CONFIG_HOME?.trim();
  return path.join(directory && path.isAbsolute(directory) ? directory : path.join(home, ".config"), "bili-subs", "config.json");
}

export function loadCliConfig(file = configPath()): Promise<CliConfig> {
  return loadConfig({ userFile: file, projectTrusted: false, extend: ({ user }: ConfigSources) => readValidatedModelConfig(user?.polish) });
}

export function requireModelConfig(polish: ModelConfig & { timeoutMs: number }): ReadyModelConfig {
  const { api, baseUrl, model, apiKey, contextWindow, maxTokens } = polish;
  if (!api || !baseUrl || !model || !apiKey || !contextWindow || !maxTokens) throw new SubtitleError("INVALID_CONFIG", "缺少模型配置，请运行 bili-subs config");
  return { ...polish, api: normalizeApi(api), baseUrl, model, apiKey, contextWindow, maxTokens };
}

export async function showConfig(file = configPath()): Promise<object> {
  const config = await loadCliConfig(file);
  return { ...config,
    polish: { ...config.polish, apiKey: config.polish.apiKey ? "[redacted]" : undefined },
  };
}

export async function saveModelConfig(file: string, polish: ModelConfig & { timeoutMs: number }, signal?: AbortSignal): Promise<void> {
  const validated = readModelConfig(polish);
  if (polish.contextWindow !== undefined && !isPositiveInteger(polish.contextWindow)) invalid("contextWindow 必须为正整数");
  if (polish.maxTokens !== undefined && !isPositiveInteger(polish.maxTokens)) invalid("maxTokens 必须为正整数");
  if (polish.contextWindow !== undefined && polish.maxTokens !== undefined && polish.maxTokens > polish.contextWindow) invalid("maxTokens 不能大于 contextWindow");
  if (!Number.isInteger(polish.timeoutMs) || polish.timeoutMs <= 0) invalid("timeoutMs 必须为正整数");
  const update = (existing: ConfigFile): ConfigFile => {
    if (Object.prototype.hasOwnProperty.call(existing, "cookie")) {
      throw new SubtitleError("INVALID_CONFIG", "检测到旧版 B 站凭证，请先运行 bili-subs login 完成迁移后再更新配置");
    }
    requireModelConfig({ ...validated, timeoutMs: polish.timeoutMs });
    return { ...existing, polish: { ...validated, timeoutMs: polish.timeoutMs } };
  };
  await configQueue(file, () => updateConfigFile({
    file,
    label: "CLI",
    signal,
    update,
    messages: {
      invalidJson: "无法保存配置，原配置未更新",
      invalidObject: "配置必须是 JSON 对象",
      notFile: "配置必须是普通文件",
      readFailure: "无法保存配置，原配置未更新",
      saveFailure: "无法保存配置，原配置未更新",
    },
  }));
}

function readModelConfig(value: unknown): ModelConfig {
  if (value === undefined) return {};
  if (!isRecord(value)) invalid("polish 必须是对象");
  return parseModelConfig(value);
}

function readValidatedModelConfig(value: unknown): ModelConfig {
  if (value === undefined) return {};
  return parseModelConfig(value as ConfigFile);
}

function parseModelConfig(record: ConfigFile): ModelConfig {
  const config: ModelConfig = {};
  if (record.api !== undefined) {
    if (record.api !== "chat-completions" && record.api !== "responses" && record.api !== "openai-completions" && record.api !== "openai-responses" && record.api !== "anthropic-messages") invalid("api 只支持 openai-completions、openai-responses 或 anthropic-messages");
    config.api = normalizeApi(record.api);
  }
  for (const key of ["baseUrl", "model", "apiKey"] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "string" || !record[key].trim() || /[\r\n]/.test(record[key])) invalid(`${key} 必须是非空单行字符串`);
    config[key] = record[key].trim();
  }
  if (record.reasoningEffort !== undefined) {
    if (!["minimal", "low", "medium", "high", "xhigh", "max"].includes(String(record.reasoningEffort))) invalid("reasoningEffort 必须是 pi-ai 支持的思考等级");
    config.reasoningEffort = record.reasoningEffort as ModelConfig["reasoningEffort"];
  }
  for (const key of ["contextWindow", "maxTokens"] as const) {
    if (record[key] === undefined) continue;
    if (!isPositiveInteger(record[key])) invalid(`${key} 必须为正整数`);
    config[key] = record[key] as number;
  }
  if (config.contextWindow !== undefined && config.maxTokens !== undefined && config.maxTokens > config.contextWindow) invalid("maxTokens 不能大于 contextWindow");
  if (config.baseUrl) {
    let url: URL;
    try { url = new URL(config.baseUrl); } catch { return invalid("baseUrl 必须是有效 URL"); }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local)) || url.username || url.password || url.search || url.hash) invalid("baseUrl 必须为不含凭证、查询参数和片段的 HTTPS URL（本机允许 HTTP）");
    config.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }
  return config;
}
function normalizeApi(api: NonNullable<ModelConfig["api"]>): ModelApi {
  if (api === "chat-completions") return "openai-completions";
  if (api === "responses") return "openai-responses";
  return api;
}
function isPositiveInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function isRecord(value: unknown): value is ConfigFile { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalid(message: string): never { throw new SubtitleError("INVALID_CONFIG", message); }
