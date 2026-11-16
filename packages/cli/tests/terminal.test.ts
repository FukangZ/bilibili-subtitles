import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { question } from "../dist/terminal.js";

function terminal() {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode: boolean) { this.isRaw = mode; } });
  const stderr = Object.assign(new PassThrough(), { isTTY: true });
  let text = "";
  stderr.on("data", (value) => { text += value; });
  stdin.pause();
  return { stdin, stderr, text: () => text };
}

test("隐藏输入支持退格，不回显 API key，恢复终端模式与暂停状态", async () => {
  const io = terminal();
  const pending = question(io, "API key：", { hidden: true });
  assert.equal(io.stdin.isRaw, true);
  io.stdin.write("private-valueX\x7f\r");
  assert.equal(await pending, "private-value");
  assert.doesNotMatch(io.text(), /private/);
  assert.equal(io.stdin.isRaw, false);
  assert.equal(io.stdin.isPaused(), true);
  const next = question(io, "模型：");
  io.stdin.write("demo\r");
  assert.equal(await next, "demo");
  assert.match(io.text(), /demo/);
});

test("Ctrl+C 与 AbortSignal 都取消输入并清理监听器", async () => {
  for (const signalMode of [false, true]) {
    const io = terminal();
    const controller = new AbortController();
    const pending = question(io, "key：", { hidden: true, signal: controller.signal });
    if (signalMode) controller.abort(); else io.stdin.write("\x03");
    await assert.rejects(() => pending, /CANCELLED/);
    assert.equal(io.stdin.listenerCount("keypress"), 0);
    assert.equal(io.stdin.isRaw, false);
  }
});
