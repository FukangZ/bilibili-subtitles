import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, AssistantMessage, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { buildStreamOptions, createStageClient, readAssistantText, resolveSelection } from "../src/model.ts";
import { toPiUsage } from "../src/usage.ts";

function model(overrides: Partial<Model<Api>>): Model<Api> {
  return {
    id: "demo",
    name: "demo",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://example.test",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4000,
    maxTokens: 1000,
    ...overrides,
  };
}

function usage(): Usage {
  return { input: 3, output: 4, cacheRead: 1, cacheWrite: 0, totalTokens: 8, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function message(overrides: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "好" }],
    api: "openai-completions",
    provider: "openai",
    model: "demo",
    usage: usage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

test("显式模型缺失或未认证时不回退，off 不传 reasoning", () => {
  const session = model({ id: "session", provider: "anthropic" });
  assert.throws(
    () => resolveSelection({
      configuredProvider: "openai",
      configuredModel: "missing",
      sessionModel: session,
      sessionThinking: "high",
      findModel: () => undefined,
      hasConfiguredAuth: () => true,
    }),
    /MODEL_NOT_FOUND/,
  );
  assert.throws(
    () => resolveSelection({
      configuredProvider: "openai",
      configuredModel: "demo",
      sessionModel: session,
      sessionThinking: "high",
      findModel: () => model({ id: "demo" }),
      hasConfiguredAuth: () => false,
    }),
    /MODEL_AUTH_REQUIRED/,
  );
  const selected = resolveSelection({
    configuredThinking: "off",
    sessionModel: session,
    sessionThinking: "high",
    findModel: () => {
      throw new Error("不应查找");
    },
    hasConfiguredAuth: () => true,
  });
  assert.equal(selected.model, session);
  assert.equal(selected.effectiveThinking, "off");
  assert.equal(buildStreamOptions(selected, undefined, 5000).reasoning, undefined);
  assert.equal(buildStreamOptions(selected, undefined, 5000).maxRetries, 1);
});

test("显式不支持的思考强度报错，继承值则降级并记录", () => {
  const plain = model({ reasoning: false });
  assert.throws(
    () => resolveSelection({
      configuredThinking: "high" as ModelThinkingLevel,
      sessionModel: plain,
      sessionThinking: "off",
      findModel: () => undefined,
      hasConfiguredAuth: () => true,
    }),
    /INVALID_CONFIG/,
  );
  const lowered = resolveSelection({
    sessionModel: plain,
    sessionThinking: "high",
    findModel: () => undefined,
    hasConfiguredAuth: () => true,
  });
  assert.equal(lowered.effectiveThinking, "off");
  assert.match(lowered.warnings.join(" "), /已降为 off/);
  const extended = model({ thinkingLevelMap: { xhigh: "xhigh" } });
  assert.throws(
    () => resolveSelection({
      configuredThinking: "xhigh",
      sessionModel: model({}),
      sessionThinking: "low",
      findModel: () => undefined,
      hasConfiguredAuth: () => true,
    }),
    /INVALID_CONFIG/,
  );
  const inherited = resolveSelection({
    sessionModel: extended,
    sessionThinking: "max",
    findModel: () => undefined,
    hasConfiguredAuth: () => true,
  });
  assert.equal(inherited.effectiveThinking, "xhigh");
});

test("core 用量在 Pi 边界补齐未知费用，已报告详情保持不变", () => {
  const reported = { ...usage(), reasoning: 2, cacheWrite1h: 1 };
  assert.deepEqual(toPiUsage(reported), reported);
  const { cost: _cost, ...unknownCost } = reported;
  assert.deepEqual(toPiUsage(unknownCost), { ...unknownCost, cost: usage().cost });
  assert.equal("cost" in unknownCost, false);
});

test("每次请求可单独取消，也保留整个任务的取消信号", async () => {
  for (const abortTarget of ["request", "task"] as const) {
    const task = new AbortController();
    const request = new AbortController();
    let calls = 0;
    const client = createStageClient({
      selection: resolveSelection({ sessionModel: model({}), sessionThinking: "off", findModel: () => undefined, hasConfiguredAuth: () => true }),
      timeoutMs: 500, signal: task.signal,
      streamSimple: (_model, _context, options) => {
        calls += 1;
        return { result: () => new Promise<AssistantMessage>((_resolve, reject) => {
          assert.ok(options.signal);
          options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          (abortTarget === "task" ? task : request).abort();
        }) };
      },
    });
    await assert.rejects(() => client.complete({ system: "s", user: "u" }, request.signal), /CANCELLED/);
    await assert.rejects(() => client.complete({ system: "s", user: "u" }, request.signal), /CANCELLED/);
    assert.equal(calls, 1);
  }
});

test("认证失败经消息返回、同步抛出或异步拒绝都提示登录", async () => {
  for (const failureMode of ["message", "throw", "reject"] as const) {
    for (const detail of ["Not logged in", "unauthorized", "unauthenticated", "invalid api key", "authentication failed", "API key missing"]) {
      const client = createStageClient({
        selection: resolveSelection({ sessionModel: model({}), sessionThinking: "off", findModel: () => undefined, hasConfiguredAuth: () => true }),
        timeoutMs: 500,
        streamSimple: () => {
          if (failureMode === "throw") throw new Error(detail);
          return { result: async () => {
            if (failureMode === "reject") throw new Error(detail);
            return message({ stopReason: "error", errorMessage: detail });
          } };
        },
      });
      await assert.rejects(() => client.complete({ system: "s", user: "u" }), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "MODEL_AUTH_REQUIRED", `${failureMode}/${detail}`);
        assert.match(error.message, /请使用 \/login/);
        assert.ok("usage" in error);
        assert.deepEqual(error.usage, failureMode === "message" ? usage() : undefined);
        return true;
      });
    }
  }
});

test("截断、溢出、工具调用和空文本都不能当成正文", () => {
  assert.throws(() => readAssistantText(message({ stopReason: "length" }), 4000), /OUTPUT_TRUNCATED/);
  assert.throws(() => readAssistantText(message({ stopReason: "error", errorMessage: "prompt is too long: 9000 tokens > 4000 maximum" }), 4000), /INPUT_TOO_LARGE/);
  assert.throws(() => readAssistantText(message({ content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] }), 4000), /INVALID_MODEL_OUTPUT/);
  assert.throws(() => readAssistantText(message({ content: [] }), 4000), /INVALID_MODEL_OUTPUT/);
  const client = createStageClient({
    selection: resolveSelection({
      configuredThinking: "low",
      sessionModel: model({}),
      sessionThinking: "off",
      findModel: () => undefined,
      hasConfiguredAuth: () => true,
    }),
    timeoutMs: 42,
    streamSimple: (_model, context, options) => {
      assert.equal(context.messages.length, 1);
      assert.equal(context.systemPrompt, "系统");
      assert.equal("tools" in context, false);
      assert.equal("context" in context, false);
      assert.equal("context" in options, false);
      assert.doesNotMatch(JSON.stringify(context), /stage|attempt|structure|body/);
      assert.equal(options.reasoning, "low");
      assert.equal(options.toolChoice, "none");
      assert.equal(options.timeoutMs, 42);
      return { result: async () => message({}) };
    },
  });
  return client.complete({ system: "系统", user: "用户", context: { stage: "body", attempt: 2 } }).then((result) => {
    assert.equal(result.text, "好");
  });
});
