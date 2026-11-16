import { cancelled, isSubtitleError, SubtitleError } from "./errors.js";
import { isRecord, throwIfCancelled } from "./guards.js";
import { isChineseLanguage } from "./transcript.js";
import { parseBilibiliVideoUrl, type VideoUrlFailure } from "./video-url.js";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const API_HOST = "api.bilibili.com";
const RETRY_DELAYS_MS = [200, 800];
const SUBTITLE_TIMEOUT_MS = 20_000;
const DEFAULT_CHINESE_TRACK_PREFERENCE = [
  "zh-CN",
  "zh-Hans",
  "zh",
  "ai-zh",
  "zh-Hant",
  "zh-TW",
  "zh-HK",
  "en-US",
  "en",
  "ja",
  "ko",
];

export interface FetchLike {
  (url: string, init?: RequestInit): Promise<Response>;
}

export interface VideoPage {
  cid: number;
  page: number;
  part: string;
}

export interface ViewData {
  bvid: string;
  aid?: number;
  title: string;
  publishedAt: number;
  ownerName: string;
  ownerMid: number;
  viewCount?: number;
  danmakuCount?: number;
  replyCount?: number;
  favoriteCount?: number;
  coinCount?: number;
  shareCount?: number;
  likeCount?: number;
  pages: VideoPage[];
}

export type TrackKind = "human" | "ai" | "unknown";

export interface SubtitleTrack {
  id: string;
  language: string;
  languageName: string;
  kind: TrackKind;
  subtitleUrl: string;
}

export interface SubtitleCue {
  from: number;
  to: number;
  content: string;
}

export interface BilibiliClient {
  getView(bvid: string): Promise<ViewData>;
  getPlayer(bvid: string, cid: number): Promise<{ tracks: SubtitleTrack[]; loginRequired: boolean }>;
  getSubtitle(url: string): Promise<SubtitleCue[]>;
}

export function parseVideoSource(source: string): { bvid: string; page?: number } {
  const trimmed = source.trim().replace(/^@/, "");
  if (!trimmed) throw new SubtitleError("INVALID_INPUT", "缺少 BV 号或视频链接");
  if (/b23\.tv|bili2233\.cn/i.test(trimmed)) {
    throw new SubtitleError("INVALID_INPUT", "第一版不支持 b23.tv 短链，请使用 BV 号或完整视频链接");
  }
  if (/^BV[0-9A-Za-z]+$/.test(trimmed)) return { bvid: trimmed };
  const parsed = parseBilibiliVideoUrl(trimmed);
  if (parsed.ok) return parsed.page === undefined ? { bvid: parsed.bvid } : { bvid: parsed.bvid, page: parsed.page };
  throw new SubtitleError("INVALID_INPUT", videoSourceMessage(parsed.reason));
}

function videoSourceMessage(reason: VideoUrlFailure): string {
  switch (reason) {
    case "unrecognized": return "无法识别的视频来源";
    case "protocol": return "视频链接必须是 http 或 https";
    case "host": return "只接受 bilibili.com 的视频链接";
    case "missing-bvid": return "链接里没有 BV 号";
    case "invalid-page": return "链接中的 p 不是有效分P";
  }
}

export function resolveRequestedPage(urlPage: number | undefined, explicitPage: number | undefined): number {
  if (explicitPage !== undefined && (!Number.isInteger(explicitPage) || explicitPage < 1)) {
    throw new SubtitleError("INVALID_INPUT", "page 必须是从 1 开始的整数");
  }
  if (urlPage !== undefined && explicitPage !== undefined && urlPage !== explicitPage) {
    throw new SubtitleError("INVALID_INPUT", `page=${explicitPage} 与链接中的 p=${urlPage} 冲突`);
  }
  return explicitPage ?? urlPage ?? 1;
}

