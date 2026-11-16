import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { apply, inject, name } from "../dist/index.js";
import { COOKIE_KEY } from "../dist/credentials.js";
import { createTools } from "../dist/tools.js";
import { SubtitleError } from "@fukangz/core-bilibili-subtitles";
import { exec, fakeHost, json, text, withDir } from "./helpers.ts";

const view = {
  code: 0,
  data: {
    bvid: "BV1test", aid: 7, title: "示例视频 空格（第一课），标点！", desc: "", pic: "https://example.test/c.jpg", pubdate: 1_700_000_000, duration: 4,
    owner: { mid: 3, name: "作者" }, stat: { view: 1, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
    pages: [{ cid: 11, page: 1, part: "正片", duration: 4 }],
  },
};
const player = { code: 0, data: { subtitle: { subtitles: [{ id: 1, lan: "zh-CN", lan_doc: "中文", subtitle_url: "https://i0.hdslb.com/a.json", author_mid: 1 }] } } };
const cues = { body: [{ from: 0, to: 1, content: "开头介绍主题。" }, { from: 61, to: 62, content: "进入第一章。" }] };

function biliFetch(seen: Array<{ url: string; cookie: string | null }> = []) {
  return async (url: string, init?: RequestInit) => {
    seen.push({ url, cookie: new Headers(init?.headers).get("cookie") });
    if (url.includes("/view?")) return json(view);
    if (url.includes("/wbi/v2")) return json(player);
    return json(cues);
  };
}

const structure = JSON.stringify({ title: "文章", sections: [{ kind: "intro", startSegmentId: 1 }, { kind: "chapter", heading: "第一章", level: 2, startSegmentId: 2 }] });
const bodies = JSON.stringify({ sections: [{ id: "section-1", text: "开头介绍主题。" }, { id: "section-2", text: "进入第一章。" }] });

test("入口不依赖命令服务，仅注册两个工具与配置页登录路由", async () => {
  await withDir(async (cwd) => {
    assert.equal(name, "bilibili-subtitles");
    assert.ok(inject.includes("credentials"));
    assert.ok(!inject.includes("commands"));
    const host = fakeHost({ cwd });
    apply(host.ctx, { get: () => ({}) });
    assert.deepEqual([...host.tools.keys()], ["bilibili_download_subtitle", "bilibili_polish_subtitle"]);
    assert.deepEqual([...host.routes.keys()].sort(), [
      "/api/bilibili-subtitles/account/logout",
      "/api/bilibili-subtitles/account/status",
      "/api/bilibili-subtitles/login/cancel",
      "/api/bilibili-subtitles/login/poll",
      "/api/bilibili-subtitles/login/start",
    ]);
    assert.equal("commands" in host.ctx, false);
  });
});

test("实际工具定义约束调用、原样路径和默认简短交付", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd });
    apply(host.ctx, { get: () => ({}) });
    const download = host.tools.get("bilibili_download_subtitle")!;
    const polish = host.tools.get("bilibili_polish_subtitle")!;
    assert.match(download.description, /无中文字幕.*报告原因.*语音识别.*翻译/);
    assert.match(download.description, /仅.*用户要求.*润色.*文章/);
    for (const tool of [download, polish]) {
      assert.match(tool.description, /默认.*路径.*简短统计/);
      assert.match(tool.description, /不主动读取全文.*不自行编辑/);
      assert.match(tool.description, /用户.*要求.*检查.*讨论/);
      assert.match(tool.description, /dsh 插件设置页/);
    }
    assert.match(polish.description, /原始字幕 Markdown.*旧 JSON/);
    assert.match(polish.description, /失败.*分类.*阶段.*不.*重复整条/);
    assert.match(polish.parameters.properties?.transcriptPath.description ?? "", /原样.*transcriptPath.*空格.*中文.*标点.*不.*重建路径/);
    assert.equal("promptGuidelines" in download, false);
    assert.equal("promptGuidelines" in polish, false);
  });
});

