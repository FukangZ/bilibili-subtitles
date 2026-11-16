import { setTimeout as delay } from "node:timers/promises";
import type { FetchLike } from "./bilibili.js";
import { COOKIE_CONFIG_KEYS, type CookieConfig } from "./config.js";
import { cancelled, isSubtitleError, SubtitleError } from "./errors.js";
import { isRecord } from "./guards.js";

const PASSPORT_ORIGIN = "https://passport.bilibili.com";
const QR_ORIGINS = new Set([PASSPORT_ORIGIN, "https://account.bilibili.com"]);
const QR_LIFETIME_MS = 180_000;
const REQUEST_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 2_000;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export type LoginCookie = Required<CookieConfig>;
export type LoginProgress =
  | { state: "generating" }
  | { state: "waiting" | "scanned"; url: string; expiresAt: number };

export async function loginWithQr(options: {
  fetch: FetchLike;
  signal: AbortSignal;
  onProgress: (progress: LoginProgress) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  lifetimeMs?: number;
  requestTimeoutMs?: number;
}): Promise<LoginCookie> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const expiresAt = now() + (options.lifetimeMs ?? QR_LIFETIME_MS);
  const check = () => {
    if (options.signal.aborted) throw cancelled();
    if (now() >= expiresAt) throw new SubtitleError("LOGIN_EXPIRED", "二维码已过期");
  };

  check();
  options.onProgress({ state: "generating" });
  const generated = await request(new URL("/x/passport-login/web/qrcode/generate", PASSPORT_ORIGIN));
  const url = loginUrl(generated.data.url);
  const key = generated.data.qrcode_key;
  if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(key)) {
    throw new SubtitleError("INVALID_RESPONSE", "登录接口没有返回有效的二维码标识");
  }
  options.onProgress({ state: "waiting", url, expiresAt });

  while (true) {
    check();
    try {
      await sleep(Math.min(POLL_INTERVAL_MS, expiresAt - now()), options.signal);
    } catch (error) {
      check();
      throw error;
    }
    const pollUrl = new URL("/x/passport-login/web/qrcode/poll", PASSPORT_ORIGIN);
    pollUrl.searchParams.set("qrcode_key", key);
    const polled = await request(pollUrl);
    switch (polled.data.code) {
      case 86101:
        options.onProgress({ state: "waiting", url, expiresAt });
        break;
      case 86090:
        options.onProgress({ state: "scanned", url, expiresAt });
        break;
      case 86038:
        throw new SubtitleError("LOGIN_EXPIRED", "二维码已过期");
      case 0:
        return readLoginCookie(polled.headers);
      default:
        throw new SubtitleError("LOGIN_FAILED", "B 站未完成登录");
    }
  }

  async function request(url: URL): Promise<{ data: Record<string, unknown>; headers: Headers }> {
    check();
    const timeout = AbortSignal.timeout(Math.max(1, Math.min(options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS, expiresAt - now())));
    const signal = AbortSignal.any([options.signal, timeout]);
    try {
      // 登录客户端不接收已有 Cookie，且不跟随重定向。
      const response = await options.fetch(url.href, {
        method: "GET",
        redirect: "manual",
        credentials: "omit",
        signal,
        headers: { "User-Agent": USER_AGENT, Referer: "https://www.bilibili.com/" },
      });
      check();
      if (response.status === 412 || response.status === 429) {
        throw new SubtitleError("RATE_LIMITED", "登录请求被限制，请稍后再试");
      }
      if (!response.ok) throw new SubtitleError("NETWORK_ERROR", "登录接口请求失败");
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        if (signal.aborted) throw new SubtitleError("NETWORK_ERROR", "登录接口请求超时");
        throw new SubtitleError("INVALID_RESPONSE", "登录接口返回了无效 JSON");
      }
      check();
      if (!isRecord(body) || typeof body.code !== "number") {
        throw new SubtitleError("INVALID_RESPONSE", "无法识别登录接口响应");
      }
      if (body.code === -412) throw new SubtitleError("RATE_LIMITED", "登录请求被限制，请稍后再试");
      if (body.code !== 0) throw new SubtitleError("LOGIN_FAILED", "登录接口拒绝了请求，请稍后再试");
      if (!isRecord(body.data)) throw new SubtitleError("INVALID_RESPONSE", "登录接口缺少响应数据");
      return { data: body.data, headers: response.headers };
    } catch (error) {
      check();
      if (isSubtitleError(error)) throw error;
      throw new SubtitleError("NETWORK_ERROR", "无法连接 B 站登录接口，请稍后再试");
    }
  }
}

function readLoginCookie(headers: Headers): LoginCookie {
  const cookie: CookieConfig = {};
  for (const header of headers.getSetCookie()) {
    const match = /^([^=;]+)=([^;]*)/.exec(header);
    if (!match) continue;
    const name = COOKIE_CONFIG_KEYS.find((name) => name === match[1]?.trim());
    if (!name) continue;
    const value = match[2];
    // 保留 SESSDATA 的百分号编码；不接受分隔符或控制字符。
    if (!/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/.test(value)) {
      throw new SubtitleError("INVALID_RESPONSE", "登录接口返回了无效的凭证");
    }
    cookie[name] = value;
  }
  const { SESSDATA, bili_jct, DedeUserID } = cookie;
  if (!SESSDATA || !bili_jct || !DedeUserID) {
    throw new SubtitleError("INVALID_RESPONSE", "登录成功响应缺少完整 Cookie，未更新配置");
  }
  return { SESSDATA, bili_jct, DedeUserID };
}

function loginUrl(value: unknown): string {
  try {
    if (typeof value !== "string" || value.length > 2048) throw new Error();
    const url = new URL(value);
    if (!QR_ORIGINS.has(url.origin) || url.username || url.password) throw new Error();
    return url.href;
  } catch {
    throw new SubtitleError("INVALID_RESPONSE", "登录接口返回了无效的二维码链接");
  }
}
