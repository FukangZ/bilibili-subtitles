import { SubtitleError, type FileStore } from "@fukangz/core-bilibili-subtitles";
import type { DshFs, SandboxPolicy } from "./host.js";

/** 原始字幕/文章读取上限；超出视为非法输入。 */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** 用 dsh ctx.fs 实现 core FileStore，读写都经过宿主沙箱策略。 */
export function createDshFileStore(fs: DshFs, policy: SandboxPolicy | undefined): FileStore {
  return {
    async readFile(absolutePath, signal) {
      try {
        const target = await fs.resolve(absolutePath, { signal });
        return await fs.readBytes(target, signal, MAX_READ_BYTES);
      } catch (error) {
        throw mapFsError(error);
      }
    },
    async createIfAbsent(absolutePath, content, signal) {
      try {
        const target = await fs.resolve(absolutePath, { signal });
        await fs.writeText(target, content, { kind: "createIfAbsent" }, signal, policy);
        return true;
      } catch (error) {
        if (fsCode(error) === "FS_NOT_OBSERVED") return false;
        throw mapFsError(error);
      }
    },
  };
}

function mapFsError(error: unknown): unknown {
  const code = fsCode(error);
  if (code === "FS_ABORTED") return new SubtitleError("CANCELLED", "任务已取消");
  if (code === "FS_SANDBOX_DENIED") return new SubtitleError("INVALID_INPUT", "沙箱策略拒绝访问该路径");
  if (code === "FS_NOT_FOUND") return new SubtitleError("INVALID_INPUT", "文件不存在");
  return error;
}

function fsCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
