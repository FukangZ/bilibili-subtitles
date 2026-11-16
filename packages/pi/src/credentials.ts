import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { SubtitleError, updateConfigFile, type CookieConfig, type MutationQueue } from "@fukangz/core-bilibili-subtitles";

const keys = ["SESSDATA", "bili_jct", "DedeUserID"] as const;
export function credentialPath(agentDir: string): string { return path.join(agentDir, "bilibili-subtitles.credentials.json"); }

export async function readPiCredentials(file: string): Promise<CookieConfig | undefined> {
  try {
    const entry = await lstat(file);
    if (!entry.isFile()) throw new Error();
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!record(parsed) || !record(parsed.cookie)) throw new Error();
    const cookie: CookieConfig = {};
    for (const key of keys) {
      const value = parsed.cookie[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new Error();
      if (typeof value === "string") cookie[key] = value;
    }
    if (!Object.keys(cookie).length) throw new Error();
    return cookie;
  } catch (error) {
    if (code(error, "ENOENT")) return undefined;
    throw new SubtitleError("INVALID_CONFIG", "无法读取 Pi 用户级凭证");
  }
}

export async function writePiCredentials(file: string, cookie: CookieConfig, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new SubtitleError("CANCELLED", "操作已取消");
  let temporary: string | undefined;
  let created = false;
  try {
    try {
      if (!(await lstat(file)).isFile()) throw new Error();
      await readPiCredentials(file);
    } catch (error) { if (!code(error, "ENOENT")) throw error; }
    const directory = path.dirname(file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = path.join(directory, `.credentials.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    created = true;
    try { await handle.writeFile(`${JSON.stringify({ cookie }, null, 2)}\n`); }
    finally { await handle.close(); }
    if (signal?.aborted) throw new SubtitleError("CANCELLED", "操作已取消");
    await rename(temporary, file);
  } catch (error) {
    if (error instanceof SubtitleError) throw error;
    throw new SubtitleError("INVALID_CONFIG", "无法保存 Pi 用户级凭证");
  } finally { if (created && temporary) await unlink(temporary).catch(() => undefined); }
}

export async function migratePiCookie(configFile: string, credentials: string, queue: MutationQueue, signal?: AbortSignal): Promise<void> {
  await queue(configFile, async () => {
    let old: unknown;
    try {
      const parsed: unknown = JSON.parse(await readFile(configFile, "utf8"));
      if (!record(parsed)) throw new Error();
      old = parsed.cookie;
    } catch (error) {
      if (code(error, "ENOENT")) return;
      throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 Pi 登录凭证，原配置未更改");
    }
    if (old === undefined) return;
    if (!record(old)) throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 Pi 登录凭证，原配置未更改");
    const cookie: CookieConfig = {};
    for (const key of keys) {
      const value = old[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 Pi 登录凭证，原配置未更改");
      if (typeof value === "string") cookie[key] = value;
    }
    if (!Object.keys(cookie).length) throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 Pi 登录凭证，原配置未更改");
    const existing = await readPiCredentials(credentials);
    if (existing === undefined) {
      await writePiCredentials(credentials, cookie, signal);
      if (JSON.stringify(await readPiCredentials(credentials)) !== JSON.stringify(cookie)) throw new SubtitleError("INVALID_CONFIG", "无法验证 Pi 登录凭证，原配置未更改");
    }
    await updateConfigFile({ file: configFile, label: "Pi 用户级", signal,
      update: (existing) => Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "cookie")),
      messages: { saveFailure: "无法迁移旧版 Pi 登录凭证，原配置未更改" },
    });
  });
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function code(error: unknown, expected: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === expected; }
