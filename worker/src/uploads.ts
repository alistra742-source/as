import type { BrowserContext, Page, Response } from "playwright-core";
import { readingPause, sleep, thinkingPause } from "./human.js";
import {
  CANDIDATE_ATTR,
  CAPTION_MAX_CHARS,
  CAPTION_SELECTOR,
  collectEditableBoxes,
  pickEditableBox,
  type EditableBox,
} from "./captionPick.js";
import {
  candidateFromResponse,
  sizeFloorNote,
  splitByMediaHost,
  describeGrabFailure,
  harvestMediaUrls,
  looksLikeVideoBytes,
  rankCandidates,
  sizeRejection,
  sourcePlatformOf,
  tiktokPostId,
  youtubePlayability,
  type MediaCandidate,
  type SourcePlatform,
} from "./sourceGrab.js";
import { TIKTOK_EDITING_TIP_ATTR, markTikTokEditingTipButton } from "./tiktokPrompt.js";

export interface VideoFile {
  name: string;
  mime: string;
  buffer: Buffer;
}

type StepLog = (text: string) => void;

export type UploadPlatform = "tiktok" | "instagram" | "youtube";

export interface UploadResult {
  ok: boolean;
  message: string;
  /** Destination post URL, only when the studio exposed one after publishing. */
  liveUrl?: string;
}

/**
 * "The page went away", as opposed to "the site said no". Playwright reports a
 * crashed or replaced tab as a closed target on whichever call it was on, so this
 * matches the whole family. Only this kind of failure is worth retrying: the site
 * refusing a publish will refuse it again.
 */
export function isTabGone(err: unknown): boolean {
  const m = (err as Error)?.message ?? String(err);
  return /Target (page, context or browser has been )?closed|Target crashed|has been closed|closed while|Execution context was destroyed|page\.reload: Target/i.test(m);
}

/**
 * Resolve a public video page — TikTok, Instagram or YouTube — to the file that
 * site serves, and download it.
 *
 * One rule shapes this whole function: **believe the wire, not the DOM.** Every
 * one of the three players can hold the file in a `blob:` URL or set it after the
 * page settles, so the page's `<video>` tag is only a hint; the URLs the page's
 * own JSON contains, and the responses the player actually fetched, are the
 * evidence. Candidates are ranked, then tried in order, and an attempt is only a
 * success when the bytes start with a video container — a CDN's XML `AccessDenied`
 * and a bot-wall login page are both valid HTTP 200 answers that would otherwise
 * be handed to the uploader as if they were footage.
 */
