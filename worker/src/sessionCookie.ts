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

/** @see `planSessionCookies` — records are what Playwright's `addCookies` takes. */
export interface CookiePlan {
  ok: boolean;
  /** The name the platform's login actually hangs on (`sessionid`, `SID`). */
  sessionName?: string;
  /** Human sentence — safe to show and log: no cookie values in it. */
  detail: string;
  cookies: CookieRecord[];
  names: string[];
  /** Epoch ms when the site will consider the session stale, when we can tell. */
  expiresAt: number | null;
}

interface PlatformCookie {
  domain: string;
  /**
   * Domains a pasted cookie is allowed to land on. A cookie editor exports
   * everything the site can see — Google, DoubleClick, analytics — and writing
   * those into the profile is how you make the browser *less* like the user's,
   * not more. Anything outside this list is dropped.
   */
  allow: string[];
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
    allow: [".tiktok.com"],
    need: "sessionid",
    twins: ["sessionid_ss"],
    strict: ["sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", ".ttwebid"],
  },
  instagram: {
    domain: ".instagram.com",
    allow: [".instagram.com"],
    need: "sessionid",
    twins: [],
    strict: ["sessionid", "rur", "ds_user_id", "mid"],
  },
  youtube: {
    domain: ".youtube.com",
    // A Google login spans both, and a YouTube session without the .google.com
    // cookies is a session that gets challenged on the first write.
    allow: [".youtube.com", ".google.com"],
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

/** One parsed cookie, before it is judged against the platform's rules. */
interface ParsedCookie {
  name: string;
  value: string;
  domain: string | null;
  /** Seconds since the epoch, when the paste said so. */
  expires: number | null;
  httpOnly: boolean | null;
  secure: boolean | null;
  sameSite: "Strict" | "Lax" | "None" | null;
}

interface ParsedPaste {
  cookies: ParsedCookie[];
  /** What we think the paste was, for the log line. */
  shape: "pairs" | "json" | "netscape" | "empty";
  error?: string;
}

const SAME_SITE = new Set(["strict", "lax", "none", "no_restriction", "unrestricted"]);

function asSameSite(v: unknown): "Strict" | "Lax" | "None" | null {
  const s = String(v ?? "").toLowerCase().replace(/[_-]/g, "");
  if (!s) return null;
  if (s === "norestriction" || s === "unrestricted") return "None";
  if (SAME_SITE.has(s)) return (s[0].toUpperCase() + s.slice(1)) as "Strict" | "Lax" | "None";
  return null;
}

/** Chrome's `expirationDate`, Cookie-Editor's `expires`, `session` … → unix seconds. */
function asExpiry(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n);
}

function cleanDomain(v: unknown): string | null {
  const raw = String(v ?? "").trim().replace(/^#HttpOnly_/, "").toLowerCase();
  if (!raw) return null;
  return raw.replace(/^\.+/, ".");
}

/** A cookie-editor export (EditThisCookie, Cookie-Editor, devtools' JSON). */
function fromJson(text: string): ParsedPaste {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { cookies: [], shape: "json", error: `looks like JSON but is not (${(e as Error).message})` };
  }
  const rows = Array.isArray(data)
    ? data
    : Array.isArray((data as { cookies?: unknown[] })?.cookies)
      ? (data as { cookies: unknown[] }).cookies
      : typeof (data as { name?: unknown })?.name === "string"
        ? [data]
        : [];
  const cookies: ParsedCookie[] = [];
  for (const row of rows) {
    const o = (row ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? o.Name ?? "").trim();
    const value = String(o.value ?? o.Value ?? "").trim();
    if (!name || !value || cookies.length >= MAX_COOKIES) continue;
    cookies.push({
      name,
      value: value.replace(/^"|"$/g, "").slice(0, MAX_VALUE),
      domain: cleanDomain(o.domain ?? o.Domain),
      expires: asExpiry(o.expirationDate ?? o.expires ?? o.expiry ?? o.max_age),
      httpOnly: typeof o.httpOnly === "boolean" ? o.httpOnly : null,
      secure: typeof o.secure === "boolean" ? o.secure : null,
      sameSite: asSameSite(o.sameSite ?? o.same_same_site),
    });
  }
  if (!cookies.length) return { cookies: [], shape: "json", error: "JSON with no cookie objects in it" };
  return { cookies, shape: "json" };
}

