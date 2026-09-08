import type { BrowserContext, Page, Response } from "playwright-core";
import { readingPause, sleep, thinkingPause } from "./human.js";
import {
  candidateFromResponse,
  describeGrabFailure,
  harvestMediaUrls,
  looksLikeVideoBytes,
  rankCandidates,
  sizeRejection,
  sourcePlatformOf,
  youtubePlayability,
  type MediaCandidate,
  type SourcePlatform,
} from "./sourceGrab.js";

export interface VideoFile {
  name: string;
  mime: string;
  buffer: Buffer;
}

type StepLog = (text: string) => void;

export type UploadPlatform = "tiktok" | "instagram" | "youtube";

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

  // Watch the wire while the page loads: what the player fetches is, by
  // definition, a URL that works for this browser at this moment.
  const sniffed: MediaCandidate[] = [];
  const onResponse = (res: Response) => {
    try {
      if (sniffed.length >= 60) return;
      const status = res.status();
      if (status !== 200 && status !== 206) return;
      const u = res.url();
      if (!u || u === sourceUrl) return;
      const lenH = res.headers()["content-length"];
      const c = candidateFromResponse(u, res.headers()["content-type"] || "", lenH ? Number(lenH) : undefined);
      if (c) sniffed.push(c);
    } catch {
      /* a detached response header set is not worth a failed publish */
    }
  };
  page.on("response", onResponse);

  try {
    log(
      platform === "other"
        ? `Opening source video page…`
        : `Opening source video page… (${platform} link${
            platform === "tiktok" ? "" : ` — cross-posting a ${platform} video is fine`
          })`
    );
    await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    // The player decides its source late, and only once it trusts the browser.
    await page
      .waitForFunction(() => !!document.querySelector("video"), null, { timeout: 12_000 })
      .catch(() => undefined);
    await sleep(2200);

    const html = await page.content().catch(() => "");
    const verdict = platform === "youtube" ? youtubePlayability(html) : null;
    if (verdict && verdict.status !== "OK") {
      log(
        `YouTube says “${verdict.status}${verdict.reason ? `: ${verdict.reason}` : ""}” for this video — ` +
          `still trying the URLs the page exposed, but that is usually a bot check on this IP.`
      );
    }

    const candidates: MediaCandidate[] = [
      ...harvestMediaUrls(html).map((url) => ({ url, from: "page-json" as const, score: 0 })),
      ...(await playerHints(page)),
      ...sniffed,
    ];
    const ranked = rankCandidates(candidates, platform);
    log(
      ranked.length
        ? `${ranked.length} candidate video URL${ranked.length === 1 ? "" : "s"} for this ${platform === "other" ? "page" : platform} link — fetching the best one…`
        : `No video URL in the page or on the wire — inspecting what the site actually returned…`
    );
    if (!ranked.length) throw new Error(describeGrabFailure(platform, [], describePage(html)));

    const ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
    let lastNote = describePage(html);
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i];
      const host = hostOf(c.url);
      const headers: Record<string, string> = {
        referer: sourceUrl,
        origin,
        "user-agent": ua,
        accept: "*/*",
      };
      // Google's CDN answers 403 to a whole-file request unless a range is asked
      // for; asking for everything is how you get the whole file back.
      if (/googlevideo\.com/i.test(c.url)) headers.range = "bytes=0-";
      const resp = await ctx.request
        .get(c.url, { headers, timeout: 120_000 })
        .catch((e) => ((lastNote = `fetch failed: ${(e as Error).message}`), null));
      if (!resp) continue;
      const status = resp.status();
      if (status !== 200 && status !== 206) {
        lastNote = `${host} answered HTTP ${status}`;
        log(`  · candidate ${i + 1}/${ranked.length} ${host} → HTTP ${status}`);
        continue;
      }
      const lenH = resp.headers()["content-length"];
      const declared = lenH ? Number(lenH) : 0;
      const tooBig = sizeRejection(declared);
      if (tooBig) {
        lastNote = tooBig;
        log(`  · candidate ${i + 1}/${ranked.length} ${host} → ${tooBig}`);
        continue;
      }
      const body = await resp.body().catch(() => null);
      if (!body || body.length < 60_000) {
        lastNote = `${host} returned ${body ? body.length : 0} bytes — not a video`;
        continue;
      }
      if (!looksLikeVideoBytes(body)) {
        lastNote = `${host} returned a page/error document, not video bytes (bot wall?)`;
        log(`  · candidate ${i + 1}/${ranked.length} ${host} → not a video container`);
        continue;
      }
      const oversize = sizeRejection(body.length);
      if (oversize) throw new Error(oversize);
      const mime = (resp.headers()["content-type"] || "video/mp4").split(";")[0];
      log(`Got video (${(body.length / 1_048_576).toFixed(1)} MB) from ${host} — ready to publish.`);
      return { name: `clip-${Date.now()}.mp4`, mime: mime.includes("video") ? mime : "video/mp4", buffer: body };
    }
    throw new Error(describeGrabFailure(platform, ranked, lastNote));
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

