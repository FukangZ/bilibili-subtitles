import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type Model,
  type ModelThinkingLevel,
  type ThinkingLevel,
  type Usage,
} from "@earendil-works/pi-ai";
import { isSubtitleError, SubtitleError, type StageClient, type StageResult } from "@fukangz/core-bilibili-subtitles";

const AUTH_ERROR_PATTERN = /unauthorized|unauthenticated|invalid api key|not logged in|authentication|api key/i;

export interface ResolvedSelection {
  model: Model<Api>;
  effectiveThinking: ModelThinkingLevel;
  warnings: string[];
}

export function resolveSelection(input: {
  configuredProvider?: string;
  configuredModel?: string;
  configuredThinking?: ModelThinkingLevel;
  sessionModel?: Model<Api>;
  sessionThinking: ModelThinkingLevel;
  findModel: (provider: string, id: string) => Model<Api> | undefined;
  hasConfiguredAuth: (model: Model<Api>) => boolean;
}): ResolvedSelection {
  const configured = Boolean(input.configuredProvider && input.configuredModel);
  const model = configured
    ? input.findModel(input.configuredProvider!, input.configuredModel!)
    : input.sessionModel;
  if (!model) {
    throw new SubtitleError(
      "MODEL_NOT_FOUND",
      configured
        ? `没有找到模型 ${input.configuredProvider}/${input.configuredModel}。请检查 /model 或 models.json`
        : "当前会话没有模型。请先选择模型，或在配置里同时写上 provider 和 model",
    );
  }
  if (!input.hasConfiguredAuth(model)) {
    throw new SubtitleError("MODEL_AUTH_REQUIRED", `模型 ${model.provider}/${model.id} 还没有认证。请使用 /login`);
  }
  const requested = input.configuredThinking ?? input.sessionThinking;
  const supported = getSupportedThinkingLevels(model);
  if (input.configuredThinking && !supported.includes(input.configuredThinking)) {
    throw new SubtitleError(
      "INVALID_CONFIG",
      `模型 ${model.provider}/${model.id} 不支持思考强度 ${input.configuredThinking}。可用：${supported.join("、")}`,
    );
  }
  const effective = clampThinkingLevel(model, requested);
  const warnings: string[] = [];
  if (effective !== requested) {
    warnings.push(`思考强度 ${requested} 超出模型能力，已降为 ${effective}`);
  }
  return { model, effectiveThinking: effective, warnings };
}

type StreamOptions = {
  signal?: AbortSignal;
  timeoutMs: number;
  maxTokens: number;
  maxRetries: number;
  toolChoice: "none";
  reasoning?: ThinkingLevel;
};

export function buildStreamOptions(
  selection: ResolvedSelection,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): StreamOptions {
  const options: StreamOptions = {
    signal,
    timeoutMs,
    maxTokens: selection.model.maxTokens,
    maxRetries: 1,
    toolChoice: "none",
  };
  if (selection.effectiveThinking !== "off") options.reasoning = selection.effectiveThinking;
  return options;
}

export function readAssistantText(message: AssistantMessage, contextWindow: number): StageResult {
  const usage = message.usage;
  if (message.stopReason === "aborted") fail("CANCELLED", "模型请求已取消", usage);
  if (message.stopReason === "length") fail("OUTPUT_TRUNCATED", "模型输出被截断，未保存为完整文章", usage);
  if (message.stopReason === "error") {
    if (isContextOverflow(message, contextWindow)) {
      fail("INPUT_TOO_LARGE", "字幕超出模型上下文，未保存为完整文章", usage);
    }
    const detail = message.errorMessage ?? "模型请求失败";
    if (AUTH_ERROR_PATTERN.test(detail)) {
      fail("MODEL_AUTH_REQUIRED", "模型认证失败。请使用 /login", usage);
    }
    if (/rate limit|too many requests|429/i.test(detail)) fail("RATE_LIMITED", "模型请求被限流", usage);
    fail("MODEL_ERROR", "模型请求失败", usage);
  }
  if (message.stopReason !== "stop") {
    fail("INVALID_MODEL_OUTPUT", "模型没有正常结束", usage);
  }
  if (message.content.some((block) => block.type === "toolCall")) {
    fail("INVALID_MODEL_OUTPUT", "模型返回了工具调用，未保存为完整文章", usage);
  }
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
  if (!text) fail("INVALID_MODEL_OUTPUT", "模型没有返回文本", usage);
  return { text, usage };
}

export function createStageClient(input: {
  selection: ResolvedSelection;
  timeoutMs: number;
  signal?: AbortSignal;
  streamSimple: (
    model: Model<Api>,
    context: { systemPrompt: string; messages: Array<{ role: "user"; content: string; timestamp: number }> },
    options: ReturnType<typeof buildStreamOptions>,
  ) => { result: () => Promise<AssistantMessage> };
}): StageClient {
  return {
    async complete(request, requestSignal) {
      const signal = input.signal && requestSignal
        ? AbortSignal.any([input.signal, requestSignal])
        : requestSignal ?? input.signal;
      if (signal?.aborted) fail("CANCELLED", "任务已取消");
      const options = buildStreamOptions(input.selection, signal, input.timeoutMs);
      let stream: { result: () => Promise<AssistantMessage> };
      try {
        stream = input.streamSimple(
          input.selection.model,
          {
            systemPrompt: request.system,
            messages: [{ role: "user", content: request.user, timestamp: Date.now() }],
          },
          options,
        );
      } catch (error) {
        throw mapStreamError(error, signal);
      }
      try {
        return readAssistantText(await stream.result(), input.selection.model.contextWindow);
      } catch (error) {
        if (isSubtitleError(error)) throw error;
        throw mapStreamError(error, signal);
      }
    },
  };
}

function mapStreamError(error: unknown, signal?: AbortSignal): SubtitleError {
  if (signal?.aborted) return new SubtitleError("CANCELLED", "任务已取消");
  const message = error instanceof Error ? error.message : "模型请求失败";
  if (AUTH_ERROR_PATTERN.test(message)) {
    return new SubtitleError("MODEL_AUTH_REQUIRED", "模型认证失败。请使用 /login");
  }
  return new SubtitleError("MODEL_ERROR", "模型请求失败");
}

function fail(code: ConstructorParameters<typeof SubtitleError>[0], message: string, usage?: Usage): never {
  const error = new SubtitleError(code, message);
  error.usage = usage;
  throw error;
}
