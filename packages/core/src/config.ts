import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { cancelled, isSubtitleError, SubtitleError } from "./errors.js";
import { isCode, isRecord } from "./guards.js";

export const DEFAULT_OUTPUT_DIR = ".subtitles";
export const DEFAULT_TIMEOUT_MS = 120_000;


export const COOKIE_CONFIG_KEYS = ["SESSDATA", "bili_jct", "DedeUserID"] as const;
export type CookieConfig = { [key in (typeof COOKIE_CONFIG_KEYS)[number]]?: string };

export interface PolishConfig {
  timeoutMs: number;
}

export interface AppConfig<P extends object = object> {
  polish: PolishConfig & P;
}

export type ConfigFile = Record<string, unknown>;
export interface ConfigSources {
  user?: ConfigFile;
  project?: ConfigFile;
}

export interface LoadConfigOptions {
  userFile: string;
  projectFile?: string;
  projectTrusted: boolean;
}

/** Only trusted project files are read; adapter fields are validated by extend. */
export function loadConfig<P extends object>(options: LoadConfigOptions & {
  extend: (sources: ConfigSources) => P;
}): Promise<AppConfig<P>>;
export function loadConfig(options: LoadConfigOptions): Promise<AppConfig>;
export async function loadConfig(options: LoadConfigOptions & {
  extend?: (sources: ConfigSources) => object;
}): Promise<AppConfig> {
  const user = await readOptional(options.userFile, "用户级");
  const project = options.projectTrusted && options.projectFile
    ? await readOptional(options.projectFile, "项目级")
    : undefined;
  if (project && Object.prototype.hasOwnProperty.call(project, "cookie")) {
    throw new SubtitleError("INVALID_CONFIG", "项目级配置不能包含 cookie");
  }
  const userPolish = readPolish(user?.polish, "用户级配置");
  const projectPolish = readPolish(project?.polish, "项目级配置");
  const extension = options.extend?.({ user, project }) ?? {};
  return {
    polish: {
      ...extension,
      timeoutMs: projectPolish?.timeoutMs ?? userPolish?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    },
  };
}


export async function updateConfigFile(options: {
  file: string;
  label: string;
  signal?: AbortSignal;
  update: (existing: ConfigFile) => ConfigFile;
  messages?: {
    notFile?: string;
    invalidJson?: string;
    invalidObject?: string;
    readFailure?: string;
    saveFailure?: string;
  };
}): Promise<string> {
  const { file, label, signal, messages } = options;
  const directory = path.dirname(file);
  if (signal?.aborted) throw cancelled();
  let temporary: string | undefined;
  let temporaryCreated = false;
  try {
    try {
      const stat = await lstat(file);
      if (!stat.isFile()) throw new SubtitleError("INVALID_CONFIG", messages?.notFile ?? `${label}配置必须是普通文件，未更新`);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    const existing = await readOptional(file, label, messages);
    const updated = options.update(existing ?? {});
    if (!isRecord(updated)) throw new SubtitleError("INVALID_CONFIG", `${label}配置更新结果必须是 JSON 对象`);
    const content = `${JSON.stringify(updated, null, 2)}\n`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    temporary = path.join(directory, `.bilibili-subtitles.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(content, "utf8");
    } finally {
      await handle.close();
    }
    if (signal?.aborted) throw cancelled();
    await rename(temporary, file);
    return file;
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    if (isSubtitleError(error)) throw error;
    throw new SubtitleError("INVALID_CONFIG", messages?.saveFailure ?? `无法保存${label}配置，原配置未更新`);
  } finally {
    if (temporaryCreated && temporary) await unlink(temporary).catch(() => undefined);
  }
}

export function buildCookieHeader(cookie: CookieConfig | undefined): string | undefined {
  if (!cookie) return undefined;
  const parts: string[] = [];
  for (const key of COOKIE_CONFIG_KEYS) {
    const value = cookie[key]?.trim();
    if (value) parts.push(`${key}=${value}`);
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function readPolish(value: unknown, label: string): Partial<PolishConfig> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new SubtitleError("INVALID_CONFIG", `${label}的 polish 必须是对象`);
  return { timeoutMs: readTimeout(value.timeoutMs, label) };
}

function readTimeout(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new SubtitleError("INVALID_CONFIG", `${label}的 timeoutMs 必须是正整数`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new SubtitleError("INVALID_CONFIG", `${label} 必须是非空字符串`);
  }
  return value.trim();
}

async function readOptional(file: string, label: string, messages?: {
  invalidJson?: string;
  invalidObject?: string;
  readFailure?: string;
}): Promise<ConfigFile | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isCode(error, "ENOENT")) return undefined;
    throw new SubtitleError("INVALID_CONFIG", messages?.readFailure ?? `无法读取${label}配置`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SubtitleError("INVALID_CONFIG", messages?.invalidJson ?? `${label}配置不是合法 JSON 对象`);
  }
  if (!isRecord(parsed)) throw new SubtitleError("INVALID_CONFIG", messages?.invalidObject ?? `${label}配置不是合法 JSON 对象`);
  return parsed;
}
