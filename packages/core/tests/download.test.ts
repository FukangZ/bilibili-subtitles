import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type AppConfig, type FileStore } from "@fukangz/core-bilibili-subtitles";
import { downloadSubtitle } from "@fukangz/core-bilibili-subtitles";
import { isSubtitleError } from "@fukangz/core-bilibili-subtitles";
import { passthroughQueue } from "@fukangz/core-bilibili-subtitles";
import { parseTranscriptMarkdown } from "@fukangz/core-bilibili-subtitles";

const cues = [
  { from: 0, to: 1.5, content: " 第一句 " },
  { from: 1.2, to: 3, content: "第二行\n继续" },
  { from: 3, to: 4, content: "   " },
];

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    polish: { timeoutMs: 120_000 },
    ...overrides,
  };
}

function view(pages = [{ cid: 11, page: 1, part: "上", duration: 4 }, { cid: 22, page: 2, part: "下", duration: 4 }], title = "示例视频") {
  return {
    code: 0,
    data: {
      bvid: "BV1test",
      aid: 7,
      title,
      desc: "简介",
      pic: "https://example.test/cover.jpg",
      pubdate: 1_700_000_000,
      duration: 8,
      owner: { mid: 3, name: "作者" },
      stat: { view: 12345, danmaku: 67, reply: 89, favorite: 101, coin: 23, share: 45, like: 678 },
      pages,
    },
  };
}

function player(subtitles: unknown[], extra: Record<string, unknown> = {}) {
  return { code: 0, data: { ...extra, subtitle: { subtitles } } };
}

function track(overrides: Record<string, unknown>) {
  return {
    id: 1,
    lan: "zh-CN",
    lan_doc: "中文",
    subtitle_url: "https://aisubtitle.hdslb.com/a.json",
    ...overrides,
  };
}

async function withDir(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "bili-dl-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("多P下载中文 AI 字幕，小数秒向下取整，cookie 不进入字幕文件", async () => {
  const seen: Array<{ url: string; cookie?: string }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, cookie: headers.get("cookie") ?? undefined });
    if (url.includes("/view?")) return json(view());
    if (url.includes("/wbi/v2")) {
      assert.match(url, /cid=22/);
      return json(player([
        track({ id: 2, lan: "en", lan_doc: "英语", subtitle_url: "https://i0.hdslb.com/en.json", author_mid: 9 }),
        track({ id: 8, subtitle_url: "https://aisubtitle.hdslb.com/zh.json", ai_status: 2 }),
      ]));
    }
    assert.equal(headers.get("cookie"), null);
    return json({ body: cues });
  };
  await withDir(async (cwd) => {
    const result = await downloadSubtitle({
      source: "https://www.bilibili.com/video/BV1test?p=2",
      cwd,
      config: config(),
      cookie: { SESSDATA: "secret-session" },
      fetch: fetch as typeof fetch,
      queue: passthroughQueue,
      sleep: async () => undefined,
    });
    assert.equal(result.page, 2);
    assert.equal(result.pageCount, 2);
    assert.equal(result.language, "zh-CN");
    assert.equal(result.kind, "ai");
    assert.equal(result.segmentCount, 2);
    assert.equal(result.transcriptPath, ".subtitles/BV1test-示例视频-p2/transcript.md");
    assert.equal("textPath" in result, false);
    assert.equal("metadataPath" in result, false);
    assert.equal("cached" in result, false);
    const file = await readFile(path.join(cwd, result.transcriptPath), "utf8");
    assert.equal(file.includes("secret-session"), false);
    assert.equal(file.includes("subtitle_url"), false);
    assert.equal(file.includes("endSeconds"), false);
    assert.equal(file.includes(".tmp"), false);
    const transcript = parseTranscriptMarkdown(file);
    assert.equal(transcript.segments[0]?.startSeconds, 0);
    assert.equal(transcript.segments[1]?.text, "第二行 继续");
    assert.equal(transcript.segments[1]?.startSeconds, 1);
    assert.equal(transcript.authorName, "作者");
    assert.equal(transcript.authorMid, 3);
    assert.equal(transcript.publishedAt, "2023-11-14T22:13:20.000Z");
    assert.equal(transcript.viewCount, 12345);
    assert.equal(transcript.danmakuCount, 67);
    assert.equal(transcript.replyCount, 89);
    assert.equal(transcript.favoriteCount, 101);
    assert.equal(transcript.coinCount, 23);
    assert.equal(transcript.shareCount, 45);
    assert.equal(transcript.likeCount, 678);
    assert.match(transcript.statsFetchedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(seen[0]?.cookie, "SESSDATA=secret-session");
    assert.equal(seen[2]?.cookie, undefined);
    const names = await readdir(path.join(cwd, ".subtitles/BV1test-示例视频-p2"));
    assert.deepEqual(names, ["transcript.md"]);
  });
});