export function selectChineseTrack(tracks: readonly SubtitleTrack[]): SubtitleTrack {
  const pool = tracks.filter((track) => isChineseLanguage(track.language));
  if (pool.length === 0) {
    if (tracks.length === 0) throw new SubtitleError("NO_SUBTITLE", "这个视频没有可用字幕");
    const available = tracks.map((track) => `${track.language}（${track.languageName}，${track.kind}）`).join("、");
    throw new SubtitleError("LANGUAGE_NOT_AVAILABLE", `没有中文字幕。可用：${available}`, {
      available: tracks.map((track) => track.language),
    });
  }
  return [...pool].sort(compareChineseTracks(DEFAULT_CHINESE_TRACK_PREFERENCE))[0];
}

export function createBilibiliClient(options: {
  fetch: FetchLike;
  cookieHeader?: string;
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): BilibiliClient {
  const timeoutMs = 15_000;
  const sleep = options.sleep ?? delay;
  return {
    async getView(bvid) {
      const url = new URL("https://api.bilibili.com/x/web-interface/view");
      url.searchParams.set("bvid", bvid);
      const data = await getJson(url, true, timeoutMs);
      return parseView(data, bvid);
    },
    async getPlayer(bvid, cid) {
      const url = new URL("https://api.bilibili.com/x/player/wbi/v2");
      url.searchParams.set("bvid", bvid);
      url.searchParams.set("cid", String(cid));
      const data = await getJson(url, true, timeoutMs);
      return parsePlayer(data);
    },
    async getSubtitle(subtitleUrl) {
      const url = assertSubtitleUrl(subtitleUrl);
      const body = await getJson(url, false, SUBTITLE_TIMEOUT_MS);
      return parseCues(body);
    },
  };

  async function getJson(url: URL, authenticated: boolean, timeout: number): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      throwIfCancelled(options.signal);
      const timeoutSignal = AbortSignal.timeout(timeout);
      const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
      let retryable = false;
      let failure: SubtitleError;
      try {
        const response = await fetchManual(url, authenticated, signal);
        if (response.status === 429 || response.status === 412) {
          retryable = true;
          throw new SubtitleError("RATE_LIMITED", `请求被限流（HTTP ${response.status}）`);
        }
        if (response.status >= 500) {
          retryable = true;
          throw new SubtitleError("NETWORK_ERROR", `服务暂时不可用（HTTP ${response.status}）`);
        }
        if (response.status < 200 || response.status >= 300) {
          throw new SubtitleError("NETWORK_ERROR", `请求失败（HTTP ${response.status}）：${url.hostname}${url.pathname}`);
        }
        let payload: unknown;
        try {
          payload = JSON.parse(response.body) as unknown;
        } catch {
          throw new SubtitleError("INVALID_RESPONSE", `响应不是 JSON：${url.hostname}${url.pathname}`);
        }
        return authenticated ? assertBilibiliOk(payload) ?? null : payload;
      } catch (error) {
        if (isSubtitleError(error)) {
          if (!retryable) throw error;
          failure = error;
        } else {
          if (options.signal?.aborted) throw cancelled();
          failure = new SubtitleError("NETWORK_ERROR", timeoutSignal.aborted
            ? `请求超时：${url.hostname}${url.pathname}`
            : `网络请求失败：${url.hostname}${url.pathname}`);
        }
      }
      if (attempt >= RETRY_DELAYS_MS.length) throw failure;
      await sleep(RETRY_DELAYS_MS[attempt], options.signal);
    }
  }

  async function fetchManual(url: URL, authenticated: boolean, signal: AbortSignal): Promise<{ status: number; body: string }> {
    let current = url;
    for (let hop = 0; hop <= 3; hop++) {
      const headers = baseHeaders(current, authenticated, options.cookieHeader);
      const response = await options.fetch(current.toString(), { headers, signal, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new SubtitleError("INVALID_RESPONSE", "重定向缺少 Location");
        current = assertRedirect(current, location, authenticated);
        continue;
      }
      const body = await response.text();
      return { status: response.status, body };
    }
    throw new SubtitleError("NETWORK_ERROR", "重定向次数过多");
  }
}

