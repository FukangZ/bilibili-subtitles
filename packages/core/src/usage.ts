export interface UsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  /** Optional provider detail retained for host adapters. */
  cacheWrite1h?: number;
  totalTokens: number;
  cost?: UsageCost;
}

export type UsageStatus = "unknown" | "partial" | "complete";

export function usageStatus(reportedCalls: number, attemptedCalls: number): UsageStatus {
  if (reportedCalls === 0) return "unknown";
  return reportedCalls === attemptedCalls ? "complete" : "partial";
}

export function zeroUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

/** 只相加两边都报告过的可选字段，避免把“上游没给”写成 0。 */
export function addUsage(left: Usage | undefined, right: Usage | undefined): Usage | undefined {
  if (!left) return right;
  if (!right) return left;
  const usage: Usage = {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
  };
  if (left.cost && right.cost) {
    usage.cost = {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    };
  }
  if (left.reasoning !== undefined && right.reasoning !== undefined) {
    usage.reasoning = left.reasoning + right.reasoning;
  }
  if (left.cacheWrite1h !== undefined && right.cacheWrite1h !== undefined) {
    usage.cacheWrite1h = left.cacheWrite1h + right.cacheWrite1h;
  }
  return usage;
}
