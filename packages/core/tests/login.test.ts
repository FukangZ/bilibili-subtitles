import assert from "node:assert/strict";
import { test } from "node:test";
import type { FetchLike } from "@fukangz/core-bilibili-subtitles";
import { loginWithQr, type LoginProgress } from "@fukangz/core-bilibili-subtitles";

const qrUrl = "https://account.bilibili.com/h5/account-h5/auth/scan-web?auth_code=qr-secret";
const cookieHeaders = [
  "SESSDATA=session%2Cencoded; Domain=.bilibili.com; Path=/; HttpOnly; Secure",
  "bili_jct=csrf-secret; Domain=.bilibili.com; Path=/",
  "DedeUserID=12345; Domain=.bilibili.com; Path=/",
  "unrelated=ignored; Path=/",
];

function response(data: unknown, cookies: string[] = [], code = 0): Response {
  const headers = new Headers();
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify({ code, message: "server-secret", data }), { headers });
}

function generated(url = qrUrl): Response {
  return response({ url, qrcode_key: "qr-key" });
}

function sequence(responses: Response[], calls: Array<{ url: string; init?: RequestInit }> = []): FetchLike {
  return async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    assert.ok(next, "发生了预期外的请求");
    return next;
  };
}

const noSleep = async () => {};

test("扫码后继续等待确认，只从成功响应的 Set-Cookie 读取完整凭证", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const progress: LoginProgress[] = [];
  const cookie = await loginWithQr({
    fetch: sequence([
      generated(),
      response({ code: 86101 }),
      response({ code: 86090 }, ["SESSDATA=not-confirmed"]),
      response({ code: 0, url: "https://example.test/?SESSDATA=wrong", refresh_token: "refresh-secret" }, cookieHeaders),
    ], calls),
    signal: new AbortController().signal,
    onProgress: (value) => progress.push(value),
    sleep: noSleep,
  });
  assert.deepEqual(cookie, { SESSDATA: "session%2Cencoded", bili_jct: "csrf-secret", DedeUserID: "12345" });
  assert.deepEqual(progress.map((item) => item.state), ["generating", "waiting", "waiting", "scanned"]);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(new URL(call.url).origin, "https://passport.bilibili.com");
    assert.equal(new Headers(call.init?.headers).has("Cookie"), false);
    assert.equal(call.init?.redirect, "manual");
    assert.equal(call.init?.credentials, "omit");
  }
  assert.equal(new URL(calls[1]!.url).searchParams.get("qrcode_key"), "qr-key");
  assert.equal(JSON.stringify(progress).includes("session%2Cencoded"), false);
  assert.equal(JSON.stringify(progress).includes("refresh-secret"), false);
});

test("接口报告二维码过期后不再轮询", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await assert.rejects(() => loginWithQr({
    fetch: sequence([generated(), response({ code: 86038 })], calls),
    signal: new AbortController().signal,
    onProgress() {},
    sleep: noSleep,
  }), /LOGIN_EXPIRED/);
  assert.equal(calls.length, 2);
});

test("本地有效期到达时停止等待，不继续请求", async () => {
  let time = 100;
  let calls = 0;
  await assert.rejects(() => loginWithQr({
    fetch: async () => { calls += 1; return generated(); },
    signal: new AbortController().signal,
    onProgress() {},
    now: () => time,
    lifetimeMs: 10,
    sleep: async (ms) => { assert.equal(ms, 10); time += ms; },
  }), /LOGIN_EXPIRED/);
  assert.equal(calls, 1);
});

test("取消等待后不再请求；请求中取消也只返回 CANCELLED", async () => {
  const controller = new AbortController();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await assert.rejects(() => loginWithQr({
    fetch: sequence([generated()], calls),
    signal: controller.signal,
    onProgress() {},
    sleep: async () => { controller.abort(); throw new Error("private cancellation detail"); },
  }), /CANCELLED/);
  assert.equal(calls.length, 1);

  const inFlight = new AbortController();
  await assert.rejects(() => loginWithQr({
    fetch: async (_url, init) => {
      inFlight.abort();
      assert.equal(init?.signal?.aborted, true);
      throw new Error("request-secret");
    },
    signal: inFlight.signal,
    onProgress() {},
  }), /CANCELLED/);
});

test("同时兼容当前 account 域名和旧版 passport 二维码链接", async () => {
  for (const url of [qrUrl, "https://passport.bilibili.com/h5-app/passport/login/scan?auth_code=legacy-key"]) {
    const progress: LoginProgress[] = [];
    await loginWithQr({
      fetch: sequence([generated(url), response({ code: 0 }, cookieHeaders)]),
      signal: new AbortController().signal,
      onProgress: (value) => progress.push(value),
      sleep: noSleep,
    });
    assert.ok(progress.some((value) => value.state === "waiting" && value.url === url));
  }
});

