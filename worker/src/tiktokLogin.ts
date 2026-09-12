export type TikTokLoginState = "signed-in" | "signed-out" | "challenge" | "unknown";

/** Secret- and identity-free facts that can safely cross `page.evaluate()`. */
export interface TikTokLoginEvidence {
  state: TikTokLoginState;
  reason:
    | "account-context"
    | "account-chrome"
    | "studio-private-route"
    | "studio-control"
    | "upload-success"
    | "login-url"
    | "login-control"
    | "password-control"
    | "challenge"
    | "conflicting-ui"
    | "no-auth-evidence";
}

/**
 * Read TikTok's own page, not the cookie jar. A cookie named `sessionid` is only
 * syntax; authenticated account context/private controls are proof that TikTok
 * accepted it. This function must remain closure-free because Playwright sends
 * its source into the page.
 */
export function tiktokLoginEvidencePage(): TikTokLoginEvidence {
  const href = String(location.href || "").toLowerCase();
  const path = String(location.pathname || "").toLowerCase();
  const host = String(location.hostname || "").toLowerCase();
  const body = String(document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 120_000);
  const lowBody = body.toLowerCase();

  const visible = (node: Element | null): boolean => {
    if (!node) return false;
    const el = node as HTMLElement;
    if (el.hidden || el.getAttribute?.("aria-hidden") === "true") return false;
    if (typeof getComputedStyle === "function") {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    }
    // Test doubles and very early DOM nodes do not always expose layout APIs.
    if (typeof el.getClientRects === "function") return el.getClientRects().length > 0;
    return true;
  };
  const hasVisible = (selector: string): boolean => {
    if (typeof document.querySelectorAll === "function") {
      return Array.from(document.querySelectorAll(selector)).some((node) => visible(node));
    }
    return visible(document.querySelector(selector));
  };

  const challenge =
    /(?:^|\/)(?:challenge|captcha|verify)(?:\/|$)/.test(path) ||
    host.includes("captcha") ||
    hasVisible('iframe[src*="captcha"], [id*="captcha" i], [class*="captcha" i]') ||
    /verify (?:that )?(?:it'?s really you|you are human)|complete (?:the )?(?:captcha|verification)|security verification/.test(lowBody);
  if (challenge) return { state: "challenge", reason: "challenge" };

  const atLoginUrl =
    host.includes("passport.tiktok") ||
    /^\/(?:login|signup)(?:\/|$)/.test(path) ||
    /\/passport(?:\/|$)/.test(path);
  if (atLoginUrl) return { state: "signed-out", reason: "login-url" };

  const password = hasVisible('input[type="password"]');
  if (password) return { state: "signed-out", reason: "password-control" };

  const topLogin = hasVisible(
    '[data-e2e="top-login-button"], [data-e2e="login-button"], [data-e2e="nav-login"], button[data-e2e*="login"], a[href*="/login"], form[action*="/login"]'
  );

  // Current TikTok SSR exposes the viewer (not the viewed creator) here. A
  // non-empty viewer id is stronger than a brittle avatar selector and does not
  // require returning the id/name to the worker.
  let accountContext = false;
  try {
    const globalData =
      typeof window !== "undefined"
        ? ((window as unknown as Record<string, unknown>)["__$UNIVERSAL_DATA$__"] as Record<string, unknown> | undefined)
        : undefined;
    const script = document.querySelector('script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
    const raw = script?.textContent || (script as HTMLElement | null)?.innerText || "";
    const parsed = globalData || (raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    const scope = (parsed.__DEFAULT_SCOPE__ || {}) as Record<string, unknown>;
    const app = (scope["webapp.app-context"] || {}) as Record<string, unknown>;
    const user = (app.user || app.viewer || {}) as Record<string, unknown>;
    const ids = [user.id, user.uid, user.userId, user.user_id, user.uniqueId, user.unique_id, user.secUid, user.sec_uid];
    accountContext = ids.some((id) => (typeof id === "string" && id.trim().length > 0) || (typeof id === "number" && id > 0));
    accountContext ||= app.isLogin === true || app.isLoggedIn === true || user.isLogin === true || user.isLoggedIn === true;
  } catch {
    // TikTok changes hydration shape often; DOM evidence below remains useful.
  }

  const accountChrome = hasVisible(
    '[data-e2e="profile-icon"], [data-e2e="user-avatar"], [data-e2e="profile-avatar"], [data-e2e="inbox-icon"], [data-e2e="nav-inbox"], [data-e2e="message-icon"], header a[href^="/@"], header a[href*="/messages"], nav a[href*="/messages"], button[aria-label*="Profile" i], a[aria-label*="Profile" i]'
  );
  const studioControl = hasVisible(
    'input[type="file"], [data-e2e="post_video_button"], [data-e2e="upload-card"], [class*="upload-card" i]'
  );
  const uploadSuccess = /your video has been uploaded|upload another video|manage your posts/.test(lowBody);

  // Contradictory live UI is not a green light. This can happen for one render
  // while TikTok replaces its SSR header after a rejected session.
  if (topLogin && (accountContext || accountChrome || studioControl || uploadSuccess)) {
    return { state: "unknown", reason: "conflicting-ui" };
  }
  if (topLogin) return { state: "signed-out", reason: "login-control" };
  if (accountContext) return { state: "signed-in", reason: "account-context" };
  if (accountChrome) return { state: "signed-in", reason: "account-chrome" };
  if (studioControl) return { state: "signed-in", reason: "studio-control" };
  if (uploadSuccess) return { state: "signed-in", reason: "upload-success" };

  // Studio's content manager is an authenticated route. TikTok sometimes renders
  // it without the consumer avatar after a publish; remaining there with no login
  // or password control is useful positive evidence. `/upload` alone is public and
  // deliberately does not get this fallback.
  if (path.startsWith("/tiktokstudio/content")) return { state: "signed-in", reason: "studio-private-route" };

  return { state: "unknown", reason: "no-auth-evidence" };
}

export interface TikTokAccountProbe {
  state: TikTokLoginState;
  /** HTTP status only; account payload, names, ids, and descriptions never leave the page. */
  httpStatus: number | null;
}

/**
 * One bounded post-install check against TikTok's account endpoint. This is not
 * used by the ambient five-second detector (which would rate-limit the account).
 * It returns only a verdict and status — never response data or cookie values.
 */
export async function tiktokAccountProbePage(): Promise<TikTokAccountProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("/passport/web/account/info/", {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json, text/plain, */*" },
      signal: controller.signal,
    });
    const status = response.status;
    let payload: Record<string, unknown> = {};
    try {
      payload = (await response.json()) as Record<string, unknown>;
    } catch {
      return { state: status === 401 ? "signed-out" : status === 403 || status === 429 ? "challenge" : "unknown", httpStatus: status };
    }

    const data = (payload.data || {}) as Record<string, unknown>;
    const user = (data.user || data.account || data) as Record<string, unknown>;
    const ids = [
      user.id,
      user.uid,
      user.uid_str,
      user.userId,
      user.user_id,
      user.user_id_str,
      user.secUid,
      user.sec_uid,
      user.sec_user_id,
      user.uniqueId,
      user.unique_id,
    ];
    const hasIdentity = ids.some((id) => (typeof id === "string" && id.trim().length > 0) || (typeof id === "number" && id > 0));
    if (hasIdentity) return { state: "signed-in", httpStatus: status };

    const message = String(data.description || payload.description || payload.message || "").toLowerCase();
    if (status === 401 || /not (?:logged|login)|login (?:first|required)|session (?:expired|invalid)|invalid session/.test(message)) {
      return { state: "signed-out", httpStatus: status };
    }
    if (status === 403 || status === 429 || /captcha|verify|verification|too frequent|risk|unusual/.test(message)) {
      return { state: "challenge", httpStatus: status };
    }
    return { state: "unknown", httpStatus: status };
  } catch {
    return { state: "unknown", httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}
