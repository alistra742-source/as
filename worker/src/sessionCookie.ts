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
    strict: ["sessionid", "sessionid_ss", "sid_guard", "sid_tt", "uid_tt", "ttwebid"],
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
function expiryFromSidGuard(value: string | undefined): number | null {
  if (!value) return null;
  const m = /(?:^|\|)(\d{9,11})-(\d{4,9})-/.exec(value);
  if (!m) return null;
  const issued = Number(m[1]);
  const life = Number(m[2]);
  if (!issued || !life) return null;
  return issued + life;
}

/** One parsed cookie, before it is judged against the platform's rules. */
interface ParsedCookie {
  name: string;
  value: string;
  domain: string | null;
  /** Keep an exported scope intact; changing `/foo` to `/` can change which duplicate wins. */
  path: string | null;
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
  const raw = String(v ?? "")
    .trim()
    .replace(/^\uFEFF/, "")
    .replace(/^#HttpOnly_/, "")
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/:\d+$/, "")
    .toLowerCase();
  if (!raw) return null;
  return raw.replace(/^\.+/, ".");
}

function exportDomain(domain: unknown, hostOnly: unknown): string | null {
  const cleaned = cleanDomain(domain);
  if (!cleaned) return null;
  // A leading dot is the actual include-subdomains representation and wins over
  // contradictory extension metadata. When the dot is absent, `hostOnly:false`
  // is enough information to restore it.
  return !cleaned.startsWith(".") && hostOnly === false ? `.${cleaned}` : cleaned;
}

