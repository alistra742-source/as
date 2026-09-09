import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { accountDataDir, validAccountId } from "./accountScope.js";
import { env } from "./config.js";

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const TOKEN_FILE = "youtube-oauth.enc.json";
const PENDING_MAX_AGE_MS = 15 * 60_000;

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
  connectedAt: number;
}

interface EncryptedFile {
  version: 1;
  iv: string;
  tag: string;
  data: string;
}

interface StatePayload {
  version: 1;
  accountId: string;
  accountName: string;
  nonce: string;
  expiresAt: number;
}

interface GoogleTokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  error?: unknown;
  error_description?: unknown;
}

export interface YouTubeOAuthStatus {
  configured: boolean;
  connected: boolean;
  expiresAt: number | null;
  scope: string | null;
  error: string | null;
}

export interface YouTubeOAuthCompletion {
  accountId: string;
  accountName: string;
}

export interface YouTubeUploadFile {
  name: string;
  mime: string;
  buffer: Buffer;
}

type StepLog = (text: string) => void;

function compact(value: unknown, max = 300): string {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function oauthConfig(): OAuthConfig | null {
  const clientId = compact(process.env.GOOGLE_CLIENT_ID, 300);
  const clientSecret = compact(process.env.GOOGLE_CLIENT_SECRET, 500);
  const redirectUri = compact(process.env.GOOGLE_REDIRECT_URI, 1000);
  // Least privilege is a product invariant, not an environment preference.
  // Ignore accidental extra scopes in Railway rather than making the UI's
  // “youtube.upload only” promise false.
  const scopes = [YOUTUBE_UPLOAD_SCOPE];
  if (!clientId || !clientSecret || !redirectUri) return null;
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    return null;
  }
  if (redirect.protocol !== "https:" && redirect.hostname !== "localhost" && redirect.hostname !== "127.0.0.1") {
    return null;
  }
  return { clientId, clientSecret, redirectUri: redirect.toString(), scopes };
}

function requireConfig(): OAuthConfig {
  const config = oauthConfig();
  if (!config) {
    throw new Error(
      "YouTube OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI as separate Railway variables."
    );
  }
  return config;
}

function requireAccountId(value: string): string {
  const id = validAccountId(value);
  if (!id) throw new Error("Invalid YouTube account id");
  return id;
}

function accountName(value: string): string {
  return compact(value, 48) || "YouTube account";
}

function tokenPath(accountId: string): string {
  const dir = accountDataDir(env.dataDir, "youtube", requireAccountId(accountId));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, TOKEN_FILE);
}

function encryptionKey(config: OAuthConfig): Buffer {
  // The optional key allows client-secret rotation without reconnecting every
  // account. Falling back to the server-side client secret still keeps refresh
  // tokens out of plaintext on the Railway volume.
  const material = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || config.clientSecret;
  return crypto.createHash("sha256").update(`viraldeck-youtube-oauth\0${material}`).digest();
}

function aad(accountId: string): Buffer {
  return Buffer.from(`viraldeck:youtube:${accountId}:v1`, "utf8");
}

function encryptToken(accountId: string, token: StoredToken, config: OAuthConfig): EncryptedFile {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  cipher.setAAD(aad(accountId));
  const data = Buffer.concat([cipher.update(JSON.stringify(token), "utf8"), cipher.final()]);
  return {
    version: 1,
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    data: data.toString("base64url"),
  };
}