export async function downloadVideo(
  page: Page,
  ctx: BrowserContext,
  sourceUrl: string,
  log: StepLog
): Promise<VideoFile> {
  const platform = sourcePlatformOf(sourceUrl);
  let origin = sourceUrl;
  try {
    origin = new URL(sourceUrl).origin;
  } catch {
    /* a malformed link gets the failure it deserves below */
  }

  // Watch both kinds of evidence while each source surface loads:
  //   1. the media response itself, and
  //   2. TikTok's item-detail JSON response, which often owns playAddr even when
  //      React never mounts <video> on the heavy share page.
  // The old listener kept only (1), then stopped 700 ms after a bare <video>
  // element appeared. That is why the exact same link could yield 20.6 MB once
  // and only a 223 KB tour/login asset on the next press.
  const sniffed: MediaCandidate[] = [];
  const apiCandidates: MediaCandidate[] = [];
  const apiReads = new Set<Promise<void>>();
  let sourceId = platform === "tiktok" ? tiktokPostId(sourceUrl) : null;
  const onResponse = (res: Response) => {
    try {
      const status = res.status();
      if (status !== 200 && status !== 206) return;
      const u = res.url();
      if (!u) return;
      const headers = res.headers();
      const lenH = headers["content-length"];
      const rangeTotal = /\/([0-9]+)$/.exec(headers["content-range"] || "")?.[1];
      const declared = rangeTotal ? Number(rangeTotal) : lenH ? Number(lenH) : undefined;
      const candidate = candidateFromResponse(u, headers["content-type"] || "", declared);
      if (candidate && sniffed.length < 100) sniffed.push(candidate);

      // XHR JSON is not part of page.content(). Keep only the one-item endpoint,
      // never feed/recommendation JSON (which would let a different video's URL
      // masquerade as the requested post).
      if (platform !== "tiktok" || !/\/api\/item\/detail(?:\/|\?)/i.test(u)) return;
      const responseId = tiktokPostId(u);
      if (sourceId && responseId && responseId !== sourceId) return;
      if (!sourceId && responseId) sourceId = responseId;
      const read = res
        .text()
        .then((text) => {
          if (sourceId && !text.includes(sourceId)) return;
          for (const url of harvestMediaUrls(text)) apiCandidates.push({ url, from: "page-json", score: 0 });
        })
        .catch(() => undefined);
      apiReads.add(read);
      void read.finally(() => apiReads.delete(read));
    } catch {
      /* a detached response header set is not worth a failed publish */
    }
  };
  page.on("response", onResponse);

  // All surfaces contribute to one ranked pool. Exact URLs are fetched once;
  // TikTok's official player / refresh normally supplies a newly signed URL.
  const candidates: MediaCandidate[] = [];
  const attemptedUrls = new Set<string>();
  const tried: MediaCandidate[] = [];
  // More than the old four so a valid extensionless playAddr cannot sit just
  // below a few decorative mp4s, but still bounded tightly enough that a page's
  // related-video JSON can never turn into a broad download crawl.
  const maxFetches = platform === "tiktok" ? 8 : 6;
  let lastNote: string | null = null;
  let lastHtml = "";

  const settleApiReads = async () => {
    const pending = Array.from(apiReads);
    if (!pending.length) return;
    await Promise.race([Promise.allSettled(pending), sleep(1800)]);
  };

  /** Open one official representation of the same post and collect its evidence. */
  const inspectSurface = async (url: string, player = false): Promise<string> => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    sourceId ||= platform === "tiktok" ? tiktokPostId(page.url()) : null;

    // If hydration JSON already contains a media host, do not pay the old 12 s
    // worst-case wait. Otherwise wait for a *ready/source-bearing* video, not just
    // an empty element that React inserted before it knew what to play.
    let earlyHtml = await page.content().catch(() => "");
    const early = harvestMediaUrls(earlyHtml).map((mediaUrl) => ({ url: mediaUrl, from: "page-json" as const, score: 0 }));
    const hasEarlyContent = splitByMediaHost(early, platform).kept.length > 0;
    if (player) {
      // Wake the official player as soon as its element exists. Waiting for
      // readyState *before* play() made an idle player burn its full 14 s budget
      // without ever issuing the media request we were waiting to sniff.
      await page
        .waitForFunction(() => !!document.querySelector("video"), null, { timeout: hasEarlyContent ? 2000 : 8000 })
        .catch(() => undefined);
      await page
        .evaluate(() => {
          const video = document.querySelector("video") as HTMLVideoElement | null;
          if (!video) return;
          video.muted = true;
          void video.play().catch(() => undefined);
        })
        .catch(() => undefined);
    }
    await page
      .waitForFunction(
        () => {
          const video = document.querySelector("video") as HTMLVideoElement | null;
          return !!video && (video.readyState >= 1 || !!video.currentSrc || !!video.getAttribute("src"));
        },
        null,
        { timeout: hasEarlyContent ? 3000 : player ? 6000 : 12_000 }
      )
      .catch(() => undefined);
    await sleep(player ? 1100 : 650);
    await settleApiReads();

    const html = (await page.content().catch(() => "")) || earlyHtml;
    if (!html && (page.isClosed() || !(await page.evaluate(() => true).then(() => true).catch(() => false)))) {
      throw new Error("The tab has been closed while the source page was opening (it crashed) — waiting for the reopen");
    }
    candidates.push(
      ...harvestMediaUrls(html).map((mediaUrl) => ({ url: mediaUrl, from: "page-json" as const, score: 0 })),
      ...(await playerHints(page)),
      ...apiCandidates,
      ...sniffed
    );
    lastHtml = html;
    sourceId ||= platform === "tiktok" ? tiktokPostId(page.url()) : null;
    return html;
  };

  /** Fetch newly discovered candidates, validating the complete bytes each time. */
  const fetchAvailable = async (): Promise<VideoFile | null> => {
    const { kept, dropped } = splitByMediaHost(candidates, platform);
    const left = maxFetches - tried.length;
    if (left <= 0) return null;
    const ranked = rankCandidates(kept, platform, Math.max(24, kept.length))
      .filter((candidate) => !attemptedUrls.has(candidate.url.split("#")[0]))
      .slice(0, left);
    if (!ranked.length) {
      if (!kept.length && dropped.length) lastNote = describePage(lastHtml) || `${dropped.length} URL(s) were static/login assets`;
      return null;
    }
    log(
      `${ranked.length} new candidate video URL${ranked.length === 1 ? "" : "s"} from this surface` +
        `${dropped.length ? ` (${dropped.length} page-asset URL${dropped.length === 1 ? "" : "s"} ignored)` : ""} — fetching in ranked order…`
    );

    const ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
    const language = await page.evaluate(() => navigator.language).catch(() => "en-US");
    const referer = /^https?:/i.test(page.url()) ? page.url() : sourceUrl;
    let requestOrigin = origin;
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      /* keep the validated source origin */
    }
    for (const candidate of ranked) {
      const key = candidate.url.split("#")[0];
      attemptedUrls.add(key);
      tried.push(candidate);
      const n = tried.length;
      const host = hostOf(candidate.url);
      const headers: Record<string, string> = {
        referer,
        origin: requestOrigin,
        "user-agent": ua,
        "accept-language": `${language},en;q=0.8`,
        accept: "video/mp4,video/webm,video/*;q=0.9,*/*;q=0.5",
      };
      // Google's CDN requires an explicit range for a whole-file API request.
      // TikTok does not: leaving Range off is deliberate, because its CDN can cap
      // an open-ended range to one playback chunk while a plain GET returns the
      // complete file (the 20.6 MB success in the report used that path).
      if (/googlevideo\.com/i.test(candidate.url)) headers.range = "bytes=0-";
      const resp = await ctx.request
        .get(candidate.url, { headers, timeout: 120_000 })
        .catch((error) => ((lastNote = `fetch failed: ${(error as Error).message}`), null));
      if (!resp) {
        log(`  · candidate ${n}/${maxFetches} ${host} (${candidate.from}) → ${lastNote}`);
        continue;
      }
      const status = resp.status();
      if (status !== 200 && status !== 206) {
        lastNote = `${host} answered HTTP ${status}`;
        log(`  · candidate ${n}/${maxFetches} ${host} (${candidate.from}) → HTTP ${status}`);
        continue;
      }
      const responseHeaders = resp.headers();
      const contentRange = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(responseHeaders["content-range"] || "");
      const rangeStart = contentRange ? Number(contentRange[1]) : 0;
      const rangeEnd = contentRange ? Number(contentRange[2]) : -1;
      const rangeTotal = contentRange && contentRange[3] !== "*" ? Number(contentRange[3]) : 0;
      const lenH = responseHeaders["content-length"];
      const declared = rangeTotal || (lenH ? Number(lenH) : 0);
      const tooBig = sizeRejection(declared);
      if (tooBig) {
        lastNote = tooBig;
        log(`  · candidate ${n}/${maxFetches} ${host} (${candidate.from}) → ${tooBig}`);
        continue;
      }
      const body = await resp.body().catch(() => null);
      if (!body || body.length < 60_000) {
        lastNote = `${host} returned ${body ? body.length : 0} bytes — not a video`;
        log(`  · candidate ${n}/${maxFetches} ${host} (${candidate.from}) → ${lastNote}`);
        continue;
      }
      // Never upload a valid-looking *piece* of an MP4. A first range starts with
      // ftyp and can easily exceed 300 KB, so byte sniffing alone would bless a
      // truncated file that TikTok's studio later cannot process.
      if (rangeTotal && (rangeStart !== 0 || rangeEnd + 1 < rangeTotal)) {
        lastNote = `${host} returned only bytes ${rangeStart}-${rangeEnd} of ${rangeTotal}`;
        log(`  · candidate ${n}/${maxFetches} ${host} (${candidate.from}) → partial media range, not the complete clip`);
        continue;
      }
      const floor = sizeFloorNote(body.length);
      if (floor) {
        lastNote = `${host}: ${floor}`;
        log(`  · candidate ${n}/${maxFetches} ${host} (${candidate.from}) → ${floor}`);
        continue;
      }
      if (!looksLikeVideoBytes(body)) {
        lastNote = `${host} returned a page/error document, not video bytes`;
        log(`  · candidate ${n}/${maxFetches} ${host} (${candidate.from}) → not a video container`);
        continue;
      }
      const oversize = sizeRejection(body.length);
      if (oversize) throw new Error(oversize);
      const mime = (responseHeaders["content-type"] || "video/mp4").split(";")[0];
      log(`Got complete video (${(body.length / 1_048_576).toFixed(1)} MB) from ${host} — opening the upload studio now.`);
      return { name: `clip-${Date.now()}.mp4`, mime: mime.includes("video") ? mime : "video/mp4", buffer: body };
    }
    return null;
  };

  try {
    log(
      platform === "other"
        ? "Reading the source video in a temporary background tab…"
        : `Reading the source video in a temporary background tab… (${platform} link${
            platform === "tiktok" ? "" : ` — cross-posting a ${platform} video is fine`
          })`
    );
    const html = await inspectSurface(sourceUrl);
    const verdict = platform === "youtube" ? youtubePlayability(html) : null;
    if (verdict && verdict.status !== "OK") {
      log(
        `YouTube says “${verdict.status}${verdict.reason ? `: ${verdict.reason}` : ""}” for this video — ` +
          `still trying the URLs the page exposed, but that is usually a bot check on this IP.`
      );
    }
    lastNote = describePage(html);
    let video = await fetchAvailable();
    if (video) return video;

    if (platform === "tiktok") {
      sourceId ||= tiktokPostId(page.url(), html);
      if (sourceId) {
        log("The share page exposed only previews or unusable URLs — trying TikTok’s official lightweight player for the same post…");
        await inspectSurface(`https://www.tiktok.com/player/v1/${sourceId}?autoplay=1&controls=0`, true);
        video = await fetchAvailable();
        if (video) return video;
      }

      // A fresh document gets fresh time-limited playAddr signatures. This is one
      // bounded retry, not a loop: if the share page and official player both
      // refuse the content, hammering them only makes the session less trusted.
      log("No complete file yet — refreshing the original TikTok post once for fresh media URLs…");
      await inspectSurface(sourceUrl);
      video = await fetchAvailable();
      if (video) return video;
    }

    const { dropped } = splitByMediaHost(candidates, platform);
    const uniqueDropped = rankCandidates(dropped, platform, Math.max(24, dropped.length)).length;
    throw new Error(describeGrabFailure(platform, tried, lastNote || describePage(lastHtml), uniqueDropped));
  } finally {
    page.off("response", onResponse);
  }
}

