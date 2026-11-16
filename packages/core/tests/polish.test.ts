import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import type { FileStore, ModelInfo, Usage } from "@fukangz/core-bilibili-subtitles";
import { SubtitleError } from "@fukangz/core-bilibili-subtitles";
import { polishTranscript, validateStructure } from "@fukangz/core-bilibili-subtitles";
import { passthroughQueue } from "@fukangz/core-bilibili-subtitles";
import { renderTranscriptMarkdown, type Transcript } from "@fukangz/core-bilibili-subtitles";

const prompts = { structure: "structure-prompt", polish: "polish-prompt" };

function model(): ModelInfo {
  return { label: "openai/demo", thinking: "low", warnings: [] };
}

function transcript(): Transcript {
  return {
    schemaVersion: 1,
    kind: "bilibili-subtitle",
    bvid: "BV1test",
    aid: 1,
    cid: 22,
    page: 2,
    pageCount: 3,
    pageTitle: "下集",
    videoTitle: "视频标题",
    sourceUrl: "https://www.bilibili.com/video/BV1test/?p=2",
    language: "zh-CN",
    languageName: "中文",
    trackKind: "human",
    trackId: "8",
    segments: [
      { id: 1, startSeconds: 0, text: "开头介绍这个主题。" },
      { id: 2, startSeconds: 61, text: "这里进入第一个章节，数字是 12，不是 13。" },
      { id: 3, startSeconds: 80, text: "请在 08:30 继续说明。" },
    ],
  };
}

function structure() {
  return {
    title: "标题: 文章",
    sections: [
      { kind: "intro", startSegmentId: 1 },
      { kind: "chapter", heading: "第一个主题", level: 2, startSegmentId: 2 },
    ],
  };
}

function bodies() {
  return {
    sections: [
      { id: "section-1", text: "这是导语。" },
      { id: "section-2", text: "这里进入第一个章节，数字是 12，不是 13。请在 08:30 继续说明。" },
    ],
  };
}

function usage(input: number, output: number): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

