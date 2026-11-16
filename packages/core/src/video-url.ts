export type VideoUrlFailure = "unrecognized" | "protocol" | "host" | "missing-bvid" | "invalid-page";

export type VideoUrlResult =
  | { ok: true; bvid: string; page?: number }
  | { ok: false; reason: Exclude<VideoUrlFailure, "invalid-page"> }
  | { ok: false; reason: "invalid-page"; bvid: string };

export function parseBilibiliVideoUrl(source: string): VideoUrlResult {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return { ok: false, reason: "unrecognized" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "protocol" };
  const host = url.hostname.toLowerCase();
  if (host !== "www.bilibili.com" && host !== "bilibili.com" && host !== "m.bilibili.com") {
    return { ok: false, reason: "host" };
  }
  const match = url.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (!match?.[1]) return { ok: false, reason: "missing-bvid" };
  const rawPage = url.searchParams.get("p");
  if (rawPage === null) return { ok: true, bvid: match[1] };
  if (!/^[1-9]\d*$/.test(rawPage)) return { ok: false, reason: "invalid-page", bvid: match[1] };
  return { ok: true, bvid: match[1], page: Number(rawPage) };
}

export function bilibiliVideoUrl(bvid: string, page: number, seconds?: number): string {
  const url = new URL(`https://www.bilibili.com/video/${bvid}/`);
  url.searchParams.set("p", String(page));
  if (seconds !== undefined) url.searchParams.set("t", String(Math.max(0, Math.floor(seconds))));
  return url.toString();
}
