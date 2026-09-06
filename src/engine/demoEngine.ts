import type {
  Candidate,
  EngineState,
  LogEntry,
  MetricCheck,
  Niche,
  Platform,
  PostRecord,
  Room,
} from "../lib/types";
import { compactNumber, seededStep, uid } from "../lib/format";
import { DEMO_CANDIDATES, DEMO_HOOKS } from "../data/demo";

/**
 * Demo engine — simulates the real worker's scheduler locally so the whole
 * product loop (hourly checks, 3000+ view trigger, 50k+ discovery, one post
 * per hour) can be explored before the Railway worker is connected.
 * Timings below are compressed; the worker enforces real hours.
 */
export const DEMO_FIRST_CHECK_MS = 16_000;
export const DEMO_SECOND_CHECK_MS = 95_000;
export const DEMO_CADENCE_MS = 45_000;
export const DEMO_PHASE_MS = 2_400;

/** Demo compresses one real hour into ~45s, so the slot window follows that. */
export function demoWindow(cadenceHours: number): number {
  return Math.min(cadenceHours * 3_600_000, DEMO_CADENCE_MS);
}

function seedOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function viewsAt(seed: number, ageMs: number): number {
  const base = seededStep(seed, 1.0, 0.6);
  const blow = seededStep(seed + 7, 1) > 0.82 ? 2.6 : 1;
  const ageSec = Math.max(1, ageMs / 1000);
  return Math.round(48 * base * blow * Math.pow(ageSec, 1.12));
}

function simMetrics(post: PostRecord, ageMs: number): MetricCheck {
  const seed = seedOf(post.id);
  const views = viewsAt(seed, ageMs);
  return {
    at: Date.now(),
    views,
    likes: Math.round(views * seededStep(seed + 3, 0.09, 0.05)),
    comments: Math.round(views * seededStep(seed + 5, 0.008, 0.004)),
  };
}

/* ------------------------------ candidates ------------------------------- */

export function discoverCandidates(
  engine: EngineState,
  niche: Niche,
  now: number
): { engine: Partial<EngineState>; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  const pool = DEMO_CANDIDATES.filter(
    (c) => c.niche === niche && c.likes >= engine.likesFloor
  );
  const sorted = [...pool].sort((a, b) => b.likes - a.likes);
  const candidates: Candidate[] = sorted.map((c, i) => {
    const ratio = c.likes / Math.max(1, c.views);
    const seeded = seededStep(seedOf(c.id) + i, 1);
    const captionDraft = `${DEMO_HOOKS[niche][i % DEMO_HOOKS[niche].length]}\n\n${
      niche === "facts"
        ? "#facts #didyouknow #learnontiktok"
        : niche === "scary"
          ? "#scary #creepy #storytime"
          : "#storytime #pov #viral"
    }`;
    const good = c.likes >= engine.likesFloor && ratio > 0.05 && seeded > 0.28;
    return {
      ...c,
      verdict: good ? "post" : "skip",
      reason: good
        ? `Comments are engaged (${compactNumber(c.comments)}) and the hook holds >95% of viewers.`
        : `Like/comment ratio ${(ratio * 100).toFixed(1)}% is under the quality bar — skipping.`,
      captionDraft,
    };
  });
  const goodCount = candidates.filter((c) => c.verdict === "post").length;
  logs.push(
    aiLog(
      `Discovery scan complete: ${candidates.length} faceless clips at 50K+ likes, “${niche}” niche. Groq reviewed captions + comment sentiment. ${goodCount} cleared the bar.`
    )
  );
  return { engine: { candidates }, logs };
}

/* ------------------------------- metric tick ------------------------------ */