test("下载入口保留裸 BV、@ 前缀及完整链接的解析行为", async () => {
  await withDir(async (cwd) => {
    for (const [source, page] of [
      ["BV1test", 1],
      ["  @BV1test  ", 1],
      ["https://www.bilibili.com/video/BV1test/", 1],
      ["http://bilibili.com/video/BV1test/?p=2", 2],
      [" @https://m.bilibili.com/video/BV1test/?p=2 ", 2],
    ] as const) {
      const fetch = async (url: string) => {
        if (url.includes("/view?")) {
          assert.equal(new URL(url).searchParams.get("bvid"), "BV1test");
          return json(view());
        }
        if (url.includes("/wbi/v2")) {
          assert.equal(new URL(url).searchParams.get("cid"), page === 1 ? "11" : "22");
          return json(player([track({ author_mid: 1 })]));
        }
        return json({ body: cues });
      };
      const result = await downloadSubtitle({ source, cwd, config: config(), fetch, queue: passthroughQueue });
      assert.equal(result.page, page);
      const saved = parseTranscriptMarkdown(await readFile(path.join(cwd, result.transcriptPath), "utf8"));
      assert.equal(saved.sourceUrl, `https://www.bilibili.com/video/BV1test/?p=${page}`);
    }
  });
});

test("下载入口在请求前拒绝无效来源并保留错误文案", async () => {
  await withDir(async (cwd) => {
    for (const [source, message] of [
      [" @", "缺少 BV 号或视频链接"],
      ["not-a-link", "无法识别的视频来源"],
      ["https://b23.tv/abc", "第一版不支持 b23.tv 短链，请使用 BV 号或完整视频链接"],
      ["https://bili2233.cn/abc", "第一版不支持 b23.tv 短链，请使用 BV 号或完整视频链接"],
      ["ftp://www.bilibili.com/video/BV1test", "视频链接必须是 http 或 https"],
      ["https://www.bilibili.com.example.test/video/BV1test", "只接受 bilibili.com 的视频链接"],
      ["https://www.bilibili.com/video/av123", "链接里没有 BV 号"],
      ["https://www.bilibili.com/video/BV1test?p=0", "链接中的 p 不是有效分P"],
      ["https://www.bilibili.com/video/BV1test?p=01", "链接中的 p 不是有效分P"],
    ]) {
      await assert.rejects(() => downloadSubtitle({
        source, cwd, config: config(), queue: passthroughQueue,
        fetch: async () => { assert.fail("无效来源不应发出请求"); },
      }), { code: "INVALID_INPUT", message: `INVALID_INPUT: ${message}` });
    }
  });
});

test("aid 缺失或无效时在 transcript 中省略", async () => {
  for (const aid of [undefined, "invalid", 0, 1.5]) {
    const fetch = async (url: string) => {
      if (url.includes("/view?")) return json({ code: 0, data: { ...view().data, aid } });
      if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1 })]));
      return json({ body: cues });
    };
    await withDir(async (cwd) => {
      const result = await downloadSubtitle({ source: "BV1test", cwd, config: config(), fetch });
      const file = await readFile(path.join(cwd, result.transcriptPath), "utf8");
      const transcript = parseTranscriptMarkdown(file);
      assert.equal(transcript.aid, undefined);
      assert.equal(file.includes("aid:"), false);
    });
  }
});

