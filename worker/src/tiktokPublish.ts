/**
 * TikTok Studio's final Post control and publish response change names across the
 * old `/upload` and new `/tiktokstudio/upload` screens. Everything here is pure
 * or page-side/self-contained so it can be tested without Chromium.
 */

export const TIKTOK_POST_ATTR = "data-vd-tiktok-post";

export interface TikTokPostButton {
  tag: string;
  label: string;
  dataE2e: string;
  width: number;
  height: number;
  enabled: boolean;
  disabledBy: string;
  ariaDisabled: string;
  dataDisabled: string;
}

/**
 * Mark the real final Post control. `enabledOnly=true` is suitable for
 * waitForFunction: it stays null while TikTok is uploading/processing.
 */
export function markTikTokPostButton([attr, enabledOnly]: [string, boolean]): TikTokPostButton | null {
  const norm = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
  try {
    for (const old of Array.from(document.querySelectorAll(`[${attr}]`))) old.removeAttribute(attr);
  } catch {
    /* detached document */
  }

  const vw = window.innerWidth || document.documentElement?.clientWidth || 1280;
  const vh = window.innerHeight || document.documentElement?.clientHeight || 900;
  const ranked: Array<{ el: HTMLElement; score: number; result: TikTokPostButton }> = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'))) {
    let rect: DOMRect;
    let style: CSSStyleDeclaration;
    try {
      rect = el.getBoundingClientRect();
      style = window.getComputedStyle(el);
    } catch {
      continue;
    }
    const dataE2e = norm(el.getAttribute("data-e2e")).toLowerCase();
    const modern = dataE2e === "post_video_button";
    const legacy = dataE2e === "post_button";
    if (
      rect.width < 24 ||
      rect.height < 16 ||
      rect.right <= 0 ||
      rect.left >= vw ||
      ((!modern && !legacy) && (rect.bottom <= 0 || rect.top >= vh)) ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      continue;
    }

    const label = norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.textContent);
    const low = label.toLowerCase();
    const exactText = low === "post" || low === "publish";
    if (!modern && !legacy && !exactText) continue;
    if (!modern && !legacy && /posts|repost|schedule|draft|discard|edit post/.test(low)) continue;

    const nativeDisabled = (el as HTMLButtonElement).disabled || el.hasAttribute("disabled");
    const ariaState = norm(el.getAttribute("aria-disabled")).toLowerCase();
    const dataState = norm(el.getAttribute("data-disabled")).toLowerCase();
    const ariaDisabled = ariaState === "true";
    const dataDisabled = dataState === "true";
    const classDisabled = /(^|[\s_-])(disabled|loading)([\s_-]|$)/i.test(el.className || "");
    const pointerDisabled = style.pointerEvents === "none";
    const enabled = !(nativeDisabled || ariaDisabled || dataDisabled || classDisabled || pointerDisabled);
    const disabledBy = nativeDisabled
      ? "disabled attribute"
      : ariaDisabled
        ? "aria-disabled=true"
        : dataDisabled
          ? "data-disabled=true"
          : classDisabled
            ? "disabled/loading class"
            : pointerDisabled
              ? "pointer-events:none"
              : "";
    let score = modern ? 140 : legacy ? 130 : low === "post" ? 80 : 70;
    if (enabled) score += 20;
    if (rect.top < 80 && !modern && !legacy) score -= 35; // top-nav text decoy
    if (rect.width >= 80 && rect.width <= 600) score += 8;
    ranked.push({
      el,
      score,
      result: {
        tag: el.tagName,
        label: label || "Post",
        dataE2e,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        enabled,
        disabledBy,
        ariaDisabled: ariaState || "absent",
        dataDisabled: dataState || "absent",
      },
    });
  }

  // If Studio exposes its named post button, never fall through to an unrelated
  // exact-text button merely because the real one is still disabled.
  const named = ranked.filter((item) => item.result.dataE2e === "post_video_button" || item.result.dataE2e === "post_button");
  const semanticPool = named.length ? named : ranked;
  const pool = enabledOnly ? semanticPool.filter((item) => item.result.enabled) : semanticPool;
  pool.sort((a, b) => b.score - a.score);
  const best = pool[0];
  if (!best) return null;
  try {
    best.el.setAttribute(attr, "1");
  } catch {
    return null;
  }
  return best.result;
}

export interface TikTokPublishEvidence {
  ok: boolean | null;
  postId: string;
  liveUrl: string;
  error: string;
}

/** Endpoints observed across TikTok's classic uploader and TikTok Studio. */
export function isTikTokPublishResponseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname) && !/(^|\.)tiktokapis\.com$/i.test(parsed.hostname)) return false;
    return /\/(?:api\/post\/item_create|web\/project\/post\/create|api\/post\/publish|api\/v\d+\/web\/project\/post|post\/create|creation\/publish|(?:api\/)?(?:v\d+\/)?(?:item\/create|post\/publish|publish\/video|upload\/publish))(?:[/?#]|$)/i.test(
      parsed.pathname + parsed.search
    );
  } catch {
    return false;
  }
}

