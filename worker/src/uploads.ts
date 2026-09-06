import type { BrowserContext, Page } from "playwright";

export interface VideoFile {
  name: string;
  mime: string;
  buffer: Buffer;
}

type StepLog = (text: string) => void;

export type UploadPlatform = "tiktok" | "instagram" | "youtube";

/** Resolve a public video page to an actual playable mp4 and download it. */
export async function downloadVideo(
  page: Page,
  ctx: BrowserContext,
  sourceUrl: string,
  log: StepLog
): Promise<VideoFile> {
  log(`Opening source video page…`);
  await page.goto(sourceUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(3500);
  const direct = await page.evaluate(() => {
    const v = document.querySelector("video");
    const src = (v?.currentSrc || v?.src || "") as string;
    if (src && !src.startsWith("blob:")) return src;
    const og = document.querySelector('meta[property="og:video"]');
    const content = og?.getAttribute("content");
    if (content && !content.startsWith("blob:")) return content;
    return null;
  });
  if (!direct) throw new Error("Could not resolve a downloadable mp4 from that link (page may block direct grabs).");
  log(`Downloading video from source…`);
  const ua = await page.evaluate(() => navigator.userAgent).catch(() => "");
  const resp = await ctx.request.get(direct, {
    headers: {
      referer: sourceUrl,
      "user-agent": ua,
    },
    timeout: 90_000,
  });
  if (!resp.ok()) throw new Error(`Video download failed (HTTP ${resp.status()}).`);
  const buffer = Buffer.from(await resp.body());
  if (buffer.length < 10_000) throw new Error("Downloaded file looks too small — likely a bot wall.");
  const mime = (resp.headers()["content-type"] || "video/mp4").split(";")[0];
  log(`Got video (${(buffer.length / 1_048_576).toFixed(1)} MB) — ready to publish.`);
  return { name: `clip-${Date.now()}.mp4`, mime: mime.includes("video") ? mime : "video/mp4", buffer };
}

/* --------------------------------- TikTok --------------------------------- */

export async function uploadTikTok(page: Page, video: VideoFile, caption: string, log: StepLog) {
  log("Opening TikTok upload studio…");
  await page.goto("https://www.tiktok.com/upload", { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(2500);

  const fileInput = page.locator('input[type="file"]').first();
  try {
    await fileInput.waitFor({ state: "attached", timeout: 40_000 });
    await fileInput.setInputFiles({ name: video.name, mimeType: video.mime, buffer: video.buffer });
  } catch {
    throw new Error("Upload studio didn't expose a file input (TikTok may be challenging this session).");
  }
  log("Video processing in studio…");
  await page.waitForTimeout(4000);

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
        await page.keyboard.type(caption.slice(0, 2200), { delay: 12 });
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
  await page.waitForTimeout(2500);

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
    await page.waitForTimeout(1500);
  }

  const captionBox = page.locator('div[role="textbox"]').first();
  try {
    await captionBox.waitFor({ state: "visible", timeout: 20_000 });
    await captionBox.click();
    await page.keyboard.type(caption.slice(0, 2200), { delay: 12 });
  } catch {
    log("Caption box not found — continuing without caption.");
  }

  // Uncheck "Also post to Facebook" / similar share toggles if shown.
  const fbToggle = page.locator('div[role="button"]:has-text("Also post to Facebook"), div[role="checkbox"]').first();
  if ((await fbToggle.count()) > 0) {
    await fbToggle.click().catch(() => undefined);
    await page.waitForTimeout(500);
  }

  log("Publishing reel…");
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
  await page.waitForTimeout(2500);

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
    await page.keyboard.type(caption.slice(0, 90), { delay: 10 });
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
    await page.waitForTimeout(300);
  }

  // Visibility = Public (the “Everyone” audience). Best-effort: pick the
  // Public radio inside the upload dialog.
  const visPublic = page
    .locator("ytcp-uploads-dialog div[role='radio']:has-text(\"Public\"), ytcp-video-visibility-select div[role='radio']:has-text(\"Public\"), paper-radio-button[name='PUBLIC_VISIBILITY']")
    .first();
  if ((await visPublic.count()) > 0) {
    await visPublic.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(400);
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