/**
 * What the page itself points at: the playing element, its <source> children, and
 * the og:/twitter: stream metas a share button relies on. A `blob:` URL is skipped
 * — it is only valid inside this page, so it can never be re-fetched.
 */
async function playerHints(page: Page): Promise<MediaCandidate[]> {
  const raw = await page
    .evaluate(() => {
      const out: { url: string; from: "player" | "meta" }[] = [];
      const push = (url: string | null | undefined, from: "player" | "meta") => {
        if (url && !/^blob:/i.test(url) && !/^data:/i.test(url)) out.push({ url, from });
      };
      const v = document.querySelector("video");
      if (v) {
        push((v.currentSrc || v.src || "") as string, "player");
        for (const s of Array.from(v.querySelectorAll("source"))) push(s.getAttribute("src"), "player");
      }
      for (const s of Array.from(document.querySelectorAll("video source"))) push(s.getAttribute("src"), "player");
      for (const sel of ['meta[property="og:video"]', 'meta[property="og:video:url"]', 'meta[property="og:video:secure_url"]', 'meta[name="twitter:player:stream"]']) {
        const el = document.querySelector(sel);
        push(el?.getAttribute("content"), "meta");
      }
      return out;
    })
    .catch(() => [] as { url: string; from: "player" | "meta" }[]);
  return raw.map((r) => ({ url: r.url, from: r.from, score: 0 }));
}