test("二维码链接只允许 B 站 HTTPS 登录域名", async () => {
  for (const url of ["http://passport.bilibili.com/scan", "https://evil.test/scan", "https://passport.bilibili.com.evil.test/scan", "https://account.bilibili.com.evil.test/scan", "https://user:password@passport.bilibili.com/scan", "https://passport.bilibili.com:444/scan"]) {
    await assert.rejects(() => loginWithQr({
      fetch: sequence([generated(url)]),
      signal: new AbortController().signal,
      onProgress() {},
      sleep: noSleep,
    }), /INVALID_RESPONSE/);
  }
});

test("Cookie 缺失或包含无效值时拒绝成功，不泄漏返回内容", async () => {
  for (const cookies of [[], cookieHeaders.slice(0, 2), [...cookieHeaders, "SESSDATA=session-secret,malformed"]]) {
    await assert.rejects(() => loginWithQr({
      fetch: sequence([generated(), response({ code: 0 }, cookies)]),
      signal: new AbortController().signal,
      onProgress() {},
      sleep: noSleep,
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /INVALID_RESPONSE/);
      assert.equal(error.message.includes("session-secret"), false);
      return true;
    });
  }
});

test("拒绝重定向、限流、异常响应，错误不包含服务端信息或 Cookie", async () => {
  const cases: Array<[Response, RegExp]> = [
    [new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }), /NETWORK_ERROR/],
    [new Response("secret", { status: 429 }), /RATE_LIMITED/],
    [response({}, [], -412), /RATE_LIMITED/],
    [response({}, [], -1), /LOGIN_FAILED/],
    [new Response("invalid-json-secret"), /INVALID_RESPONSE/],
    [response({}), /INVALID_RESPONSE/],
  ];
  for (const [first, expected] of cases) {
    await assert.rejects(() => loginWithQr({
      fetch: sequence([first]),
      signal: new AbortController().signal,
      onProgress() {},
      sleep: noSleep,
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, expected);
      assert.equal(error.message.includes("secret"), false);
      return true;
    });
  }
});

test("单次请求超时覆盖响应头等待和正文读取，错误不包含底层内容", async () => {
  // AbortSignal.timeout() 的计时器不保持事件循环；为测试中的模拟请求保留一个句柄。
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    for (const bodyOnly of [false, true]) {
      await assert.rejects(() => loginWithQr({
        signal: new AbortController().signal,
        requestTimeoutMs: 5,
        onProgress() {},
        fetch: async (_url, init) => {
          const signal = init?.signal;
          assert.ok(signal);
          if (!bodyOnly) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener("abort", () => reject(new Error("timeout-private-detail")), { once: true });
            });
          }
          return new Response(new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"code":'));
              signal.addEventListener("abort", () => stream.error(new Error("body-private-detail")), { once: true });
            },
          }));
        },
      }), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /NETWORK_ERROR/);
        assert.equal(error.message.includes("private"), false);
        return true;
      });
    }
  } finally {
    clearTimeout(keepAlive);
  }
});

test("开始前取消不发请求，成功响应到达时取消也不返回凭证", async () => {
  let calls = 0;
  const before = new AbortController();
  before.abort();
  await assert.rejects(() => loginWithQr({
    fetch: async () => { calls += 1; return generated(); },
    signal: before.signal,
    onProgress() {},
  }), /CANCELLED/);
  assert.equal(calls, 0);
  const confirmed = new AbortController();
  await assert.rejects(() => loginWithQr({
    fetch: async () => {
      calls += 1;
      if (calls === 1) return generated();
      confirmed.abort();
      return response({ code: 0 }, cookieHeaders);
    },
    signal: confirmed.signal,
    sleep: noSleep,
    onProgress() {},
  }), /CANCELLED/);
  assert.equal(calls, 2);
});

test("未知登录状态失败，网络异常不输出原始错误", async () => {
  await assert.rejects(() => loginWithQr({
    fetch: sequence([generated(), response({ code: 123456 })]),
    signal: new AbortController().signal,
    onProgress() {},
    sleep: noSleep,
  }), /LOGIN_FAILED/);
  await assert.rejects(() => loginWithQr({
    fetch: async () => { throw new Error("SESSDATA=private-session"); },
    signal: new AbortController().signal,
    onProgress() {},
  }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /NETWORK_ERROR/);
    assert.equal(error.message.includes("private-session"), false);
    return true;
  });
});
