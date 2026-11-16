import { cancelled } from "./errors.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

export function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