test("下载经 ctx.fs 写入工作目录，Cookie 只发给 API，渲染摘要", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd });
    host.records.set(COOKIE_KEY, { kind: "grant", payload: { SESSDATA: "secret-session", bili_jct: "jct-value", DedeUserID: "42" } });
    const seen: Array<{ url: string; cookie: string | null }> = [];
    const [download] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch(seen) as typeof fetch });
    const result = (await download.execute({ source: "BV1test" }, exec())) as { transcriptPath: string; segmentCount: number };
    assert.equal(result.segmentCount, 2);
    assert.match(result.transcriptPath, /^\.subtitles\//);
    const custom = (await download.execute({ source: "BV1test", outputDir: "out" }, exec())) as { transcriptPath: string };
    assert.match(custom.transcriptPath, /^out\//);
    const saved = await readFile(path.join(cwd, result.transcriptPath), "utf8");
    assert.match(saved, /开头介绍主题/);
    assert.doesNotMatch(saved, /secret-session/);
    assert.deepEqual(host.writes.map((w) => w.policy), [{ policy: "session" }, { policy: "session" }]);
    for (const request of seen) {
      if (request.url.includes("hdslb.com")) assert.equal(request.cookie, null);
      else assert.match(request.cookie ?? "", /SESSDATA=secret-session/);
    }
    const rendered = download.output.render({}, custom)[0].text;
    assert.match(rendered, /^已下载字幕。/);
    assert.match(rendered, /transcriptPath: out\//);
  });
});

test("参数校验拒绝未知字段和非法分P", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd });
    const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
    await assert.rejects(download.execute({ source: "BV1test", page: 0 }, exec()), /^Error: INVALID_INPUT: page/);
    await assert.rejects(download.execute({ source: "BV1test", extra: 1 }, exec()), /INVALID_INPUT: 不支持的参数：extra/);
    await assert.rejects(polish.execute({}, exec()), /INVALID_INPUT: transcriptPath/);
  });
});

test("润色跟随会话模型，两阶段写出文章并汇总用量", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd, streams: [text(structure), text(bodies)] });
    const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
    const downloaded = (await download.execute({ source: "BV1test" }, exec())) as { transcriptPath: string };
    const result = (await polish.execute({ transcriptPath: downloaded.transcriptPath }, exec())) as {
      outputPath: string; model: string; thinking?: string; usage: { input: number; output: number; cacheRead: number };
    };
    assert.match(downloaded.transcriptPath, /示例视频 空格（第一课），标点！/);
    assert.equal(result.model, "demo/flash");
    assert.equal(result.thinking, "high");
    assert.deepEqual([result.usage.input, result.usage.output, result.usage.cacheRead], [20, 10, 4]);
    assert.equal(host.calls.length, 2);
    assert.deepEqual(host.calls[0].selection, { provider: "demo", model: "flash", reasoningEffort: "high" });
    assert.equal(host.calls[0].options.sessionId, "session-1");
    assert.equal(host.calls[0].options.purpose, "bilibili-polish");
    for (const call of host.calls) {
      assert.equal("context" in call.options, false);
      assert.doesNotMatch(JSON.stringify(call.options.messages), /"stage"|"attempt"/);
    }
    const written = host.writes.length;
    await assert.rejects(polish.execute({ transcriptPath: downloaded.transcriptPath.replaceAll(" ", "") }, exec()), /INVALID_INPUT/);
    assert.equal(host.calls.length, 2);
    assert.equal(host.writes.length, written);
    const article = await readFile(path.join(cwd, result.outputPath), "utf8");
    assert.match(article, /第一章/);
    const rendered = polish.output.render({}, result)[0].text;
    assert.match(rendered, /用量：输入 20，输出 10，缓存读 4/);
  });
});

test("配置覆盖模型；只填 provider 时报 INVALID_CONFIG", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd, streams: [text(structure), text(bodies)] });
    let snapshot: Record<string, unknown> = { provider: "other", model: "pro", reasoningEffort: "low" };
    const [download, polish] = createTools({ ctx: host.ctx, config: () => snapshot, fetch: biliFetch() as typeof fetch });
    const downloaded = (await download.execute({ source: "BV1test" }, exec())) as { transcriptPath: string };
    await polish.execute({ transcriptPath: downloaded.transcriptPath }, exec());
    assert.deepEqual(host.calls[0].selection, { provider: "other", model: "pro", reasoningEffort: "low" });
    snapshot = { provider: "other" };
    await assert.rejects(
      polish.execute({ transcriptPath: downloaded.transcriptPath }, exec()),
      /INVALID_CONFIG: provider 和 model 必须同时填写.*dsh 插件设置页/,
    );
  });
});

