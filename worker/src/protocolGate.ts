export type ProtocolAccess = "current" | "growth-only" | "reject";

/**
 * Protocol v12 has the same wire schema as v13, but its Growth Start button
 * incorrectly emits a composer publish immediately before `engine start`.
 * It can therefore be supported safely only when composer publish commands are
 * refused server-side. Older/future schemas remain fail-closed.
 */
export function protocolAccess(deckVersion: unknown, workerVersion: number): ProtocolAccess {
  if (deckVersion === workerVersion) return "current";
  if (workerVersion === 13 && deckVersion === 12) return "growth-only";
  return "reject";
}
