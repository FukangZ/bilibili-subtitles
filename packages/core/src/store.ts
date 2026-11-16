import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { SubtitleError } from "./errors.js";
import { isCode } from "./guards.js";

export type MutationQueue = <T>(filePath: string, fn: () => Promise<T>) => Promise<T>;

export const passthroughQueue: MutationQueue = (_filePath, fn) => fn();

/**
 * 宿主文件读写边界。路径均为已校验在 cwd 内的绝对路径。
 * createIfAbsent 必须原子地发布完整内容、按需创建父目录、绝不覆盖已有文件：
 * 目标已存在时返回 false，其它失败直接抛出。
 */
export interface FileStore {
  readFile(absolutePath: string, signal?: AbortSignal): Promise<Uint8Array>;
  createIfAbsent(absolutePath: string, content: string, signal?: AbortSignal): Promise<boolean>;
}

export const nodeFileStore: FileStore = {
  readFile: (absolutePath) => readFile(absolutePath),
  async createIfAbsent(absolutePath, content) {
    const directory = path.dirname(absolutePath);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(
      directory,
      `.${path.basename(absolutePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
    );
    try {
      await writeFile(temporary, content, "utf8");
      try {
        await link(temporary, absolutePath);
        return true;
      } catch (error) {
        if (isCode(error, "EEXIST")) return false;
        throw error;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  },
};

const TITLE_LIMIT = 80;

export function resolveInsideCwd(cwd: string, requested: string, label: string): string {
  const raw = requested.trim().replace(/^@/, "");
  if (!raw) throw new SubtitleError("INVALID_INPUT", `${label} 不能为空`);
  if (path.isAbsolute(raw)) throw new SubtitleError("INVALID_INPUT", `${label} 必须是相对当前工作目录的路径`);
  const resolved = path.resolve(cwd, raw);
  const relative = path.relative(cwd, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SubtitleError("INVALID_INPUT", `${label} 不能超出当前工作目录`);
  }
  return resolved;
}

export function toPosixRelative(cwd: string, target: string): string {
  const relative = path.relative(cwd, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return target;
  return relative.split(path.sep).join("/");
}

export function videoDirectoryName(bvid: string, title: string, page: number, pageCount: number): string {
  const name = `${bvid}-${sanitizeTitle(title)}`;
  return pageCount > 1 ? `${name}-p${page}` : name;
}

export function sanitizeTitle(title: string): string {
  const withoutControls = Array.from(title, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f ? " " : char;
  }).join("");
  const cleaned = withoutControls
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/u, "");
  const limited = Array.from(cleaned).slice(0, TITLE_LIMIT).join("").trim().replace(/[. ]+$/u, "");
  return limited || "未命名";
}

export async function writeNewFile(
  desiredPath: string,
  content: string,
  files: FileStore = nodeFileStore,
  signal?: AbortSignal,
): Promise<string> {
  for (let index = 1; index <= 1000; index += 1) {
    const candidate = numberedPath(desiredPath, index);
    if (await files.createIfAbsent(candidate, content, signal)) return candidate;
  }
  throw new SubtitleError("INVALID_INPUT", "无法分配不覆盖已有文件的路径");
}

function numberedPath(desiredPath: string, index: number): string {
  if (index === 1) return desiredPath;
  const extension = path.extname(desiredPath);
  const stem = extension ? desiredPath.slice(0, -extension.length) : desiredPath;
  return `${stem}-${index}${extension}`;
}