test("模型被截断时报错并附带已产生的用量", async () => {
  await withDir(async (cwd) => {
    const truncated = [
      { type: "text-delta", text: "{" },
      { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } },
      { type: "finish", reason: { kind: "max-tokens" } },
    ];
    const host = fakeHost({ cwd, streams: [truncated] });
    const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
    const downloaded = (await download.execute({ source: "BV1test" }, exec())) as { transcriptPath: string };
    await assert.rejects(polish.execute({ transcriptPath: downloaded.transcriptPath }, exec()), (error: Error & { usage?: { input: number } }) => {
      assert.match(error.message, /^OUTPUT_TRUNCATED: 模型输出被截断/);
      assert.match(error.message, /截至失败已报告用量：输入 7，输出 3/);
      assert.equal(error.usage?.input, 7);
      return true;
    });
  });
});

test("prepare 抛错、stream 抛错和流内失败统一限流诊断且不重试", async () => {
  for (const entry of ["prepare", "stream", "finish"] as const) {
    await withDir(async (cwd) => {
      const failure = { code: "RATE_LIMIT", status: 429, providerRetryAfterMs: 2000, message: "fake-secret", requestId: "fake-secret" };
      const upstream = Object.assign(new Error("fake-secret"), { code: "AUTH", failure, details: { secret: "fake-secret" }, cause: "fake-secret" });
      const host = fakeHost({ cwd,
        prepare: entry === "prepare" ? async () => { throw upstream; } : undefined,
        streams: entry === "stream" ? [async function* () { throw upstream; }] : [[{ type: "finish", reason: { kind: "error", failure } }]],
      });
      const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
      const downloaded = (await download.execute({ source: "BV1test" }, exec())) as { transcriptPath: string };
      const before = host.writes.length;
      await assert.rejects(polish.execute({ transcriptPath: downloaded.transcriptPath }, exec()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^RATE_LIMITED:/);
        assert.match(error.message, /阶段.*structure.*尝试.*1/);
        assert.match(error.message, /RATE_LIMIT.*429.*2000/);
        assert.match(error.message, /未收到用量报告，不能据此判断是否计费/);
        assert.deepEqual((error as Error & { details?: unknown }).details, { diagnostic: {
          stage: "structure", attempt: 1, operation: entry === "prepare" ? "prepare" : "stream",
          reason: "upstream", hostCode: "RATE_LIMIT", httpStatus: 429, retryAfterMs: 2000,
        } });
        assert.doesNotMatch(error.message + JSON.stringify(error), /fake-secret|requestId/);
        return true;
      });
      assert.equal(host.prepares.length, 1);
      assert.equal(host.writes.length, before);
    });
  }
});