test("缺失或无效元数据省略，零统计值保留", async () => {
  for (const stat of [undefined, { view: -1, like: "--", coin: 1.5 }, { view: 0, like: 0, coin: 0 }]) {
    const fetch = async (url: string) => {
      if (url.includes("/view?")) {
        return json({ code: 0, data: { ...view().data, owner: undefined, pubdate: undefined, stat } });
      }
      if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1 })]));
      return json({ body: cues });
    };
    await withDir(async (cwd) => {
      const result = await downloadSubtitle({ source: "BV1test", cwd, config: config(), fetch });
      const file = await readFile(path.join(cwd, result.transcriptPath), "utf8");
      const transcript = parseTranscriptMarkdown(file);
      for (const key of ["authorName", "authorMid", "publishedAt", "danmakuCount", "replyCount", "favoriteCount", "shareCount"] as const) {
        assert.equal(transcript[key], undefined);
        assert.equal(file.includes(`${key}:`), false);
      }
      const expected = stat?.view === 0 ? 0 : undefined;
      for (const key of ["viewCount", "likeCount", "coinCount"] as const) {
        assert.equal(transcript[key], expected);
        assert.equal(file.includes(`${key}:`), expected !== undefined);
      }
      assert.equal(file.includes("statsFetchedAt:"), expected !== undefined);
    });
  }
});

test("单P省略 -p1，特殊字符和过长标题会被清理", async () => {
  const longTitle = `示例/视频: "标题"*${"字".repeat(120)}`;
  const fetch = async (url: string) => {
    if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "正片", duration: 1 }], longTitle));
    if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1, subtitle_url: "https://i0.hdslb.com/a.json" })]));
    return json({ body: [{ from: 0, to: 1, content: "正文" }] });
  };
  await withDir(async (cwd) => {
    const result = await downloadSubtitle({
      source: "BV1test",
      cwd,
      config: config(),
      fetch: fetch as typeof fetch,
      queue: passthroughQueue,
      sleep: async () => undefined,
    });
    assert.match(result.transcriptPath, /^\.subtitles\/BV1test-示例 视频 标题 /);
    assert.equal(result.transcriptPath.includes("/"), true);
    assert.equal(result.transcriptPath.includes("-p1"), false);
    assert.equal(result.transcriptPath.endsWith("/transcript.md"), true);
    const directory = path.basename(path.dirname(result.transcriptPath));
    assert.ok(directory.length < "BV1test-".length + 90);
    const empty = async (url: string) => {
      if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "", duration: 1 }], "   "));
      if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1, subtitle_url: "https://i0.hdslb.com/a.json" })]));
      return json({ body: [{ from: 0, to: 1, content: "正文" }] });
    };
    const fallback = await downloadSubtitle({
      source: "BV1test",
      cwd,
      config: config(),
      fetch: empty as typeof fetch,
      queue: passthroughQueue,
      sleep: async () => undefined,
    });
    assert.match(fallback.transcriptPath, /BV1test-未命名\/transcript\.md$/);
  });
});

test("outputDir 为 . 时写在当前目录，越界和绝对路径被拒绝", async () => {
  let calls = 0;
  const fetch = async (url: string) => {
    calls += 1;
    if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "正片", duration: 1 }]));
    if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1, subtitle_url: "https://i0.hdslb.com/a.json" })]));
    return json({ body: [{ from: 0, to: 1, content: "正文" }] });
  };
  await withDir(async (cwd) => {
    const result = await downloadSubtitle({
      source: "BV1test",
      outputDir: ".",
      cwd,
      config: config(),
      fetch: fetch as typeof fetch,
      queue: passthroughQueue,
      sleep: async () => undefined,
    });
    assert.equal(result.transcriptPath, "BV1test-示例视频/transcript.md");
    for (const outputDir of ["..", "../outside", "nested/../../outside"]) {
      await assert.rejects(
        () => downloadSubtitle({ source: "BV1test", outputDir, cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue }),
        /outputDir 不能超出当前工作目录/,
      );
    }
    await assert.rejects(
      () => downloadSubtitle({ source: "BV1test", outputDir: "/tmp", cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue }),
      /outputDir 必须是相对当前工作目录的路径/,
    );
    assert.equal(calls, 3);
  });
});