async function withTranscript(value: Transcript, run: (cwd: string, file: string) => Promise<void>) {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-polish-"));
  const file = "transcript.md";
  await writeFile(path.join(cwd, file), renderTranscriptMarkdown(value));
  try {
    await run(cwd, file);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("两次成功调用生成跳转链接，第二阶段只有章节正文，且不改原始字幕", async () => {
  const calls: Array<{ system: string; user: string; context?: { stage: string; attempt: number } }> = [];
  await withTranscript(transcript(), async (cwd, file) => {
    const before = await readFile(path.join(cwd, file));
    const result = await polishTranscript({
      transcriptPath: file,
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete: async (request) => {
        calls.push(request);
        return {
          text: calls.length === 1 ? JSON.stringify(structure()) : JSON.stringify(bodies()),
          usage: usage(calls.length, 1),
        };
      } },
    });
    assert.deepEqual(calls.map((call) => call.system), ["structure-prompt", "polish-prompt"]);
    assert.deepEqual(calls.map((call) => call.context), [{ stage: "structure", attempt: 1 }, { stage: "body", attempt: 1 }]);
    const structureLine = calls[0]?.user.split("\n").find((line) => line.startsWith("2\t"));
    assert.equal(structureLine?.split("\t").length, 3);
    assert.equal(calls[0]?.user.includes("endSeconds"), false);
    const polishPayload = JSON.parse(calls[1]?.user ?? "{}") as {
      title: string;
      sections: Array<{ id: string; heading?: string; text: string; startSeconds?: number }>;
    };
    assert.equal(polishPayload.title, "标题: 文章");
    assert.equal(polishPayload.sections[1]?.text.includes("08:30"), true);
    assert.equal(JSON.stringify(polishPayload).includes("startSeconds"), false);
    assert.equal(JSON.stringify(polishPayload).includes("startSegmentId"), false);
    assert.equal(result.sectionCount, 2);
    assert.equal(result.inputCount, 3);
    assert.equal(result.model, "openai/demo");
    assert.equal(result.thinking, "low");
    assert.equal(result.usage?.input, 3);
    assert.equal(result.usage?.output, 2);
    assert.equal("cached" in result, false);
    const article = await readFile(path.join(cwd, result.outputPath), "utf8");
    assert.match(article, /kind: bilibili-polished-article/);
    assert.match(article, /title: "标题: 文章"/);
    assert.match(article, /sourceTranscript: transcript\.md/);
    assert.match(article, /# 标题: 文章/);
    assert.match(article, /## 第一个主题 \[▶ 1:01\]\(https:\/\/www\.bilibili\.com\/video\/BV1test\/\?p=2&t=61\)/);
    assert.equal(article.includes("12"), true);
    assert.equal((await readFile(path.join(cwd, file))).equals(before), true);
  });
});

test("文章继承作者和完整统计快照，保留零值并独立记录生成时间", async (t) => {
  const generatedAt = "2026-11-13T09:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(generatedAt) });
  const snapshots = [
    { viewCount: 123456, danmakuCount: 1234, replyCount: 56, favoriteCount: 789, coinCount: 321, shareCount: 45, likeCount: 6789 },
    { viewCount: 0, danmakuCount: 0, replyCount: 0, favoriteCount: 0, coinCount: 0, shareCount: 0, likeCount: 0 },
  ];
  for (const snapshot of snapshots) {
    const value: Transcript = {
      ...transcript(),
      authorName: '作者: "示例"',
      authorMid: 12345,
      publishedAt: "2024-01-01T12:00:00.000Z",
      statsFetchedAt: "2026-11-01T08:00:00.000Z",
      ...snapshot,
    };
    await withTranscript(value, async (cwd, file) => {
      const before = await readFile(path.join(cwd, file));
      let calls = 0;
      const result = await polishTranscript({
        transcriptPath: file,
        cwd,
        model: model(),
        prompts,
        client: { complete: async () => ({ text: JSON.stringify(++calls === 1 ? structure() : bodies()) }) },
      });
      const article = await readFile(path.join(cwd, result.outputPath), "utf8");
      assert.deepEqual(parse(article.split("---")[1] ?? ""), {
        schemaVersion: 1,
        kind: "bilibili-polished-article",
        title: "标题: 文章",
        videoTitle: value.videoTitle,
        authorName: value.authorName,
        authorMid: value.authorMid,
        publishedAt: value.publishedAt,
        statsFetchedAt: value.statsFetchedAt,
        ...snapshot,
        bvid: value.bvid,
        page: value.page,
        pageTitle: value.pageTitle,
        source: value.sourceUrl,
        language: value.language,
        trackKind: value.trackKind,
        model: "openai/demo",
        thinking: "low",
        generatedAt,
        sourceTranscript: file,
      });
      assert.equal(calls, 2);
      assert.equal((await readFile(path.join(cwd, file))).equals(before), true);
    });
  }
});

test("旧字幕缺少作者与统计时省略字段，不补零或伪造采集时间", async (t) => {
  const generatedAt = "2026-11-13T09:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(generatedAt) });
  await withTranscript(transcript(), async (cwd, file) => {
    let calls = 0;
    const result = await polishTranscript({
      transcriptPath: file,
      cwd,
      model: model(),
      prompts,
      client: { complete: async () => ({ text: JSON.stringify(++calls === 1 ? structure() : bodies()) }) },
    });
    const article = await readFile(path.join(cwd, result.outputPath), "utf8");
    assert.deepEqual(parse(article.split("---")[1] ?? ""), {
      schemaVersion: 1,
      kind: "bilibili-polished-article",
      title: "标题: 文章",
      videoTitle: "视频标题",
      bvid: "BV1test",
      page: 2,
      pageTitle: "下集",
      source: "https://www.bilibili.com/video/BV1test/?p=2",
      language: "zh-CN",
      trackKind: "human",
      model: "openai/demo",
      thinking: "low",
      generatedAt,
      sourceTranscript: file,
    });
  });
});

test("同一秒的多条字幕仍按 id 切分", () => {
  const segments = [
    { id: 1, startSeconds: 10, text: "甲" },
    { id: 2, startSeconds: 10, text: "乙" },
  ];
  const outline = validateStructure(
    {
      title: "文",
      sections: [
        { kind: "chapter", heading: "前", level: 2, startSegmentId: 1 },
        { kind: "chapter", heading: "后", level: 2, startSegmentId: 2 },
      ],
    },
    segments,
  );
  assert.equal(outline.errors.length, 0);
  assert.equal(outline.value?.sections[0]?.endSegmentId, 1);
  assert.equal(outline.value?.sections[1]?.startSegmentId, 2);
  assert.equal(outline.value?.sections[1]?.startSeconds, 10);
});

test("错误的字幕编号不会被改成最近时间，修复一次后仍失败就不保存文章", async () => {
  const explained = validateStructure(
    { title: "文", sections: [{ kind: "chapter", heading: "章", level: 2, startSegmentId: 99 }] },
    transcript().segments,
  );
  assert.equal(explained.value, undefined);
  assert.match(explained.errors.join("\n"), /不存在/);
  await withTranscript(transcript(), async (cwd, file) => {
    const before = await readFile(path.join(cwd, file));
    await assert.rejects(
      () => polishTranscript({
        transcriptPath: file,
        cwd,
        model: model(),
        prompts,
        queue: passthroughQueue,
        client: { complete: async () => ({ text: JSON.stringify({ title: "文", sections: [{ kind: "chapter", heading: "章", level: 2, startSegmentId: 99 }] }), usage: usage(1, 1) }) },
      }),
      /INVALID_MODEL_OUTPUT/,
    );
    assert.deepEqual(await readdir(cwd), ["transcript.md"]);
    assert.equal((await readFile(path.join(cwd, file))).equals(before), true);
  });
});

test("第一次结构无效时只修复一次；再次润色会重新调用模型", async () => {
  await withTranscript(transcript(), async (cwd, file) => {
    let calls = 0;
    const result = await polishTranscript({
      transcriptPath: file,
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete: async () => {
        calls += 1;
        if (calls === 1) return { text: "不是 JSON", usage: usage(1, 1) };
        if (calls === 2) return { text: JSON.stringify(structure()), usage: usage(4, 1) };
        return { text: JSON.stringify(bodies()), usage: usage(1, 1) };
      } },
    });
    assert.equal(calls, 3);
    assert.equal(result.usage?.input, 6);
    const again = await polishTranscript({
      transcriptPath: file,
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete: async () => {
        calls += 1;
        return { text: calls === 4 ? JSON.stringify(structure()) : JSON.stringify(bodies()), usage: usage(1, 1) };
      } },
    });
    assert.equal(calls, 5);
    assert.equal(again.outputPath, "transcript.polished-2.md");
    assert.notEqual(again.outputPath, result.outputPath);
  });
});

test("最终用量区分未知、部分阶段报告和真实零值", async () => {
  await withTranscript(transcript(), async (cwd, file) => {
    let calls = 0;
    const unknown = await polishTranscript({
      transcriptPath: file, cwd, model: model(), prompts, client: { complete: async () => ({ text: JSON.stringify(++calls === 1 ? structure() : bodies()) }) },
    });
    assert.equal(unknown.usage, undefined);
    assert.equal(unknown.usageStatus, "unknown");
  });
  await withTranscript(transcript(), async (cwd, file) => {
    let calls = 0;
    const partial = await polishTranscript({
      transcriptPath: file, cwd, model: model(), prompts, client: { complete: async () => ++calls === 1
        ? { text: JSON.stringify(structure()), usage: usage(3, 2) }
        : { text: JSON.stringify(bodies()) } },
    });
    assert.deepEqual(partial.usage, usage(3, 2));
    assert.equal(partial.usageStatus, "partial");
  });
  await withTranscript(transcript(), async (cwd, file) => {
    let calls = 0;
    const zero = await polishTranscript({
      transcriptPath: file, cwd, model: model(), prompts, client: { complete: async () => ({ text: JSON.stringify(++calls === 1 ? structure() : bodies()), usage: usage(0, 0) }) },
    });
    assert.equal(zero.usage?.totalTokens, 0);
    assert.equal(zero.usageStatus, "complete");
  });
});

test("截断和取消不留下文章，外语和润色文件在模型调用前失败", async () => {
  await withTranscript(transcript(), async (cwd, file) => {
    await assert.rejects(
      () => polishTranscript({
        transcriptPath: file,
        cwd,
        model: model(),
        prompts,
        queue: passthroughQueue,
        client: { complete: async () => {
          throw new SubtitleError("OUTPUT_TRUNCATED", "模型输出被截断，未保存为完整文章");
        } },
      }),
      /OUTPUT_TRUNCATED/,
    );
    assert.deepEqual(await readdir(cwd), ["transcript.md"]);
  });

  await withTranscript(transcript(), async (cwd, file) => {
    const controller = new AbortController();
    let calls = 0;
    await assert.rejects(
      () => polishTranscript({
        transcriptPath: file,
        cwd,
        model: model(),
        prompts,
        queue: passthroughQueue,
        signal: controller.signal,
        client: { complete: async () => {
          calls += 1;
          controller.abort();
          return { text: JSON.stringify(structure()), usage: usage(2, 2) };
        } },
      }),
      /CANCELLED/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(await readdir(cwd), ["transcript.md"]);
  });

  const foreign = transcript();
  foreign.language = "en";
  await withTranscript(foreign, async (cwd, file) => {
    await assert.rejects(
      () => polishTranscript({
        transcriptPath: file,
        cwd,
        model: model(),
        prompts,
        queue: passthroughQueue,
        client: { complete: async () => {
          throw new Error("不应调用");
        } },
      }),
      /POLISH_LANGUAGE_UNSUPPORTED/,
    );
  });

  await withTranscript(transcript(), async (cwd, file) => {
    const article = [
      "---",
      "schemaVersion: 1",
      "kind: bilibili-polished-article",
      "title: 文章",
      "---",
      "",
      "# 文章",
      "",
    ].join("\n");
    await writeFile(path.join(cwd, "article.md"), article);
    await assert.rejects(
      () => polishTranscript({
        transcriptPath: "article.md",
        cwd,
        model: model(),
        prompts,
        queue: passthroughQueue,
        client: { complete: async () => {
          throw new Error("不应调用");
        } },
      }),
      /润色文章/,
    );
    assert.equal(await readFile(path.join(cwd, file), "utf8"), renderTranscriptMarkdown(transcript()));
  });
});

test("手动修改正文后，下一次润色使用修改后的内容", async () => {
  await withTranscript(transcript(), async (cwd, file) => {
    const absolute = path.join(cwd, file);
    const edited = (await readFile(absolute, "utf8")).replace("开头介绍这个主题。", "用户改过的开头。");
    await writeFile(absolute, edited);
    let polishText = "";
    await polishTranscript({
      transcriptPath: file,
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete: async (request) => {
        if (request.system === "polish-prompt") polishText = request.user;
        return {
          text: request.system === "structure-prompt" ? JSON.stringify(structure()) : JSON.stringify(bodies()),
          usage: usage(1, 1),
        };
      } },
    });
    assert.match(polishText, /用户改过的开头。/);
    assert.equal(await readFile(absolute, "utf8"), edited);
  });
});

test("原始字幕在模型生成或排队期间变更时拒绝保存文章并保留用量", async () => {
  for (const changeDuring of ["model", "queue"] as const) {
    await withTranscript(transcript(), async (cwd, file) => {
      const absolute = path.join(cwd, file);
      const edited = renderTranscriptMarkdown(transcript()).replace("开头介绍这个主题。", "用户改过的开头。");
      await assert.rejects(() => polishTranscript({
        transcriptPath: file,
        cwd,
        model: model(),
        prompts,
        queue: async (_directory, write) => {
          if (changeDuring === "queue") await writeFile(absolute, edited);
          return write();
        },
        client: { complete: async (request) => {
          if (changeDuring === "model" && request.system === "polish-prompt") await writeFile(absolute, edited);
          return {
            text: request.system === "structure-prompt" ? JSON.stringify(structure()) : JSON.stringify(bodies()),
            usage: usage(1, 1),
          };
        } },
      }), (error: unknown) => {
        assert.ok(error instanceof SubtitleError);
        assert.equal(error.code, "INVALID_INPUT");
        assert.match(error.message, /原始字幕在润色期间发生变化/);
        assert.equal(error.usage?.input, 2);
        assert.equal(error.usage?.output, 2);
        return true;
      });
      assert.deepEqual(await readdir(cwd), ["transcript.md"], changeDuring);
      assert.equal(await readFile(absolute, "utf8"), edited);
    });
  }
});

test("指定当前目录、重复目标和输入路径本身都不会覆盖已有文件", async () => {
  await withTranscript(transcript(), async (cwd, file) => {
    const before = await readFile(path.join(cwd, file));
    await writeFile(path.join(cwd, "文章.md"), "已有文章\n");
    const complete = async (request: { system: string }) => ({
      text: request.system === "structure-prompt" ? JSON.stringify(structure()) : JSON.stringify(bodies()),
      usage: usage(1, 1),
    });
    const placed = await polishTranscript({
      transcriptPath: file,
      outputPath: "./文章.md",
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete },
    });
    assert.equal(placed.outputPath, "文章-2.md");
    assert.equal(await readFile(path.join(cwd, "文章.md"), "utf8"), "已有文章\n");
    assert.match(await readFile(path.join(cwd, placed.outputPath), "utf8"), /这是导语。/);

    const same = await polishTranscript({
      transcriptPath: file,
      outputPath: file,
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete },
    });
    assert.notEqual(same.outputPath, file);
    assert.equal((await readFile(path.join(cwd, file))).equals(before), true);
    assert.match(await readFile(path.join(cwd, same.outputPath), "utf8"), /kind: bilibili-polished-article/);
  });
});