function measureDue(room: Room, now: number): { posts: PostRecord[]; logs: LogEntry[] } {
  const logs: LogEntry[] = [];
  let changed = false;
  const posts = room.posts.map((p) => {
    const age = now - p.postedAt;
    const checks = p.checks;
    if (checks.length === 0 && age >= DEMO_FIRST_CHECK_MS) {
      changed = true;
      const m = simMetrics(p, age);
      const crossed = m.views >= room.engine.thresholdViews;
      const verdict = crossed
        ? `🔥 ${compactNumber(m.views)} views in the first hour — crossed the ${room.engine.thresholdViews.toLocaleString()} target. Engine doubles down on this format.`
        : `📉 ${compactNumber(m.views)} views in hour one — under the ${room.engine.thresholdViews.toLocaleString()} target. Keeping cadence, testing a fresh angle next.`;
      logs.push(
        aiLog(
          crossed
            ? `Post ${p.id.slice(-4)} read: ${compactNumber(m.views)} views / ${compactNumber(m.likes)} likes / ${compactNumber(m.comments)} comments in the first hour → TARGET HIT (≥${room.engine.thresholdViews.toLocaleString()}).`
            : `Post ${p.id.slice(-4)} read: ${compactNumber(m.views)} views in the first hour — below the ${room.engine.thresholdViews.toLocaleString()} trigger. Monitoring for one more window.`
        )
      );
      logs.push(
        crossed
          ? logEntry("ok", `🎯 Threshold crossed → “${room.engine.activeNiche}” niche unlocked for similar posts.`)
          : logEntry("info", `⏳ No trigger yet — next check in ~1h (simulated).`)
      );
      return { ...p, checks: [...checks, m], verdict };
    }
    if (checks.length === 1 && age >= DEMO_SECOND_CHECK_MS) {
      changed = true;
      const m = simMetrics(p, age);
      const first = checks[0];
      const delta = m.views - first.views;
      const verdict =
        delta > 0
          ? `Long-run read ${compactNumber(m.views)} views — ${compactNumber(delta)} since hour one. Momentum confirmed.`
          : `Final read ${compactNumber(m.views)} views — cooled off. Archived as a test.`;
      logs.push(
        aiLog(
          delta > 0
            ? `Post ${p.id.slice(-4)} keeps compounding (+${compactNumber(delta)} views). Groq flags it as a format winner.`
            : `Post ${p.id.slice(-4)} peaked early (+${compactNumber(Math.max(delta, 0))} since hour one). Logged for the angle library.`
        )
      );
      return { ...p, checks: [...checks, m], verdict };
    }
    return p;
  });
  return changed ? { posts, logs } : { posts: room.posts, logs };
}

/* ----------------------------- engine machine ----------------------------- */

