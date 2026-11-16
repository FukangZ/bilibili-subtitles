import path from "node:path";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { loadConfig as loadCoreConfig, SubtitleError, type AppConfig } from "@fukangz/core-bilibili-subtitles";

interface PiPolishConfig {
  provider?: string;
  model?: string;
  thinking?: ModelThinkingLevel;
}

const THINKING_LEVELS = new Set<ModelThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export async function loadConfig(options: { agentDir: string }): Promise<AppConfig<PiPolishConfig>> {
  return loadCoreConfig({
    userFile: path.join(options.agentDir, "bilibili-subtitles.json"),
    projectTrusted: false,
    extend: readPiConfig,
  });
}

function readPiConfig({ user }: { user?: Record<string, unknown> }): PiPolishConfig {
  const userPolish = readPolish(user?.polish, "用户级配置");
  return {
    provider: userPolish?.provider,
    model: userPolish?.model,
    thinking: userPolish?.thinking,
  };
}

function readPolish(value: unknown, label: string): PiPolishConfig | undefined {
  if (value === undefined) return undefined;
  const record = value as Record<string, unknown>;
  const provider = optionalString(record.provider, `${label}的 polish.provider`);
  const model = optionalString(record.model, `${label}的 polish.model`);
  if (Boolean(provider) !== Boolean(model)) {
    throw new SubtitleError("INVALID_CONFIG", `${label}的 provider 和 model 必须同时填写`);
  }
  const thinking = record.thinking;
  if (thinking !== undefined && (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking as ModelThinkingLevel))) {
    throw new SubtitleError("INVALID_CONFIG", `${label}的 thinking 无效`);
  }
  return { provider, model, thinking: thinking as ModelThinkingLevel | undefined };
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new SubtitleError("INVALID_CONFIG", `${label} 必须是非空字符串`);
  }
  return value.trim();
}