test("宿主文件接口接管读取与写入：读两次原文、已存在目标顺延，读取失败报告输入错误", async () => {
  const cwd = path.join(tmpdir(), "bili-virtual-polish");
  const source = path.join(cwd, "sub", "transcript.md");
  const original = new TextEncoder().encode(renderTranscriptMarkdown(transcript()));
  const reads: string[] = [];
  const created = new Map<string, string>();
  const controller = new AbortController();
  const files: FileStore = {
    readFile: async (file, signal) => {
      assert.equal(signal, controller.signal);
      reads.push(file);
      if (file !== source) throw new Error("not found");
      return original;
    },
    createIfAbsent: async (file, content, signal) => {
      assert.equal(signal, controller.signal);
      if (file.endsWith("transcript.polished.md")) return false;
      created.set(file, content);
      return true;
    },
  };
  const complete = async (request: { system: string }) => ({
    text: request.system === "structure-prompt" ? JSON.stringify(structure()) : JSON.stringify(bodies()),
  });
  const result = await polishTranscript({
    transcriptPath: "sub/transcript.md", cwd, model: model(), prompts, files, signal: controller.signal, client: { complete },
  });
  assert.equal(result.outputPath, "sub/transcript.polished-2.md");
  assert.deepEqual(reads, [source, source]);
  assert.match(created.get(path.join(cwd, "sub", "transcript.polished-2.md")) ?? "", /sourceTranscript: transcript\.md/);
  await assert.rejects(
    polishTranscript({ transcriptPath: "missing.md", cwd, model: model(), prompts, files, signal: controller.signal, client: { complete } }),
    /INVALID_INPUT: 无法读取 transcriptPath/,
  );
});

