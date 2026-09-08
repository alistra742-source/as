/**
 * Unit tests for the session-cookie plan (worker/src/sessionCookie.ts) — the code
 * that turns whatever you paste into the login panel into cookies for the profile.
 * No browser needed:
 *
 *   npm test
 *
 * The interesting properties are the ones a happy-path demo never shows: every
 * shape people actually copy is understood, a paste that is not a session is
 * refused with a sentence instead of a stack, site metadata never becomes a fake
 * cookie, and the secret never leaks into the text the deck shows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { describePlan, planSessionCookies } from "../worker/src/sessionCookie.ts";

const DAY = 86_400;
const NOW = 1_760_000_000_000; // fixed clock: expiry maths must be exact
const SECRET = "7cbb9f0e3a1d4f2a8e6b5d4c3b2a19f7"; // looks like a real sessionid

const byName = (plan, name) => plan.cookies.find((c) => c.name === name);

test("a bare sessionid value becomes a usable TikTok session", () => {
  const plan = planSessionCookies("tiktok", SECRET, NOW);
  assert.equal(plan.ok, true, plan.detail);
  const sid = byName(plan, "sessionid");
  assert.equal(sid.value, SECRET);
  assert.equal(sid.domain, ".tiktok.com");
  assert.equal(sid.path, "/");
  assert.equal(sid.secure, true);
  assert.equal(sid.httpOnly, true, "TikTok sends sessionid httpOnly; matching it keeps the jar believable");
  assert.equal(sid.sameSite, "None", "the same-site XHR that decides 'am I logged in' cannot see a Lax cookie");
  assert.ok(sid.expires * 1000 > NOW, "must not be born expired");
});

test("www.tiktok.com reads the SameSite twin, so it is minted from the same value", () => {
  const plan = planSessionCookies("tiktok", `sessionid=${SECRET}`, NOW);
  const twin = byName(plan, "sessionid_ss");
  assert.ok(twin, "sessionid_ss missing");
  assert.equal(twin.value, SECRET);
});

test("a pasted twin is never overwritten", () => {
  const plan = planSessionCookies("tiktok", `sessionid=${SECRET}; sessionid_ss=mine-mine-mine-mine`, NOW);
  assert.equal(byName(plan, "sessionid_ss").value, "mine-mine-mine-mine");
});

test("a whole Cookie: header is parsed, prefix and all", () => {
  const raw = `Cookie: sessionid=${SECRET}; ttwid=abc123def456ghi789; msToken=zzz999yyy888xxx`;
  const plan = planSessionCookies("tiktok", raw, NOW);
  assert.equal(plan.ok, true, plan.detail);
  // The SameSite twin is appended, so it lands last.
  assert.deepEqual(plan.names, ["sessionid", "ttwid", "msToken", "sessionid_ss"]);
  assert.equal(byName(plan, "ttwid").httpOnly, false, "ttwid is JS-visible on the real site");
});

test("trailing separators do not confuse the split", () => {
  const plan = planSessionCookies("tiktok", `sessionid=${SECRET};\n`, NOW);
  assert.equal(byName(plan, "sessionid").value, SECRET);
});

test("Set-Cookie attributes never become cookies", () => {
  const raw = `Set-Cookie: sessionid=${SECRET}; Path=/; Domain=.tiktok.com; Expires=Wed, 21 Oct 2025 07:28:00 GMT; Max-Age=31536000; HttpOnly; Secure; SameSite=None`;
  const plan = planSessionCookies("tiktok", raw, NOW);
  assert.equal(plan.ok, true, plan.detail);
  const names = plan.names.map((n) => n.toLowerCase());
  for (const junk of ["path", "domain", "expires", "max-age", "samesite", "httponly", "secure"]) {
    assert.ok(!names.includes(junk), `${junk} was stored as a cookie`);
  }
  assert.equal(plan.cookies.length, 2, `expected sessionid + its twin, got ${plan.names.join(", ")}`);
});

test("a paste without the session name is refused by name, not by stack trace", () => {
  const plan = planSessionCookies("tiktok", "ttwid=abc123def456; msToken=xyz789abc123", NOW);
  assert.equal(plan.ok, false);
  assert.match(plan.detail, /no sessionid/);
  assert.match(plan.detail, /ttwid/, "should list what it did find so the mistake is obvious");
  assert.equal(plan.cookies.length, 0);
});

test("an empty or junk paste is refused politely", () => {
  for (const raw of ["", "   ", ";;;;", "not a cookie at all"]) {
    const plan = planSessionCookies("tiktok", raw, NOW);
    assert.equal(plan.ok, false, JSON.stringify(raw));
    assert.ok(plan.detail.length > 8, "the deck shows this sentence");
  }
});

test("a truncated paste is refused rather than installed dead", () => {
  const plan = planSessionCookies("tiktok", "sessionid=abc", NOW);
  assert.equal(plan.ok, false);
  assert.match(plan.detail, /truncated/);
});

test("each platform checks for its own session name", () => {
  assert.equal(planSessionCookies("instagram", `sessionid=${SECRET}`, NOW).ok, true);
  assert.equal(planSessionCookies("youtube", `SID=${SECRET}`, NOW).ok, true);
  // A TikTok cookie must not be pushed into the YouTube profile.
  assert.equal(planSessionCookies("youtube", `sessionid=${SECRET}`, NOW).ok, false);
  assert.equal(planSessionCookies("instagram", `SID=${SECRET}`, NOW).ok, false);
  assert.equal(byName(planSessionCookies("instagram", `sessionid=${SECRET}`, NOW), "sessionid").domain, ".instagram.com");
});

test("TikTok twins are not minted for other platforms", () => {
  // YouTube's SAPISID is NOT a copy of SID; deriving it would break login.
  const plan = planSessionCookies("youtube", `SID=${SECRET}`, NOW);
  assert.ok(!plan.names.includes("SAPISID"), "invented a cookie with the wrong value");
  assert.deepEqual(plan.names, ["SID"]);
});

test("sid_guard carries the real lifetime, and it is honoured", () => {
  const issued = Math.floor(NOW / 1000);
  const guard = `hashishash|${issued}-${60 * 60 * 24 * 30}-Wed, 01-Nov-2025 00:00:00 GMT`;
  const plan = planSessionCookies("tiktok", `sessionid=${SECRET}; sid_guard=${guard}`, NOW);
  assert.equal(plan.ok, true, plan.detail);
  assert.equal(plan.expiresAt, (issued + 30 * DAY) * 1000);
  assert.match(plan.detail, /sid_guard/);
});

test("a guard that already lapsed does not install an expired cookie", () => {
  const issued = Math.floor(NOW / 1000) - 400 * DAY;
  const guard = `hash|${issued}-86400-x`;
  const plan = planSessionCookies("tiktok", `sessionid=${SECRET}; sid_guard=${guard}`, NOW);
  assert.ok(plan.expiresAt > NOW, "would be born expired");
  assert.ok(plan.expiresAt <= NOW + 31 * DAY * 1000, "should clamp to a short lease, not a year");
});

test("the secret never appears in anything the deck shows", () => {
  const good = planSessionCookies("tiktok", `sessionid=${SECRET}; ttwid=${SECRET}`, NOW);
  assert.ok(!good.detail.includes(SECRET), "plan.detail leaked the value");
  assert.ok(!describePlan(good).includes(SECRET), "describePlan leaked the value");
  const bad = planSessionCookies("tiktok", `ttwid=${SECRET}`, NOW);
  assert.ok(!bad.detail.includes(SECRET), "the refusal echoed the value");
});

test("a long paste is capped instead of bloating the profile", () => {
  const many = Array.from({ length: 80 }, (_, i) => `n${i}=${SECRET}`).join("; ");
  assert.ok(planSessionCookies("tiktok", many, NOW).cookies.length <= 40);
  const huge = planSessionCookies("tiktok", `sessionid=${SECRET.repeat(400)}`, NOW);
  assert.ok(byName(huge, "sessionid").value.length <= 8192);
});

test("describePlan is a one-liner with names and a date", () => {
  const plan = planSessionCookies("tiktok", `sessionid=${SECRET}; ttwid=abc123def456`, NOW);
  const text = describePlan(plan);
  assert.match(text, /sessionid/);
  assert.match(text, /more/);
  assert.match(text, /valid to /);
});
