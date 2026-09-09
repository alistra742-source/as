import type { ManagedAccount, Platform, Room } from "./types";

export function accountRoomKey(platform: Platform, accountId: string): string {
  return `${platform}:${accountId}`;
}

export function cleanAccountName(value: string): string {
  return (value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

export function accountNameTaken(accounts: ManagedAccount[], rawName: string): boolean {
  const name = cleanAccountName(rawName).toLocaleLowerCase();
  return !!name && accounts.some((account) => account.name.toLocaleLowerCase() === name);
}

/** Destination authentication: browser login on every platform, or the official
 * per-account Google upload grant for YouTube. */
export function roomAuthenticated(room: Room | null | undefined): boolean {
  return !!(
    room &&
    (room.session?.state === "logged-in" ||
      (room.platform === "youtube" && room.live.youtubeOAuthConnected))
  );
}

/** Resolve a card to its freshest room (the open room wins over its saved copy). */
export function roomForAccount(
  platform: Platform,
  account: ManagedAccount,
  activeAccountId: string | null,
  activeRoom: Room,
  saved: Record<string, Room>
): Room | null {
  return activeAccountId === account.id
    ? activeRoom
    : saved[accountRoomKey(platform, account.id)] ?? null;
}
