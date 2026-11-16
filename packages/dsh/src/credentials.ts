import type { CookieConfig, LoginCookie } from "@fukangz/core-bilibili-subtitles";
import type { DshCredentials } from "./host.js";

export const COOKIE_KEY = "bilibili-subtitles/cookie";
const COOKIE_FIELDS = ["SESSDATA", "bili_jct", "DedeUserID"] as const;

/** 读取已保存的 B 站 Cookie；记录缺失或形状不符时返回 undefined。 */
export async function readCookie(credentials: DshCredentials): Promise<CookieConfig | undefined> {
  const record = await credentials.readRecord(COOKIE_KEY);
  if (!record || record.kind !== "grant") return undefined;
  const payload = (record as { payload: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const cookie: CookieConfig = {};
  for (const field of COOKIE_FIELDS) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === "string" && value) cookie[field] = value;
  }
  return cookie.SESSDATA ? cookie : undefined;
}

export async function saveCookie(credentials: DshCredentials, cookie: LoginCookie): Promise<void> {
  const payload: Record<string, string> = {};
  for (const field of COOKIE_FIELDS) payload[field] = cookie[field];
  await credentials.modifyRecord(COOKIE_KEY, async () => ({ kind: "grant", payload }));
}

export async function deleteCookie(credentials: DshCredentials): Promise<void> {
  await credentials.deleteRecord(COOKIE_KEY);
}

/** 用于从错误信息中脱敏的 Cookie 值（长度 ≥4）。 */
export function secretValues(cookie: CookieConfig | undefined): string[] {
  if (!cookie) return [];
  return Object.values(cookie).filter((value): value is string => typeof value === "string" && value.length >= 4);
}