test("以多个点开头的合法目录可下载并返回相对路径", async () => {
  const fetch = async (url: string) => {
    if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "正片", duration: 1 }]));
    if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1 })]));
    return json({ body: [{ from: 0, to: 1, content: "正文" }] });
  };
  await withDir(async (cwd) => {
    for (const outputDir of ["..notes/a", "...md"]) {
      const result = await downloadSubtitle({ source: "BV1test", outputDir, cwd, config: config(), fetch });
      assert.equal(result.transcriptPath, `${outputDir}/BV1test-示例视频/transcript.md`);
      const saved = parseTranscriptMarkdown(await readFile(path.join(cwd, result.transcriptPath), "utf8"));
      assert.equal(saved.segments[0]?.text, "正文");
    }
  });
});

test("链接 p 与 page 冲突时不发请求；短链和缺页会失败", async () => {
  let calls = 0;
  const fetch = async () => {
    calls += 1;
    return json(view());
  };
  await withDir(async (cwd) => {
    await assert.rejects(
      () => downloadSubtitle({ source: "https://www.bilibili.com/video/BV1test?p=2", page: 1, cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue }),
      /INVALID_INPUT/,
    );
    await assert.rejects(
      () => downloadSubtitle({ source: "https://b23.tv/abc", cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue }),
      /INVALID_INPUT/,
    );
    await assert.rejects(
      () => downloadSubtitle({ source: "BV1test", page: 9, cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue, sleep: async () => undefined }),
      /PAGE_NOT_FOUND/,
    );
    assert.equal(calls, 1);
  });
});

test("没有字幕、需要登录和没有中文是不同错误", async () => {
  const routes = new Map<string, unknown>([
    ["empty", player([])],
    ["login", player([], { need_login_subtitle: true })],
    ["langs", player([track({ lan: "en", lan_doc: "英语", author_mid: 4, subtitle_url: "https://i0.hdslb.com/en.json" })])],
  ]);
  await withDir(async (cwd) => {
    for (const [name, code] of [["empty", "NO_SUBTITLE"], ["login", "AUTH_REQUIRED"]] as const) {
      const fetch = async (url: string) => json(url.includes("/view?") ? view() : routes.get(name));
      await assert.rejects(
        () => downloadSubtitle({ source: "BV1test", cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue, sleep: async () => undefined }),
        new RegExp(code),
      );
    }
    const fetch = async (url: string) => json(url.includes("/view?") ? view([{ cid: 11, page: 1, part: "上", duration: 1 }]) : routes.get("langs"));
    await assert.rejects(
      () => downloadSubtitle({ source: "BV1test", cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue, sleep: async () => undefined }),
      /LANGUAGE_NOT_AVAILABLE[\s\S]*没有中文字幕[\s\S]*en/,
    );
  });
});

test("中文轨道按人工、AI、未知排序，未知类型不会被当成人工", async () => {
  await withDir(async (cwd) => {
    const human = await downloadOne(cwd, [
      track({ id: "b", lan: "zh-CN", subtitle_url: "https://i0.hdslb.com/unknown.json" }),
      track({ id: "ai", lan: "zh-CN", ai_status: 1, subtitle_url: "https://i0.hdslb.com/ai.json" }),
      track({ id: "h", lan: "zh-TW", author_mid: 5, subtitle_url: "https://i0.hdslb.com/human.json" }),
    ]);
    assert.equal(human.kind, "human");
    assert.match(await readFile(path.join(cwd, human.transcriptPath), "utf8"), /人工字幕/);

    const ai = await downloadOne(cwd, [
      track({ id: "u", lan: "zh-CN", subtitle_url: "https://i0.hdslb.com/unknown.json" }),
      track({ id: "a", lan: "zh-CN", ai_status: 1, subtitle_url: "https://i0.hdslb.com/ai.json" }),
    ]);
    assert.equal(ai.kind, "ai");

    const unknown = await downloadOne(cwd, [
      track({ id: "b", lan: "zh-CN", subtitle_url: "https://i0.hdslb.com/unknown.json" }),
      track({ id: "a", lan: "zh-CN", type: 0, subtitle_url: "https://i0.hdslb.com/typed.json" }),
    ]);
    assert.equal(unknown.kind, "unknown");
    assert.match(await readFile(path.join(cwd, unknown.transcriptPath), "utf8"), /trackKind: unknown/);
    assert.match(await readFile(path.join(cwd, unknown.transcriptPath), "utf8"), /其他/);

    const preferred = await downloadOne(cwd, [
      track({ id: "a", lan: "zh-Hant", ai_status: 1 }),
      track({ id: "b", lan: "zh-CN", ai_status: 1 }),
    ]);
    assert.equal(preferred.language, "zh-CN");
  });
});