test("并发润色同一目标得到不同完整文件", async () => {
  await withTranscript(transcript(), async (cwd, file) => {
    const before = await readFile(path.join(cwd, file));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const pending = Promise.all([0, 1].map(() => polishTranscript({
      transcriptPath: file,
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete: async (request) => {
        if (request.system === "structure-prompt") {
          entered += 1;
          if (entered === 2) release?.();
          await gate;
        }
        return {
          text: request.system === "structure-prompt" ? JSON.stringify(structure()) : JSON.stringify(bodies()),
          usage: usage(1, 1),
        };
      } },
    })));
    const [left, right] = await pending;
    assert.notEqual(left.outputPath, right.outputPath);
    assert.match(await readFile(path.join(cwd, left.outputPath), "utf8"), /这是导语。/);
    assert.match(await readFile(path.join(cwd, right.outputPath), "utf8"), /这是导语。/);
    assert.equal((await readFile(path.join(cwd, file))).equals(before), true);
  });
});

test("信号贯穿结构生成、正文生成及各自格式修复，阶段上下文不混入提示词", async () => {
  await withTranscript(transcript(), async (cwd, file) => {
    const controller = new AbortController();
    let calls = 0;
    const result = await polishTranscript({
      cwd, transcriptPath: file, prompts, signal: controller.signal,
      model: { label: "generic/model", warnings: ["adapter-warning"] },
      client: { async complete(request, signal) {
        assert.equal(signal, controller.signal);
        calls += 1;
        assert.deepEqual(request.context, [
          { stage: "structure", attempt: 1 }, { stage: "structure", attempt: 2 },
          { stage: "body", attempt: 1 }, { stage: "body", attempt: 2 },
        ][calls - 1]);
        assert.doesNotMatch(request.system + request.user, /"stage"|"attempt"/);
        return { text: calls % 2 === 1 ? "invalid JSON" : JSON.stringify(calls === 2 ? structure() : bodies()) };
      } },
    });
    assert.equal(calls, 4);
    assert.equal(result.thinking, undefined);
    assert.equal(result.usage?.cost, undefined);
    assert.deepEqual(result.warnings, ["adapter-warning"]);
    const article = await readFile(path.join(cwd, result.outputPath), "utf8");
    assert.match(article, /model: generic\/model/);
    assert.doesNotMatch(article, /thinking:/);
  });
});

