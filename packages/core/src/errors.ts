import type { Usage, UsageStatus } from "./usage.js";

export const ERROR_CODES = [
  "INVALID_INPUT",
  "PAGE_NOT_FOUND",
  "AUTH_REQUIRED",
  "NO_SUBTITLE",
  "LANGUAGE_NOT_AVAILABLE",
  "RATE_LIMITED",
  "NETWORK_ERROR",
  "LOGIN_FAILED",
  "LOGIN_EXPIRED",
  "MODEL_NOT_FOUND",
  "MODEL_AUTH_REQUIRED",
  "INVALID_MODEL_OUTPUT",
  "OUTPUT_TRUNCATED",
  "INPUT_TOO_LARGE",
  "CANCELLED",
  "INVALID_CONFIG",
  "INVALID_RESPONSE",
  "SIGNATURE_REQUIRED",
  "POLISH_LANGUAGE_UNSUPPORTED",
  "MODEL_ERROR",
  "MODEL_REQUEST_REJECTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class SubtitleError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  usage?: Usage;
  usageStatus?: UsageStatus;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "SubtitleError";
    this.code = code;
    this.details = details;
  }
}

export function isSubtitleError(error: unknown): error is SubtitleError {
  return error instanceof SubtitleError;
}

export function cancelled(): SubtitleError {
  return new SubtitleError("CANCELLED", "任务已取消");
}