test("已确认的宿主错误分类在三种入口一致，未知代码不凭 HTTP 或错误正文猜测", async () => {
  const mappings = [
    ["INVALID_CREDENTIAL", "MODEL_AUTH_REQUIRED"], ["MISSING_CREDENTIAL", "MODEL_AUTH_REQUIRED"], ["AUTH", "MODEL_AUTH_REQUIRED"],
    ["CONTEXT_WINDOW_EXCEEDED", "INPUT_TOO_LARGE"], ["QUOTA", "MODEL_REQUEST_REJECTED"],
    ["ACCOUNT_QUOTA", "MODEL_REQUEST_REJECTED"], ["NO_ADAPTER", "MODEL_REQUEST_REJECTED"],
    ["EMPTY_RESPONSE", "INVALID_MODEL_OUTPUT"], ["PI_AI_ERROR", "MODEL_ERROR"], ["secret-unknown", "MODEL_ERROR"],
  ];
  for (const [code, expected] of mappings) {
    for (const entry of ["prepare", "stream", "finish"] as const) {
      await withDir(async (cwd) => {
        const failure = { code, status: 429, providerRetryAfterMs: 0, message: "secret RATE_LIMIT", cause: { code: "AUTH" } };
        const host = fakeHost({ cwd,
          prepare: entry === "prepare" ? async () => { throw Object.assign(new Error("secret"), failure); } : undefined,
          streams: entry === "stream" ? [async function* () { throw { failure }; }] : [[{ type: "finish", reason: { kind: "error", failure } }]],
        });
        const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
        const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
        await assert.rejects(polish.execute({ transcriptPath }, exec()), (error: unknown) => {
          assert.ok(error instanceof SubtitleError);
          assert.equal(error.code, expected, `${entry}/${code}`);
          assert.deepEqual(error.details, { diagnostic: {
            stage: "structure", attempt: 1, operation: entry === "prepare" ? "prepare" : "stream", reason: "upstream",
            ...(code === "secret-unknown" ? {} : { hostCode: code }), httpStatus: 429, retryAfterMs: 0,
          } });
          assert.doesNotMatch(error.message + JSON.stringify(error), /secret|bilibili-login/);
          return true;
        });
        assert.equal(host.prepares.length, 1);
        assert.equal(host.writes.length, 1);
      });
    }
  }
});

test("受控模型错误保留分类，但错误出口只接受白名单字段和有效数值", async () => {
  await withDir(async (cwd) => {
    const failure = new SubtitleError("INVALID_MODEL_OUTPUT", "secret-provider-message", {
      secret: "secret-details",
      diagnostic: { stage: "secret-stage", attempt: 9, operation: "secret-operation", reason: "secret-reason", hostCode: "secret-host", httpStatus: 600, retryAfterMs: -1, requestId: "secret-request" },
    });
    const host = fakeHost({ cwd, streams: [async function* () { throw failure; }] });
    const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
    const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
    await assert.rejects(polish.execute({ transcriptPath }, exec()), (error: unknown) => {
      assert.ok(error instanceof SubtitleError);
      assert.equal(error.code, "INVALID_MODEL_OUTPUT");
      assert.deepEqual(error.details, { diagnostic: { stage: "structure", attempt: 1, operation: "stream" } });
      assert.doesNotMatch(error.message + JSON.stringify(error), /secret/);
      return true;
    });
  });
});

test("诊断数值只公开有效范围的整数，缺失或无效字段不补零", async () => {
  const cases = [
    { status: 100, wait: 0, expected: { httpStatus: 100, retryAfterMs: 0 } },
    { status: 599, wait: Number.MAX_SAFE_INTEGER, expected: { httpStatus: 599, retryAfterMs: Number.MAX_SAFE_INTEGER } },
    ...[undefined, null, "429", 99, 600, 429.5, NaN, Infinity].map((status, i) => ({
      status, wait: [undefined, null, "2000", -1, Number.MAX_SAFE_INTEGER + 1, 0.5, NaN, Infinity][i], expected: {},
    })),
  ];
  for (const { status, wait, expected } of cases) {
    await withDir(async (cwd) => {
      const host = fakeHost({ cwd, streams: [[{ type: "finish", reason: { kind: "error", failure: { code: "RATE_LIMIT", status, providerRetryAfterMs: wait } } }]] });
      const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
      const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
      await assert.rejects(polish.execute({ transcriptPath }, exec()), (error: unknown) => {
        assert.ok(error instanceof SubtitleError);
        assert.equal(error.code, "RATE_LIMITED");
        assert.deepEqual(error.details, { diagnostic: { stage: "structure", attempt: 1, operation: "stream", reason: "upstream", hostCode: "RATE_LIMIT", ...expected } });
        return true;
      });
    });
  }
});

test("没有会话或配置模型时仍为 MODEL_NOT_FOUND，且不发请求", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd });
    const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
    const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
    const execution = { callId: "no-model", signal: new AbortController().signal };
    await assert.rejects(polish.execute({ transcriptPath }, execution), /MODEL_NOT_FOUND: 当前会话没有模型/);
    assert.equal(host.prepares.length, 0);
    assert.equal(host.writes.length, 1);
  });
});