function baseHeaders(url: URL, authenticated: boolean, cookieHeader?: string): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain, */*",
    "user-agent": USER_AGENT,
    referer: "https://www.bilibili.com",
  };
  if (authenticated) {
    if (url.hostname !== API_HOST) {
      throw new SubtitleError("INVALID_RESPONSE", "认证请求的目标主机不被允许");
    }
    headers.origin = "https://www.bilibili.com";
    if (cookieHeader) headers.cookie = cookieHeader;
  }
  return headers;
}

function assertRedirect(from: URL, location: string, authenticated: boolean): URL {
  const next = new URL(location, from);
  if (next.protocol !== "https:") throw new SubtitleError("INVALID_RESPONSE", "只跟随 https 重定向");
  if (authenticated) {
    if (next.hostname !== API_HOST) {
      throw new SubtitleError("INVALID_RESPONSE", `认证请求不能跳转到 ${next.hostname}`);
    }
    return next;
  }
  assertSubtitleUrl(next.toString());
  return next;
}

export function assertSubtitleUrl(raw: string): URL {
  const normalized = raw.startsWith("//") ? `https:${raw}` : raw;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new SubtitleError("INVALID_RESPONSE", "字幕地址无效");
  }
  if (url.protocol !== "https:") throw new SubtitleError("INVALID_RESPONSE", "字幕地址必须是 https");
  const host = url.hostname.toLowerCase();
  const allowed = host === "hdslb.com" || host.endsWith(".hdslb.com");
  if (!allowed) throw new SubtitleError("INVALID_RESPONSE", `字幕主机不被允许：${host}`);
  if (url.username || url.password) throw new SubtitleError("INVALID_RESPONSE", "字幕地址不能携带账号");
  return url;
}

function assertBilibiliOk(payload: unknown): unknown {
  if (!isRecord(payload) || typeof payload.code !== "number") {
    throw new SubtitleError("INVALID_RESPONSE", "接口响应缺少 code");
  }
  if (payload.code === 0) return payload.data;
  const message = typeof payload.message === "string" ? payload.message : "接口返回失败";
  if (payload.code === -101 || payload.code === -403) {
    throw new SubtitleError("AUTH_REQUIRED", "需要登录或更新哔哩哔哩 Cookie");
  }
  if (payload.code === -404) throw new SubtitleError("INVALID_INPUT", "视频不存在或不可见");
  if (payload.code === -400) throw new SubtitleError("INVALID_INPUT", "视频请求参数被拒绝");
  if (payload.code === -352) {
    throw new SubtitleError("SIGNATURE_REQUIRED", "播放器接口拒绝了未签名请求，当前版本还没有 WBI 签名");
  }
  if (payload.code === -412 || payload.code === -509) {
    throw new SubtitleError("RATE_LIMITED", message);
  }
  throw new SubtitleError("NETWORK_ERROR", `接口返回 ${payload.code}`);
}

function parseView(data: unknown, expectedBvid: string): ViewData {
  if (!isRecord(data)) throw new SubtitleError("INVALID_RESPONSE", "视频信息格式无效");
  const bvid = typeof data.bvid === "string" ? data.bvid : expectedBvid;
  const aid = optionalPositiveInteger(data.aid);
  const pages = parsePages(data);
  if (pages.length === 0) throw new SubtitleError("INVALID_RESPONSE", "视频没有分P信息");
  return {
    bvid,
    ...(aid === undefined ? {} : { aid }),
    title: stringValue(data.title) ?? "",
    publishedAt: numberValue(data.pubdate) ?? 0,
    ownerName: isRecord(data.owner) ? stringValue(data.owner.name) ?? "" : "",
    ownerMid: isRecord(data.owner) ? numberValue(data.owner.mid) ?? 0 : 0,
    viewCount: optionalStat(data.stat, "view"),
    danmakuCount: optionalStat(data.stat, "danmaku"),
    replyCount: optionalStat(data.stat, "reply"),
    favoriteCount: optionalStat(data.stat, "favorite"),
    coinCount: optionalStat(data.stat, "coin"),
    shareCount: optionalStat(data.stat, "share"),
    likeCount: optionalStat(data.stat, "like"),
    pages,
  };
}

function parsePages(data: Record<string, unknown>): VideoPage[] {
  if (Array.isArray(data.pages) && data.pages.length > 0) {
    return data.pages.map((page, index) => {
      if (!isRecord(page)) throw new SubtitleError("INVALID_RESPONSE", "分P信息格式无效");
      const cid = numberValue(page.cid);
      if (cid === undefined) throw new SubtitleError("INVALID_RESPONSE", "分P缺少 cid");
      return {
        cid,
        page: numberValue(page.page) ?? index + 1,
        part: stringValue(page.part) ?? "",
      };
    });
  }
  const cid = numberValue(data.cid);
  if (cid === undefined) return [];
  return [{ cid, page: 1, part: stringValue(data.title) ?? "" }];
}

function parsePlayer(data: unknown): { tracks: SubtitleTrack[]; loginRequired: boolean } {
  if (!isRecord(data)) throw new SubtitleError("INVALID_RESPONSE", "播放器响应格式无效");
  const loginRequired = data.need_login_subtitle === true;
  const subtitle = isRecord(data.subtitle) ? data.subtitle : undefined;
  const list = subtitle && Array.isArray(subtitle.subtitles) ? subtitle.subtitles : [];
  const tracks: SubtitleTrack[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const subtitleUrl = stringValue(item.subtitle_url);
    const language = stringValue(item.lan);
    if (!subtitleUrl || !language) continue;
    tracks.push({
      id: String(item.id ?? language),
      language,
      languageName: stringValue(item.lan_doc) ?? language,
      kind: classifyKind(item, subtitleUrl),
      subtitleUrl,
    });
  }
  return { tracks, loginRequired };
}

export function classifyKind(track: Record<string, unknown>, subtitleUrl: string): TrackKind {
  const language = (stringValue(track.lan) ?? "").toLowerCase();
  const url = subtitleUrl.toLowerCase();
  if (language.startsWith("ai-") || url.includes("ai_subtitle") || url.includes("/ai/")) return "ai";
  if (typeof track.ai_status === "number" && track.ai_status > 0) return "ai";
  if (track.ai_type === 1) return "ai";
  if (typeof track.author_mid === "number" && track.author_mid > 0) return "human";
  return "unknown";
}

function parseCues(data: unknown): SubtitleCue[] {
  const body = isRecord(data) && Array.isArray(data.body) ? data.body : undefined;
  if (!body) throw new SubtitleError("INVALID_RESPONSE", "字幕正文格式无效");
  const parsed: SubtitleCue[] = [];
  for (const item of body) {
    if (!isRecord(item)) throw new SubtitleError("INVALID_RESPONSE", "字幕条目格式无效");
    const content = stringValue(item.content);
    if (!content) continue;
    const from = numberValue(item.from);
    const to = numberValue(item.to);
    if (from === undefined || to === undefined) {
      throw new SubtitleError("INVALID_RESPONSE", "字幕条目缺少时间或文本");
    }
    parsed.push({ from, to, content });
  }
  return parsed;
}

function compareChineseTracks(preference: readonly string[]) {
  const rank = new Map(preference.map((language, index) => [language.toLowerCase(), index]));
  const kindRank: Record<TrackKind, number> = { human: 0, ai: 1, unknown: 2 };
  return (left: SubtitleTrack, right: SubtitleTrack) => {
    const kindDelta = kindRank[left.kind] - kindRank[right.kind];
    if (kindDelta !== 0) return kindDelta;
    const languageDelta =
      (rank.get(left.language.toLowerCase()) ?? preference.length + 1) -
      (rank.get(right.language.toLowerCase()) ?? preference.length + 1);
    if (languageDelta !== 0) return languageDelta;
    return left.id.localeCompare(right.id);
  };
}

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalStat(value: unknown, key: string): number | undefined {
  return isRecord(value) ? optionalNonNegativeInteger(value[key]) : undefined;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  const number = numberValue(value);
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const number = numberValue(value);
  return number !== undefined && Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