test("重复下载会再次请求并写入新文件，取消不留下字幕文件", async () => {
  let subtitleCalls = 0;
  const fetch = async (url: string, init?: RequestInit) => {
    if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "上", duration: 1 }]));
    if (url.includes("/wbi/v2")) return json(player([track({ subtitle_url: "https://i0.hdslb.com/a.json", author_mid: 1 })]));
    subtitleCalls += 1;
    if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return json({ body: [{ from: 0, to: 1, content: "正文" }] });
  };
  await withDir(async (cwd) => {
    const input = { source: "BV1test", cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue, sleep: async () => undefined };
    const first = await downloadSubtitle(input);
    const second = await downloadSubtitle(input);
    assert.equal(subtitleCalls, 2);
    assert.equal(first.transcriptPath, ".subtitles/BV1test-示例视频/transcript.md");
    assert.equal(second.transcriptPath, ".subtitles/BV1test-示例视频/transcript-2.md");

    const controller = new AbortController();
    const hanging = async (url: string, init?: RequestInit) => {
      if (!url.includes("hdslb.com")) return fetch(url, init);
      if (init?.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    };
    const pending = downloadSubtitle({ ...input, fetch: hanging as typeof fetch, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /CANCELLED/);
    const names = await readdir(path.join(cwd, ".subtitles/BV1test-示例视频"));
    assert.deepEqual(names.sort(), ["transcript-2.md", "transcript.md"]);
  });
});

test("宿主文件接口接管写入：已存在目标顺延编号，信号与绝对路径传给宿主", async () => {
  const fetch = async (url: string) => {
    if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "上", duration: 1 }]));
    if (url.includes("/wbi/v2")) return json(player([track({ subtitle_url: "https://i0.hdslb.com/a.json", author_mid: 1 })]));
    return json({ body: [{ from: 0, to: 1, content: "正文" }] });
  };
  const controller = new AbortController();
  const written = new Map<string, string>();
  const calls: Array<{ file: string; signal?: AbortSignal }> = [];
  const files: FileStore = {
    readFile: async () => { throw new Error("download 不应读取文件"); },
    createIfAbsent: async (file, content, signal) => {
      calls.push({ file, signal });
      if (file.endsWith("/transcript.md")) return false;
      written.set(file, content);
      return true;
    },
  };
  const cwd = path.join(tmpdir(), "bili-virtual-cwd");
  const result = await downloadSubtitle({
    source: "BV1test", cwd, config: config(), fetch: fetch as typeof fetch, files, signal: controller.signal,
    sleep: async () => undefined,
  });
  assert.equal(result.transcriptPath, ".subtitles/BV1test-示例视频/transcript-2.md");
  assert.deepEqual(calls.map((call) => path.relative(cwd, call.file)), [
    ".subtitles/BV1test-示例视频/transcript.md",
    ".subtitles/BV1test-示例视频/transcript-2.md",
  ]);
  assert.ok(calls.every((call) => call.signal === controller.signal));
  const [content] = [...written.values()];
  assert.equal(parseTranscriptMarkdown(content ?? "").segments[0]?.text, "正文");
  await assert.rejects(readdir(cwd), { code: "ENOENT" });
});