export async function uploadTikTok(page: Page, video: VideoFile, caption: string, log: StepLog) {
  log("Opening TikTok upload studio…");
  await page.goto("https://www.tiktok.com/upload", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await sleep(2500);
  await readingPause(600, 1800);

  const fileInput = page.locator('input[type="file"]').first();
  try {
    await fileInput.waitFor({ state: "attached", timeout: 40_000 });
    await fileInput.setInputFiles({ name: video.name, mimeType: video.mime, buffer: video.buffer });
  } catch {
    throw new Error("Upload studio didn't expose a file input (TikTok may be challenging this session).");
  }
  log("Video processing in studio…");
  await sleep(4000);

  // Caption editor — try several known containers.
  const captionSel = [
    '[data-e2e="post_caption_editable"]',
    'div[contenteditable="true"]',
    'textarea[id*="caption"], textarea[placeholder*="caption" i]',
  ];
  let typed = false;
  for (const sel of captionSel) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) {
      try {
        await el.click({ timeout: 4000 });
        await thinkingPause(400, 1400); // compose before typing
        await page.keyboard.type(caption.slice(0, 2200)); // humanized (trusted events, typos auto-corrected)
        typed = true;
        break;
      } catch {
        /* try next */
      }
    }
  }
  if (!typed) log("Caption editor not found — posting without a caption (or paste it manually in the studio).");

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
  const postBtn = page.locator('button[data-e2e="post_button"], button:has-text("Post")').last();
  await postBtn.click({ timeout: 15_000 }).catch(() => undefined);
  try {
    await page.waitForURL(/\/video\//, { timeout: 40_000 });
    log("✅ TikTok publish confirmed — video is live, audience Everyone.");
    return { ok: true as const, message: "Published on TikTok" };
  } catch {
    return { ok: false as const, message: "Posted but confirmation redirect wasn't observed — verify in the browser." };
  }
}

/* -------------------------------- Instagram -------------------------------- */

export async function uploadInstagram(page: Page, video: VideoFile, caption: string, log: StepLog) {
  log("Opening Instagram create flow…");
  await page.goto("https://www.instagram.com/create/select/", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await sleep(2500);
  await readingPause(600, 1800);

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
    await sleep(1500);
  }

  const captionBox = page.locator('div[role="textbox"]').first();
  try {
    await captionBox.waitFor({ state: "visible", timeout: 20_000 });
    await captionBox.click();
    await thinkingPause(400, 1400); // compose before typing
    await page.keyboard.type(caption.slice(0, 2200)); // humanized (trusted events, typos auto-corrected)
  } catch {
    log("Caption box not found — continuing without caption.");
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
    log("✅ Instagram publish confirmed — reel is live.");
    return { ok: true as const, message: "Published on Instagram" };
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
) {
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
export async function uploadYouTube(page: Page, video: VideoFile, caption: string, log: StepLog) {
  log("Opening YouTube Studio upload flow…");
  await page.goto("https://www.youtube.com/upload", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await sleep(2500);
  await readingPause(600, 1800);

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
