import { isSubtitleError, SubtitleError, type ErrorCode, type ModelInfo, type StageClient, type Usage } from "@fukangz/core-bilibili-subtitles";
import type { DshLlm, LlmFailure, ModelSelection, ToolRunContext, UsageChunk } from "./host.js";
import type { DshPolishConfig } from "./config.js";

export interface ResolvedModel {
  selection: ModelSelection;
  info: ModelInfo;
}

/** 配置覆盖优先，否则跟随会话模型。 */
export function resolveModel(polish: DshPolishConfig, exec: ToolRunContext): ResolvedModel {
  let selection: ModelSelection | undefined;
  if (polish.provider && polish.model) {
    selection = { provider: polish.provider, model: polish.model };
    if (polish.reasoningEffort) selection.reasoningEffort = polish.reasoningEffort;
  } else {
    const current = exec.agent?.model.current();
    if (current) {
      selection = { provider: current.provider, model: current.model };
      const effort = polish.reasoningEffort ?? current.reasoningEffort;
      if (effort) selection.reasoningEffort = effort;
    }
  }
  if (!selection) {
    throw new SubtitleError("MODEL_NOT_FOUND", "当前会话没有模型。请先选择模型，或在设置里同时填写 provider 和 model");
  }
  return {
    selection,
    info: { label: `${selection.provider}/${selection.model}`, thinking: selection.reasoningEffort, warnings: [] },
  };
}

export function toUsage(chunk: UsageChunk): Usage {
  const input = chunk.inputTokens ?? 0;
  const output = chunk.outputTokens ?? 0;
  const cacheRead = chunk.cacheReadTokens ?? 0;
  const cacheWrite = chunk.cacheWriteTokens ?? 0;
  const usage: Usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: chunk.totalTokens ?? input + output + cacheRead + cacheWrite,
  };
  if (chunk.reasoningTokens !== undefined) usage.reasoning = chunk.reasoningTokens;
  return usage;
}

const HOST_CODES = new Map<string, ErrorCode>([
  ["INVALID_CREDENTIAL", "MODEL_AUTH_REQUIRED"], ["MISSING_CREDENTIAL", "MODEL_AUTH_REQUIRED"], ["AUTH", "MODEL_AUTH_REQUIRED"],
  ["RATE_LIMIT", "RATE_LIMITED"], ["CONTEXT_WINDOW_EXCEEDED", "INPUT_TOO_LARGE"],
  ["QUOTA", "MODEL_REQUEST_REJECTED"], ["ACCOUNT_QUOTA", "MODEL_REQUEST_REJECTED"], ["NO_ADAPTER", "MODEL_REQUEST_REJECTED"],
  ["EMPTY_RESPONSE", "INVALID_MODEL_OUTPUT"], ["PI_AI_ERROR", "MODEL_ERROR"],
]);

const MODEL_MESSAGES: Partial<Record<ErrorCode, string>> = {
  CANCELLED: "任务已取消",
  MODEL_ERROR: "润色模型请求失败",
  MODEL_AUTH_REQUIRED: "润色模型尚未认证，请检查润色模型认证",
  RATE_LIMITED: "润色模型请求被限流",
  INPUT_TOO_LARGE: "输入超出润色模型上下文限制",
  MODEL_REQUEST_REJECTED: "润色模型请求被拒绝，请检查模型配额或提供方适配是否可用",
  OUTPUT_TRUNCATED: "模型输出被截断，未保存为完整文章",
  INVALID_MODEL_OUTPUT: "模型输出无效，未保存为完整文章",
};

type PolishDiagnostic = {
  stage?: "structure" | "body";
  attempt?: 1 | 2;
  operation?: "prepare" | "stream" | "validate";
  reason?: "timeout" | "upstream" | "invalid_output";
  hostCode?: string;
  httpStatus?: number;
  retryAfterMs?: number;
};

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function diagnosticProjection(value: unknown): PolishDiagnostic {
  const input = record(value);
  const result: PolishDiagnostic = {};
  if (input.stage === "structure" || input.stage === "body") result.stage = input.stage;
  if (input.attempt === 1 || input.attempt === 2) result.attempt = input.attempt;
  if (input.operation === "prepare" || input.operation === "stream" || input.operation === "validate") result.operation = input.operation;
  if (input.reason === "timeout" || input.reason === "upstream" || input.reason === "invalid_output") result.reason = input.reason;
  if (typeof input.hostCode === "string" && HOST_CODES.has(input.hostCode)) result.hostCode = input.hostCode;
  if (typeof input.httpStatus === "number" && Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) result.httpStatus = input.httpStatus;
  if (typeof input.retryAfterMs === "number" && Number.isSafeInteger(input.retryAfterMs) && input.retryAfterMs >= 0) result.retryAfterMs = input.retryAfterMs;
  return result;
}