test("正文失败和格式修复失败累计已报告用量，同一请求的重复快照不重计", async () => {
  for (const mode of ["body", "structure-repair", "body-repair"] as const) {
    await withDir(async (cwd) => {
      const failed = async function* () {
        yield { type: "usage", usage: { inputTokens: 9, outputTokens: 4 } };
        yield { type: "usage", usage: { inputTokens: 9, outputTokens: 4 } };
        throw { failure: { code: "PI_AI_ERROR", message: "secret" } };
      };
      const streams = mode === "body" ? [text(structure), failed] : mode === "structure-repair" ? [text("invalid JSON"), failed] : [text(structure), text("invalid JSON"), failed];
      const host = fakeHost({ cwd, streams });
      const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
      const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
      await assert.rejects(polish.execute({ transcriptPath }, exec()), (error: unknown) => {
        assert.ok(error instanceof SubtitleError);
        assert.equal(error.code, "MODEL_ERROR");
        assert.deepEqual(error.details, { diagnostic: {
          stage: mode === "structure-repair" ? "structure" : "body", attempt: mode === "body" ? 1 : 2,
          operation: "stream", reason: "upstream", hostCode: "PI_AI_ERROR",
        } });
        assert.deepEqual(error.usage, mode === "body-repair"
          ? { input: 29, output: 14, cacheRead: 4, cacheWrite: 0, totalTokens: 47 }
          : { input: 19, output: 9, cacheRead: 2, cacheWrite: 0, totalTokens: 30 });
        assert.match(error.message, /截至失败已报告用量/);
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret|未收到用量报告/);
        return true;
      });
      assert.equal(host.prepares.length, mode === "body-repair" ? 3 : 2);
      assert.equal(host.writes.length, 1);
    });
  }
});

test("结构或正文两次校验失败暴露终态上下文，空文本不会触发格式修复", async () => {
  for (const mode of ["structure", "body", "empty", "aborted", "zero"] as const) {
    await withDir(async (cwd) => {
      const invalid = text("secret invalid JSON");
      const streams = mode === "body" ? [text(structure), invalid, invalid] : mode === "structure" ? [invalid, invalid]
        : mode === "aborted" ? [[{ type: "finish", reason: { kind: "aborted" } }]]
        : mode === "zero" ? [[{ type: "usage", usage: { inputTokens: 0, outputTokens: 0 } }, { type: "finish", reason: { kind: "error" } }]]
        : [[{ type: "text-delta", text: "  " }, { type: "finish", reason: { kind: "stop" } }]];
      const host = fakeHost({ cwd, streams });
      const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
      const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
      await assert.rejects(polish.execute({ transcriptPath }, exec()), (error: unknown) => {
        assert.ok(error instanceof SubtitleError);
        assert.equal(error.code, mode === "aborted" || mode === "zero" ? "MODEL_ERROR" : "INVALID_MODEL_OUTPUT");
        assert.deepEqual(error.details, { diagnostic: {
          stage: mode === "body" ? "body" : "structure", attempt: mode === "structure" || mode === "body" ? 2 : 1,
          operation: mode === "structure" || mode === "body" ? "validate" : "stream",
          reason: mode === "aborted" || mode === "zero" ? "upstream" : "invalid_output",
        } });
        if (mode === "zero") {
          assert.equal(error.usage?.totalTokens, 0);
          assert.equal(error.usage?.cost, undefined);
          assert.match(error.message, /截至失败已报告用量/);
        }
        if (mode === "empty" || mode === "aborted") assert.equal(error.usage, undefined);
        assert.doesNotMatch(error.message + JSON.stringify(error), /secret/);
        return true;
      });
      assert.equal(host.prepares.length, mode === "body" ? 3 : mode === "structure" ? 2 : 1);
      assert.equal(host.writes.length, 1);
    });
  }
});

