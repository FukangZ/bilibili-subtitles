import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { SubtitleError, updateConfigFile, type CookieConfig, type MutationQueue } from "@fukangz/core-bilibili-subtitles";

const keys = ["SESSDATA", "bili_jct", "DedeUserID"] as const;
const tails = new Map<string, Promise<unknown>>();

export function credentialsFile(configFile: string): string {
  return path.join(path.dirname(configFile), "credentials.json");
}

export const configQueue: MutationQueue = async (file, mutate) => {
  const previous = tails.get(file) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  tails.set(file, tail);
  await previous;
  try { return await mutate(); }
  finally { release(); if (tails.get(file) === tail) tails.delete(file); }
};

export async function readCredentials(file: string): Promise<CookieConfig | undefined> {
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
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw new SubtitleError("INVALID_CONFIG", "无法读取 CLI 用户级凭证");
  }
}

export async function writeCredentials(file: string, cookie: CookieConfig, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new SubtitleError("CANCELLED", "操作已取消");
  let temporary: string | undefined;
  let created = false;
  try {
    try {
      if (!(await lstat(file)).isFile()) throw new Error();
      await readCredentials(file);
    } catch (error) { if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error; }
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
    throw new SubtitleError("INVALID_CONFIG", "无法保存 CLI 用户级凭证");
  } finally { if (created && temporary) await unlink(temporary).catch(() => undefined); }
}

export async function migrateLegacyCookie(configFile: string, credentials: string, signal?: AbortSignal): Promise<void> {
  await configQueue(configFile, async () => {
    let old: unknown;
    try {
      const parsed: unknown = JSON.parse(await readFile(configFile, "utf8"));
      if (!record(parsed)) throw new Error();
      old = parsed.cookie;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 CLI 登录凭证，原配置未更改");
    }
    if (old === undefined) return;
    if (!record(old)) throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 CLI 登录凭证，原配置未更改");
    const cookie: CookieConfig = {};
    for (const key of keys) {
      const value = old[key];
      if (value !== undefined && (typeof value !== "string" || !value.trim())) throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 CLI 登录凭证，原配置未更改");
      if (typeof value === "string") cookie[key] = value;
    }
    if (!Object.keys(cookie).length) throw new SubtitleError("INVALID_CONFIG", "无法迁移旧版 CLI 登录凭证，原配置未更改");
    const existing = await readCredentials(credentials);
    if (existing === undefined) {
      await writeCredentials(credentials, cookie, signal);
      const verified = await readCredentials(credentials);
      if (JSON.stringify(verified) !== JSON.stringify(cookie)) throw new SubtitleError("INVALID_CONFIG", "无法验证 CLI 登录凭证，原配置未更改");
    }
    await updateConfigFile({ file: configFile, label: "CLI", signal,
      update: (existing) => Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "cookie")),
      messages: { saveFailure: "无法迁移旧版 CLI 登录凭证，原配置未更改" },
    });
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
