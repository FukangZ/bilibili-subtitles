import Schema from "@deepseek-ai/schemastery";
import { SubtitleError, type AppConfig } from "@fukangz/core-bilibili-subtitles";

export const DEFAULT_TIMEOUT_MS = 300_000;

export const Config = Schema.object({
  provider: Schema.string().description("润色模型提供商；留空则跟随会话模型"),
  model: Schema.string().description("润色模型 id；与 provider 同时填写"),
  reasoningEffort: Schema.string().description("润色思考强度；留空使用模型默认"),
  timeoutMs: Schema.natural().min(1000).default(DEFAULT_TIMEOUT_MS).description("每阶段模型请求超时（毫秒）"),
}).default({}).volatile();

export interface DshPolishConfig {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface ConfigSnapshot {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  timeoutMs?: number;
}

/** 把宿主设置快照转换为 core AppConfig。 */
export function toAppConfig(snapshot: ConfigSnapshot | undefined): AppConfig<DshPolishConfig> {
  const provider = clean(snapshot?.provider);
  const model = clean(snapshot?.model);
  if (Boolean(provider) !== Boolean(model)) {
    throw new SubtitleError("INVALID_CONFIG", "provider 和 model 必须同时填写");
  }
  const timeoutMs = snapshot?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new SubtitleError("INVALID_CONFIG", "timeoutMs 必须是不小于 1000 的整数");
  }
  return {
    polish: { timeoutMs, provider, model, reasoningEffort: clean(snapshot?.reasoningEffort) },
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