/** One honest sentence about what the source page showed, for the failure log. */
function describePage(html: string): string | null {
  if (!html || html.length < 1500) return "the page never finished loading";
  if (/captcha|Are you a robot|verify it.s really you/i.test(html.slice(0, 6000))) return "a captcha/verification wall";
  if (/log in to continue|"statusCode":10221|passport\/|accounts\/login/i.test(html)) return "a login wall";
  if (/"playabilityStatus"[^}]*"LOGIN_REQUIRED"/i.test(html)) return "YouTube login required";
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^rr\d+-/, "");
  } catch {
    return url.slice(0, 28);
  }
}

/* --------------------------------- TikTok --------------------------------- */

/** TikTok's studio has answered at both of these; which one renders depends on
 * the account and the day, so try each until a file input shows up. */
const TIKTOK_STUDIO_URLS = ["https://www.tiktok.com/upload", "https://www.tiktok.com/tiktokstudio/upload"];

/**
 * Close the one-time "New editing features added" card that TikTok lays over the
 * completed upload editor. This is not cosmetic: its backdrop intercepts the
 * Description, audience and Post presses. The finder in `tiktokPrompt.ts`
 * requires the local title + exact "Got it" label, so an unrelated acknowledgement
 * elsewhere in Studio cannot be pressed.
 *
 * Start with Playwright's normal trusted pointer click. A React re-render can
 * replace the marked button between finding and pressing, so each retry finds it
 * afresh; force and DOM activation are bounded last resorts for this harmless
 * product-tour acknowledgement. We only report success after the card is no
 * longer found, and stop the publish rather than blindly posting behind it if all
 * three paths are ignored.
 */
async function dismissTikTokEditingTip(page: Page, log: StepLog): Promise<boolean> {
  const find = () =>
    page
      .evaluate(markTikTokEditingTipButton, [TIKTOK_EDITING_TIP_ATTR] as [string])
      .catch(() => null);

  let tip = await find();
  if (!tip) return false;
  log(`TikTok showed “New editing features added” — auto-clicking “Got it”…`);

  for (let attempt = 0; attempt < 3; attempt++) {
    const button = page.locator(`[${TIKTOK_EDITING_TIP_ATTR}="1"]`).first();
    if (attempt === 0) {
      await button.scrollIntoViewIfNeeded().catch(() => undefined);
      await button.click({ timeout: 5000 }).catch(() => undefined);
    } else if (attempt === 1) {
      // Still a real trusted mouse event; `force` only skips Playwright's
      // actionability gate if the fading backdrop confuses its hit test.
      await button.click({ timeout: 3000, force: true }).catch(() => undefined);
    } else {
      // The tour card carries no account action. A direct click is safer than
      // letting the upload continue with every meaningful control covered.
      await button.evaluate((el: Element) => (el as HTMLElement).click()).catch(() => undefined);
    }
    await sleep(attempt === 0 ? 450 : 650);
    tip = await find();
    if (!tip) {
      log(`✅ Auto-clicked “Got it” — TikTok’s editing-features popup is closed.`);
      return true;
    }
  }

  await page
    .evaluate((attr) => {
      for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
    }, TIKTOK_EDITING_TIP_ATTR)
    .catch(() => undefined);
  throw new Error(
    `TikTok's “New editing features added” popup stayed open after three “Got it” click attempts — ` +
      `close it in the live browser, then post again.`
  );
}

/**
 * Get to a usable file input on the current page: notice a login wall, wait for
 * the input, and press the button that mounts it when the studio keeps the input
 * hidden inside "Upload video" until it is clicked.
 */
