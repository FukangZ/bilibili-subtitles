import type { Usage } from "./usage.js";

export interface StageRequest {
  system: string;
  user: string;
  /** Internal orchestration metadata; adapters must not send it to the model. */
  context?: {
    stage: "structure" | "body";
    attempt: 1 | 2;
  };
}

export interface StageResult {
  text: string;
  usage?: Usage;
}

/** The adapter owns model selection, authentication, thinking and timeouts. */
export interface StageClient {
  complete(request: StageRequest, signal?: AbortSignal): Promise<StageResult>;
}

export interface ModelInfo {
  label: string;
  thinking?: string;
  warnings: string[];
}
