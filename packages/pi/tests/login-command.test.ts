import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { registerLoginCommand } from "../src/login-command.ts";
import { credentialPath } from "../src/credentials.ts";
import { loginWithQr } from "@fukangz/core-bilibili-subtitles";
import { passthroughQueue } from "@fukangz/core-bilibili-subtitles";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Options = Parameters<typeof registerLoginCommand>[1];
const qrUrl = "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=temporary-key";
const cookie = { SESSDATA: "private-session", bili_jct: "private-csrf", DedeUserID: "12345" };

function harness(options: Options) {
  let command: Command | undefined;
  let view: (Component & { dispose?(): void }) | undefined;
  let width = 100;
  const terminal = { rows: 60 };
  const frames: string[][] = [];
  const notifications: Array<{ message: string; type: string }> = [];
  const events = new Map<string, () => void>();
  const render = () => {
    if (!view) return [];
    const lines = view.render(width);
    frames.push(lines);
    return lines;
  };
  registerLoginCommand({
    registerCommand(name: string, value: Command) { assert.equal(name, "bilibili-login"); command = value; },
    on(name: string, handler: () => void) { events.set(name, handler); },
  } as unknown as ExtensionAPI, options);
  const ctx = {
    mode: "tui",
    ui: {
      notify(message: string, type: string) { notifications.push({ message, type }); },
      custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => Component & { dispose?(): void }) {
        return new Promise((resolve) => {
          view = factory(
            { terminal, requestRender: render },
            { fg: (_color: string, value: string) => value },
            {},
            (result) => { view?.dispose?.(); resolve(result); },
          );
          render();
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  assert.ok(command);
  const registered = command;
  return {
    ctx, notifications, events, frames,
    run: (args = "") => registered.handler(args, ctx),
    input: (value: string) => view?.handleInput?.(value),
    render: (columns: number, rows: number) => { width = columns; terminal.rows = rows; return render(); },
  };
}

function pendingLogin() {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const login: typeof loginWithQr = async ({ signal, onProgress }) => {
    onProgress({ state: "waiting", url: qrUrl, expiresAt: Date.now() + 180_000 });
    started();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private-abort-detail")), { once: true });
    });
  };
  return { ready, login };
}

const unusedFetch: Options["fetch"] = async () => { throw new Error("不应发起请求"); };

test("登录命令贯通扫码协议与配置保存，不向界面输出 Cookie", async () => {
  const agent = await mkdtemp(path.join(tmpdir(), "bili-command-"));
  const responses = [
    new Response(JSON.stringify({ code: 0, data: { url: qrUrl, qrcode_key: "key" } })),
    new Response(JSON.stringify({ code: 0, data: { code: 86090 } })),
    new Response(JSON.stringify({ code: 0, data: { code: 0 } }), {
      headers: [["Set-Cookie", `SESSDATA=${cookie.SESSDATA}; Path=/`], ["Set-Cookie", `bili_jct=${cookie.bili_jct}; Path=/`], ["Set-Cookie", `DedeUserID=${cookie.DedeUserID}; Path=/`]],
    }),
  ];
  const h = harness({
    agentDir: agent, queue: passthroughQueue,
    fetch: async () => { const next = responses.shift(); assert.ok(next); return next; },
    login: (options) => loginWithQr({ ...options, sleep: async () => {} }),
  });
  try {
    await h.run();
    assert.deepEqual(JSON.parse(await readFile(credentialPath(agent), "utf8")), { cookie });
    assert.match(h.notifications[0]!.message, /登录成功/);
    assert.equal(h.notifications[0]!.type, "info");
    const display = JSON.stringify([h.frames, h.notifications]);
    assert.equal(display.includes(cookie.SESSDATA), false);
    assert.equal(display.includes(cookie.bili_jct), false);
    assert.equal(display.includes(qrUrl), false);
    assert.match(display, /等待扫码/);
    assert.match(display, /已扫码，请在手机上确认/);
    assert.ok(h.frames.some((lines) => lines.some((line) => line.includes("\x1b[0;30;47m"))));
    assert.ok(h.frames.every((lines) => lines.every((line) => visibleWidth(line) <= 100)));
  } finally {
    await rm(agent, { recursive: true, force: true });
  }
});

test("Esc、Ctrl+C 和 Pi 关闭都会中止登录并保留旧 Cookie", async () => {
  for (const action of ["escape", "ctrl+c", "shutdown"]) {
    const agent = await mkdtemp(path.join(tmpdir(), "bili-command-cancel-"));
    const file = path.join(agent, "bilibili-subtitles.json");
    const original = JSON.stringify({ cookie: { SESSDATA: "previous" } });
    await writeFile(file, original);
    const pending = pendingLogin();
    const h = harness({ agentDir: agent, queue: passthroughQueue, fetch: unusedFetch, login: pending.login });
    try {
      const run = h.run();
      await pending.ready;
      if (action === "shutdown") h.events.get("session_shutdown")!();
      else h.input(action === "escape" ? "\x1b" : "\x03");
      await run;
      assert.equal(await readFile(file, "utf8"), original);
      assert.match(h.notifications[0]!.message, /已取消/);
      assert.equal(JSON.stringify(h.notifications).includes("private"), false);
    } finally {
      await rm(agent, { recursive: true, force: true });
    }
  }
});

test("窗口过小不截断二维码；扩大后显示完整二维码", async () => {
  const pending = pendingLogin();
  const h = harness({ agentDir: "/unused", queue: passthroughQueue, fetch: unusedFetch, login: pending.login });
  const run = h.run();
  await pending.ready;
  const narrow = h.render(30, 60);
  assert.match(narrow.join(""), /扩大终端窗口/);
  assert.equal(narrow.some((line) => line.includes("\x1b[0;30;47m")), false);
  const short = h.render(100, 10);
  assert.match(short.join(""), /扩大终端窗口/);
  assert.equal(short.some((line) => line.includes("\x1b[0;30;47m")), false);
  const full = h.render(100, 60);
  assert.ok(full.some((line) => line.includes("\x1b[0;30;47m")));
  assert.ok(full.every((line) => visibleWidth(line) <= 100));
  h.input("\x1b");
  await run;
});

test("拒绝非交互模式、参数和重复登录；取消后可以重新登录", async () => {
  const pending = pendingLogin();
  const h = harness({ agentDir: "/unused", queue: passthroughQueue, fetch: unusedFetch, login: pending.login });
  h.ctx.mode = "rpc";
  await h.run();
  assert.match(h.notifications.at(-1)!.message, /交互式终端/);
  h.ctx.mode = "tui";
  await h.run("unexpected");
  assert.match(h.notifications.at(-1)!.message, /无需参数/);
  const first = h.run();
  await pending.ready;
  await h.run();
  assert.match(h.notifications.at(-1)!.message, /已有 B 站登录/);
  h.input("\x1b");
  await first;
  const count = h.notifications.length;
  const second = h.run();
  await Promise.resolve();
  h.input("\x03");
  await second;
  assert.equal(h.notifications.length, count + 1);
  assert.match(h.notifications.at(-1)!.message, /已取消/);
});

test("保存失败和未知异常只显示固定错误，不泄漏凭证", async () => {
  const agent = await mkdtemp(path.join(tmpdir(), "bili-command-error-"));
  const file = path.join(agent, "bilibili-subtitles.json");
  await writeFile(file, "invalid-config-private");
  try {
    const saveFailure = harness({ agentDir: agent, queue: passthroughQueue, fetch: unusedFetch, login: async () => cookie });
    await saveFailure.run();
    assert.equal(await readFile(file, "utf8"), "invalid-config-private");
    assert.match(saveFailure.notifications[0]!.message, /无法更新用户级凭证/);
    const failure = harness({ agentDir: agent, queue: passthroughQueue, fetch: unusedFetch, login: async () => { throw new Error(cookie.SESSDATA); } });
    await failure.run();
    assert.equal(failure.notifications[0]!.type, "error");
    assert.equal(JSON.stringify([failure.notifications, saveFailure.notifications]).includes("private"), false);
  } finally {
    await rm(agent, { recursive: true, force: true });
  }
});