/**
 * `cookies.txt` (Netscape format), the thing `curl` and every downloader writes:
 *   domain  flag  path  expiry  name  value          ← 6 fields
 *   # comment / "# Netscape HTTP Cookie File" / "#HttpOnly_.tiktok.com …"
 */
function fromNetscape(text: string): ParsedPaste | null {
  // Comments are dropped — except `#HttpOnly_`, which is a real flag Netscape
  // writers prefix onto the domain field.
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && (!l.startsWith("#") || l.startsWith("#HttpOnly_")));
  if (lines.length < 1) return null;
  const tableish = lines.filter((l) => l.includes("\t")).length;
  if (tableish < Math.max(1, Math.floor(lines.length / 2))) return null;
  const cookies: ParsedCookie[] = [];
  for (const line of lines) {
    const f = line.split(/\t+/).map((x) => x.trim());
    if (f.length < 6) continue;
    const [domain, , path, expiry, name, value] = f;
    if (!name || !value || cookies.length >= MAX_COOKIES) continue;
    cookies.push({
      name,
      value: value.slice(0, MAX_VALUE),
      domain: cleanDomain(domain),
      expires: asExpiry(expiry),
      httpOnly: line.startsWith("#HttpOnly_") ? true : null,
      secure: null,
      sameSite: path === "/" ? null : null,
    });
  }
  return cookies.length ? { cookies, shape: "netscape" } : null;
}

/** `name=value` pairs, a `Cookie:` header, or a lone value. */
function fromPairs(text: string): ParsedPaste {
  const cookies: ParsedCookie[] = [];
  const body = text.replace(/^(cookie|set-cookie)\s*:\s*/i, "");
  for (const chunk of body.split(/[;\n\r]+/)) {
    const token = chunk.trim();
    if (!token) continue;
    const eq = token.indexOf("=");
    if (eq < 0) {
      // `Secure`, or a bare session value pasted on its own. Cookie values never
      // contain spaces, which is what keeps "my tiktok cookie" from being read as
      // one and installed as a session.
      if (!cookies.length && /^[^\s;,"']{16,}$/.test(token) && !NOT_A_COOKIE.has(cookieName(token))) {
        cookies.push({ name: "__bare__", value: token, domain: null, expires: null, httpOnly: null, secure: null, sameSite: null });
      }
      continue;
    }
    const name = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!name || !value) continue;
    if (NOT_A_COOKIE.has(cookieName(name))) continue;
    if (cookies.length >= MAX_COOKIES) break;
    cookies.push({ name, value: value.slice(0, MAX_VALUE), domain: null, expires: null, httpOnly: null, secure: null, sameSite: null });
  }
  return { cookies, shape: cookies.length ? "pairs" : "empty" };
}

