/**
 * Turn a studio outcome into the only two states the engine may broadcast.
 * Kept import-free so the false-success contract is unit-testable without a
 * browser: an `ok:false` can never become post-ok, and the source URL can never
 * be presented as the confirmed destination URL.
 */
export type PublishOutcome = { ok: boolean; message: string; liveUrl?: string };

export type PublishReceipt =
  | { confirmed: false; error: string }
  | { confirmed: true; recordUrl: string; liveUrl: string };

export function publishReceipt(result: PublishOutcome, sourceUrl: string): PublishReceipt {
  if (!result.ok) {
    return { confirmed: false, error: result.message || "The studio did not confirm this publish." };
  }
  const liveUrl = /^https?:\/\//i.test((result.liveUrl || "").trim()) ? result.liveUrl!.trim() : "";
  if (liveUrl) {
    try {
      const live = new URL(liveUrl);
      const source = new URL(sourceUrl);
      const cleanPath = (value: string) => value.replace(/\/+$/, "") || "/";
      const liveTikTokId = /\/video\/(\d{15,24})(?:\/|$)/i.exec(live.pathname)?.[1];
      const sourceTikTokId = /\/video\/(\d{15,24})(?:\/|$)/i.exec(source.pathname)?.[1];
      const sameTikTokPost =
        !!liveTikTokId &&
        liveTikTokId === sourceTikTokId &&
        /(^|\.)tiktok\.com$/i.test(live.hostname) &&
        /(^|\.)tiktok\.com$/i.test(source.hostname);
      if ((live.origin === source.origin && cleanPath(live.pathname) === cleanPath(source.pathname)) || sameTikTokPost) {
        return {
          confirmed: false,
          error: "The studio returned the source video URL, not a new destination post — publish was not confirmed.",
        };
      }
    } catch {
      /* sourceUrl was validated before this point; invalid input keeps no receipt URL */
    }
  }
  return {
    confirmed: true,
    // Some studios confirm without exposing a share URL. Keep the source as an
    // internal metrics fallback, but broadcast an empty liveUrl so the deck does
    // not label that source as the newly published post.
    recordUrl: liveUrl || sourceUrl,
    liveUrl,
  };
}