test("取消优先于 deadline 和上游异常，两种等待入口均保留用量且不写文章", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const entry of ["prepare", "stream"] as const) {
    for (const mode of ["cancel", "timeout", "both"] as const) {
      await withDir(async (cwd) => {
        const controller = new AbortController();
        let enter: (() => void) | undefined;
        const entered = new Promise<void>((resolve) => { enter = resolve; });
        const wait = async (signal: AbortSignal) => {
          if (mode === "both") signal.addEventListener("abort", () => controller.abort(), { once: true });
          const aborted = once(signal, "abort");
          enter?.();
          await aborted;
          throw { code: "AUTH", message: "secret" };
        };
        const host = fakeHost({ cwd,
          prepare: entry === "prepare" ? async (_selection, signal) => wait(signal!) : undefined,
          streams: [async function* (options) {
            yield { type: "usage", usage: { inputTokens: 7, outputTokens: 3 } };
            await wait(options.signal!);
          }],
        });
        const [download, polish] = createTools({ ctx: host.ctx, config: () => ({ timeoutMs: 1000 }), fetch: biliFetch() as typeof fetch });
        const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
        const result = assert.rejects(polish.execute({ transcriptPath }, exec(controller.signal)), (error: unknown) => {
          assert.ok(error instanceof SubtitleError);
          assert.equal(error.code, mode === "timeout" ? "MODEL_ERROR" : "CANCELLED");
          assert.deepEqual(error.details, { diagnostic: {
            stage: "structure", attempt: 1, operation: entry, ...(mode === "timeout" ? { reason: "timeout" } : {}),
          } });
          assert.equal(error.usage?.input, entry === "stream" ? 7 : undefined);
          assert.equal(error.usage?.cost, undefined);
          assert.doesNotMatch(error.message + JSON.stringify(error), /secret|AUTH/);
          return true;
        });
        await entered;
        if (mode === "cancel") controller.abort();
        else t.mock.timers.tick(1000);
        await result;
        assert.equal(host.prepares.length, 1);
        assert.equal(host.writes.length, 1);
      });
    }
  }
});

test("成功或上游失败结束后清理 deadline，结束的请求不会被迟到的定时器取消", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const succeeds of [true, false]) {
    await withDir(async (cwd) => {
      const host = fakeHost({ cwd, streams: succeeds ? [text(structure), text(bodies)] : [[{ type: "finish", reason: { kind: "error", failure: { code: "AUTH" } } }]] });
      const [download, polish] = createTools({ ctx: host.ctx, config: () => ({ timeoutMs: 1000 }), fetch: biliFetch() as typeof fetch });
      const { transcriptPath } = await download.execute({ source: "BV1test" }, exec()) as { transcriptPath: string };
      if (succeeds) await polish.execute({ transcriptPath }, exec());
      else await assert.rejects(polish.execute({ transcriptPath }, exec()), /MODEL_AUTH_REQUIRED/);
      t.mock.timers.tick(1001);
      for (const call of host.prepares) assert.equal(call.signal?.aborted, false);
    });
  }
});

test("需要登录时仅提示插件设置页扫码登录，错误信息不含 Cookie", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd });
    host.records.set(COOKIE_KEY, { kind: "grant", payload: { SESSDATA: "secret-session" } });
    const fetch = async (url: string) => {
      if (url.includes("/view?")) return json(view);
      return json({ code: -101, message: "账号未登录 secret-session" });
    };
    const [download] = createTools({ ctx: host.ctx, config: () => ({}), fetch: fetch as typeof globalThis.fetch });
    await assert.rejects(download.execute({ source: "BV1test" }, exec()), (error: Error) => {
      assert.match(error.message, /AUTH_REQUIRED/);
      assert.match(error.message, /dsh 插件设置页.*扫码登录/);
      assert.doesNotMatch(error.message, /secret-session|bilibili-login|bilibili-logout/);
      return true;
    });
  });
});

test("取消信号传给润色并报 CANCELLED", async () => {
  await withDir(async (cwd) => {
    const host = fakeHost({ cwd, streams: [text(structure)] });
    const [download, polish] = createTools({ ctx: host.ctx, config: () => ({}), fetch: biliFetch() as typeof fetch });
    const downloaded = (await download.execute({ source: "BV1test" }, exec())) as { transcriptPath: string };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(polish.execute({ transcriptPath: downloaded.transcriptPath }, exec(controller.signal)), /CANCELLED/);
    assert.equal(host.calls.length, 0);
  });
});