/** Read whatever was pasted, in whichever of the four shapes it arrived in. */
function parsePaste(raw: string): ParsedPaste {
  const text = (raw || "").trim();
  if (!text) return { cookies: [], shape: "empty" };
  if (/^[{[]/.test(text)) {
    const json = fromJson(text);
    // `[{` that is not JSON is not a header either — report the JSON verdict.
    if (json.cookies.length || json.error) return json;
  }
  const netscape = fromNetscape(text);
  if (netscape) return netscape;
  return fromPairs(text);
}

/**
 * The plan for one platform: what would be written, or exactly why the paste is
 * not usable. Never throws — this runs on user input, and the answer the deck
 * shows has to be a sentence, not a stack.
 */
export function planSessionCookies(platform: PlatformKey, raw: string, nowMs = Date.now()): CookiePlan {
  const spec = TABLE[platform];
  const fail = (detail: string): CookiePlan => ({ ok: false, detail, cookies: [], names: [], expiresAt: null });
  if (!spec) return fail(`no cookie login is configured for ${platform}`);

  const pasted = parsePaste(raw);
  if (pasted.error) return fail(pasted.error);
  if (!pasted.cookies.length) {
    return fail("nothing to read — paste the session cookie value (or the whole header)");
  }

  // First name wins, and an entry the paste says belongs to a site we do not
  // trust for this platform is dropped rather than written into the profile.
  const kept: ParsedCookie[] = [];
  const named = new Map<string, ParsedCookie>();
  let skipped = 0;
  for (const c of pasted.cookies) {
    if (!c.name || !c.value) continue;
    const key = c.name.toLowerCase();
    if (named.has(key)) continue;
    if (c.domain && !spec.allow.some((d) => c.domain === d.slice(1) || c.domain === d || (c.domain || "").endsWith(d))) {
      skipped++;
      continue;
    }
    named.set(key, c);
    kept.push(c);
  }

  const needle = spec.need.toLowerCase();
  const bare = named.get("__bare__");
  if (bare) {
    named.delete("__bare__");
    const rest = Array.from(named.values());
    named.clear();
    // A lone value: the paste was just the `sessionid` string itself.
    named.set(needle, { ...bare, name: spec.need });
    for (const c of rest) named.set(c.name.toLowerCase(), c);
  }
  const session = named.get(needle);
  if (!session) {
    const found = Array.from(named.values()).map((c) => c.name);
    return fail(
      found.length
        ? `no ${spec.need} in what you pasted (names found: ${found.slice(0, 6).join(", ")})`
        : `no ${spec.need} in what you pasted`
    );
  }
  if (session.value.length < 16) {
    return fail(`${spec.need} looks truncated (${session.value.length} characters) — copy the whole value`);
  }
  // The bare-value route leaves everything else out; the named route keeps it.
  const list = bare ? [session] : Array.from(named.values());

  // TikTok's www origin reads the SameSite twin, so mint it when it is missing.
  for (const twin of spec.twins) {
    if (!named.has(twin.toLowerCase())) list.push({ ...session, name: twin });
  }

  const guardExpiry = expiryFromSidGuard(named.get("sid_guard")?.value, nowMs);
  const fromSession = session.expires && session.expires * 1000 > nowMs ? session.expires : null;
  const raw_expiry = fromSession ?? guardExpiry ?? Math.floor(nowMs / 1000) + 365 * DAY;
  const expiresSec = Math.max(raw_expiry, Math.floor(nowMs / 1000) + 30 * DAY);
  const where = fromSession ? "lifetime from the paste" : guardExpiry ? "lifetime from sid_guard" : "kept for 365 days";

  const cookies: CookieRecord[] = [];
  for (const c of list) {
    const key = c.name.toLowerCase();
    const site = spec.allow.find((d) => (c.domain || "").endsWith(d) || c.domain === d.slice(1)) ?? spec.domain;
    const sameSite = c.sameSite ?? "None";
    cookies.push({
      name: c.name,
      value: c.value,
      domain: site,
      path: "/",
      expires: c.expires && c.expires * 1000 > nowMs ? c.expires : expiresSec,
      httpOnly: c.httpOnly ?? spec.strict.includes(key),
      // "None" is what these sites ship their session with, and the profile is
      // HTTPS-only. An export that says `secure: false` alongside SameSite=None
      // would be rejected outright by Chromium, so the pair is forced together:
      // a dropped cookie is a failed login, a slightly-overstated flag is not.
      secure: sameSite === "None" ? true : (c.secure ?? true),
      sameSite,
    });
  }
  const skippedNote = skipped ? ` · ${skipped} entr${skipped === 1 ? "y" : "ies"} from other sites skipped` : "";
  return {
    ok: cookies.length > 0,
    sessionName: spec.need,
    detail: `${cookies.length} cookie${cookies.length === 1 ? "" : "s"} for ${spec.domain}${
      pasted.shape === "json" ? " (cookie export)" : pasted.shape === "netscape" ? " (cookies.txt)" : ""
    } — ${cookies.map((c) => c.name).join(", ")} · ${where}${skippedNote}`,
    cookies,
    names: cookies.map((c) => c.name),
    expiresAt: expiresSec * 1000,
  };
}

/** Short, secret-free label for the deck: "sessionid, +2 · expires 12 Nov". */
export function describePlan(plan: CookiePlan): string {
  if (!plan.ok) return plan.detail;
  // Lead with the session cookie itself, not with whatever name happened to be
  // first in the paste — `delay_guest_mode_vid, +22 more` tells the user nothing,
  // `sessionid, +22 more` says the login took.
  const lead = plan.sessionName && plan.names.includes(plan.sessionName) ? plan.sessionName : (plan.names[0] ?? "cookie");
  const extra = plan.names.length > 1 ? `, +${plan.names.length - 1} more` : "";
  const until = plan.expiresAt ? new Date(plan.expiresAt).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" }) : "session";
  return `${lead}${extra} · valid to ${until}`;
}
