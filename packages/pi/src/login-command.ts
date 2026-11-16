import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, type Component } from "@earendil-works/pi-tui";
import path from "node:path";
import {
  encodeQrLines, isSubtitleError, loginWithQr,
  type FetchLike, type LoginProgress, type MutationQueue, type CookieConfig,
} from "@fukangz/core-bilibili-subtitles";
import { credentialPath, migratePiCookie, writePiCredentials } from "./credentials.ts";

type LoginResult =
  | { state: "success"; file: string }
  | { state: "cancelled" }
  | { state: "error"; message: string };

type ViewState = LoginProgress | { state: "saving" };

export function registerLoginCommand(pi: ExtensionAPI, options: {
  agentDir: string;
  fetch: FetchLike;
  queue: MutationQueue;
  login?: typeof loginWithQr;
}): void {
  let active: AbortController | undefined;
  pi.on("session_shutdown", () => active?.abort());
  pi.registerCommand("bilibili-login", {
    description: "显示 B 站登录二维码，扫码确认后自动保存用户级 Cookie",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/bilibili-login 需要在 Pi 交互式终端中手动运行。", "error");
        return;
      }
      if (args.trim()) {
        ctx.ui.notify("用法：/bilibili-login（无需参数）", "warning");
        return;
      }
      if (active) {
        ctx.ui.notify("已有 B 站登录正在进行，请先完成或取消。", "warning");
        return;
      }
      const controller = new AbortController();
      active = controller;
      try {
        const result = await ctx.ui.custom<LoginResult>((tui, theme, _keybindings, done) => {
          let disposed = false;
          let finished = false;
          let state: ViewState = { state: "generating" };
          let qr: ReturnType<typeof encodeQrLines> | undefined;
          let qrUrl: string | undefined;
          const timer = setInterval(() => tui.requestRender(), 1000);
          timer.unref();
          const finish = (result: LoginResult) => {
            if (disposed || finished) return;
            finished = true;
            clearInterval(timer);
            done(result);
          };
          const view: Component & { dispose(): void } = {
            render(width) {
              const header = [...text(theme.fg("accent", "B 站扫码登录"), width), ""];
              const footer = ["", ...text(statusText(state), width), ...text(
                state.state === "saving" ? "正在写入用户级配置…" : "请用 B 站 App 扫码并确认。Esc / Ctrl+C 取消。", width,
              )];
              if (!qr || state.state === "saving") return [...header, ...footer];
              const requiredRows = header.length + qr.lines.length + footer.length;
              if (width < qr.width || tui.terminal.rows < requiredRows) {
                return [...header, ...text(`二维码需要至少 ${qr.width} 列、${requiredRows} 行，请扩大终端窗口。`, width), ...footer];
              }
              const padding = " ".repeat(Math.floor((width - qr.width) / 2));
              return [...header, ...qr.lines.map((line) => padding + line), ...footer];
            },
            handleInput(data) {
              // 原子保存开始后不再接受界面取消，避免成功落盘却显示取消。
              if (state.state !== "saving" && (matchesKey(data, "escape") || matchesKey(data, "ctrl+c"))) {
                controller.abort();
              }
            },
            invalidate() {},
            dispose() {
              disposed = true;
              controller.abort();
              clearInterval(timer);
            },
          };
          // 在 custom() 安装组件后再启动异步工作，确保完成时组件可正常释放。
          void Promise.resolve().then(async () => {
            try {
              const cookie = await (options.login ?? loginWithQr)({
                fetch: options.fetch,
                signal: controller.signal,
                onProgress(progress) {
                  if (disposed || controller.signal.aborted) return;
                  state = progress;
                  if (progress.state !== "generating" && progress.url !== qrUrl) {
                    qr = encodeQrLines(progress.url);
                    qrUrl = progress.url;
                  }
                  tui.requestRender();
                },
              });
              if (controller.signal.aborted) {
                finish({ state: "cancelled" });
                return;
              }
              state = { state: "saving" };
              qr = undefined;
              tui.requestRender();
              const configFile = path.join(options.agentDir, "bilibili-subtitles.json");
              await migratePiCookie(configFile, credentialPath(options.agentDir), options.queue, controller.signal);
              const file = credentialPath(options.agentDir);
              await options.queue(configFile, () => writePiCredentials(file, cookie, controller.signal));
              finish({ state: "success", file });
            } catch (error) {
              finish(controller.signal.aborted
                ? { state: "cancelled" }
                : { state: "error", message: loginErrorMessage(error) });
            }
          });
          return view;
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%" } });
        if (result.state === "success") {
          ctx.ui.notify(`B 站登录成功，Cookie 已保存至 ${result.file}。下次下载直接生效。`, "info");
        } else if (result.state === "cancelled") {
          ctx.ui.notify("已取消 B 站登录，未更新 Cookie。", "info");
        } else {
          ctx.ui.notify(result.message, "error");
        }
      } catch {
        ctx.ui.notify("无法打开 B 站登录界面，请在 Pi 交互式终端中重试。", "error");
      } finally {
        controller.abort();
        if (active === controller) active = undefined;
      }
    },
  });
}

function statusText(state: ViewState): string {
  switch (state.state) {
    case "generating": return "正在申请登录二维码…";
    case "saving": return "手机已确认登录。";
    case "waiting": return `等待扫码（剩余约 ${Math.max(0, Math.ceil((state.expiresAt - Date.now()) / 1000))} 秒）`;
    case "scanned": return "已扫码，请在手机上确认登录。";
  }
}

function text(value: string, width: number): string[] {
  return new Text(value, 0, 0).render(width);
}

function loginErrorMessage(error: unknown): string {
  if (!isSubtitleError(error)) return "B 站登录失败，未更新 Cookie，请重试。";
  // 不展示接口原文、底层网络错误或凭证，只输出固定提示。
  switch (error.code) {
    case "LOGIN_EXPIRED": return "二维码已过期，请重新运行 /bilibili-login。";
    case "RATE_LIMITED": return "B 站限制了登录请求，请稍后再试。";
    case "NETWORK_ERROR": return "无法连接 B 站登录接口或请求超时，请稍后再试。";
    case "INVALID_CONFIG": return "无法更新用户级凭证，请检查 JSON 格式、文件权限及是否为普通文件；原配置未更新。";
    case "INVALID_RESPONSE": return "B 站登录响应无效或 Cookie 不完整，未更新配置，请重试。";
    default: return "B 站未完成登录，未更新 Cookie，请重新运行 /bilibili-login。";
  }
}