/** The tool's model-failure exit uses this projection, including core validation errors. */
export function projectPolishError(error: SubtitleError): SubtitleError {
  const diagnostic = diagnosticProjection(error.details?.diagnostic);
  const facts: string[] = [];
  if (diagnostic.stage) facts.push(`阶段=${diagnostic.stage}`);
  if (diagnostic.attempt) facts.push(`尝试=${diagnostic.attempt}`);
  if (diagnostic.operation) facts.push(`操作=${diagnostic.operation}`);
  if (diagnostic.reason) facts.push(`原因=${diagnostic.reason}`);
  if (diagnostic.hostCode) facts.push(`宿主代码=${diagnostic.hostCode}`);
  if (diagnostic.httpStatus !== undefined) facts.push(`HTTP=${diagnostic.httpStatus}`);
  if (diagnostic.retryAfterMs !== undefined) facts.push(`供应商等待=${diagnostic.retryAfterMs}ms`);
  const message = error.code === "MODEL_ERROR" && diagnostic.reason === "timeout"
    ? "润色模型请求超时"
    : MODEL_MESSAGES[error.code] ?? error.message.replace(/^[A-Z_]+:\s*/, "");
  const projected = new SubtitleError(error.code, message + (facts.length ? `（${facts.join("，")}）` : ""),
    Object.keys(diagnostic).length ? { diagnostic } : undefined);
  if (error.usage) projected.usage = error.usage;
  if (error.usageStatus) projected.usageStatus = error.usageStatus;
  return projected;
}

export function createStageClient(options: {
  llm: DshLlm;
  selection: ModelSelection;
  exec: ToolRunContext;
  timeoutMs: number;
}): StageClient {
  const { llm, selection, exec, timeoutMs } = options;
  return {
    async complete(request, signal) {
      const userSignal = signal ? AbortSignal.any([exec.signal, signal]) : exec.signal;
      if (userSignal.aborted) throw new SubtitleError("CANCELLED", "任务已取消");
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      const merged = AbortSignal.any([userSignal, deadline.signal]);
      let usage: Usage | undefined;
      let operation: "prepare" | "stream" = "prepare";
      const fail = (code: ErrorCode, facts: PolishDiagnostic = {}): never => {
        const error = projectPolishError(new SubtitleError(code, "模型请求失败", {
          diagnostic: { ...request.context, operation, ...facts },
        }));
        if (usage) error.usage = usage;
        throw error;
      };
      try {
        let text = "";
        let finish: { kind: string; failure?: LlmFailure } | undefined;
        const prepared = await llm.prepareCall(selection, merged);
        operation = "stream";
        const config = prepared.config;
        for await (const chunk of prepared.stream({
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
          ...(config.maxTokens !== undefined ? { maxTokens: config.maxTokens } : {}),
          system: request.system,
          messages: [{ role: "user", content: [{ type: "text", text: request.user }] }],
          signal: merged,
          ...(exec.agent?.session?.id ? { sessionId: exec.agent.session.id } : {}),
          purpose: "bilibili-polish",
        })) {
          if (chunk.type === "text-delta" && typeof chunk.text === "string") text += chunk.text;
          else if (chunk.type === "usage" && chunk.usage) usage = toUsage(chunk.usage as UsageChunk);
          else if (chunk.type === "finish") finish = chunk.reason as typeof finish;
        }
        if (userSignal.aborted) fail("CANCELLED");
        if (deadline.signal.aborted) fail("MODEL_ERROR", { reason: "timeout" });
        const kind = finish?.kind;
        if (kind === "max-tokens") fail("OUTPUT_TRUNCATED", { reason: "invalid_output" });
        if (kind === "error" || kind === "aborted") throw finish?.failure ?? {};
        if (kind !== "stop" || !text.trim()) fail("INVALID_MODEL_OUTPUT", { reason: "invalid_output" });
        return usage ? { text: text.trim(), usage } : { text: text.trim() };
      } catch (error) {
        // User cancellation wins even if a deadline or provider failure arrives concurrently.
        if (userSignal.aborted) fail("CANCELLED");
        if (deadline.signal.aborted) fail("MODEL_ERROR", { reason: "timeout" });
        if (isSubtitleError(error)) {
          const controlled = new SubtitleError(error.code, error.message.replace(/^[A-Z_]+:\s*/, ""), {
            diagnostic: { ...diagnosticProjection(error.details?.diagnostic), ...request.context, operation },
          });
          controlled.usage = usage ?? error.usage;
          controlled.usageStatus = error.usageStatus;
          throw projectPolishError(controlled);
        }
        const outer = record(error);
        const structured = record(outer.failure);
        const failure = Object.keys(structured).length ? structured : outer;
        const hostCode = typeof failure.code === "string" ? failure.code : typeof outer.code === "string" ? outer.code : "";
        return fail(HOST_CODES.get(hostCode) ?? "MODEL_ERROR", diagnosticProjection({
          reason: "upstream", hostCode,
          httpStatus: failure.status,
          retryAfterMs: failure.providerRetryAfterMs,
        }));
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
