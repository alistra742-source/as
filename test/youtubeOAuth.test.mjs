import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";

const source = fs.readFileSync(new URL("../worker/src/youtubeOAuth.ts", import.meta.url), "utf8");
const js = stripTypeScriptTypes(source, { mode: "strip" })
  .replace(/^import[^;]+;\s*/gm, "")
  .replace(/export /g, "");
const load = new Function(`${js}; return { youtubeTitle, youtubeUploadMetadata, youtubePublicReceipt };`);
const { youtubeTitle, youtubeUploadMetadata, youtubePublicReceipt } = load();

test("YouTube uses the first caption line as a Unicode-safe bounded title", () => {
  assert.equal(youtubeTitle("\n  Exact first line  \nsecond line"), "Exact first line");
  const emoji = "🎬".repeat(110);
  assert.equal(Array.from(youtubeTitle(emoji)).length, 100);
  assert.ok(!youtubeTitle(emoji).endsWith("\ud83c"), "a surrogate pair must not be split");
});

test("YouTube API metadata keeps the supplied caption exact and visibility Public", () => {
  const caption = "Exact caption #tag\nSecond line — unchanged";
  const metadata = youtubeUploadMetadata(caption);
  assert.equal(metadata.snippet.description, caption);
  assert.equal(metadata.snippet.title, "Exact caption #tag");
  assert.equal(metadata.snippet.categoryId, "22");
  assert.equal(metadata.status.privacyStatus, "public");
});

test("an over-limit YouTube description fails closed instead of being silently changed", () => {
  assert.throws(() => youtubeUploadMetadata("x".repeat(5001)), /5,000 characters.*nothing was uploaded/i);
});

test("only a returned public YouTube video id becomes a success receipt", () => {
  assert.equal(
    youtubePublicReceipt({ id: "AbCdEf12345", status: { privacyStatus: "public" } }),
    "https://www.youtube.com/watch?v=AbCdEf12345"
  );
  assert.throws(
    () => youtubePublicReceipt({ id: "AbCdEf12345", status: { privacyStatus: "private" } }),
    /created .* but reported privacy .*private.*not Public/i
  );
  assert.throws(() => youtubePublicReceipt({ status: { privacyStatus: "public" } }), /no verified video id/i);
});

test("OAuth implementation has per-account encrypted storage and one-time signed state", () => {
  assert.match(source, /accountDataDir\(env\.dataDir, "youtube"/);
  assert.match(source, /aes-256-gcm/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /youtube-pending/);
  assert.match(source, /privacyStatus: "public"/);
  assert.doesNotMatch(source, /localStorage|console\.log\([^\n]*(?:accessToken|refreshToken)/);
});

test("OAuth callback consumes one-time state and stores no plaintext token", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "viraldeck-oauth-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = {
    id: process.env.GOOGLE_CLIENT_ID,
    secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect: process.env.GOOGLE_REDIRECT_URI,
    scopes: process.env.GOOGLE_SCOPES,
  };
  process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "server-only-test-secret";
  process.env.GOOGLE_REDIRECT_URI = "https://deck.example/callback";
  process.env.GOOGLE_SCOPES = "openid profile https://www.googleapis.com/auth/youtube.upload";
  t.after(() => {
    for (const [key, value] of Object.entries({
      GOOGLE_CLIENT_ID: old.id,
      GOOGLE_CLIENT_SECRET: old.secret,
      GOOGLE_REDIRECT_URI: old.redirect,
      GOOGLE_SCOPES: old.scopes,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const accountDataDir = (dataRoot, platform, accountId) =>
    accountId === "default" ? dataRoot : path.join(dataRoot, "accounts", `${platform}--${accountId}`);
  const validAccountId = (value) => (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(String(value || "")) ? String(value) : null);
  const calls = [];
  const fakeFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: "plaintext-access-token-must-not-appear-on-disk",
          refresh_token: "plaintext-refresh-token-must-not-appear-on-disk",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/youtube.upload",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (String(url).includes("upload/youtube/v3/videos?uploadType=resumable")) {
      return new Response("{}", {
        status: 200,
        headers: { location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=opaque" },
      });
    }
    if (String(url).includes("upload_id=opaque")) {
      return new Response(JSON.stringify({ id: "AbCdEf12345", status: { privacyStatus: "public" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected request: ${String(url)}`);
  };
  const secureLoad = new Function(
    "crypto",
    "fs",
    "path",
    "accountDataDir",
    "validAccountId",
    "env",
    "fetch",
    `${js}; return { beginYouTubeOAuth, completeYouTubeOAuth, youtubeOAuthStatus, uploadYouTubeWithOAuth };`
  );
  const oauth = secureLoad(crypto, fs, path, accountDataDir, validAccountId, { dataDir: root, token: "worker-secret" }, fakeFetch);

  const authorization = new URL(oauth.beginYouTubeOAuth("account-a", "Personal channel"));
  assert.equal(authorization.hostname, "accounts.google.com");
  assert.equal(authorization.searchParams.get("scope"), "https://www.googleapis.com/auth/youtube.upload");
  assert.equal(authorization.searchParams.get("access_type"), "offline");
  assert.equal(authorization.searchParams.get("prompt"), "consent");
  const state = authorization.searchParams.get("state");
  assert.ok(state);

  const completed = await oauth.completeYouTubeOAuth("single-use-code", state);
  assert.deepEqual(completed, { accountId: "account-a", accountName: "Personal channel" });
  assert.equal(oauth.youtubeOAuthStatus("account-a").connected, true);

  const encryptedPath = path.join(root, "accounts", "youtube--account-a", "youtube-oauth.enc.json");
  const encrypted = fs.readFileSync(encryptedPath, "utf8");
  assert.doesNotMatch(encrypted, /plaintext-(?:access|refresh)-token/);
  assert.match(encrypted, /"iv"/);
  assert.match(encrypted, /"tag"/);

  const caption = "Exact API description\nwith its second line";
  const logs = [];
  const receipt = await oauth.uploadYouTubeWithOAuth(
    "account-a",
    { name: "master.mp4", mime: "video/mp4", buffer: Buffer.alloc(120_000, 7) },
    caption,
    (line) => logs.push(line)
  );
  assert.equal(receipt.liveUrl, "https://www.youtube.com/watch?v=AbCdEf12345");
  const initCall = calls.find((call) => call.url.includes("uploadType=resumable"));
  const metadata = JSON.parse(initCall.options.body);
  assert.equal(metadata.snippet.description, caption);
  assert.equal(metadata.status.privacyStatus, "public");
  assert.equal(initCall.options.headers.authorization, "Bearer plaintext-access-token-must-not-appear-on-disk");
  assert.match(logs.at(-1), /publish confirmed as Public/);

  await assert.rejects(
    oauth.completeYouTubeOAuth("replayed-code", state),
    /already used|not started/i,
    "the callback marker must be consumed after its first use"
  );
  await assert.rejects(
    oauth.completeYouTubeOAuth("code", `${state.slice(0, -1)}x`),
    /could not be verified|invalid/i,
    "a modified state must never select an account"
  );
});