export function engineTick(
  room: Room,
  now: number
): { engine: Partial<EngineState>; posts: PostRecord[] | null; logs: LogEntry[] } {
  const engine = room.engine;
  const { posts, logs } = measureDue(room, now);
  const enginePatch: Partial<EngineState> = {};

  if (!engine.running || engine.phase === "paused" || engine.phase === "error") {
    if (logs.length === 0) return { engine: {}, posts: posts !== room.posts ? posts : null, logs };
    return { engine: {}, posts: posts !== room.posts ? posts : null, logs };
  }

  const phaseSince = engine.lastRunAt ?? now;

  if (engine.phase === "analyzing") {
    if (now - phaseSince >= DEMO_PHASE_MS) {
      enginePatch.phase = "discovering";
      enginePatch.lastRunAt = now;
      enginePatch.message = `Analyzing account + algorithm… scanning “${engine.activeNiche}” feed for faceless winners.`;
      const next = nextNiche(engine);
      enginePatch.activeNiche = next;
      logs.push(
        aiLog(
          `Account analysis done. The algorithm is rewarding ${next} hooks with a ${engine.thresholdViews.toLocaleString()}+ view window — switching discovery to that niche.`
        )
      );
      const { engine: discPatch, logs: discLogs } = discoverCandidates(
        { ...engine, activeNiche: next },
        next,
        now
      );
      enginePatch.candidates = discPatch.candidates;
      logs.push(...discLogs);
    }
  } else if (engine.phase === "discovering") {
    if (now - phaseSince >= 1_600) {
      const best = pickBest(engine.candidates);
      if (best) {
        enginePatch.phase = "reviewing";
        enginePatch.lastRunAt = now;
        enginePatch.message = `Groq verdict: “${best.title.slice(0, 60)}…” → POST (${compactNumber(best.likes)} likes, comments verify quality).`;
        logs.push(
          aiLog(
            `Groq reviewed the shortlist. Best candidate: “${best.title}” — verdict ${best.verdict}, caption drafted.`
          )
        );
      } else {
        enginePatch.phase = "waiting";
        enginePatch.lastRunAt = now;
        enginePatch.message = "No candidate cleared the quality bar this hour — trying again next cycle.";
        logs.push(logEntry("warn", "No 50K+ candidate cleared review this cycle — nothing posted (quality first)."));
      }
    }
  } else if (engine.phase === "reviewing") {
    if (now - phaseSince >= 1_800) {
      const lastPost = room.posts[room.posts.length - 1];
      const slotFree = !lastPost || now - lastPost.postedAt >= demoWindow(engine.cadenceHours);
      const best = pickBest(engine.candidates);
      enginePatch.lastRunAt = now;
      if (slotFree && best && best.verdict === "post") {
        // Complete the AI post immediately (source: ai).
        const newPost = draftPost(
          room.platform,
          {
            url: best.url,
            caption: aiCaptionFor(best),
            niche: engine.activeNiche,
            source: "ai",
          },
          now
        );
        const base = posts !== room.posts ? posts : [...room.posts];
        const appended = [...base, newPost];
        enginePatch.phase = "waiting";
        enginePatch.nextRunAt = now + demoWindow(engine.cadenceHours);
        enginePatch.message = `Posted “${best.title.slice(0, 50)}…” — audience Everyone. Watching metrics; next check in 1h.`;
        logs.push(
          logEntry("ok", `📤 Auto-posted “${best.title.slice(0, 72)}…” — audience Everyone, 1 of 1 slot this hour.`)
        );
        return { engine: enginePatch, posts: appended, logs };
      } else if (!slotFree) {
        enginePatch.phase = "waiting";
        enginePatch.nextRunAt = now + demoWindow(engine.cadenceHours);
        enginePatch.message = "Hourly slot used — next auto-post scheduled.";
        logs.push(logEntry("info", "Hourly slot already used — next post in 1h (sim ~45s)."));
      } else {
        enginePatch.phase = "waiting";
        enginePatch.nextRunAt = now + demoWindow(engine.cadenceHours);
        enginePatch.message = "Waiting for a candidate that clears review.";
        logs.push(logEntry("info", "No post this cycle — quality bar holds. Re-checking in 1h."));
      }
    }
  } else if (engine.phase === "waiting") {
    const due = engine.nextRunAt !== null && now >= engine.nextRunAt;
    if (due) {
      enginePatch.phase = "analyzing";
      enginePatch.lastRunAt = now;
      enginePatch.message = "Hourly cycle — analyzing fresh data…";
      logs.push(logEntry("info", "🕐 Hourly check fired — analyzing account + scanning for new faceless content."));
    }
  }

  return {
    engine: enginePatch,
    posts: posts !== room.posts ? posts : null,
    logs,
  };
}

export function nextNiche(engine: EngineState): Niche {
  const enabled = engine.niches.length ? engine.niches : (["stories", "scary", "facts"] as Niche[]);
  const idx = Math.max(0, enabled.indexOf(engine.activeNiche));
  return enabled[(idx + 1) % enabled.length];
}

export function pickBest(candidates: Candidate[]): Candidate | undefined {
  const posts = candidates.filter((c) => c.verdict === "post");
  return (posts.length ? posts : candidates).sort((a, b) => b.likes - a.likes)[0];
}

/* ------------------------------ post helpers ------------------------------ */

export function draftPost(
  platform: Platform,
  opts: { url: string; caption: string; niche: Niche; source: "manual" | "ai" },
  now: number
): PostRecord {
  return {
    id: uid("post"),
    url: opts.url,
    caption: opts.caption,
    niche: opts.niche,
    source: opts.source,
    audience: "Everyone",
    postedAt: now,
    checks: [],
    verdict: null,
  };
}

export function consumeHourSlot(
  engine: EngineState,
  now: number
): Partial<EngineState> {
  const patch: Partial<EngineState> = {
    lastRunAt: now,
    nextRunAt: now + demoWindow(engine.cadenceHours),
  };
  if (engine.running) patch.phase = "waiting";
  return patch;
}

export function aiCaptionFor(candidate: Candidate): string {
  return candidate.captionDraft ?? "";
}
/* --------------------------------- logging -------------------------------- */

export function aiLog(text: string): LogEntry {
  return logEntry("ai", `🤖 ${text}`);
}

export function logEntry(level: LogEntry["level"], text: string): LogEntry {
  return { id: uid("log"), at: Date.now(), level, text };
}
