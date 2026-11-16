import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CredentialRecord, DshContext, FetchRoute, GenerateOptions, ModelSelection, StreamChunk, ToolDefinition } from "../dist/host.js";

export class FsCodeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export async function withDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-dsh-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export interface FakeHost {
  ctx: DshContext;
  tools: Map<string, ToolDefinition>;
  routes: Map<string, FetchRoute>;
  records: Map<string, CredentialRecord>;
  calls: Array<{ selection: unknown; options: Record<string, unknown> }>;
  prepares: Array<{ selection: ModelSelection; signal?: AbortSignal }>;
  writes: Array<{ path: string; policy: unknown }>;
}

/** 内存凭据 + 真实临时目录文件系统 + 可编排的模型流。 */
type ScriptedStream = StreamChunk[] | ((options: GenerateOptions) => AsyncIterable<StreamChunk>);

export function fakeHost(options: {
  cwd: string;
  streams?: ScriptedStream[];
  prepare?: (selection: ModelSelection, signal?: AbortSignal) => Promise<void>;
  denied?: string;
} = { cwd: "" }): FakeHost {
  const host: FakeHost = {
    ctx: undefined as unknown as DshContext,
    tools: new Map(),
    routes: new Map(),
    records: new Map(),
    calls: [],
    prepares: [],
    writes: [],
  };
  const streams = [...(options.streams ?? [])];
  host.ctx = {
    fs: {
      sandboxMode: "workspace-write",
      async resolve(target) {
        return { targetKey: target, displayPath: target };
      },
      async readBytes(target) {
        try {
          return new Uint8Array(await readFile(target.displayPath));
        } catch {
          throw new FsCodeError("FS_NOT_FOUND");
        }
      },
      async writeText(target, content, _expected, _signal, policy) {
        if (options.denied && target.displayPath.startsWith(options.denied)) throw new FsCodeError("FS_SANDBOX_DENIED");
        host.writes.push({ path: target.displayPath, policy });
        await mkdir(path.dirname(target.displayPath), { recursive: true });
        try {
          await writeFile(target.displayPath, content, { flag: "wx" });
        } catch {
          throw new FsCodeError("FS_NOT_OBSERVED");
        }
        return { operation: "create" };
      },
    },
    llm: {
      async prepareCall(selection, signal) {
        host.prepares.push({ selection, signal });
        await options.prepare?.(selection, signal);
        return {
          config: selection,
          async *stream(streamOptions) {
            host.calls.push({ selection, options: streamOptions as unknown as Record<string, unknown> });
            const chunks = streams.shift();
            if (!chunks) throw new Error("no scripted stream");
            if (typeof chunks === "function") yield* chunks(streamOptions);
            else for (const chunk of chunks) yield chunk;
          },
        };
      },
    },
    credentials: {
      async readRecord(key) {
        return host.records.get(key);
      },
      async modifyRecord(key, update) {
        const next = await update(host.records.get(key));
        if (next) host.records.set(key, next);
        return next;
      },
      async deleteRecord(key) {
        host.records.delete(key);
      },
    },
    tools: { register: (tool) => host.tools.set(tool.name, tool) },
    connection: { fetch: { register: (route) => host.routes.set(route.path, route) } },
    workingDirectory: { ensure: async () => options.cwd },
    get: (name) => (name === "sandboxPolicy" ? { resolve: () => ({ policy: "session" }) } : undefined),
  };
  return host;
}

export function text(value: string): StreamChunk[] {
  return [
    { type: "text-delta", text: value },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

export function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

export function exec(signal = new AbortController().signal) {
  return {
    callId: "call-1",
    signal,
    agent: { session: { id: "session-1" }, model: { current: () => ({ provider: "demo", model: "flash", reasoningEffort: "high" }) } },
  };
}
