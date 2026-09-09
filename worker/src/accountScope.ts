import path from "node:path";
import type { PlatformKey } from "./config.js";

/** Existing one-profile installs keep this id and therefore keep their old path. */
export const LEGACY_ACCOUNT_ID = "default";

/** IDs come from the deck, so make the filesystem boundary explicit. */
export function validAccountId(value: string | null | undefined): string | null {
  const id = (value || "").trim();
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id) ? id : null;
}

export function accountScopeKey(platform: PlatformKey, accountId: string): string {
  return `${platform}:${accountId}`;
}

/** New accounts have both state and browser data in one isolated directory. */
export function accountDataDir(root: string, platform: PlatformKey, accountId: string): string {
  if (accountId === LEGACY_ACCOUNT_ID) return root;
  const safe = validAccountId(accountId);
  if (!safe) throw new Error("Invalid account id");
  return path.join(root, "accounts", `${platform}--${safe}`);
}

export function accountProfileDir(root: string, platform: PlatformKey, accountId: string): string {
  return accountId === LEGACY_ACCOUNT_ID
    ? path.join(root, `profile-${platform}`)
    : path.join(accountDataDir(root, platform, accountId), "profile");
}

/** Parse a persisted account directory without ever accepting path syntax. */
export function parseAccountDir(name: string): { platform: PlatformKey; accountId: string } | null {
  const match = /^(tiktok|instagram|youtube)--([a-z0-9][a-z0-9_-]{0,63})$/i.exec(name);
  if (!match) return null;
  const platform = match[1].toLowerCase() as PlatformKey;
  const accountId = validAccountId(match[2]);
  return accountId ? { platform, accountId } : null;
}
