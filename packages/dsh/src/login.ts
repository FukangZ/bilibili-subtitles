import {
  encodeQrModules,
  isSubtitleError,
  loginWithQr,
  type FetchLike,
  type LoginCookie,
  type LoginProgress,
} from "@fukangz/core-bilibili-subtitles";
import { deleteCookie, readCookie, saveCookie } from "./credentials.js";
import type { DshContext } from "./host.js";

export const ROUTE_PREFIX = "/api/bilibili-subtitles";
const MAX_SESSIONS = 4;
const RETAIN_FINISHED_MS = 60_000;

export type LoginState =
  | { state: "generating" }
  | { state: "waiting" | "scanned"; url: string; expiresAt: number; size: number; rows: string[] }
  | { state: "saving" }
  | { state: "success"; userId?: string }
  | { state: "error"; code: string; message: string }
  | { state: "cancelled" };

interface LoginSession {
  id: string;
  controller: AbortController;
  status: LoginState;
  finishedAt?: number;
}

export interface LoginManagerOptions {
  fetch?: FetchLike;
  save: (cookie: LoginCookie) => Promise<void>;
  now?: () => number;
  login?: typeof loginWithQr;
}

/** 管理宿主端的扫码登录会话；Cookie 只写入凭据存储，不经过客户端。 */
export class LoginManager {
  private readonly sessions = new Map<string, LoginSession>();
  private readonly now: () => number;
  private operations: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly options: LoginManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  start(): { id: string; status: LoginState } {
    if (this.disposed) throw new Error("LoginManager is disposed");
    for (const session of this.sessions.values()) {
      if (session.finishedAt === undefined) this.cancel(session.id);
    }
    this.prune(1);
    const id = crypto.randomUUID();
    const session: LoginSession = { id, controller: new AbortController(), status: { state: "generating" } };
    this.sessions.set(id, session);
    void this.run(session);
    return { id, status: session.status };
  }

  poll(id: string): LoginState | undefined {
    this.prune();
    return this.sessions.get(id)?.status;
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    // 凭据存储不支持撤销已开始的写入，不能把提交中的会话谎报为已取消。
    if (session.status.state === "saving") return false;
    if (session.finishedAt === undefined) {
      session.controller.abort();
      this.finish(session, { state: "cancelled" });
    }
    return true;
  }

  /** 立即使旧会话失效；已进入存储的写入完成后，再删除凭据。 */
  logout(remove: () => Promise<void>): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.finishedAt !== undefined) continue;
      session.controller.abort();
      this.finish(session, { state: "cancelled" });
    }
    return this.enqueue(remove);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      session.controller.abort();
      this.finish(session, { state: "cancelled" });
    }
    this.sessions.clear();
    // 已开始的存储不能撤销；停用完成前等待它落地，不删除用户原有凭据。
    return this.operations;
  }

  private async run(session: LoginSession): Promise<void> {
    const login = this.options.login ?? loginWithQr;
    try {
      const cookie = await login({
        fetch: this.options.fetch ?? globalThis.fetch,
        signal: session.controller.signal,
        onProgress: (progress) => {
          if (session.finishedAt === undefined && session.status.state !== "saving") session.status = toState(progress);
        },
      });
      if (session.finishedAt !== undefined) return;
      await this.enqueue(async () => {
        if (session.finishedAt !== undefined) return;
        session.status = { state: "saving" };
        await this.options.save(cookie);
        this.finish(session, { state: "success", userId: cookie.DedeUserID });
      });
    } catch (error) {
      if (session.finishedAt !== undefined) return;
      if (isSubtitleError(error)) {
        this.finish(session, { state: "error", code: error.code, message: error.message.replace(/^[A-Z_]+:\s*/, "") });
      } else {
        this.finish(session, { state: "error", code: "LOGIN_FAILED", message: "登录失败" });
      }
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.operations.then(operation);
    // 存储失败不能阻塞后续登出或新登录。调用者仍收到原始失败。
    this.operations = result.catch(() => {});
    return result;
  }

  private finish(session: LoginSession, status: LoginState): void {
    if (session.finishedAt !== undefined) return;
    session.status = status;
    session.finishedAt = this.now();
  }

  private prune(reserve = 0): void {
    const cutoff = this.now() - RETAIN_FINISHED_MS;
    for (const [id, session] of this.sessions) {
      if (session.finishedAt !== undefined && session.finishedAt < cutoff) this.sessions.delete(id);
    }
    for (const [id, session] of this.sessions) {
      if (this.sessions.size <= MAX_SESSIONS - reserve) break;
      if (session.finishedAt !== undefined) this.sessions.delete(id);
    }
  }
}

function toState(progress: LoginProgress): LoginState {
  if (progress.state === "generating") return { state: "generating" };
  const { size, rows } = encodeQrModules(progress.url);
  return { state: progress.state, url: progress.url, expiresAt: progress.expiresAt, size, rows };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

async function readId(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.json()) as unknown;
    if (typeof body === "object" && body !== null && typeof (body as { id?: unknown }).id === "string") {
      return (body as { id: string }).id;
    }
  } catch {
    // 非 JSON 请求体按缺少 id 处理
  }
  return undefined;
}

/** 注册登录相关路由。路由由宿主做身份校验；响应不包含 Cookie 值。 */
export function registerLoginRoutes(ctx: DshContext, manager: LoginManager): void {
  const route = (path: string, handler: (request: Request) => Promise<Response>) =>
    ctx.connection.fetch.register({ path: `${ROUTE_PREFIX}${path}`, methods: ["POST"], requestBody: "buffered", fetch: handler });

  route("/login/start", async () => json(manager.start()));
  route("/login/poll", async (request) => {
    const id = await readId(request);
    const status = id ? manager.poll(id) : undefined;
    return status ? json({ id, status }) : json({ error: "UNKNOWN_SESSION" }, 404);
  });
  route("/login/cancel", async (request) => {
    const id = await readId(request);
    if (!id || !manager.poll(id)) return json({ error: "UNKNOWN_SESSION" }, 404);
    return manager.cancel(id) ? json({ ok: true }) : json({ error: "LOGIN_SAVING" }, 409);
  });
  route("/account/status", async () => {
    const cookie = await readCookie(ctx.credentials);
    return json({ loggedIn: Boolean(cookie), userId: cookie?.DedeUserID });
  });
  route("/account/logout", async () => {
    await manager.logout(() => deleteCookie(ctx.credentials));
    return json({ ok: true });
  });
}

export function createLoginManager(ctx: DshContext, fetch?: FetchLike): LoginManager {
  return new LoginManager({ fetch, save: (cookie) => saveCookie(ctx.credentials, cookie) });
}
