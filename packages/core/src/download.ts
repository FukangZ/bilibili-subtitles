import path from "node:path";
import { DEFAULT_OUTPUT_DIR, type AppConfig } from "./config.js";
import { buildCookieHeader, type CookieConfig } from "./config.js";
import {
  createBilibiliClient,
  resolveRequestedPage,
  parseVideoSource,
  selectChineseTrack,
  type FetchLike,
  type SubtitleCue,
  type SubtitleTrack,
  type VideoPage,
  type ViewData,
} from "./bilibili.js";
import { SubtitleError } from "./errors.js";
import { throwIfCancelled } from "./guards.js";
import {
  passthroughQueue, resolveInsideCwd, toPosixRelative, videoDirectoryName, writeNewFile, type FileStore, type MutationQueue,
} from "./store.js";
import { normalizeCues, renderTranscriptMarkdown, sourceUrlFor, type Transcript } from "./transcript.js";

export interface DownloadResult {
  bvid: string;
  title: string;
  page: number;
  pageCount: number;
  pageTitle: string;
  language: string;
  languageName: string;
  kind: Transcript["trackKind"];
  segmentCount: number;
  transcriptPath: string;
}

export async function downloadSubtitle(input: {
  source: string;
  page?: number;
  outputDir?: string;
  cwd: string;
  config: AppConfig;
  fetch: FetchLike;
  cookie?: CookieConfig;
  signal?: AbortSignal;
  queue?: MutationQueue;
  files?: FileStore;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (message: string) => void;
}): Promise<DownloadResult> {
  const parsed = parseVideoSource(input.source);
  const page = resolveRequestedPage(parsed.page, input.page);
  const outputDir = resolveInsideCwd(input.cwd, input.outputDir ?? DEFAULT_OUTPUT_DIR, "outputDir");
  throwIfCancelled(input.signal);
  const client = createBilibiliClient({
    fetch: input.fetch,
    cookieHeader: buildCookieHeader(input.cookie),
    signal: input.signal,
    sleep: input.sleep,
  });
  input.onProgress?.("正在读取视频信息");
  const view = await client.getView(parsed.bvid);
  const statsFetchedAt = hasStats(view) ? new Date().toISOString() : undefined;
  const selectedPage = view.pages.find((item) => item.page === page);
  if (!selectedPage) {
    const available = view.pages.map((item) => item.page).join("、");
    throw new SubtitleError("PAGE_NOT_FOUND", `没有第 ${page} 分P。可用分P：${available}`);
  }
  input.onProgress?.("正在获取字幕列表");
  const player = await client.getPlayer(view.bvid, selectedPage.cid);
  if (player.tracks.length === 0) {
    throw new SubtitleError(
      player.loginRequired ? "AUTH_REQUIRED" : "NO_SUBTITLE",
      player.loginRequired ? "这个视频的字幕需要登录" : "这个视频没有字幕",
    );
  }
  const track = selectChineseTrack(player.tracks);
  input.onProgress?.("正在下载字幕");
  const cues = await client.getSubtitle(track.subtitleUrl);
  throwIfCancelled(input.signal);
  const transcript = buildTranscript(view, selectedPage, track, cues, statsFetchedAt);
  const directory = path.join(outputDir, videoDirectoryName(view.bvid, view.title, selectedPage.page, view.pages.length));
  const queue = input.queue ?? passthroughQueue;
  const transcriptPath = await queue(directory, () => writeNewFile(
    path.join(directory, "transcript.md"),
    renderTranscriptMarkdown(transcript),
    input.files,
    input.signal,
  ));
  return {
    bvid: view.bvid,
    title: view.title,
    page: selectedPage.page,
    pageCount: view.pages.length,
    pageTitle: selectedPage.part,
    language: track.language,
    languageName: track.languageName,
    kind: track.kind,
    segmentCount: transcript.segments.length,
    transcriptPath: toPosixRelative(input.cwd, transcriptPath),
  };
}

function buildTranscript(
  view: ViewData,
  page: VideoPage,
  track: SubtitleTrack,
  cues: SubtitleCue[],
  statsFetchedAt?: string,
): Transcript {
  return {
    schemaVersion: 1,
    kind: "bilibili-subtitle",
    bvid: view.bvid,
    aid: view.aid,
    cid: page.cid,
    page: page.page,
    pageCount: view.pages.length,
    pageTitle: page.part,
    videoTitle: view.title,
    authorName: view.ownerName || undefined,
    authorMid: view.ownerMid || undefined,
    publishedAt: view.publishedAt > 0 ? new Date(view.publishedAt * 1000).toISOString() : undefined,
    statsFetchedAt,
    viewCount: view.viewCount,
    danmakuCount: view.danmakuCount,
    replyCount: view.replyCount,
    favoriteCount: view.favoriteCount,
    coinCount: view.coinCount,
    shareCount: view.shareCount,
    likeCount: view.likeCount,
    sourceUrl: sourceUrlFor(view.bvid, page.page),
    language: track.language,
    languageName: track.languageName,
    trackKind: track.kind,
    trackId: track.id,
    segments: normalizeCues(cues),
  };
}

function hasStats(view: ViewData): boolean {
  return [view.viewCount, view.danmakuCount, view.replyCount, view.favoriteCount, view.coinCount, view.shareCount, view.likeCount]
    .some((value) => value !== undefined);
}
