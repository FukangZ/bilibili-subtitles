import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { renderTranscriptMarkdown, type Transcript } from "@fukangz/core-bilibili-subtitles";
import { runCli } from "../dist/commands.js";

function streams() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = "", err = "";
  stdout.on("data", (data) => { out += data; });
  stderr.on("data", (data) => { err += data; });
  return { stdin, stdout, stderr, output: () => ({ out, err }) };
}
function chatResponse(text: string): Response {
  const payload = { choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } };
  return new Response(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
}
const transcript: Transcript = { schemaVersion: 1, kind: "bilibili-subtitle", bvid: "BV1cli", aid: 1, cid: 5, page: 1, pageCount: 1, pageTitle: "正片", videoTitle: "CLI 视频", sourceUrl: "https://www.bilibili.com/video/BV1cli/", language: "zh-CN", languageName: "中文", trackKind: "human", trackId: "3", segments: [{ id: 1, startSeconds: 12, text: "需要保留的字幕正文。" }] };

test("download 输出文本结果并将进度发到 stderr", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-cli-download-"));
  try {
    const configFile = path.join(cwd, "config.json");
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify(calls % 3 === 1
        ? { code: 0, data: { bvid: "BV1cli", aid: 1, title: "CLI 视频", pages: [{ cid: 5, page: 1, part: "正片" }] } }
        : calls % 3 === 2
          ? { code: 0, data: { subtitle: { subtitles: [{ id: 3, lan: "zh-CN", lan_doc: "中文", subtitle_url: "https://i0.hdslb.com/a.json" }] } } }
          : { body: [{ from: 0, to: 1, content: "原始字幕全文" }] }));
    };
    const io = streams();
    assert.equal(await runCli(["download", "BV1cli"], { ...io, cwd, configFile, fetch }), 0);
    assert.match(io.output().out, /transcriptPath:/);
    assert.match(io.output().err, /正在/);
    assert.match(await readFile(path.join(cwd, ".subtitles", "BV1cli-CLI 视频", "transcript.md"), "utf8"), /原始字幕全文/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("交互配置收集模型窗口和输出上限，保留隐藏 key 且 config show 脱敏", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-cli-interactive-"));
  try {
    const configFile = path.join(cwd, "config.json");
    const io = streams();
    Object.assign(io.stdin, { isTTY: true, setRawMode() {} });
    Object.assign(io.stderr, { isTTY: true });
    const answers = ["anthropic-messages", "https://api.anthropic.com", "claude-demo", "hidden-api-secret", "200000", "8192", "high", "600000"];
    io.stderr.on("data", (chunk) => {
      if (String(chunk).endsWith("：")) setImmediate(() => io.stdin.write(`${answers.shift() ?? ""}\r`));
    });
    assert.equal(await runCli(["config"], { ...io, cwd, configFile }), 0);
    assert.equal(answers.length, 0);
    const saved = JSON.parse(await readFile(configFile, "utf8"));
    assert.equal(saved.polish.api, "anthropic-messages");
    assert.equal(saved.polish.apiKey, "hidden-api-secret");
    assert.equal(saved.polish.contextWindow, 200000);
    assert.equal(saved.polish.maxTokens, 8192);
    assert.equal(saved.polish.reasoningEffort, "high");
    assert.equal(saved.polish.timeoutMs, 600000);
    assert.doesNotMatch(io.output().out + io.output().err, /hidden-api-secret/);
    const shown = streams();
    assert.equal(await runCli(["config", "show"], { ...shown, cwd, configFile }), 0);
    assert.match(shown.output().out, /"apiKey":"\[redacted\]"/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("pi-ai StageClient 贯通两阶段润色和 JSON 修复，不覆盖原字幕", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-cli-polish-"));
  try {
    const configFile = path.join(cwd, "config.json");
    const original = renderTranscriptMarkdown(transcript);
    await writeFile(path.join(cwd, "transcript.md"), original);
    await writeFile(configFile, JSON.stringify({ polish: { api: "chat-completions", baseUrl: "https://models.example/v1", model: "demo", apiKey: "secret-key", contextWindow: 32000, maxTokens: 8192, timeoutMs: 1000 } }));
    let calls = 0;
    const fetch = async (_url: string, init?: RequestInit) => {
      calls += 1;
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "demo");
      const text = calls === 1 ? "bad JSON" : calls === 2
        ? JSON.stringify({ title: "文章标题", sections: [{ kind: "chapter", heading: "正文", level: 2, startSegmentId: 1 }] })
        : JSON.stringify({ sections: [{ id: "section-1", text: "需要保留的字幕正文。" }] });
      if (calls === 2) assert.match(body.messages[1].content, /上一次输出没有通过校验/);
      return chatResponse(text);
    };
    const io = streams();
    assert.equal(await runCli(["polish", "transcript.md", "--out", "article.md"], { ...io, cwd, configFile, fetch }), 0);
    assert.equal(calls, 3);
    assert.match(io.output().out, /usage: \{"input":30/);
    assert.match(await readFile(path.join(cwd, "article.md"), "utf8"), /文章标题/);
    assert.match(await readFile(path.join(cwd, "article.md"), "utf8"), /t=12/);
    assert.equal(await readFile(path.join(cwd, "transcript.md"), "utf8"), original);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("config test 只发一个不超过配置或 256 tokens 的请求", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-cli-model-test-"));
  try {
    const configFile = path.join(cwd, "config.json");
    await writeFile(configFile, JSON.stringify({ polish: { api: "openai-responses", baseUrl: "https://models.example/v1", model: "demo", apiKey: "secret-key", contextWindow: 32000, maxTokens: 128, timeoutMs: 1000 } }));
    let calls = 0;
    const fetch = async (_url: string, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body));
      assert.ok((body.max_output_tokens ?? body.max_tokens) <= 128);
      return new Response([
        { type: "response.output_item.added", output_index: 0, item: { id: "m1", type: "message", role: "assistant", status: "in_progress", content: [] } },
        { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "OK" },
        { type: "response.output_item.done", output_index: 0, item: { id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] } },
        { type: "response.completed", response: { id: "r1", status: "completed", output: [{ id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
      ].map((item) => `event: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    };
    const io = streams();
    assert.equal(await runCli(["config", "test"], { ...io, cwd, configFile, fetch }), 0);
    assert.equal(calls, 1);
    assert.match(io.output().out, /模型连接测试成功/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("上游失败不公开响应正文或密钥，参数错误不发请求", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-cli-failure-"));
  try {
    const configFile = path.join(cwd, "config.json");
    await writeFile(configFile, JSON.stringify({ polish: { api: "openai-completions", baseUrl: "https://models.example/v1", model: "demo", apiKey: "secret-key", contextWindow: 32000, maxTokens: 8192, timeoutMs: 1000 } }));
    const original = renderTranscriptMarkdown(transcript);
    await writeFile(path.join(cwd, "transcript.md"), original);
    let calls = 0;
    const fetch = async () => { calls += 1; return new Response(JSON.stringify({ error: { message: "secret-key https://private.example prompt-body" } }), { status: 401 }); };
    const failed = streams();
    assert.equal(await runCli(["polish", "transcript.md"], { ...failed, cwd, configFile, fetch }), 1);
    assert.doesNotMatch(failed.output().out + failed.output().err, /secret-key|private\.example|prompt-body/);
    const invalid = streams();
    assert.equal(await runCli(["polish", "missing.md", "--page", "2"], { ...invalid, cwd, configFile, fetch }), 2);
    assert.equal(calls, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