/** Parse only a response already known to be from a publish endpoint. */
export function parseTikTokPublishResponse(text: string, httpStatus: number): TikTokPublishEvidence {
  const clean = (text || "")
    .replace(/\\u002f/gi, "/")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&");
  const fullUrl = /https?:\/\/(?:[a-z0-9-]+\.)*tiktok\.com\/@[^\s/"']+\/video\/(\d{15,24})[^\s"']*/i.exec(clean);
  const keyedId = /"(?:aweme_id|awemeId|item_id|itemId|video_id|post_id)"\s*:\s*"?(\d{15,24})"?/i.exec(clean)?.[1] || "";
  const postId = fullUrl?.[1] || keyedId;
  const liveUrl = fullUrl?.[0] || "";
  const message = /"(?:status_msg|statusMsg|status_message|message|msg|description)"\s*:\s*"([^"\\]{2,240})"/i.exec(clean)?.[1] || "";
  const explicitError =
    /"status_code"\s*:\s*-?[1-9]\d*/i.test(clean) ||
    /"statusCode"\s*:\s*-?[1-9]\d*/i.test(clean) ||
    /"code"\s*:\s*-?[1-9]\d*/i.test(clean) ||
    /"success"\s*:\s*false/i.test(clean) ||
    /"status"\s*:\s*"(?:fail(?:ed|ure)?|error|rejected)"/i.test(clean) ||
    /"error"\s*:\s*\{[^}]*"code"\s*:\s*"(?!ok")[^"]+"/i.test(clean);
  const explicitSuccess =
    !!postId ||
    /"status_code"\s*:\s*0/i.test(clean) ||
    /"statusCode"\s*:\s*0/i.test(clean) ||
    /"code"\s*:\s*0/i.test(clean) ||
    /"success"\s*:\s*true/i.test(clean) ||
    /"status"\s*:\s*"success"/i.test(clean) ||
    /"error"\s*:\s*\{[^}]*"code"\s*:\s*"ok"/i.test(clean);
  if (httpStatus < 200 || httpStatus >= 300 || explicitError) {
    return { ok: false, postId, liveUrl, error: message || `publish endpoint answered HTTP ${httpStatus}` };
  }
  return { ok: explicitSuccess ? true : null, postId, liveUrl, error: "" };
}

/** A changed URL or newly appearing Studio message can confirm the UI path. */
export function readTikTokPublishUi(beforeText: string, afterText: string, beforeUrl: string, afterUrl: string): TikTokPublishEvidence {
  const norm = (value: string) => (value || "").replace(/\s+/g, " ").trim();
  const before = norm(beforeText).toLowerCase();
  const after = norm(afterText);
  const low = after.toLowerCase();
  if (afterUrl !== beforeUrl) {
    try {
      const destination = new URL(afterUrl);
      const tiktokHost = /(^|\.)tiktok\.com$/i.test(destination.hostname);
      const postId = tiktokHost ? /\/video\/(\d{15,24})(?:[/?#]|$)/i.exec(destination.pathname)?.[1] || "" : "";
      if (postId) return { ok: true, postId, liveUrl: afterUrl, error: "" };
      if (/\/(?:login|passport)(?:[/?#]|$)/i.test(destination.pathname)) {
        return { ok: false, postId: "", liveUrl: "", error: "TikTok redirected to sign-in during submission" };
      }
      if (tiktokHost && /^\/tiktokstudio\/content(?:[/?#]|$)/i.test(destination.pathname)) {
        return { ok: true, postId: "", liveUrl: "", error: "redirected to TikTok Studio content" };
      }
    } catch {
      /* UI text can still confirm below */
    }
  }
  const successes = [
    "your video has been uploaded",
    "your video is being uploaded",
    "uploaded to tiktok",
    "upload another video",
    "manage posts",
    "post published",
    "posted successfully",
    "video published",
    "upload complete",
  ];
  const success = successes.find((phrase) => low.includes(phrase) && !before.includes(phrase));
  if (success) return { ok: true, postId: "", liveUrl: "", error: success };
  const failures = [
    "couldn't upload",
    "could not upload",
    "couldn't post",
    "failed to post",
    "post failed",
    "upload failed",
    "copyright check failed",
    "could not be processed",
    "complete the captcha",
    "verify to continue",
    "something went wrong",
  ];
  const failure = failures.find((phrase) => low.includes(phrase) && !before.includes(phrase));
  if (failure) return { ok: false, postId: "", liveUrl: "", error: failure };
  return { ok: null, postId: "", liveUrl: "", error: "" };
}
