/**
 * Turning *any* short-video link into a file we can upload.
 *
 * The deck's publisher used to grab whatever `document.querySelector("video").src`
 * happened to expose on the source page. That works on exactly none of the three
 * sites it is aimed at: TikTok and YouTube play through MSE with a `blob:` URL,
 * Instagram's `<video>` is set late (or behind a wall), and a page that refuses a
 * datacenter browser answers with a login screen that has no video at all. So this
 * module reads the *page text* instead — the same three places a human's browser
 * gets its stream from:
 *
 *   TikTok     `__UNIVERSAL_DATA_FOR_REHYDRATION__` / `__SIGI_STATE__` → `playAddr`,
 *              `bitRateList[].PlayAddr.UrlList[]`, `downloadAddr`
 *   Instagram  `"video_versions":[{"url":"https://…cdninstagram.com/…mp4"}]`, `og:video`
 *   YouTube    `ytInitialPlayerResponse.streaming.formats[].url` (progressive mp4)
 *
 * None of it needs the JSON to be well-formed or the schema to be today's schema:
 * media URLs are harvested with a tolerant scan, then *ranked* per platform, so a
 * renamed key costs nothing and a candidate that 403s is just the next candidate.
 *
 * Every function here is pure text in / list out and runs in plain node — that is
 * the point: this is the layer the whole publish flow stands on, and it is
 * covered by `npm test` without a browser.
 */

export type SourcePlatform = "tiktok" | "instagram" | "youtube" | "other";

/** A URL we would be willing to fetch and hand to an uploader. */
export interface MediaCandidate {
  url: string;
  /** Where it came from — shown in the log so a failure is explainable. */
  from: "page-json" | "meta" | "player" | "network";
  /** Higher is better. Platform-specific ranking, see `rankCandidates`. */
  score: number;
  /** Bytes, when the source told us (network sniff / content-length). */
  size?: number;
}

