/**
 * Turn a pasted cookie into real cookies in the live profile.
 *
 * WHY. The deck's login step is "drive the remote browser by hand until the site
 * says you're in" — which means every tap has to survive a screenshot's aspect
 * ratio, a resized window, page zoom and a hit-test surface, on a 62 px row, from
 * a phone. It is the single most fragile interaction in the product. A session
 * cookie skips it: paste what your own already-logged-in browser holds, and the
 * profile is signed in without a single click. Nothing about posting changes —
 * the engine still only runs when you press Start.
 *
 * Accepts all three shapes people actually paste:
 *   sessionid                                                 → a bare value
 *   sessionid=abc; ttwid=def                                  → name=value pairs
 *   Cookie: sessionid=abc; …                                  → a DevTools request header
 *   Set-Cookie: sessionid=abc; Path=/; HttpOnly; …            → a raw response header
 *
 * Values are never echoed back: `detail` describes the plan (names, counts,
 * lifetimes) so a mistake is explainable without the secret ending up in a log
 * panel, a toast, or a screenshot of either.
 */
import type { PlatformKey } from "./config.js";

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch, as Playwright's `addCookies` wants it. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

export interface CookiePlan {
  ok: boolean;
  /** Human sentence — safe to show and log: no cookie values in it. */
  detail: string;
  cookies: CookieRecord[];
  names: string[];
  /** Epoch ms when the site will consider the session stale, when we can tell. */
  expiresAt: number | null;
}

interface PlatformCookie {
  domain: string;
  /** The one name without which the paste is not a session. */
  need: string;
  /**
   * Names to mint from `need`'s value because the site reads a second copy under
   * a different name. Only valid where the two really are the same string:
   * TikTok writes `sessionid_ss` as the SameSite=None twin of `sessionid`, and
   * www.tiktok.com is the one that checks the twin. (YouTube's SAPISID is NOT a
   * copy of SID, so it is absent — deriving it would look clever and break login.)
   */
  twins: string[];
  /** Names the site marks httpOnly; JS-visible ones stay visible so pages read them. */
  strict: string[];
}

const TABLE: Record<PlatformKey, PlatformCookie> = {
  tiktok: {
    domain: ".tiktok.com",
    need: "sessionid",
    twins: ["sessionid_ss"],
    strict: ["sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", ".ttwebid"],
  },
  instagram: {
    domain: ".instagram.com",
    need: "sessionid",
    twins: [],
    strict: ["sessionid", "rur", "ds_user_id", "mid"],
  },
  youtube: {
    domain: ".youtube.com",
    need: "SID",
    twins: [],
    strict: ["SID", "HSID", "SSID", "APID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS"],
  },
};

/** `Set-Cookie` metadata, which pastes as `name=value` but is not a cookie. */
const NOT_A_COOKIE = new Set([
  "expires",
  "max-age",
  "domain",
  "path",
  "secure",
  "httponly",
  "samesite",
  "partitioned",
  "priority",
  "value",
]);

const MAX_COOKIES = 40;
const MAX_VALUE = 8192;
const DAY = 86_400;

const cookieName = (raw: string) => raw.replace(/^\.+/, "").toLowerCase();

/**
 * TikTok's `sid_guard` carries the session's own clock: `<hash>|<issued>-<lifetime
 * seconds>-…`. When it is in the paste, honour it — a cookie installed for a year
 * that the server expired in a month only produces a mysteriously dead session.
 */
function expiryFromSidGuard(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const m = /(\d{9,11})-(\d{4,9})-/.exec(value);
  if (!m) return null;
  const issued = Number(m[1]);
  const life = Number(m[2]);
  if (!issued || !life) return null;
  const at = issued + life;
  return at * 1000 > nowMs ? at : Math.floor(nowMs / 1000) + 30 * DAY;
}

/** Parse the paste into name → value, tolerating every shape listed above. */
function parsePairs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let text = (raw || "").trim();
  if (!text) return out;
  text = text.replace(/^(cookie|set-cookie)\s*:\s*/i, "");
  // A `Set-Cookie` line puts the value before its attributes; the attribute list
  // is what we split away, but only after taking the value we came for.
  for (const chunk of text.split(/[;\n\r]+/)) {
    const token = chunk.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq < 0) {
      // `Secure`, or a bare session value pasted on its own. Cookie values never
      // contain spaces, which is what keeps "my tiktok cookie" from being read as
      // one and installed as a session.
      if (out.size === 0 && /^[^\s;,"']{16,}$/.test(token) && !NOT_A_COOKIE.has(cookieName(token))) {
        out.set("__bare__", token);
      }
      continue;
    }
    const name = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!name || !value) continue;
    if (NOT_A_COOKIE.has(cookieName(name))) continue;
    if (out.size >= MAX_COOKIES) break;
    out.set(name, value.slice(0, MAX_VALUE));
  }
  return out;
}

