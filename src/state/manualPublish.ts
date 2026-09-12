import type { EngineSnapshot, ManualPublishResult } from "../lib/protocol";

export type ManualSnapshotResolution =
  | { state: "pending" }
  | { state: "succeeded"; postId?: string; postedAt?: number; url?: string }
  | { state: "failed"; message: string };

/**
 * Reconcile one account-local publish request with a worker snapshot.
 *
 * `manualBusy` by itself is deliberately not evidence. A snapshot can already be
 * in the WebSocket receive buffer when the user presses Post, so an old `false`
 * is allowed to arrive after the optimistic local row exists. Only evidence that
 * names this exact request may settle it.
 */
export function resolveManualSnapshot(
  requestId: string | null | undefined,
  snapshot: Pick<EngineSnapshot, "manualRequestId" | "manualResult" | "lastPost">
): ManualSnapshotResolution {
  if (!requestId) return { state: "pending" };

  const last = snapshot.lastPost;
  if (last?.requestId === requestId) {
    return {
      state: "succeeded",
      postId: last.id,
      postedAt: last.postedAt,
      url: last.url,
    };
  }

  const result: ManualPublishResult | null = snapshot.manualResult;
  if (!result || result.requestId !== requestId || result.status === "accepted") {
    return { state: "pending" };
  }
  if (result.status === "failed") return { state: "failed", message: result.message };
  return {
    state: "succeeded",
    postId: result.postId,
    postedAt: result.postedAt,
    url: result.url,
  };
}