function cleanPath(v: unknown): string | null {
  const path = String(v ?? "").trim();
  return path.startsWith("/") ? path.slice(0, 1024) : null;
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
    // JSON exports already delimit the value structurally. Trimming or removing
    // quote characters mutates a valid opaque token; preserve its bytes exactly.
    const value = String(o.value ?? o.Value ?? "");
    if (!name || !value || cookies.length >= MAX_COOKIES) continue;
    cookies.push({
      name,
      value: value.slice(0, MAX_VALUE),
      domain: exportDomain(o.domain ?? o.Domain, o.hostOnly ?? o.host_only),
      path: cleanPath(o.path ?? o.Path),
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
 *   domain  include-subdomains  path  secure  expiry  name  value  ← 7 fields
 *   # comment / "# Netscape HTTP Cookie File" / "#HttpOnly_.tiktok.com …"
 * A few browser extensions omit the secure column (legacy 6-field variant), so
 * that shape remains accepted too.
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
    const f = line.split("\t").map((x) => x.trim());
    if (f.length < 6) continue;
    const standard = f.length >= 7;
    const domain = f[0];
    const includeSubdomains = /^true$/i.test(f[1]);
    const path = f[2];
    const secure = standard ? /^true$/i.test(f[3]) : null;
    const expiry = f[standard ? 4 : 3];
    const name = f[standard ? 5 : 4];
    const value = f.slice(standard ? 6 : 5).join("\t");
    if (!name || !value || cookies.length >= MAX_COOKIES) continue;
    cookies.push({
      name,
      value: value.slice(0, MAX_VALUE),
      domain: exportDomain(domain, !includeSubdomains),
      path: cleanPath(path),
      expires: asExpiry(expiry),
      httpOnly: line.startsWith("#HttpOnly_") ? true : null,
      secure,
      sameSite: null,
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
        cookies.push({ name: "__bare__", value: token, domain: null, path: null, expires: null, httpOnly: null, secure: null, sameSite: null });
      }
      continue;
    }
    const name = token.slice(0, eq).trim();
    const value = token.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (!name || !value) continue;
    if (NOT_A_COOKIE.has(cookieName(name))) continue;
    if (cookies.length >= MAX_COOKIES) break;
    cookies.push({ name, value: value.slice(0, MAX_VALUE), domain: null, path: null, expires: null, httpOnly: null, secure: null, sameSite: null });
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

  // Cookie identity is name + domain + path, not name alone. Cookie-editor
  // exports can legitimately contain host-only and parent-domain copies of the
  // same name; dropping the second one changes the Cookie header the working
  // source browser sent. De-duplicate only an exact exported scope.
  const accepted: ParsedCookie[] = [];
  const named = new Map<string, ParsedCookie>();
  const seenScopes = new Set<string>();
  let skipped = 0;
  for (const c of pasted.cookies) {
    if (!c.name || !c.value) continue;
    const key = c.name.toLowerCase();
    const domain = c.domain;
    if (domain && !spec.allow.some((d) => domain === d.slice(1) || domain === d || domain.endsWith(d))) {
      skipped++;
      continue;
    }
    const scope = `${key}\u0000${c.domain ?? ""}\u0000${c.path ?? ""}`;
    if (seenScopes.has(scope)) continue;
    seenScopes.add(scope);
    accepted.push(c);
    if (!named.has(key)) named.set(key, c);
  }

  const needle = spec.need.toLowerCase();
  const bare = named.get("__bare__");
  const nowSec = Math.floor(nowMs / 1000);
  let sessionCandidates: ParsedCookie[];
  if (bare) {
    // A lone value: the paste was just the `sessionid` string itself.
    sessionCandidates = [{ ...bare, name: spec.need }];
    named.set(needle, sessionCandidates[0]);
  } else {
    sessionCandidates = accepted.filter((c) => c.name.toLowerCase() === needle);
  }
  const session =
    sessionCandidates.find((c) => c.value.length >= 16 && (!c.expires || c.expires > nowSec)) ?? sessionCandidates[0];
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
  const showExpiry = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);
  if (session.expires && session.expires <= nowSec) {
    return fail(`${spec.need} expired on ${showExpiry(session.expires)} — export it again from a currently signed-in tab`);
  }
  const guardExpiry = expiryFromSidGuard(named.get("sid_guard")?.value);
  if (guardExpiry && guardExpiry <= nowSec) {
    return fail(`sid_guard says this TikTok session expired on ${showExpiry(guardExpiry)} — export a fresh signed-in session`);
  }

  // The bare-value route leaves everything else out; the named route keeps it.
  // Expired accessory records are omitted instead of silently extending them:
  // extending client expiry cannot revive server-side state and can make the
  // wrong stale cookie win over a valid scoped copy already in the profile.
  let skippedExpired = 0;
  const list = (bare ? [session] : accepted).filter((c) => {
    if (!c.expires || c.expires > nowSec) return true;
    skippedExpired += 1;
    return false;
  });

  // TikTok's www origin reads the SameSite twin, so mint it when no live twin was
  // supplied. It inherits the primary session's domain/path/lifetime, with the
  // Secure+SameSite=None semantics that make it the cross-site twin.
  for (const twin of spec.twins) {
    if (!list.some((c) => c.name.toLowerCase() === twin.toLowerCase())) {
      list.push({ ...session, name: twin, sameSite: "None", secure: true });
    }
  }

  const authoritative = [
    ...list.filter((c) => c.name.toLowerCase() === needle).map((c) => c.expires),
    guardExpiry,
  ].filter((n): n is number => !!n && n > nowSec);
  const expiresSec = authoritative.length ? Math.min(...authoritative) : nowSec + 365 * DAY;
  const where = session.expires
    ? guardExpiry
      ? "lifetime from the paste and sid_guard"
      : "lifetime from the paste"
    : guardExpiry
      ? "lifetime from sid_guard"
      : "kept for 365 days";

  const cookies: CookieRecord[] = [];
  for (const c of list) {
    const key = c.name.toLowerCase();
    // A validated export's scope is already safe. Preserve it rather than
    // flattening every host-only cookie onto `.tiktok.com` and every path onto
    // `/`; cookie ordering and host-only state are part of the browser identity.
    const site = c.domain ?? spec.domain;
    // Chrome's effective default for an omitted/"unspecified" SameSite attribute
    // is Lax. The `_ss` twin is the deliberate cross-site copy and defaults to
    // None; explicit export metadata always wins.
    const sameSite = c.sameSite ?? (key.endsWith("_ss") ? "None" : "Lax");
    cookies.push({
      name: c.name,
      value: c.value,
      domain: site,
      path: c.path ?? "/",
      expires: c.expires ?? expiresSec,
      httpOnly: c.httpOnly ?? spec.strict.includes(key),
      // SameSite=None without Secure is refused by Chromium. Preserve every
      // explicit flag except this mechanically invalid combination.
      secure: sameSite === "None" ? true : (c.secure ?? true),
      sameSite,
    });
  }
  const skippedNote = skipped ? ` · ${skipped} entr${skipped === 1 ? "y" : "ies"} from other sites skipped` : "";
  const expiredNote = skippedExpired ? ` · ${skippedExpired} expired accessor${skippedExpired === 1 ? "y" : "ies"} skipped` : "";
  return {
    ok: cookies.length > 0,
    sessionName: spec.need,
    detail: `${cookies.length} cookie${cookies.length === 1 ? "" : "s"} for ${spec.domain}${
      pasted.shape === "json" ? " (cookie export)" : pasted.shape === "netscape" ? " (cookies.txt)" : ""
    } — ${cookies.map((c) => c.name).join(", ")} · ${where}${skippedNote}${expiredNote}`,
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