/**
 * The plan for one platform: what would be written, or exactly why the paste is
 * not usable. Never throws — this runs on user input, and the answer the deck
 * shows has to be a sentence, not a stack.
 */
export function planSessionCookies(platform: PlatformKey, raw: string, nowMs = Date.now()): CookiePlan {
  const spec = TABLE[platform];
  if (!spec) return { ok: false, detail: `no cookie login is configured for ${platform}`, cookies: [], names: [], expiresAt: null };
  const pairs = parsePairs(raw);
  if (pairs.size === 0) {
    return { ok: false, detail: "nothing to read — paste the session cookie value (or the whole header)", cookies: [], names: [], expiresAt: null };
  }

  // A lone value: the paste was just the `sessionid` string.
  const bare = pairs.get("__bare__");
  const named = new Map<string, string>();
  for (const [k, v] of pairs) if (k !== "__bare__") named.set(k, v);
  const needle = spec.need.toLowerCase();
  const has = (n: string) => Array.from(named.keys()).some((k) => k.toLowerCase() === n.toLowerCase());
  let sessionValue: string | undefined;
  for (const [k, v] of named) if (k.toLowerCase() === needle) sessionValue = v;
  if (!sessionValue && bare) {
    named.clear();
    named.set(spec.need, bare);
    sessionValue = bare;
  }
  if (!sessionValue || sessionValue.length < 16) {
    // Three ways to get here, and the user needs to know which one: wrong site,
    // a paste that was only half copied, or a box that was never a cookie.
    const found = Array.from(named.keys());
    const detail = sessionValue
      ? `${spec.need} looks truncated (${sessionValue.length} characters) — copy the whole value`
      : found.length
        ? `no ${spec.need} in what you pasted (names found: ${found.slice(0, 6).join(", ")})`
        : `no ${spec.need} in what you pasted`;
    return { ok: false, detail, cookies: [], names: [], expiresAt: null };
  }

  // TikTok's www origin reads the SameSite twin, so mint it when it is missing.
  for (const twin of spec.twins) if (!has(twin)) named.set(twin, sessionValue);

  const guardExpiry = expiryFromSidGuard(Array.from(named.entries()).find(([k]) => k.toLowerCase() === "sid_guard")?.[1], nowMs);
  const expiresSec = guardExpiry ?? Math.floor(nowMs / 1000) + 365 * DAY;
  const cookies: CookieRecord[] = [];
  for (const [name, value] of named) {
    if (value.length < 1) continue;
    cookies.push({
      name,
      value,
      domain: spec.domain,
      path: "/",
      expires: expiresSec,
      httpOnly: spec.strict.includes(name.toLowerCase()),
      secure: true,
      // "None" is what these sites ship them with, and the profile is HTTPS-only:
      // a Lax copy is invisible to the same-site XHR that decides "am I logged in".
      sameSite: "None",
    });
  }
  return {
    ok: cookies.length > 0,
    detail: `${cookies.length} cookie${cookies.length === 1 ? "" : "s"} for ${spec.domain} — ${cookies.map((c) => c.name).join(", ")} · ${
      guardExpiry ? "lifetime taken from sid_guard" : "kept for 365 days"
    }`,
    cookies,
    names: cookies.map((c) => c.name),
    expiresAt: expiresSec * 1000,
  };
}

/** Short, secret-free label for the deck: "sessionid, +2 · expires 12 Nov". */
export function describePlan(plan: CookiePlan): string {
  if (!plan.ok) return plan.detail;
  const extra = plan.names.length > 1 ? `, +${plan.names.length - 1} more` : "";
  const until = plan.expiresAt ? new Date(plan.expiresAt).toLocaleDateString("en-US", { day: "numeric", month: "short" }) : "session";
  return `${plan.names[0] ? plan.names[0] : "cookie"}${extra} · valid to ${until}`;
}