function decryptToken(accountId: string, file: EncryptedFile, config: OAuthConfig): StoredToken {
  if (file?.version !== 1 || !file.iv || !file.tag || !file.data) throw new Error("invalid encrypted token file");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(config), Buffer.from(file.iv, "base64url"));
  decipher.setAAD(aad(accountId));
  decipher.setAuthTag(Buffer.from(file.tag, "base64url"));
  const plain = Buffer.concat([decipher.update(Buffer.from(file.data, "base64url")), decipher.final()]);
  const parsed = JSON.parse(plain.toString("utf8")) as Partial<StoredToken>;
  if (!parsed.refreshToken || typeof parsed.refreshToken !== "string") throw new Error("refresh token is missing");
  return {
    accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : "",
    refreshToken: parsed.refreshToken,
    expiresAt: Number.isFinite(parsed.expiresAt) ? Number(parsed.expiresAt) : 0,
    scope: typeof parsed.scope === "string" ? parsed.scope : YOUTUBE_UPLOAD_SCOPE,
    tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : "Bearer",
    connectedAt: Number.isFinite(parsed.connectedAt) ? Number(parsed.connectedAt) : Date.now(),
  };
}

function readToken(accountId: string): StoredToken | null {
  const config = oauthConfig();
  if (!config) return null;
  try {
    const raw = fs.readFileSync(tokenPath(accountId), "utf8");
    return decryptToken(accountId, JSON.parse(raw) as EncryptedFile, config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("The saved YouTube authorization cannot be read. Reconnect Google for this account.");
  }
}

function writeToken(accountId: string, token: StoredToken, config: OAuthConfig) {
  const file = tokenPath(accountId);
  const temp = `${file}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(encryptToken(accountId, token, config)), { mode: 0o600 });
  fs.renameSync(temp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows/local filesystems may not implement chmod. */
  }
}

function stateKey(config: OAuthConfig): Buffer {
  return crypto
    .createHash("sha256")
    .update(`viraldeck-youtube-state\0${config.clientSecret}\0${env.token}`)
    .digest();
}

function signState(encodedPayload: string, config: OAuthConfig): string {
  return crypto.createHmac("sha256", stateKey(config)).update(encodedPayload).digest("base64url");
}

function pendingDir(): string {
  const dir = path.join(env.dataDir, ".oauth", "youtube-pending");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pendingPath(state: string): string {
  const digest = crypto.createHash("sha256").update(state).digest("hex");
  return path.join(pendingDir(), `${digest}.json`);
}

function cleanupPending() {
  const now = Date.now();
  try {
    for (const entry of fs.readdirSync(pendingDir(), { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json(?:\.\d+\.[a-f0-9]{10}\.claim)?$/.test(entry.name)) continue;
      const file = path.join(pendingDir(), entry.name);
      try {
        const stat = fs.statSync(file);
        if (now - stat.mtimeMs > PENDING_MAX_AGE_MS * 2) fs.rmSync(file, { force: true });
      } catch {
        /* raced with another callback */
      }
    }
  } catch {
    /* no pending directory yet */
  }
}

function decodeAndVerifyState(state: string, config: OAuthConfig): StatePayload {
  const [encoded, signature, extra] = state.split(".");
  if (!encoded || !signature || extra) throw new Error("The Google authorization state is invalid. Start again from ViralDeck.");
  const expected = Buffer.from(signState(encoded, config), "utf8");
  const supplied = Buffer.from(signature, "utf8");
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw new Error("The Google authorization state could not be verified. Start again from ViralDeck.");
  }
  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StatePayload;
  } catch {
    throw new Error("The Google authorization state is malformed. Start again from ViralDeck.");
  }
  const id = validAccountId(payload.accountId);
  if (
    payload.version !== 1 ||
    !id ||
    typeof payload.nonce !== "string" ||
    payload.nonce.length < 20 ||
    !Number.isFinite(payload.expiresAt) ||
    payload.expiresAt < Date.now()
  ) {
    throw new Error("The Google authorization request expired. Start again from this YouTube account.");
  }
  return { ...payload, accountId: id, accountName: accountName(payload.accountName) };
}

function googleError(status: number, text: string, fallback: string): Error {
  let detail = "";
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | unknown; error_description?: unknown };
    detail = compact(
      typeof parsed.error === "object" && parsed.error && "message" in parsed.error
        ? (parsed.error as { message?: unknown }).message
        : parsed.error_description || parsed.error,
      350
    );
  } catch {
    detail = compact(text, 350);
  }
  return new Error(`${fallback} (Google HTTP ${status}${detail ? `: ${detail}` : ""})`);
}

async function tokenRequest(params: URLSearchParams, config: OAuthConfig): Promise<GoogleTokenResponse> {
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params,
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
  if (!response.ok) throw googleError(response.status, text, "Google refused the YouTube authorization");
  try {
    return JSON.parse(text) as GoogleTokenResponse;
  } catch {
    throw new Error("Google returned an unreadable OAuth response");
  }
}

export function youtubeOAuthStatus(accountId: string): YouTubeOAuthStatus {
  if (!oauthConfig()) {
    return {
      configured: false,
      connected: false,
      expiresAt: null,
      scope: null,
      error: "Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI on Railway.",
    };
  }
  try {
    const token = readToken(requireAccountId(accountId));
    const hasUploadScope = !!token?.scope.split(/\s+/).includes(YOUTUBE_UPLOAD_SCOPE);
    return {
      configured: true,
      connected: !!token?.refreshToken && hasUploadScope,
      expiresAt: token?.expiresAt || null,
      scope: token?.scope || null,
      error: token && !hasUploadScope ? "The saved grant lacks youtube.upload. Reconnect this account." : null,
    };
  } catch (error) {
    return { configured: true, connected: false, expiresAt: null, scope: null, error: (error as Error).message };
  }
}

export function youtubeOAuthConnected(accountId: string): boolean {
  return youtubeOAuthStatus(accountId).connected;
}

export function beginYouTubeOAuth(rawAccountId: string, rawAccountName: string): string {
  const config = requireConfig();
  const accountId = requireAccountId(rawAccountId);
  cleanupPending();
  const payload: StatePayload = {
    version: 1,
    accountId,
    accountName: accountName(rawAccountName),
    nonce: crypto.randomBytes(24).toString("base64url"),
    expiresAt: Date.now() + PENDING_MAX_AGE_MS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const state = `${encoded}.${signState(encoded, config)}`;
  fs.writeFileSync(
    pendingPath(state),
    JSON.stringify({ accountId, nonce: payload.nonce, expiresAt: payload.expiresAt }),
    { mode: 0o600 }
  );
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function completeYouTubeOAuth(code: string, state: string): Promise<YouTubeOAuthCompletion> {
  const config = requireConfig();
  if (!code || code.length > 4096) throw new Error("Google did not return a usable authorization code.");
  if (!state || state.length > 4096) throw new Error("Google did not return a usable authorization state.");
  const payload = decodeAndVerifyState(state, config);
  const marker = pendingPath(state);
  const claimedMarker = `${marker}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.claim`;
  let pending: { accountId?: unknown; nonce?: unknown; expiresAt?: unknown };
  try {
    // Rename is the atomic one-use claim. Two callback requests cannot both read
    // the marker and race through a token exchange for the same named account.
    fs.renameSync(marker, claimedMarker);
    pending = JSON.parse(fs.readFileSync(claimedMarker, "utf8")) as typeof pending;
  } catch {
    throw new Error("This Google authorization was already used or was not started by ViralDeck.");
  } finally {
    fs.rmSync(claimedMarker, { force: true });
  }
  if (
    pending.accountId !== payload.accountId ||
    pending.nonce !== payload.nonce ||
    Number(pending.expiresAt) !== payload.expiresAt
  ) {
    throw new Error("The saved Google authorization state does not match. Start again from ViralDeck.");
  }

  const response = await tokenRequest(
    new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
    config
  );
  const accessToken = typeof response.access_token === "string" ? response.access_token : "";
  // Never combine a fresh access token with a refresh token from an earlier
  // consent grant: the user may have selected a different Google identity.
  const refreshToken = typeof response.refresh_token === "string" ? response.refresh_token : "";
  if (!accessToken || !refreshToken) {
    throw new Error(
      "Google did not issue a complete offline grant. The existing connection was left unchanged; revoke the old grant in your Google Account, then connect again with consent."
    );
  }
  const grantedScope = compact(response.scope, 2000) || config.scopes.join(" ");
  if (!grantedScope.split(/\s+/).includes(YOUTUBE_UPLOAD_SCOPE)) {
    throw new Error("Google did not grant youtube.upload. Reconnect and approve the requested YouTube permission.");
  }
  const expiresIn = Number(response.expires_in);
  const token: StoredToken = {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_500_000),
    scope: grantedScope,
    tokenType: compact(response.token_type, 40) || "Bearer",
    connectedAt: Date.now(),
  };
  writeToken(payload.accountId, token, config);
  return { accountId: payload.accountId, accountName: payload.accountName };
}

async function freshAccessToken(accountId: string, forceRefresh = false): Promise<string> {
  const config = requireConfig();
  const token = readToken(accountId);
  if (!token?.refreshToken) throw new Error("This YouTube account is not connected to Google. Press Connect Google first.");
  if (!forceRefresh && token.accessToken && token.expiresAt > Date.now() + 90_000) return token.accessToken;
  let response: GoogleTokenResponse;
  try {
    response = await tokenRequest(
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: token.refreshToken,
        grant_type: "refresh_token",
      }),
      config
    );
  } catch (error) {
    throw new Error(
      `YouTube authorization expired or was revoked. Reconnect Google for this named account. ${(error as Error).message}`
    );
  }
  const accessToken = typeof response.access_token === "string" ? response.access_token : "";
  if (!accessToken) throw new Error("Google refreshed the grant but returned no YouTube access token. Reconnect the account.");
  const refreshedScope = compact(response.scope, 2000) || token.scope;
  if (!refreshedScope.split(/\s+/).includes(YOUTUBE_UPLOAD_SCOPE)) {
    throw new Error("The refreshed Google grant no longer includes youtube.upload. Reconnect this named account.");
  }
  const expiresIn = Number(response.expires_in);
  writeToken(
    accountId,
    {
      ...token,
      accessToken,
      refreshToken:
        typeof response.refresh_token === "string" && response.refresh_token
          ? response.refresh_token
          : token.refreshToken,
      expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 3_500_000),
      scope: refreshedScope,
      tokenType: compact(response.token_type, 40) || token.tokenType,
    },
    config
  );
  return accessToken;
}

/** YouTube titles are required and capped at 100 Unicode characters. */
export function youtubeTitle(caption: string): string {
  const firstLine = caption
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return Array.from(firstLine || "Posted via ViralDeck").slice(0, 100).join("");
}

/** Pure metadata policy: exact description, bounded derived title, Public. */
export function youtubeUploadMetadata(rawCaption: string): {
  snippet: { title: string; description: string; categoryId: string };
  status: { privacyStatus: "public" };
} {
  const caption = rawCaption || "Posted via ViralDeck";
  if (Array.from(caption).length > 5000) {
    throw new Error("YouTube descriptions are limited to 5,000 characters; nothing was uploaded because the caption must stay exact.");
  }
  return {
    snippet: { title: youtubeTitle(caption), description: caption, categoryId: "22" },
    status: { privacyStatus: "public" },
  };
}

export function youtubePublicReceipt(result: { id?: unknown; status?: { privacyStatus?: unknown } }): string {
  const videoId = typeof result.id === "string" && /^[a-zA-Z0-9_-]{6,32}$/.test(result.id) ? result.id : "";
  if (!videoId) throw new Error("YouTube returned no verified video id; refusing to claim success.");
  const liveUrl = `https://www.youtube.com/watch?v=${videoId}`;
  if (result.status?.privacyStatus !== "public") {
    const privacy = compact(result.status?.privacyStatus, 40) || "unknown";
    throw new Error(
      `YouTube created ${liveUrl} but reported privacy “${privacy}”, not Public. ` +
        "Projects that have not passed YouTube’s API compliance audit can be forced to private; no public success was recorded."
    );
  }
  return liveUrl;
}

export async function uploadYouTubeWithOAuth(
  rawAccountId: string,
  video: YouTubeUploadFile,
  rawCaption: string,
  log: StepLog
): Promise<{ ok: true; message: string; liveUrl: string }> {
  const accountId = requireAccountId(rawAccountId);
  const caption = rawCaption || "Posted via ViralDeck";
  const metadata = youtubeUploadMetadata(caption);
  if (!video.buffer.length || !video.mime.toLowerCase().startsWith("video/")) {
    throw new Error("The prepared upload is not a video.");
  }
  const timeoutRaw = Number(process.env.YOUTUBE_UPLOAD_TIMEOUT_MIN || 15);
  const timeoutMin = Number.isFinite(timeoutRaw) ? Math.max(2, timeoutRaw) : 15;

  log("Uploading through the official YouTube Data API for this named Google account (visibility Public)…");
  for (let authAttempt = 0; authAttempt < 2; authAttempt++) {
    const accessToken = await freshAccessToken(accountId, authAttempt > 0);
    const init = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: "application/json",
          "content-type": "application/json; charset=utf-8",
          "x-upload-content-length": String(video.buffer.length),
          "x-upload-content-type": video.mime,
        },
        body: JSON.stringify(metadata),
        redirect: "error",
        signal: AbortSignal.timeout(60_000),
      }
    );
    if (init.status === 401 && authAttempt === 0) continue;
    const initText = await init.text();
    if (!init.ok) throw googleError(init.status, initText, "YouTube refused to create the upload");
    const location = init.headers.get("location") || "";
    let uploadDestination: URL | null = null;
    try {
      uploadDestination = new URL(location);
    } catch {
      /* handled below */
    }
    if (
      !uploadDestination ||
      uploadDestination.protocol !== "https:" ||
      !!uploadDestination.username ||
      !!uploadDestination.password ||
      !/(^|\.)googleapis\.com$/i.test(uploadDestination.hostname)
    ) {
      throw new Error("YouTube created no valid HTTPS resumable upload destination; nothing was published.");
    }

    const uploaded = await fetch(uploadDestination, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "content-type": video.mime,
        "content-length": String(video.buffer.length),
      },
      body: video.buffer,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMin * 60_000),
    });
    const uploadedText = await uploaded.text();
    if (!uploaded.ok) throw googleError(uploaded.status, uploadedText, "YouTube did not accept the video bytes");
    let result: { id?: unknown; status?: { privacyStatus?: unknown } };
    try {
      result = JSON.parse(uploadedText) as typeof result;
    } catch {
      throw new Error("YouTube accepted the transfer but returned no readable publish receipt; refusing to claim success.");
    }
    const liveUrl = youtubePublicReceipt(result);
    log(`✅ YouTube API publish confirmed as Public: ${liveUrl}`);
    return { ok: true, message: "YouTube API returned a public video receipt.", liveUrl };
  }
  throw new Error("YouTube rejected both the current and refreshed Google access token. Reconnect this account.");
}

export async function disconnectYouTubeOAuth(rawAccountId: string): Promise<void> {
  const accountId = requireAccountId(rawAccountId);
  let token: StoredToken | null = null;
  try {
    token = readToken(accountId);
  } catch {
    // Disconnect is also the recovery button for an unreadable encrypted file.
  }
  if (token) {
    const revoke = token.refreshToken || token.accessToken;
    if (revoke) {
      await fetch(GOOGLE_REVOKE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: revoke }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      }).catch(() => undefined);
    }
  }
  fs.rmSync(tokenPath(accountId), { force: true });
}