test("失败和取消保留已完成阶段与修复的用量，且不重复累计", async () => {
  for (const mode of ["repair-error", "repair-cancel", "prose-repair-error", "invalid-twice", "unexpected-error"] as const) {
    await withTranscript(transcript(), async (cwd, file) => {
      const controller = new AbortController();
      let calls = 0;
      const expectedInput = mode === "prose-repair-error" ? 6 : mode === "repair-cancel" || mode === "unexpected-error" ? 1 : 3;
      await assert.rejects(() => polishTranscript({
        cwd, transcriptPath: file, prompts, model: model(), signal: controller.signal,
        client: { async complete(_request, signal) {
          assert.equal(signal, controller.signal);
          calls += 1;
          if (mode === "prose-repair-error" && calls === 1) return { text: JSON.stringify(structure()), usage: usage(1, 1) };
          const invalidCall = mode === "prose-repair-error" ? 2 : 1;
          if (calls === invalidCall || mode === "invalid-twice") {
            if (mode === "repair-cancel") controller.abort();
            return { text: "invalid JSON", usage: usage(calls, 1) };
          }
          if (mode === "unexpected-error") throw new Error("unexpected adapter failure");
          const failure = new SubtitleError("OUTPUT_TRUNCATED", "truncated");
          failure.usage = usage(calls, 1);
          throw failure;
        } },
      }), (error: unknown) => {
        assert.ok(error instanceof SubtitleError);
        assert.equal(error.usage?.input, expectedInput, mode);
        assert.equal(error.code, mode === "repair-cancel" ? "CANCELLED" : mode === "unexpected-error" ? "MODEL_ERROR" : mode === "invalid-twice" ? "INVALID_MODEL_OUTPUT" : "OUTPUT_TRUNCATED");
        if (mode === "invalid-twice") assert.deepEqual(error.details?.diagnostic, { stage: "structure", attempt: 2, operation: "validate", reason: "invalid_output" });
        return true;
      });
      assert.deepEqual(await readdir(cwd), ["transcript.md"]);
    });
  }
});

test("外语轨道明确拒绝翻译，异常变短只警告", async () => {
  const long = transcript();
  long.segments = long.segments.map((segment) => ({ ...segment, text: "内容".repeat(80) }));
  await withTranscript(long, async (cwd, file) => {
    const result = await polishTranscript({
      transcriptPath: file,
      cwd,
      model: model(),
      prompts,
      queue: passthroughQueue,
      client: { complete: async (request) => ({
        text: request.system === "structure-prompt" ? JSON.stringify(structure()) : JSON.stringify({
          sections: [
            { id: "section-1", text: "太短" },
            { id: "section-2", text: "也短" },
          ],
        }),
        usage: usage(1, 1),
      }) },
    });
    assert.match(result.warnings.join("\n"), /明显短于字幕/);
    const article = await readFile(path.join(cwd, result.outputPath), "utf8");
    assert.match(article, /太短/);
  });
});
