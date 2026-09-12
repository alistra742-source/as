import { HOUR_MS } from "./config.js";

/**
 * The scheduler wakes often enough that a due hourly cycle starts promptly, but
 * the slot boundary itself is always derived from the confirmed publication
 * timestamp rather than from an interval tick or an analysis start.
 */
export const ENGINE_LOOP_TICK_MS = 10_000;
export const DISCOVERY_RETRY_MAX_MS = 5 * 60_000;

/** Before the first confirmed post, transient empty/rejected searches retry soon. */
export function discoveryRetryMs(failedPasses: number): number {
  const attempts = Number.isFinite(failedPasses) ? Math.max(1, Math.floor(failedPasses)) : 1;
  return Math.min(DISCOVERY_RETRY_MAX_MS, attempts * 60_000);
}

export function initialEngineRunAt(startedAt: number): number {
  return startedAt;
}

export function cadenceDurationMs(cadenceHours: number): number {
  const hours = Number.isFinite(cadenceHours) ? cadenceHours : 1;
  return Math.max(1, hours) * HOUR_MS;
}

/** The next slot opens exactly one configured cadence after a success receipt. */
export function nextConfirmedPostAt(postedAt: number, cadenceHours: number): number {
  return postedAt + cadenceDurationMs(cadenceHours);
}

/**
 * Metrics are read no earlier than a full hour after publication, then no
 * earlier than another full hour after the preceding read.
 */
export function metricsReadDue(postedAt: number, lastCheckAt: number | null, at: number): boolean {
  const anchor = lastCheckAt ?? postedAt;
  return at >= anchor + HOUR_MS;
}

export function latestConfirmedPostAt(posts: ReadonlyArray<{ postedAt: number }>): number | null {
  let latest: number | null = null;
  for (const post of posts) {
    if (!Number.isFinite(post.postedAt)) continue;
    if (latest === null || post.postedAt > latest) latest = post.postedAt;
  }
  return latest;
}
