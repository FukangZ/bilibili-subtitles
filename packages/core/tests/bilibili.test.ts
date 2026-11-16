import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { downloadSubtitle, SubtitleError } from "@fukangz/core-bilibili-subtitles";

async function download(input: Pick<Parameters<typeof downloadSubtitle>[0], "fetch" | "sleep" | "signal">) {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-retry-"));
  try {
    return await downloadSubtitle({
      source: "BV1test",
      cwd,
      config: { polish: { timeoutMs: 120_000 } },
      ...input,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("HTTP 限流、服务异常和网络错误重试两次，业务错误和坏 JSON 不重试", async () => {
  const cases = [
    ...[412, 429, 500, 503].map((status) => ({
      name: `HTTP ${status}`,
      respond: () => new Response(null, { status }),
      code: status < 500 ? "RATE_LIMITED" : "NETWORK_ERROR",
      attempts: 3,
    })),
    { name: "network", respond: () => { throw new Error("private network detail"); }, code: "NETWORK_ERROR", attempts: 3 },
    ...[401, 404].map((status) => ({ name: `HTTP ${status}`, respond: () => new Response(null, { status }), code: "NETWORK_ERROR", attempts: 1 })),
    ...[[-101, "AUTH_REQUIRED"], [-403, "AUTH_REQUIRED"], [-352, "SIGNATURE_REQUIRED"], [-412, "RATE_LIMITED"], [-509, "RATE_LIMITED"]].map(([code, expected]) => ({
      name: `business ${code}`, respond: () => Response.json({ code }), code: expected, attempts: 1,
    })),
    { name: "invalid JSON", respond: () => new Response("not JSON"), code: "INVALID_RESPONSE", attempts: 1 },
    { name: "missing code", respond: () => Response.json({}), code: "INVALID_RESPONSE", attempts: 1 },
  ];
  for (const scenario of cases) {
    let calls = 0;
    const delays: number[] = [];
    await assert.rejects(() => download({
      fetch: async () => { calls += 1; return scenario.respond(); },
      sleep: async (ms) => { delays.push(ms); },
    }), (error: unknown) => {
      assert.ok(error instanceof SubtitleError);
      assert.equal(error.code, scenario.code, scenario.name);
      assert.doesNotMatch(error.message, /private network detail/);
      return true;
    });
    assert.equal(calls, scenario.attempts, scenario.name);
    assert.deepEqual(delays, scenario.attempts === 3 ? [200, 800] : [], scenario.name);
  }
});

test("下载请求的响应头和正文超时均按网络错误重试并保留超时分类", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    assert.equal(ms, 15_000);
    return timeout(5);
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    for (const bodyOnly of [false, true]) {
      let calls = 0;
      const delays: number[] = [];
      await assert.rejects(() => download({
        sleep: async (ms) => { delays.push(ms); },
        fetch: async (_url, init) => {
          calls += 1;
          const signal = init?.signal;
          assert.ok(signal);
          if (!bodyOnly) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("header timeout detail")), { once: true });
            });
          }
          return new Response(new ReadableStream({ start(stream) {
            stream.enqueue(new TextEncoder().encode('{"code":'));
            signal.addEventListener("abort", () => stream.error(new Error("body timeout detail")), { once: true });
          } }));
        },
      }), (error: unknown) => {
        assert.ok(error instanceof SubtitleError);
        assert.equal(error.code, "NETWORK_ERROR");
        assert.match(error.message, /请求超时/);
        assert.doesNotMatch(error.message, /timeout detail/);
        return true;
      });
      assert.equal(calls, 3);
      assert.deepEqual(delays, [200, 800]);
    }
  } finally {
    clearTimeout(keepAlive);
  }
});

test("下载重试等待收到取消时返回 CANCELLED，不再请求", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(() => download({
    signal: controller.signal,
    fetch: async () => {
      calls += 1;
      setImmediate(() => controller.abort());
      return new Response(null, { status: 429 });
    },
  }), (error: unknown) => {
    assert.ok(error instanceof SubtitleError);
    assert.equal(error.code, "CANCELLED");
    return true;
  });
  assert.equal(calls, 1);
});
