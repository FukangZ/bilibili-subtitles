import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { SubtitleError } from "@fukangz/core-bilibili-subtitles";

export type TerminalInput = Readable & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown };
export type TerminalOutput = Writable & { isTTY?: boolean; columns?: number; rows?: number };
export interface TerminalIO { stdin: TerminalInput; stderr: TerminalOutput }

export function requireTerminal(io: TerminalIO): void {
  if (!io.stdin.isTTY || !io.stderr.isTTY) throw new SubtitleError("INVALID_INPUT", "请在自己的交互式终端运行此命令（stdin 与 stderr 必须为 TTY）");
}

/** No readline echo or history: the secret never reaches an output stream. */
export function question(io: TerminalIO, label: string, options: { hidden?: boolean; signal?: AbortSignal } = {}): Promise<string> {
  requireTerminal(io);
  if (options.signal?.aborted) return Promise.reject(new SubtitleError("CANCELLED", "任务已取消"));
  return new Promise((resolve, reject) => {
    let text = "";
    const wasRaw = io.stdin.isRaw ?? false;
    const wasPaused = io.stdin.isPaused();
    const cleanup = () => {
      io.stdin.off("keypress", onKey);
      io.stdin.off("end", onEnd);
      options.signal?.removeEventListener("abort", onAbort);
      io.stdin.setRawMode?.(wasRaw);
      if (wasPaused) io.stdin.pause();
    };
    const onAbort = () => { cleanup(); io.stderr.write("\n"); reject(new SubtitleError("CANCELLED", "任务已取消")); };
    const onEnd = () => { cleanup(); reject(new SubtitleError("INVALID_INPUT", "终端输入已关闭")); };
    const onKey = (character: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean }) => {
      if (key?.ctrl && key.name === "c") { onAbort(); return; }
      if (key?.ctrl && key.name === "d") { onEnd(); return; }
      if (key?.name === "return" || key?.name === "enter") {
        cleanup(); io.stderr.write("\n"); resolve(text.trim()); return;
      }
      if (key?.name === "backspace") {
        if (text) { text = Array.from(text).slice(0, -1).join(""); if (!options.hidden) io.stderr.write("\b \b"); }
        return;
      }
      if (character && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(character)) {
        text += character;
        if (!options.hidden) io.stderr.write(character);
      }
    };
    emitKeypressEvents(io.stdin);
    io.stdin.on("keypress", onKey);
    io.stdin.once("end", onEnd);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    io.stdin.setRawMode?.(true);
    io.stdin.resume();
    io.stderr.write(label);
  });
}
