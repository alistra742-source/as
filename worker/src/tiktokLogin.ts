/**
 * Page-side TikTok authentication evidence. Kept self-contained so navigation
 * bursts and Studio's avatar-less success page can be regression-tested without
 * a browser.
 */
export function tiktokSignedInPage(): boolean {
  const u = location.href;
  if (/login|passport/i.test(u)) return false;
  const accountChrome = document.querySelector(
    '[data-e2e="profile-icon"], [data-e2e="user-avatar"], a[data-e2e="user-avatar"], [data-e2e="upload-icon"]'
  );
  const topLogin = document.querySelector(
    '[data-e2e="top-login-button"], input[type="password"], form[action*="login" i]'
  );
  if (accountChrome || (u.includes("/foryou") && !topLogin)) return true;

  // TikTok Studio drops the consumer-site avatar on its upload/content and
  // post-success surfaces. A usable private Studio control or known success
  // destination is stronger evidence than that missing avatar. Signed-out users
  // are redirected to /login or expose its form above.
  const route = location.pathname + location.search;
  const studioRoute = /\/(?:upload|creator-center\/upload|tiktokstudio\/(?:upload|content))(?:[/?#]|$)/i.test(route);
  if (!studioRoute || topLogin) return false;
  const studioControl = document.querySelector(
    'input[type="file"], [data-e2e="post_video_button"], [data-e2e="video_visibility_container"]'
  );
  const studioSuccess = /video published|your video has been uploaded|upload another video/i.test(
    (document.body?.innerText || "").slice(0, 4000)
  );
  return !!(
    studioControl ||
    studioSuccess ||
    /\/tiktokstudio\/content(?:[/?#]|$)/i.test(location.pathname)
  );
}
