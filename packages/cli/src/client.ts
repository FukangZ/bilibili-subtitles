import { readFileSync } from "node:fs";
import { type Api, type AssistantMessage, type Model, type ThinkingLevel } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamOpenAIChat } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { isSubtitleError, SubtitleError, type FetchLike, type StageClient, type StageRequest, type StageResult, type Usage as CoreUsage } from "@fukangz/core-bilibili-subtitles";
import type { ReadyModelConfig } from "./config.js";

const version: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const AUTH_ERROR_PATTERN = /unauthorized|unauthenticated|invalid api key|not logged in|authentication|api key/i;

export function createStageClient(options: { config: ReadyModelConfig; fetch?: FetchLike; connectionTest?: boolean }): StageClient {
  const { config } = options;
  const model = createModel(config);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const fetch: typeof globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return fetchImpl(url, { ...init, redirect: "error" });
  };

  return {
    async complete(request: StageRequest, signal?: AbortSignal): Promise<StageResult> {
      if (signal?.aborted) throw new SubtitleError("CANCELLED", "任务已取消");
      try {
        const context = normalizeContext({
          systemPrompt: request.system,
          messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
        });
        const streamOptions = {
          apiKey: config.apiKey,
          fetch,
          signal,
          timeoutMs: config.timeoutMs,
          maxRetries: 0 as const,
          maxTokens: options.connectionTest ? Math.min(config.maxTokens, 256) : config.maxTokens,
          toolChoice: "none" as const,
          identity: { userAgent: { custom: `bili-subs/${version}` } },
          ...(config.reasoningEffort ? { reasoning: config.reasoningEffort as ThinkingLevel } : {}),
        };
        const stream = config.api === "openai-completions"
          ? streamOpenAIChat(model as Model<"openai-completions">, context, streamOptions)
          : config.api === "openai-responses"
            ? streamOpenAIResponses(model as Model<"openai-responses">, context, streamOptions)
            : streamAnthropic(model as Model<"anthropic-messages">, context, streamOptions);
        return readAssistantText(await stream.result(), config.contextWindow);
      } catch (error) {
        if (isSubtitleError(error)) throw error;
        throw mapStreamError(error, signal);
      }
    },
  };
}

function createModel(config: ReadyModelConfig): Model<Api> {
  return {
    id: config.model,
    name: config.model,
    api: config.api,
    provider: "bili-subs",
    baseUrl: config.baseUrl,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: Boolean(config.reasoningEffort),
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  } as Model<Api>;
}

function readAssistantText(message: AssistantMessage, contextWindow: number): StageResult {
  const usage = toCoreUsage(message);
  if (message.stopReason === "aborted") fail("CANCELLED", "任务已取消", usage);
  if (message.stopReason === "length") fail("OUTPUT_TRUNCATED", "模型输出被截断，未保存为完整文章", usage);
  if (message.stopReason === "error") {
    if (isContextOverflow(message, contextWindow)) fail("INPUT_TOO_LARGE", "字幕超出模型上下文，未保存为完整文章", usage);
    const detail = message.errorMessage ?? "模型请求失败";
    if (AUTH_ERROR_PATTERN.test(detail)) fail("MODEL_AUTH_REQUIRED", "模型认证失败", usage);
    if (/rate limit|too many requests|429/i.test(detail)) fail("RATE_LIMITED", "模型请求被限流", usage);
    fail("MODEL_ERROR", "模型请求失败", usage);
  }
  if (message.stopReason !== "stop") fail("INVALID_MODEL_OUTPUT", "模型没有正常结束", usage);
  if (message.content.some((block) => block.type === "toolCall")) fail("INVALID_MODEL_OUTPUT", "模型返回了工具调用，未保存为完整文章", usage);
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) fail("INVALID_MODEL_OUTPUT", "模型没有返回文本", usage);
  return { text, usage };
}

function toCoreUsage(message: AssistantMessage): CoreUsage {
  const usage = message.usage;
  const { cost } = usage;
  const hasKnownCost = cost.total !== 0 || cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    ...(hasKnownCost ? { cost: { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite, total: cost.total } } : {}),
  };
}

function mapStreamError(error: unknown, signal?: AbortSignal): SubtitleError {
  if (signal?.aborted) return new SubtitleError("CANCELLED", "任务已取消");
  const message = error instanceof Error ? error.message : "模型请求失败";
  if (AUTH_ERROR_PATTERN.test(message)) return new SubtitleError("MODEL_AUTH_REQUIRED", "模型认证失败");
  if (/rate limit|too many requests|429/i.test(message)) return new SubtitleError("RATE_LIMITED", "模型请求被限流");
  return new SubtitleError("MODEL_ERROR", "模型请求失败");
}

function fail(code: ConstructorParameters<typeof SubtitleError>[0], message: string, usage: CoreUsage): never {
  const error = new SubtitleError(code, message);
  error.usage = usage;
  throw error;
}