const MP4_HINT = /\.mp4(\?|#|$)/i;
/** CDN hosts that serve TikTok's own encoded file, watermark copy included. */
const TIKTOK_CDN = /(v\d{2,3}m?-?(webapp|app|look)|api\d{2}-normal-c|aweme|snssdk|tiktokcdn|tiktokv)\./i;
const IG_CDN = /(cdninstagram|instagram\.fkrt|fburl|scontent|cdnvideo)\./i;
const YT_CDN = /googlevideo\.com|ytimg\.com/i;
/** Not a file, a playlist — useless to an uploader that wants one mp4. */
const STREAM_MANIFEST = /\.(m3u8|mpd)(\?|#|$)|\/manifest\?|format=(m3u8|mpd)/i;

/** Which site the source link belongs to. */
export function sourcePlatformOf(url: string): SourcePlatform {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  host = host.replace(/^www\./, "");
  if (/tiktok\.com$/.test(host) || /\.tiktok\.com$/.test(host)) return "tiktok";
  if (/instagram\.com$/.test(host) || /instagr\.am$/.test(host)) return "instagram";
  if (/youtube\.com$/.test(host) || /youtu\.be$/.test(host) || /youtube-nocookie\.com$/.test(host)) return "youtube";
  return "other";
}

/**
 * Undo the JSON-in-HTML string escapes a page's embedded state uses, plus the
 * quotes a `srcset`/attribute would leave behind. Order matters: `\/` must be
 * unescaped before anything tries to read a URL out of it.
 */
function unescapeJsonish(text: string): string {
  return text
    .replace(/\\u0026/g, "&")
    .replace(/\\u003d/g, "=")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/\\u002f/gi, "/")
    .replace(/\\(["'/])/g, "$1")
    .replace(/&amp;/g, "&");
}

/**
 * Every URL in the text that looks like a playable media file. Deliberately
 * shape-agnostic — no `"video"` key required — because the three sites change
 * their page JSON on their own schedule and the deck must keep working anyway.
 */
export function harvestMediaUrls(html: string): string[] {
  if (!html) return [];
  const text = unescapeJsonish(html);
  const found = new Set<string>();
  // Both the quoted (`"https://…"`) and bare (`url=https://…`) forms.
  const scan = /https?:\/\/[^\s"'<>()\[\]\\]+/g;
  for (const m of text.matchAll(scan)) {
    const raw = m[0].replace(/[;,]+$/, "");
    if (!looksLikeMediaUrl(raw)) continue;
    found.add(raw);
  }
  return Array.from(found);
}

/** Accept an mp4 (by path or by a `mime=video` parameter); reject manifests. */
export function looksLikeMediaUrl(url: string): boolean {
  // http:// is allowed because `og:video` on Instagram still ships it; blob: and
  // data: are not, because they only exist inside the page that made them.
  if (!/^https?:\/\//i.test(url)) return false;
  if (STREAM_MANIFEST.test(url)) return false;
  if (url.length < 24) return false;
  if (MP4_HINT.test(url)) return true;
  if (/(mime|ct)=video%2fmp4|(mime|ct)=video\/mp4|mime_type=video_mp4/i.test(url)) return true;
  // TikTok's own re-serve endpoint carries no extension at all.
  if (/\/aweme\/v\d\/play\/?/i.test(url)) return true;
  if (YT_CDN.test(url) && /videoplayback/i.test(url)) return true;
  if (TIKTOK_CDN.test(url) && /(play|download|video|aweme)/i.test(url)) return true;
  return false;
}

/** A content-type + length pair from a network response we want to keep. */
export function candidateFromResponse(url: string, contentType: string, length: number | undefined): MediaCandidate | null {
  const ct = (contentType || "").toLowerCase();
  const ok = ct.startsWith("video/") || ct === "application/octet-stream" || looksLikeMediaUrl(url);
  if (!ok) return null;
  if (length !== undefined && length > 0 && length < 120_000) return null; // a poster, a chunk, a 403 page
  return { url, from: "network", score: 0, size: length };
}

function resolutionOf(url: string): number {
  const m = /(?:ratio=|_)(\d{3,4})p?([^a-z0-9]|$)/i.exec(url);
  const n = m ? Number(m[1]) : 0;
  return n >= 144 && n <= 4320 ? n : 0;
}

/**
 * Rank for one platform. Scores are coarse on purpose: the caller fetches the top
 * few in order, so what matters is that the *likely-to-work* form comes first and
 * that a watermark-carrying or manifest-style URL does not win.
 */
export function rankCandidates(list: MediaCandidate[], platform: SourcePlatform, max = 4): MediaCandidate[] {
  const seen = new Set<string>();
  const out: MediaCandidate[] = [];
  for (const c of list) {
    const key = c.url.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...c, score: scoreOf(c, platform) });
  }
  out.sort((a, b) => b.score - a.score || (b.size ?? 0) - (a.size ?? 0));
  return out.slice(0, max);
}

function scoreOf(c: MediaCandidate, platform: SourcePlatform): number {
  const url = c.url;
  let s = 10;
  if (MP4_HINT.test(url)) s += 30;
  if (/mime=video%2fmp4|mime=video\/mp4/i.test(url)) s += 26;
  const res = resolutionOf(url);
  // 720p–1080p is the sweet spot for a re-upload; 144p preview trick is worthless.
  if (res >= 480 && res <= 1440) s += 14;
  else if (res && res < 360) s -= 22;
  else if (res >= 2160) s -= 6; // a 4K file that will not fit the upload's memory diet
  if (c.from === "player") s += 6; // the page's own player is playing it right now
  if (c.from === "network") s += 4; // some request succeeded with it
  if (c.from === "meta") s += 2;
  if (platform === "tiktok") {
    if (TIKTOK_CDN.test(url)) s += 18;
    if (/download/i.test(url)) s -= 4; // the watermark-free copy is the flakiest one
    if (/\/aweme\/v1\/play/.test(url)) s += 4;
  } else if (platform === "instagram") {
    if (IG_CDN.test(url)) s += 20;
    if (/\/o1\/01|efga|vp8/.test(url)) s += 4;
    if (/whst\./.test(url)) s -= 8;
  } else if (platform === "youtube") {
    if (YT_CDN.test(url) && /videoplayback/i.test(url)) s += 20;
    // Progressive formats carry both audio and video in one file — exactly what a
    // re-upload needs. itag 18 (360p) and 22 (720p) are the classic pair.
    const itag = /itag=(\d+)/.exec(url);
    if (itag) s += itag[1] === "18" ? 12 : itag[1] === "22" ? 14 : -10;
    if (/source\/yt_shorts_drm|drm|sparams=.*!|content\s*=/i.test(url)) s -= 40;
  }
  if (/^http:/i.test(url)) s -= 8; // https is what these CDNs serve; plain http is a stale meta tag
  if (/signature=|sig=/.test(url)) s += 4; // already deciphered, so directly fetchable
  if (/\.googlevideo\.com\/videoplayback\?(?!.*sli=)/.test(url)) s += 2;
  return s;
}

/**
 * YouTube's own verdict, which the page embeds before any player code runs. When
 * it says the video needs a sign-in or a bot check, no candidate list will save
 * the attempt — and "the page blocked us" is a far better log line than "no mp4
 * found", because the fix (watch it once in the live browser / use another video)
 * is on the user's side.
 */
export function youtubePlayability(html: string): { status: string; reason: string } | null {
  if (!html) return null;
  const text = unescapeJsonish(html);
  const m = /"playabilityStatus"\s*:\s*\{\s*"status"\s*:\s*"([A-Z_]+)"(?:[^}]*"reason"\s*:\s*"([^"]*)")?/i.exec(text);
  if (!m) return null;
  return { status: m[1], reason: m[2] || "" };
}

/** True when a body really is a video container, not a CDN's XML error page. */
export function looksLikeVideoBytes(head: Uint8Array | Buffer): boolean {
  const b = head.subarray(0, Math.min(head.length, 4096));
  if (b.length < 12) return false;
  const ascii = Buffer.from(b).toString("latin1");
  if (ascii.startsWith("<") || /<\?xml|<!doctype|<html/i.test(ascii.slice(0, 64))) return false; // AccessDenied / bot wall
  // ISO-BMFF: 4-byte size, then 'ftyp' | 'styp' | 'moov' | 'mdat'.
  const tag = ascii.slice(4, 8);
  if (tag === "ftyp" || tag === "styp" || tag === "moov" || tag === "mdat") return true;
  if (ascii.startsWith("ID3") || ascii.startsWith("\u001aE\u00df\xa1")) return true; // mp3/webm containers
  return false;
}

/**
 * Which hosts actually serve the *content*, per site. This exists because a
 * login/challenge wall is full of real, fetchable mp4 files — the animations and
 * background loops of the "Log in to TikTok" screen. Those pass every byte-level
 * check (they are genuine mp4s) and produce exactly the failure mode you get when
 * you only look at the wire: a 0.2 MB "video" that is a wall's decoration,
 * uploaded as if it were the post. So the host has to be a media host, and asset /
 * security / login infrastructure is vetoed even when it looks like video.
 */
const MEDIA_HOST: Record<SourcePlatform, RegExp> = {
  tiktok:
    /(^|\.)(v\d{2,3}m?-|api\d{2}-normal-c\.|v\d+-[a-z0-9-]+\.|)(tiktok\.com|tiktokcdn[^.]*\.com|tiktokv\.com|snssdk\.com|bytecdn[^.]*\.com|ixgny[0-9]?\.com)$/i,
  instagram: /(^|\.)(cdninstagram\.com|instagram\.com|scontent[^.]*\.cdnfbcdn\.net|cdnfbcdn\.net|fbcdn\.net|fburl\.com)$/i,
  youtube: /(^|\.)googlevideo\.com$/i,
  other: /$^/,
};

/** Never a video's origin, whatever it claims. */
const ASSET_HOST = /(webapp-static|website-login|static\.|sf\d+-gecko|sfx-ttw|mon\.ib|security|log\.snssdk|mssdk|analytics|unpkg|jsdelivr)/i;

/** True when this URL could plausibly be the content the page is about. */
export function mediaHostOk(url: string, platform: SourcePlatform): boolean {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (ASSET_HOST.test(host) || ASSET_HOST.test(url)) return false;
  // An extensionless tiktok `play` endpoint is content even though the host is the
  // site itself (`www.tiktok.com/aweme/v1/play/?video_id=…`).
  if (platform === "tiktok" && /\/aweme\/v\d\/play/i.test(url)) return true;
  if (platform === "other") return true; // an unknown host keeps whatever looks like video
  return MEDIA_HOST[platform].test(host);
}

/**
 * Split candidates into "this is the video" and "this is the page's furniture".
 * The dropped half is reported, because *"TikTok offered 4 mp4s, all of them from
 * its static-asset host"* is the sentence that tells you the session was looking
 * at a login wall the whole time.
 */
export function splitByMediaHost(list: MediaCandidate[], platform: SourcePlatform): { kept: MediaCandidate[]; dropped: MediaCandidate[] } {
  const kept: MediaCandidate[] = [];
  const dropped: MediaCandidate[] = [];
  for (const c of list) (mediaHostOk(c.url, platform) ? kept : dropped).push(c);
  // `other` (an unknown host) keeps whatever looks like video.
  if (platform === "other") return { kept: list, dropped: [] };
  return { kept, dropped };
}

/** Below this, it is a poster, a loop, or a wall's background — not a post. */
export const MIN_VIDEO_BYTES = 300_000;

export function sizeFloorNote(bytes: number): string | null {
  if (bytes < MIN_VIDEO_BYTES) {
    return `${(bytes / 1024).toFixed(0)} KB is not a clip — that is a page asset (a login/challenge wall serves exactly these). Floor is ${(MIN_VIDEO_BYTES / 1024).toFixed(0)} KB.`;
  }
  return null;
}

/**
 * Hard cap on what we will pull into memory for an upload: the worker runs
 * alongside a 600–900 MB Chromium renderer and a full-length 4K YouTube file is
 * how you get an OOM kill instead of a post.
 */
export const MAX_VIDEO_BYTES = 180 * 1024 * 1024;

export function sizeRejection(bytes: number): string | null {
  if (bytes > MAX_VIDEO_BYTES) {
    return `source video is ${(bytes / 1_048_576).toFixed(0)} MB — over the ${Math.round(MAX_VIDEO_BYTES / 1_048_576)} MB cap. This deck re-posts clips, not full-length videos.`;
  }
  return null;
}

/**
 * The message a failed grab should print. Naming the platform and the sources we
 * consulted turns "nothing happened" into something a user can act on.
 */
export function describeGrabFailure(
  platform: SourcePlatform,
  tried: MediaCandidate[],
  note: string | null,
  assetOnly = 0
): string {
  const where = platform === "tiktok" ? "TikTok" : platform === "instagram" ? "Instagram" : platform === "youtube" ? "YouTube" : "that page";
  const n = tried.length;
  let base: string;
  if (assetOnly && !n) {
    base =
      `${where}: the page offered ${assetOnly} video URL${assetOnly === 1 ? "" : "s"}, all of them from its static/login ` +
      `host — that is what a login or challenge wall looks like from here, not a broken link`;
  } else if (n) {
    base = `${where}: fetched ${n} candidate URL${n === 1 ? "" : "s"} and none of them gave a playable video`;
  } else {
    base = `${where}: no direct video URL in the page at all`;
  }
  const fix =
    assetOnly && !n
      ? "this session is not signed in on that site — paste the session cookie again (or log in once in the live browser) and post again"
      : "open the link once in the live browser to see what that site shows this session";
  return `${base}${note ? ` (${note})` : ""} — ${fix}`;
}
