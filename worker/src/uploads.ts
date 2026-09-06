import type { BrowserContext, Page } from "playwright";

export interface VideoFile {
  name: string;
  mime: string;
  buffer: Buffer;
}

type StepLog = (text: string) => void;

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
  log(`Got video (${(buffer.length / 1_048_576).toFixed(1)} MB) — uploading to ${page.url().includes("instagram") ? "Instagram" : "TikTok"}…`);
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
  platform: "tiktok" | "instagram",
  page: Page,
  video: VideoFile,
  caption: string,
  log: StepLog
) {
  if (platform === "tiktok") return uploadTikTok(page, video, caption, log);
  return uploadInstagram(page, video, caption, log);
}