test("并发下载各自请求并得到不同的完整文件", async () => {
  let subtitleCalls = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = async (url: string) => {
    if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "上", duration: 1 }]));
    if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1, subtitle_url: "https://i0.hdslb.com/a.json" })]));
    subtitleCalls += 1;
    await gate;
    return json({ body: [{ from: 0, to: 1, content: `正文${subtitleCalls}` }] });
  };
  await withDir(async (cwd) => {
    const input = { source: "BV1test", cwd, config: config(), fetch: fetch as typeof fetch, queue: passthroughQueue, sleep: async () => undefined };
    const pending = Promise.all([downloadSubtitle(input), downloadSubtitle(input)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release?.();
    const [left, right] = await pending;
    assert.equal(subtitleCalls, 2);
    assert.notEqual(left.transcriptPath, right.transcriptPath);
    const first = parseTranscriptMarkdown(await readFile(path.join(cwd, left.transcriptPath), "utf8"));
    const second = parseTranscriptMarkdown(await readFile(path.join(cwd, right.transcriptPath), "utf8"));
    assert.equal(first.segments.length, 1);
    assert.equal(second.segments.length, 1);
  });
});

test("字幕不能跳到任意主机，接口签名错误单独报告", async () => {
  await withDir(async (cwd) => {
    const redirected = async (url: string) => {
      if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "上", duration: 1 }]));
      if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1 })]));
      if (url.includes("evil.example")) throw new Error("cookie leaked");
      return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    };
    await assert.rejects(
      () => downloadSubtitle({ source: "BV1test", cwd, config: config(), fetch: redirected as typeof fetch, queue: passthroughQueue, sleep: async () => undefined }),
      /INVALID_RESPONSE/,
    );
    const signed = async (url: string) => json(url.includes("/view?") ? view() : { code: -352, message: "风控校验失败" });
    await assert.rejects(
      () => downloadSubtitle({ source: "BV1test", cwd, config: config(), fetch: signed as typeof fetch, queue: passthroughQueue, sleep: async () => undefined }),
      (error: unknown) => {
        assert.equal(isSubtitleError(error) && error.code === "SIGNATURE_REQUIRED", true);
        return true;
      },
    );
  });
});

test("瞬时 500 会重试，404 不重试", async () => {
  let views = 0;
  const fetch = async (url: string) => {
    if (url.includes("/view?")) {
      views += 1;
      if (views === 1) return json({ code: 0 }, 500);
      return json(view([{ cid: 11, page: 1, part: "上", duration: 1 }]));
    }
    if (url.includes("/wbi/v2")) return json(player([track({ author_mid: 1, subtitle_url: "https://i0.hdslb.com/a.json" })]));
    return json({ body: [{ from: 0, to: 1, content: "正文" }] });
  };
  await withDir(async (cwd) => {
    const result = await downloadSubtitle({
      source: "BV1test",
      cwd,
      config: config(),
      fetch: fetch as typeof fetch,
      queue: passthroughQueue,
      sleep: async () => undefined,
    });
    assert.equal(result.segmentCount, 1);
    assert.equal(views, 2);
    let missing = 0;
    const notFound = async (url: string) => {
      if (url.includes("/view?")) {
        missing += 1;
        return json({ code: -404, message: "啥都木有" }, 404);
      }
      return json({ code: 0, data: {} });
    };
    await assert.rejects(
      () => downloadSubtitle({ source: "BV1test", cwd, config: config(), fetch: notFound as typeof fetch, queue: passthroughQueue, sleep: async () => undefined }),
      /NETWORK_ERROR/,
    );
    assert.equal(missing, 1);
  });
});

async function downloadOne(cwd: string, tracks: unknown[]) {
  const fetch = async (url: string) => {
    if (url.includes("/view?")) return json(view([{ cid: 11, page: 1, part: "上", duration: 1 }]));
    if (url.includes("/wbi/v2")) return json(player(tracks));
    const content = url.includes("human") ? "人工字幕" : "其他";
    return json({ body: [{ from: 0, to: 1, content }] });
  };
  return downloadSubtitle({
    source: "@BV1test",
    outputDir: `.run-${tracks.length}-${String((tracks[0] as { id?: unknown }).id ?? "x")}`,
    cwd,
    config: config(),
    fetch: fetch as typeof fetch,
    queue: passthroughQueue,
    sleep: async () => undefined,
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
