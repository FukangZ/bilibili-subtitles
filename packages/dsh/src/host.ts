/**
 * dsh 宿主接口的本地结构类型。插件运行时不导入 `@deepseek-ai/dsh-*`，
 * 这里只声明本插件实际使用的最小子集。
 */

export type SandboxPolicy = object;

export interface FsTarget {
  targetKey: unknown;
  displayPath: string;
}

export interface DshFs {
  readonly sandboxMode?: unknown;
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>;
  readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
  writeText(
    target: FsTarget,
    content: string,
    expected?: { kind: "createIfAbsent" },
    signal?: AbortSignal,
    sandboxPolicy?: SandboxPolicy,
  ): Promise<unknown>;
}

export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface AgentHandle {
  session?: { id?: string };
  model: { current(): Readonly<ModelSelection> | undefined };
}

export interface ToolRunContext {
  callId: string;
  agent?: AgentHandle;
  signal: AbortSignal;
}

export interface UsageChunk {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
}

/** Only structured facts consumed by the model adapter; provider text stays private. */
export interface LlmFailure {
  code?: string;
  status?: number;
  providerRetryAfterMs?: number;
}

export type StreamChunk =
  | { type: "text-delta"; text: string }
  | { type: "usage"; usage: UsageChunk }
  | { type: "finish"; reason: { kind: string; failure?: LlmFailure } }
  | { type: string; [key: string]: unknown };

export interface GenerateOptions {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  system?: string;
  messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }> }>;
  signal?: AbortSignal;
  sessionId?: string;
  purpose?: string;
}

export interface PreparedLlmCall {
  readonly config: ModelSelection & { maxTokens?: number };
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}

export interface DshLlm {
  prepareCall(config: ModelSelection, signal?: AbortSignal): Promise<PreparedLlmCall>;
}

export type CredentialRecord = { kind: "grant"; payload: unknown } | { kind: string; [key: string]: unknown };

export interface DshCredentials {
  readRecord(key: string): Promise<CredentialRecord | undefined>;
  modifyRecord(
    key: string,
    update: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>;
  deleteRecord(key: string): Promise<unknown>;
}

export interface JsonSchemaNode {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaNode;
  description?: string;
}

export interface ContentBlock {
  type: "text";
  text: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchemaNode;
  output: { schema: JsonSchemaNode; render(args: unknown, value: unknown): ContentBlock[] };
  timeoutMs?: number;
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>;
}

export interface FetchRoute {
  path: string;
  methods: string[];
  requestBody?: "buffered";
  fetch(request: Request): Promise<Response>;
}

export interface DshContext {
  fs: DshFs;
  llm: DshLlm;
  credentials: DshCredentials;
  tools: { register(tool: ToolDefinition): unknown };
  connection: { fetch: { register(route: FetchRoute): unknown } };
  workingDirectory: { ensure(agent: AgentHandle | undefined, signal?: AbortSignal): Promise<string> };
  get(name: string): unknown;
  on?(event: string, listener: (...args: unknown[]) => unknown): unknown;
}

export interface SandboxPolicyService {
  resolve(request?: { session?: unknown }): SandboxPolicy;
}