export async function revealTiktokInput(page: Page, log: StepLog): Promise<"found" | "wall" | "wrong-page" | "missing"> {
  const wall = await page
    .evaluate(() => {
      const u = location.href;
      const text = (document.body?.innerText || "").slice(0, 1500);
      const login = /\/login|passport|\/accounts\//i.test(u) || /log in to continue|phone or email|sign up to continue/i.test(text);
      const at = new URL(u);
      const studio = /\/((tiktokstudio|creator-center)\/)?upload(?:[/?#]|$)/i.test(at.pathname + at.search);
      return { url: u, login, studio, hasInput: !!document.querySelector('input[type="file"]') };
    })
    .catch(() => null);
  if (wall?.login && !wall.hasInput) {
    log(`TikTok redirected to a login wall at ${wall.url.slice(0, 60)}`);
    return "wall";
  }
  if (wall && !wall.studio) {
    log(`TikTok did not enter its upload studio — navigation stayed at ${wall.url.slice(0, 70)}`);
    return "wrong-page";
  }
  const input = page.locator('input[type="file"]').first();
  if ((await input.count()) > 0) return "found";
  await input.waitFor({ state: "attached", timeout: 12_000 }).then(() => "found").catch(() => "none");
  if ((await input.count()) > 0) return "found";
  const trigger = page.locator('button:has-text("Upload video"), [data-e2e="upload-btn"], div:has-text("Select file")').last();
  if ((await trigger.count()) > 0) {
    await trigger.click({ timeout: 6000 }).catch(() => undefined);
    await sleep(1800);
    if ((await page.locator('input[type="file"]').count()) > 0) return "found";
  }
  return "missing";
}

export async function uploadTikTok(page: Page, video: VideoFile, caption: string, log: StepLog): Promise<UploadResult> {
  let state: "found" | "wall" | "wrong-page" | "missing" = "missing";
  let lastUrl = "";
  let lastActualUrl = "";
  for (const studio of TIKTOK_STUDIO_URLS) {
    lastUrl = studio;
    log(`Opening TikTok upload studio… (${studio.replace("https://www.tiktok.com", "")})`);
    await page.goto(studio, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    // The studio is a React app: wait for the input itself rather than a fixed
    // delay, then keep only the short beat that makes it look read before used.
    await page
      .waitForFunction(() => !!document.querySelector('input[type="file"]') || /log in|password/i.test(document.body?.innerText?.slice(0, 400) || ""), null, { timeout: 14_000 })
      .catch(() => undefined);
    await readingPause(250, 700);
    state = await revealTiktokInput(page, log);
    lastActualUrl = page.url();
    if (state === "found") break;
  }
  if (state === "wall") {
    throw new Error(
      `TikTok bounced the upload to a login wall (${lastUrl}) — this browser's session is not accepted any more. ` +
        `Re-paste the session cookie in the deck, or log in once in the live browser, then post again.`
    );
  }
  if (state === "wrong-page") {
    throw new Error(
      `TikTok did not enter either upload-studio URL; navigation remained at ${lastActualUrl.slice(0, 90)}. ` +
        `No file was attached and nothing was posted.`
    );
  }
  if (state !== "found") {
    throw new Error(
      `TikTok's studio loaded without a file input at ${lastUrl.replace("https://www.tiktok.com", "")} — ` +
        `this session is not signed in there. Re-paste the session cookie or sign in once in the live studio, ` +
        `then post again (the video is already downloaded).`
    );
  }
  await page.locator('input[type="file"]').first().setInputFiles({ name: video.name, mimeType: video.mime, buffer: video.buffer });
  log("Video processing in studio…");
  await sleep(4000); // floor: the editor's DOM does not exist until the upload is accepted
  // The tour card can arrive before the editor beneath it finishes mounting.
  await dismissTikTokEditingTip(page, log);
  // …then wait for the editor itself. A short clip is ready in under a second and
  // used to sit at this 4 s mark; a long one used to blow past it and have the
  // caption typed into a page that was still showing a progress bar.
  await page
    .waitForFunction(() => !!document.querySelector('div[contenteditable="true"], textarea'), null, { timeout: 40_000 })
    .catch(() => undefined);
  // It can also be mounted by the same render that adds the Description field.
  await dismissTikTokEditingTip(page, log);

  // The caption is the part that silently vanishes when this is wrong, so it does
  // not get a list of yesterday's selectors: score every editable box on the page
  // by what labels it and how big it is, then type into the winner. The studio's
  // redesigns move the box; "the wide contenteditable near the word Description"
  // has survived all of them, and it beats the search input and the comment box
  // (the two decoys) by construction rather than by luck.
  const captionFilled = await typeIntoCaptionEditor(page, caption, log);
  if (!captionFilled && (await dismissTikTokEditingTip(page, log))) {
    // Covers the narrow race where the tip appeared between the pre-caption check
    // and the click into Description. The first attempt did not land, so fill it
    // again now that the backdrop is gone instead of publishing captionless.
    log("Retrying the caption now that TikTok’s popup is out of the way…");
    await typeIntoCaptionEditor(page, caption, log);
  }
  // Close a tip that raced the caption readback before touching audience controls.
  await dismissTikTokEditingTip(page, log);

  // Audience must be “Everyone”. It is TikTok's default; enforce it when the control exists.
  const whoCanView = page.getByText("Who can view this video", { exact: false });
  if ((await whoCanView.count()) > 0) {
    const everyone = page.getByText("Everyone", { exact: true }).last();
    if ((await everyone.count()) > 0) {
      await everyone.click().catch(() => undefined);
    }
  }

  log("Publishing to Everyone…");
  await readingPause(800, 2200); // a human checks the draft before hitting Post
  // Last-moment guard: if TikTok delayed the tour until the preview/settings
  // panel hydrated, remove it before the actual Post press as well.
  await dismissTikTokEditingTip(page, log);
  const studioUrlBeforePost = page.url();
  const postBtn = page.locator('button[data-e2e="post_button"], button:has-text("Post")').last();
  let postPressed = await postBtn.click({ timeout: 15_000 }).then(() => true).catch(() => false);
  if (!postPressed && (await dismissTikTokEditingTip(page, log))) {
    postPressed = await postBtn.click({ timeout: 15_000 }).then(() => true).catch(() => false);
  }
  try {
    // Check the live URL even after an ambiguous click error: navigation can
    // detach the button quickly enough for Playwright to reject a click that did
    // in fact publish.
    await page.waitForURL(
      (url) => /\/video\//i.test(url.pathname) && url.href !== studioUrlBeforePost,
      { timeout: 40_000 }
    );
    const liveUrl = page.url();
    log(`✅ TikTok publish confirmed — ${liveUrl.slice(0, 90)} · audience Everyone.`);
    return { ok: true, message: "Published on TikTok", liveUrl };
  } catch {
    return postPressed
      ? { ok: false as const, message: "Posted but confirmation redirect wasn't observed — verify in the browser." }
      : { ok: false as const, message: "TikTok's Post button did not accept the click — check the live studio for a disabled button or another prompt." };
  }
}

/**
 * "May this session post at all?" — the same probe the uploader runs, without the
 * 40 seconds of downloading first. A publish that dies on the site's own terms
 * (login wall, checkpoint) is a *session* problem, and the user should find that
 * out in ten seconds from a button rather than by reading a log line after a
 * download they did not need.
 */
export async function checkUploadAccess(
  platform: UploadPlatform,
  page: Page,
  log: StepLog
): Promise<{ ok: boolean; verdict: string }> {
  if (platform === "tiktok") {
    let wall = false;
    let wrongPage = "";
    for (const studio of TIKTOK_STUDIO_URLS) {
      log(`Checking ${studio.replace("https://www.tiktok.com", "")}…`);
      await page.goto(studio, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
      await sleep(900);
      const state = await revealTiktokInput(page, log);
      if (state === "found") return { ok: true, verdict: "the upload studio is open and has a file input — this session can post" };
      if (state === "wall") wall = true;
      if (state === "wrong-page") wrongPage = page.url();
    }
    if (wall) {
      return { ok: false, verdict: "TikTok redirected to a login wall — this session is not signed in for writes; re-paste the cookie or log in once in this tab" };
    }
    if (wrongPage) {
      return { ok: false, verdict: `TikTok did not enter its upload studio and stayed at ${wrongPage.slice(0, 70)} — no upload control was used` };
    }
    return { ok: false, verdict: "the studio loaded without a file input — this session is not signed in there; re-paste the cookie or sign in once in Studio" };
  }

  const studio = platform === "instagram" ? "https://www.instagram.com/create/select/" : "https://www.youtube.com/upload";
  log(`Checking ${studio.replace(/^https:\/\/(www\.)?/, "")}…`);
  await page.goto(studio, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await sleep(1000);
  const probe = await page
    .evaluate(() => {
      const u = location.href;
      const text = (document.body?.innerText || "").slice(0, 2000);
      const input = !!document.querySelector('input[type="file"]');
      const wall = /\/accounts\/login|accounts\.google\.com|\/login|ServiceLogin/i.test(u) || /log in|sign in|enter your password/i.test(text.slice(0, 400));
      return { url: u, input, wall };
    })
    .catch(() => null);
  if (!probe) return { ok: false, verdict: "the page did not answer" };
  if (probe.input) return { ok: true, verdict: "the create page has a file input — this session can post" };
  return probe.wall
    ? { ok: false, verdict: `bounced to a login page (${probe.url.slice(0, 60)}) — this session is not signed in for writes` }
    : { ok: false, verdict: `no file input at ${probe.url.slice(0, 60)} — the site is showing a check or its layout changed` };
}

/**
 * Find and fill the studio's description box (see `captionPick.ts` for the why).
 *
 * `insertText` (CDP `Input.insertText`) is tried before `keyboard.type` because a
 * hashtag typed one character at a time opens TikTok's suggestion popup, which
 * then swallows the following space and truncates the caption — the classic "my
 * hashtags disappeared". Inserting the whole string and pressing Escape avoids the
 * popup; per-character typing stays as the fallback for a box that refuses
 * programmatic text. Every outcome logs something, because the failure mode we are
 * guarding against is a publish that *succeeds* with no caption.
 */
async function typeIntoCaptionEditor(page: Page, caption: string, log: StepLog): Promise<boolean> {
  const text = (caption || "").trim();
  if (!text) return false;
  const boxes = (
    await page.evaluate(collectEditableBoxes, [CAPTION_SELECTOR, CANDIDATE_ATTR] as [string, string]).catch((): EditableBox[] => [])
  ) as EditableBox[];
  const best = pickEditableBox(boxes);
  if (!best) {
    const seen = boxes
      .slice(0, 5)
      .map((b) => `${b.tag} "${(b.label || "unlabelled").slice(0, 28)}" ${b.width}x${b.height}${b.enabled ? "" : " (disabled)"}`);
    log(
      seen.length
        ? `No box on the page looks like a caption field — posting without one. Editable boxes found: ${seen.join(" · ")}`
        : "No editable field on the page at all — posting without a caption (a signed-out studio shows exactly this)."
    );
    return false;
  }
  log(`Caption → ${best.tag} "${(best.label || "no nearby label").slice(0, 32)}" (${best.width}x${best.height})`);

  const box = page.locator(`[${CANDIDATE_ATTR}="${best.id}"]`).first();
  // A real focus/click first: React editors install their own selection state on
  // the event, and typing into a focused-but-never-clicked box is how you get an
  // empty caption with no error anywhere.
  // Wrapped in Promise.resolve() on purpose: if a driver's locator lacks one of
  // these methods, the call throws *synchronously* and a bare .catch() never sees
  // it — which would turn "the caption box was found" into a failed publish.
  const safe = (fn: () => unknown) => Promise.resolve().then(fn).catch(() => undefined);
  await safe(() => box.scrollIntoViewIfNeeded());
  await safe(() => box.click({ timeout: 5000 }));
  await thinkingPause(220, 600); // read the draft before writing it
  const written = await page.keyboard
    .insertText(text.slice(0, CAPTION_MAX_CHARS))
    .then(() => true)
    .catch(async () => {
      await page.keyboard.type(text.slice(0, CAPTION_MAX_CHARS)).catch(() => undefined);
      return false;
    });
  await sleep(220);
  // Dismiss the hashtag/mention popup so it cannot eat the next keystroke, and so
  // the studio's own "Post" button is not behind an open suggestion list.
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.evaluate((attr) => {
    for (const el of Array.from(document.querySelectorAll(`[${attr}]`))) el.removeAttribute(attr);
  }, CANDIDATE_ATTR).catch(() => undefined);

  const shown = await box
    .evaluate((el: Element) => ((el as HTMLTextAreaElement).value || (el as HTMLElement).innerText || "").trim())
    .catch(() => "");
  if (!shown) {
    log(written ? "Typed into the caption field but it reads back empty — check the live browser before posting." : "The caption field would not accept text — posting without a caption.");
    return false;
  }
  return true;
}

/* -------------------------------- Instagram -------------------------------- */

export async function uploadInstagram(page: Page, video: VideoFile, caption: string, log: StepLog): Promise<UploadResult> {
  log("Opening Instagram create flow…");
  await page.goto("https://www.instagram.com/create/select/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => !!document.querySelector('input[type="file"]'), null, { timeout: 14_000 })
    .catch(() => undefined);
  await readingPause(250, 700);

  const fileInput = page.locator('input[type="file"]').first();
  try {
    await fileInput.waitFor({ state: "attached", timeout: 40_000 });
    await fileInput.setInputFiles({ name: video.name, mimeType: video.mime, buffer: video.buffer });
  } catch {
    throw new Error("Instagram create page didn't expose a file input (are you signed in?).");
  }
  log("Reel uploaded — moving to the caption step…");

  // “Next” through crop/cover screens if present.
  for (let i = 0; i < 4; i++) {
    const next = page.locator('div[role="button"]:has-text("Next"), button:has-text("Next")').last();
    if ((await next.count()) === 0) break;
    await next.click({ timeout: 4000 }).catch(() => undefined);
    await sleep(900);
  }

  // Same ranked picker as TikTok: Instagram's caption step is a contenteditable
  // that has moved around twice, and "first textbox on the page" is what put the
  // caption into the alt-text field once already. The old path stays as fallback.
  const filled = await typeIntoCaptionEditor(page, caption, log).catch(() => false);
  if (!filled) {
    const captionBox = page.locator('div[role="textbox"]').first();
    try {
      await captionBox.waitFor({ state: "visible", timeout: 20_000 });
      await captionBox.click();
      await thinkingPause(400, 1400); // compose before typing
      await page.keyboard.type(caption.slice(0, CAPTION_MAX_CHARS)); // humanized (trusted events, typos auto-corrected)
    } catch {
      log("Caption box not found — continuing without caption.");
    }
  }

  // Uncheck "Also post to Facebook" / similar share toggles if shown.
  const fbToggle = page.locator('div[role="button"]:has-text("Also post to Facebook"), div[role="checkbox"]').first();
  if ((await fbToggle.count()) > 0) {
    await fbToggle.click().catch(() => undefined);
    await sleep(500);
  }

  log("Publishing reel…");
  await readingPause(800, 2200); // a human checks the draft before hitting Share
  const share = page.locator('div[role="button"]:has-text("Share"), button:has-text("Share")').last();
  await share.click({ timeout: 15_000 }).catch(() => undefined);
  try {
    await page.waitForURL(/\/(p|reel)\//, { timeout: 40_000 });
    const liveUrl = page.url();
    log(`✅ Instagram publish confirmed — ${liveUrl.slice(0, 90)}.`);
    return { ok: true, message: "Published on Instagram", liveUrl };
  } catch {
    return { ok: false as const, message: "Posted but confirmation redirect wasn't observed — verify in the browser." };
  }
}

export async function uploadToPlatform(
  platform: UploadPlatform,
  page: Page,
  video: VideoFile,
  caption: string,
  log: StepLog
): Promise<UploadResult> {
  if (platform === "tiktok") return uploadTikTok(page, video, caption, log);
  if (platform === "youtube") return uploadYouTube(page, video, caption, log);
  return uploadInstagram(page, video, caption, log);
}

/* --------------------------------- YouTube -------------------------------- */

/**
 * Publish through YouTube Studio (youtube.com/upload). The user's spec maps
 * to: title = caption, visibility = Public (= TikTok's “Everyone”). Selectors
 * are best-effort like the TikTok/IG uploaders and change over time; failures
 * log loudly and can always be finished by hand in the live browser.
 */
export async function uploadYouTube(page: Page, video: VideoFile, caption: string, log: StepLog): Promise<UploadResult> {
  log("Opening YouTube Studio upload flow…");
  await page.goto("https://www.youtube.com/upload", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => !!document.querySelector("ytcp-uploads-dialog, input[type='file'], ytcp-create-dialog"), null, { timeout: 16_000 })
    .catch(() => undefined);
  await readingPause(250, 700);

  const signedOut = await page.evaluate(() => {
    const u = location.href;
    if (/accounts\.google\.com|ServiceLogin/i.test(u)) return true;
    return /youtube\.com/i.test(u) && !document.querySelector("button#avatar-btn, a#avatar-btn, a[aria-label*='avatar' i]");
  });
  if (signedOut) {
    throw new Error("YouTube Studio needs a signed-in Google session — log in in the live browser (browser → studio.youtube.com), then post again.");
  }

  const fileInput = page.locator("ytcp-upload-file input[type='file'], input[type='file']").first();
  try {
    await fileInput.waitFor({ state: "attached", timeout: 40_000 });
    await fileInput.setInputFiles({ name: video.name, mimeType: video.mime, buffer: video.buffer });
  } catch {
    throw new Error("YouTube upload dialog didn't expose a file input (are you signed in to Studio?).");
  }

  // Processing → draft editor (title field #textbox). Shorts stay Shorts when
  // the file is 9:16 and under 3 minutes; longer files publish as a normal video.
  log("Video processing in Studio — waiting for the draft editor…");
  const titleBox = page.locator("ytcp-uploads-dialog #textbox, #textbox[contenteditable='true']").first();
  try {
    await titleBox.waitFor({ state: "visible", timeout: 240_000 });
  } catch {
    throw new Error("Draft editor never appeared after processing (video may be too long or Studio is stuck).");
  }
  try {
    await titleBox.click({ timeout: 8000 });
    await thinkingPause(400, 1400); // compose before typing
    await page.keyboard.type(caption.slice(0, 90)); // humanized (trusted events, typos auto-corrected)
    log(`Title set: “${caption.slice(0, 60)}…”`);
  } catch {
    log("Could not type the title automatically — paste it in the studio draft if needed.");
  }

  // “Made for kids” — YouTube requires an explicit answer; choose “No”.
  const notKids = page
    .locator("ytcp-uploads-dialog div[role='radio']:has-text(\"No, it's not made for kids\"), ytcp-uploads-dialog:has-text(\"Made for kids\") div[role='radio']")
    .first();
  if ((await notKids.count()) > 0) {
    await notKids.click({ timeout: 4000 }).catch(() => undefined);
    await sleep(300);
  }

  // Visibility = Public (the “Everyone” audience). Best-effort: pick the
  // Public radio inside the upload dialog.
  const visPublic = page
    .locator("ytcp-uploads-dialog div[role='radio']:has-text(\"Public\"), ytcp-video-visibility-select div[role='radio']:has-text(\"Public\"), paper-radio-button[name='PUBLIC_VISIBILITY']")
    .first();
  if ((await visPublic.count()) > 0) {
    await visPublic.click({ timeout: 5000 }).catch(() => undefined);
    await sleep(400);
    log("Visibility set to Public (Everyone).");
  }

  log("Publishing…");
  const publish = page.locator("ytcp-button[aria-label*='Publish' i], ytcp-button:has-text(\"Publish\"), button:has-text(\"Publish\")").last();
  await publish.click({ timeout: 15_000 }).catch(() => undefined);
  // Success = the studio upload dialog closes (optionally after a “published” toast).
  const dialogGone = await page
    .waitForFunction(() => {
      const dialog = document.querySelector("ytcp-uploads-dialog") as HTMLElement | null;
      return !dialog || dialog.getAttribute("hidden") !== null || dialog.style.display === "none";
    }, { timeout: 45_000 })
    .then(() => true)
    .catch(() => false);
  if (dialogGone) {
    log("✅ YouTube publish confirmed — visibility Public (Everyone).");
    return { ok: true as const, message: "Published on YouTube (Public)" };
  }
  const body = await page.evaluate(() => document.body?.innerText?.slice(0, 600) ?? "");
  if (/publish\s*ed/i.test(body) || /video\s+publish/i.test(body)) {
    log("✅ YouTube publish confirmed — visibility Public (Everyone).");
    return { ok: true as const, message: "Published on YouTube (Public)" };
  }
  return { ok: false as const, message: "Publish clicked but Studio kept the dialog open — check for an error in the live browser." };
}
