import assert from "node:assert/strict";
import { test } from "node:test";
import { createStageClient } from "../dist/client.js";
import { requireModelConfig } from "../dist/config.js";

function config(api: "openai-completions" | "openai-responses" | "anthropic-messages" = "openai-completions") {
  return requireModelConfig({ api, baseUrl: api === "anthropic-messages" ? "https://models.example" : "https://models.example/v1", model: "demo-model", apiKey: "private-api-key", contextWindow: 32000, maxTokens: 4096, timeoutMs: 1000 });
}
function event(type: string, data: unknown): string { return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`; }
function chat(text: string, finishReason = "stop", usage?: object): Response {
  const chunk = { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
  const final = { choices: [{ index: 0, delta: {}, finish_reason: finishReason }], ...(usage ? { usage } : {}) };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(final)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
function responses(text: string, status: "completed" | "incomplete" = "completed"): Response {
  const output = [{ id: "msg1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }];
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { id: "msg1", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item: output[0] },
    { type: `response.${status}`, response: { id: "r1", status, output, usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }, ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}) } },
  ];
  return new Response(events.map((item) => event(item.type, item)).join(""), { headers: { "content-type": "text/event-stream" } });
}
function anthropic(text: string): Response {
  const events = [
    ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "demo-model", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 4 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  return new Response(events.map(([type, data]) => event(type, data)).join(""), { headers: { "content-type": "text/event-stream" } });
}

test("pi-ai routes each API, sends explicit credentials and UA, blocks redirects, and respects the model output limit", async () => {
  const cases = [
    { api: "openai-completions" as const, path: "/v1/chat/completions", response: () => chat("Chat", "stop", { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) },
    { api: "openai-responses" as const, path: "/v1/responses", response: () => responses("Responses") },
    { api: "anthropic-messages" as const, path: "/v1/messages", response: () => anthropic("Anthropic") },
  ];
  for (const item of cases) {
    let calls = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      calls += 1;
      assert.equal(new URL(url).pathname, item.path);
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("user-agent"), "bili-subs/0.1.0");
      assert.equal(headers.has("authorization") || headers.has("x-api-key"), true);
      const body = JSON.parse(String(init?.body));
      const budget = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
      assert.equal(budget, 4096);
      if (item.api === "openai-responses") assert.equal(body.store, false);
      return item.response();
    };
    const result = await createStageClient({ config: config(item.api), fetch }).complete({ system: "system text", user: "prompt text" });
    assert.equal(result.text, item.api === "openai-completions" ? "Chat" : item.api === "openai-responses" ? "Responses" : "Anthropic");
    assert.equal(result.usage?.totalTokens, 14);
    assert.equal(calls, 1);
  }
});

test("config test uses at most 256 output tokens", async () => {
  let body: Record<string, unknown> | undefined;
  const fetch = async (_url: string, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return chat("OK", "stop", { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  };
  const result = await createStageClient({ config: config(), fetch, connectionTest: true }).complete({ system: "reply OK", user: "test" });
  assert.equal(result.text, "OK");
  assert.equal(body?.max_tokens ?? body?.max_completion_tokens, 256);
});

test("pi-ai usage values pass through, including zero when the provider omits usage", async () => {
  const fetch = async () => chat("OK");
  const result = await createStageClient({ config: config(), fetch }).complete({ system: "system", user: "prompt" });
  assert.deepEqual(result.usage, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
});

test("pi-ai stop reasons reject truncation and incomplete Responses with reported usage", async () => {
  const truncated = createStageClient({ config: config(), fetch: async () => chat("partial", "length", { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }) });
  await assert.rejects(() => truncated.complete({ system: "system", user: "prompt" }), (error: { code?: string; usage?: { totalTokens?: number } }) => {
    assert.equal(error.code, "OUTPUT_TRUNCATED");
    assert.equal(error.usage?.totalTokens, 8);
    return true;
  });
  const incomplete = createStageClient({ config: config("openai-responses"), fetch: async () => responses("partial", "incomplete") });
  await assert.rejects(() => incomplete.complete({ system: "system", user: "prompt" }), (error: { code?: string }) => error.code === "OUTPUT_TRUNCATED");
});

test("upstream errors are classified without exposing their body and are not retried", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { message: "rate limit; private-api-key https://private.example prompt text" } }), { status: 429, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(() => createStageClient({ config: config(), fetch }).complete({ system: "system", user: "prompt" }), (error: { code?: string; message?: string }) => {
    assert.equal(error.code, "RATE_LIMITED");
    assert.doesNotMatch(error.message ?? "", /private-api-key|private\.example|prompt text/);
    return true;
  });
  assert.equal(calls, 1);
});

test("an already-aborted request is cancelled before making a provider request", async () => {
  let calls = 0;
  const client = createStageClient({ config: config(), fetch: async () => { calls += 1; return chat("unexpected"); } });
  await assert.rejects(() => client.complete({ system: "system", user: "prompt" }, AbortSignal.abort()), (error: { code?: string }) => error.code === "CANCELLED");
  assert.equal(calls, 0);
});
