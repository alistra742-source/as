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

export interface AccountDeletionPlan {
  /** Named accounts are removed as one directory. Null for the legacy account,
   * whose shared data root must never be recursively removed. */
  accountDir: string | null;
  profileDir: string;
  legacy: boolean;
}

/**
 * Compute the only paths account deletion may touch. This repeats the containment
 * check at the destructive boundary instead of trusting a caller's TypeScript
 * type or a string assembled in an HTTP handler.
 */
export function accountDeletionPlan(root: string, platform: PlatformKey, rawAccountId: string): AccountDeletionPlan {
  if (!/^(?:tiktok|instagram|youtube)$/.test(platform)) throw new Error("Invalid account platform");
  const accountId = validAccountId(rawAccountId);
  if (!accountId) throw new Error("Invalid account id");
  const dataRoot = path.resolve(root);
  const profileDir = path.resolve(accountProfileDir(dataRoot, platform, accountId));
  if (accountId === LEGACY_ACCOUNT_ID) {
    // `/data/state.json` is shared by three compatibility runtimes. The caller
    // resets only this platform's records and removes only profile-<platform>.
    if (profileDir === dataRoot || !profileDir.startsWith(dataRoot + path.sep)) throw new Error("Unsafe legacy profile path");
    return { accountDir: null, profileDir, legacy: true };
  }
  const accountsRoot = path.resolve(dataRoot, "accounts");
  const accountDir = path.resolve(accountDataDir(dataRoot, platform, accountId));
  if (accountDir === accountsRoot || !accountDir.startsWith(accountsRoot + path.sep)) {
    throw new Error("Unsafe account deletion path");
  }
  if (profileDir === accountDir || !profileDir.startsWith(accountDir + path.sep)) {
    throw new Error("Unsafe account profile path");
  }
  return { accountDir, profileDir, legacy: false };
}

/** Parse a persisted account directory without ever accepting path syntax. */
export function parseAccountDir(name: string): { platform: PlatformKey; accountId: string } | null {
  const match = /^(tiktok|instagram|youtube)--([a-z0-9][a-z0-9_-]{0,63})$/i.exec(name);
  if (!match) return null;
  const platform = match[1].toLowerCase() as PlatformKey;
  const accountId = validAccountId(match[2]);
  return accountId ? { platform, accountId } : null;
}
