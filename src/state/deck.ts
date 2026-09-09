import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ComposerState,
  EnginePhase,
  EngineState,
  LogEntry,
  Niche,
  Platform,
  PostRecord,
  Room,
  SessionState,
} from "../lib/types";
import { PLATFORMS, START_URL, type BrowserSession } from "../lib/types";
import type { EngineSnapshot } from "../lib/protocol";
import { uid } from "../lib/format";
import { disconnectLive, isLiveConnected, sendBusRaw } from "../lib/liveBus";
import { DEMO_CANDIDATES } from "../data/demo";
import {
  aiLog,
  consumeHourSlot,
  discoverCandidates,
  draftPost,
  engineTick,
  logEntry,
  pickBest,
} from "../engine/demoEngine";

export const MAX_LOG = 400;
export const MAX_POSTS = 120;

function freshEngine(): EngineState {
  return {
    running: false,
    phase: "idle",
    thresholdViews: 3000,
    likesFloor: 50_000,
    cadenceHours: 1,
    activeNiche: "stories",
    niches: ["stories", "scary", "facts"],
    nextRunAt: null,
    lastRunAt: null,
    message: null,
    candidates: [],
  };
}

function freshComposer(): ComposerState {
  return { url: "", caption: "", busy: false, error: null, lastPostedId: null };
}

function freshLog(platform: Platform): LogEntry[] {
  const lines: string[] =
    platform === "tiktok"
      ? [
          "Deck online — TikTok room ready.",
          "Open a browser session, log in, then press Start to launch the growth engine.",
        ]        : platform === "instagram"
          ? [
              "Deck online — Instagram room ready.",
              "Open a browser session (starts on Google), log in, then press Start.",
            ]
          : [
              "Deck online — YouTube room ready.",
              "Open a browser session, sign in with your Google account, then press Start.",
            ];
  return lines.map((text) => logEntry("info", text));
}

function defaultRoom(platform: Platform): Room {
  return {
    platform,
    session: null,
    composer: freshComposer(),
    engine: freshEngine(),
    posts: [],
    log: freshLog(platform),
    live: {
      wsUrl: "",
      token: "",
      connected: false,
      lastError: null,
      cookieAt: null,
      cookieNames: [],
      cookieExpiresAt: null,
    },
    collapsed: false,
  };
}

function normalizeRoom(partial: Partial<Room>): Room {
  const platform = partial.platform ?? "tiktok";
  const d = defaultRoom(platform);
  const base: Room = {
    platform,
    session: partial.session
      ? { ...d.session!, ...partial.session }
      : null,
    composer: { ...d.composer, ...(partial.composer ?? {}) },
    engine: { ...d.engine, ...(partial.engine ?? {}) },
    posts: partial.posts ?? [],
    log: partial.log && partial.log.length > 0 ? partial.log : d.log,
    live: { ...d.live, ...(partial.live ?? {}) },
    collapsed: partial.collapsed ?? false,
  };
  return base;
}

function normalizeRooms(rooms?: Partial<Record<Platform, Partial<Room>>>): Record<Platform, Room> {
  const out = {} as Record<Platform, Room>;
  for (const p of PLATFORMS) {
    out[p] = normalizeRoom(rooms?.[p] ?? { platform: p });
  }
  return out;
}

interface DeckState {
  rooms: Record<Platform, Room>;
  // ---- session / browser ----
  openDemoSession: (p: Platform) => void;
  openLiveSession: (p: Platform) => boolean;
  closeSession: (p: Platform) => void;
  setSession: (p: Platform, patch: Partial<BrowserSession>) => void;
  markDemoLoggedIn: (p: Platform) => void;
  // ---- composer ----
  setComposer: (p: Platform, patch: Partial<ComposerState>) => void;
  postNow: (p: Platform) => void;
  finishPost: (
    p: Platform,
    post: PostRecord,
    logs: LogEntry[],
    enginePatch?: Partial<EngineState>
  ) => void;
  // ---- engine ----
  startEngine: (p: Platform) => void;
  stopEngine: (p: Platform) => void;
  updateEngine: (p: Platform, patch: Partial<EngineState>) => void;
  toggleNiche: (p: Platform, niche: Niche) => void;
  // ---- live ----
  setLive: (p: Platform, patch: Partial<Room["live"]>) => void;
  applyLiveEngine: (p: Platform, snap: EngineSnapshot) => void;
  applyLivePostOk: (p: Platform, url: string) => void;
  /** Undo the optimistic post record and put the reason on the composer. */
  applyLivePostFailed: (p: Platform, message: string) => void;
  // ---- logs / misc ----
  addLog: (p: Platform, entries: LogEntry[]) => void;
  tick: (now: number) => void;
  resetRoom: (p: Platform) => void;
}

export const useDeck = create<DeckState>()(
  persist(
    (set, get) => ({
      rooms: normalizeRooms(),

      openDemoSession: (p) => {
        const room = get().rooms[p];
        if (room.session) return;
        const session: BrowserSession = {
          id: uid("ses"),
          platform: p,
          mode: "demo",
          state: "open",
          url: START_URL[p],
          startedAt: Date.now(),
        };
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: {
              ...s.rooms[p],
              session,
              log:            [
              ...s.rooms[p].log,
              logEntry(
                "info",
                p === "instagram"
                  ? "Demo browser online → opened google.com. Log in via Google or the app, then Start."
                  : p === "youtube"
                    ? "Demo browser online → opened youtube.com. Sign in with your Google account, then Start."
                    : "Demo browser online → opened tiktok.com. Log in with your account, then Start."
              ),
            ].slice(-MAX_LOG),
            },
          },
        }));
      },

      openLiveSession: (p) => {
        const room = get().rooms[p];
        if (room.session) return false;
        // Empty Worker card is fine: the live bus falls back to the same-origin
        // /ws endpoint (single-service deploy).
        const session: BrowserSession = {
          id: uid("ses"),
          platform: p,
          mode: "live",
          state: "connecting",
          url: START_URL[p],
          startedAt: Date.now(),
        };
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: {
              ...s.rooms[p],
              session,
              log: [
                ...s.rooms[p].log,
                logEntry("info", "Live browser requested — connecting to the browser backend…"),
              ].slice(-MAX_LOG),
            },
          },
        }));
        return true;
      },

      closeSession: (p) => {
        disconnectLive(p);
        set((s) => {
          const room = s.rooms[p];
          return {
            rooms: {
              ...s.rooms,
              [p]: {
                ...room,
                session: null,
                engine: { ...room.engine, running: false, phase: "idle", nextRunAt: null },
                log: [...room.log, logEntry("warn", "Browser session closed.")].slice(-MAX_LOG),
              },
            },
          };
        });
      },

      setSession: (p, patch) => {
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: s.rooms[p].session
              ? { ...s.rooms[p], session: { ...s.rooms[p].session!, ...patch } }
              : s.rooms[p],
          },
        }));
      },

      markDemoLoggedIn: (p) => {
        const room = get().rooms[p];
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: {
              ...s.rooms[p],
              session: s.rooms[p].session
                ? { ...s.rooms[p].session!, state: "logged-in" as SessionState }
                : s.rooms[p].session,
              log: [
                ...room.log,
                logEntry(
                  "ok",
                  p === "tiktok"
                    ? "Logged in to TikTok (demo session)."
                    : p === "youtube"
                      ? "Signed in to YouTube (demo session)."
                      : "Logged in to Instagram (demo session)."
                ),
              ].slice(-MAX_LOG),
            },
          },
        }));
      },

      setComposer: (p, patch) => {
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: { ...s.rooms[p], composer: { ...s.rooms[p].composer, ...patch } },
          },
        }));
      },

      postNow: (p) => {
        const room = get().rooms[p];
        const c = room.composer;
        if (c.busy) return;
        if (!room.session || room.session.state !== "logged-in") {
          get().setComposer(p, { error: "Log in first inside the browser, then come back and post." });
          return;
        }

        // Live mode: hand the publish to the Railway worker's real browser.
        if (room.session.mode === "live") {
          const url = c.url.trim();
          if (!url) {
            get().setComposer(p, {
              error: "Live manual posts need a video link. (AI auto-posting runs on the engine's hourly schedule.)",
            });
            return;
          }
          if (!isLiveConnected(p)) {
            get().setComposer(p, { error: "Worker not connected — check the worker URL/token." });
            return;
          }
          const now = Date.now();
          const optimistic: PostRecord = draftPost(
            p,
            { url, caption: c.caption.trim() || "Posted via ViralDeck", niche: room.engine.activeNiche, source: "manual" },
            now
          );
          const ok = sendBusRaw(p, {
            type: "post",
            url,
            caption: c.caption.trim() || "Posted via ViralDeck",
          });
          if (!ok) {
            get().setComposer(p, { error: "Worker socket not open yet — try again in a second." });
            return;
          }
          get().setComposer(p, { busy: true, error: null, lastPostedId: optimistic.id });
          set((s) => ({
            rooms: {
              ...s.rooms,
              [p]: {
                ...s.rooms[p],
                posts: [...s.rooms[p].posts, optimistic].slice(-MAX_POSTS),
                log: [
                  ...s.rooms[p].log,
                  logEntry("info", `📤 Sending publish to the live browser — caption “${c.caption.trim() || "Posted via ViralDeck"}”, audience Everyone.`),
                ].slice(-MAX_LOG),
              },
            },
          }));
          // Busy stays on until the worker answers (post-ok / post-failed) — a real
          // grab + TikTok's processing checks can run for several minutes, and a
          // spinner that stops on its own timer is what makes a working publish
          // look like nothing happened. This timer only exists so a dead socket
          // cannot lock the panel forever.
          window.setTimeout(() => {
            if (get().rooms[p].composer.busy) {
              get().setComposer(p, {
                busy: false,
                error: "The worker has not answered in 8 minutes — the browser may be stuck on a challenge. Check the activity log.",
              });
            }
          }, 480_000);
          return;
        }

        const url = c.url.trim();
        if (!url && !c.caption.trim()) {
          get().setComposer(p, { error: "Paste a video link, or leave both empty and the AI will find + post a video for you." });
          return;
        }
        get().setComposer(p, { busy: true, error: null });

        window.setTimeout(() => {
          const fresh = get().rooms[p];
          const now = Date.now();
          const niche = fresh.engine.activeNiche;
          const logs: LogEntry[] = [];

          if (url) {
            const post = draftPost(p, {
              url,
              caption: c.caption.trim() || "Posted via ViralDeck",
              niche,
              source: "manual",
            }, now);
            logs.push(
              logEntry("ok", `📤 Posted “${url.length > 64 ? url.slice(0, 64) + "…" : url}” — caption "${c.caption.trim() || "Posted via ViralDeck"}", audience Everyone.`)
            );
            logs.push(aiLog(`Manual post logged. Groq will read its first-hour performance and adjust the next discovery pass.`));
            get().finishPost(p, post, logs, consumeHourSlot(fresh.engine, now));
            get().setComposer(p, { busy: false, lastPostedId: post.id });
          } else {
            // AI find-and-post path (no manual link provided).
            logs.push(aiLog("No manual link — running AI discovery: faceless clips at 50K+ likes, comments reviewed for quality."));
            const { engine: disc } = discoverCandidates(fresh.engine, niche, now);
            const best = pickBest(disc.candidates ?? []);
            if (best && best.verdict === "post") {
              const post = draftPost(p, {
                url: best.url,
                caption: c.caption.trim() || best.captionDraft || "Posted via ViralDeck",
                niche,
                source: "ai",
              }, now);
              logs.push(
                logEntry("ok", `📤 AI pick passed review → posted “${best.title.slice(0, 64)}…” — caption ready, audience Everyone.`)
              );
              get().finishPost(p, post, logs, consumeHourSlot(fresh.engine, now));
              get().setComposer(p, { busy: false, lastPostedId: post.id });
            } else {
              logs.push(logEntry("warn", "Discovery found nothing above the 50K quality bar this cycle — nothing posted."));
              get().addLog(p, logs);
              get().setComposer(p, { busy: false });
            }
          }
        }, 1100);
      },

      finishPost: (p, post, logs, enginePatch) => {
        set((s) => {
          const room = s.rooms[p];
          const engine = enginePatch ? { ...room.engine, ...enginePatch } : room.engine;
          return {
            rooms: {
              ...s.rooms,
              [p]: {
                ...room,
                posts: [...room.posts, post].slice(-MAX_POSTS),
                engine,
                log: [...room.log, ...logs].slice(-MAX_LOG),
              },
            },
          };
        });
      },

      startEngine: (p) => {
        const room = get().rooms[p];
        if (room.engine.running) return;
        if (!room.session || room.session.state !== "logged-in") {
          get().addLog(p, [
            logEntry("warn", "Start blocked — log in to the platform in the browser first (demo: tap Log in)."),
          ]);
          return;
        }
        if (room.session.mode === "live") {
          if (!isLiveConnected(p)) {
            get().addLog(p, [logEntry("err", "Worker not connected — connect it in the Worker card first.")]);
            return;
          }
          sendBusRaw(p, { type: "engine", action: "start" });
          set((s) => ({
            rooms: {
              ...s.rooms,
              [p]: {
                ...s.rooms[p],
                engine: {
                  ...s.rooms[p].engine,
                  running: true,
                  phase: "waiting",
                  message: "Engine start requested — worker is waking its browser…",
                },
              },
            },
          }));
          return;
        }
        const now = Date.now();
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: {
              ...s.rooms[p],
              engine: {
                ...s.rooms[p].engine,
                running: true,
                phase: "analyzing",
                lastRunAt: now,
                nextRunAt: null,
                message: "Analyzing account, audience and the algorithm…",
              },
              log: [
                ...s.rooms[p].log,
                aiLog("Engine armed. Watching account + algorithm, scanning faceless content, posting 1×/hour on Everyone."),
              ].slice(-MAX_LOG),
            },
          },
        }));
      },

      stopEngine: (p) => {
        const room = get().rooms[p];
        if (room.session?.mode === "live") {
          sendBusRaw(p, { type: "engine", action: "stop" });
        }
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: {
              ...s.rooms[p],
              engine: { ...s.rooms[p].engine, running: false, phase: "paused", message: "Engine paused." },
              log: [...s.rooms[p].log, logEntry("warn", "Engine paused — no posts or checks until resumed.")].slice(-MAX_LOG),
            },
          },
        }));
      },

      updateEngine: (p, patch) => {
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: { ...s.rooms[p], engine: { ...s.rooms[p].engine, ...patch } },
          },
        }));
      },

      toggleNiche: (p, niche) => {
        set((s) => {
          const engine = s.rooms[p].engine;
          const has = engine.niches.includes(niche);
          const niches = has ? engine.niches.filter((n) => n !== niche) : [...engine.niches, niche];
          if (niches.length === 0) return { rooms: s.rooms };
          return {
            rooms: {
              ...s.rooms,
              [p]: { ...s.rooms[p], engine: { ...engine, niches } },
            },
          };
        });
      },

      setLive: (p, patch) => {
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: { ...s.rooms[p], live: { ...s.rooms[p].live, ...patch } },
          },
        }));
      },

      applyLiveEngine: (p, snap) => {
        set((s) => {
          const room = s.rooms[p];
          const session = room.session
            ? { ...room.session, state: (snap.loggedIn ? "logged-in" : "open") as SessionState }
            : room.session;
          const phase = (["idle", "analyzing", "discovering", "reviewing", "posting", "waiting", "paused", "error"] as const).includes(
            snap.phase as EnginePhase
          )
            ? (snap.phase as EnginePhase)
            : "idle";
          let posts = room.posts;
          const last = snap.lastPost;
          if (last) {
            const idx = posts.findIndex(
              (pr) =>
                pr.url === last.url &&
                pr.caption === last.caption &&
                Math.abs(pr.postedAt - last.postedAt) < 6 * 3_600_000
            );
            const rec: PostRecord = {
              id: last.id,
              url: last.url,
              caption: last.caption,
              niche: last.niche as Niche,
              source: last.source,
              audience: "Everyone",
              postedAt: last.postedAt,
              checks: [{ at: Date.now(), views: last.views, likes: last.likes, comments: last.comments }],
              verdict: last.verdict,
            };
            if (idx >= 0) {
              posts = posts.map((pr, i) => (i === idx ? { ...rec, id: pr.id } : pr));
            } else {
              posts = [...posts, rec].slice(-MAX_POSTS);
            }
          }
          return {
            rooms: {
              ...s.rooms,
              [p]: {
                ...room,
                session,
                engine: {
                  ...room.engine,
                  running: snap.running,
                  phase: snap.running ? phase : phase === "paused" ? "paused" : "idle",
                  nextRunAt: snap.nextRunAt,
                  lastRunAt: snap.lastRunAt,
                  message: snap.message ?? room.engine.message,
                  cadenceHours: snap.cadenceHours,
                  thresholdViews: snap.thresholdViews,
                  likesFloor: snap.likesFloor,
                },
                posts,
              },
            },
          };
        });
      },

      applyLivePostFailed: (p, message) => {
        const c = get().rooms[p].composer;
        if (c.lastPostedId) {
          // The placeholder `postNow` inserted has to go back out: a history entry
          // for a video that was never published is worse than no feedback at all,
          // and it would be measured for metrics forever.
          const id = c.lastPostedId;
          set((s) => {
            const room = s.rooms[p];
            return { rooms: { ...s.rooms, [p]: { ...room, posts: room.posts.filter((x) => x.id !== id) } } };
          });
        }
        get().setComposer(p, { busy: false, error: message, lastPostedId: null });
      },

      applyLivePostOk: (p, url) => {
        const optimisticId = get().rooms[p].composer.lastPostedId;
        if (url && optimisticId) {
          // The optimistic row starts with the source link. Once the worker has a
          // destination URL, replace it so history/metrics never call the source
          // video our live upload.
          set((s) => {
            const room = s.rooms[p];
            return {
              rooms: {
                ...s.rooms,
                [p]: {
                  ...room,
                  posts: room.posts.map((post) => (post.id === optimisticId ? { ...post, url } : post)),
                },
              },
            };
          });
        }
        get().setComposer(p, { busy: false, error: null, lastPostedId: null });
        get().addLog(p, [
          logEntry("ok", `✅ Live publish confirmed${url ? ` — ${url.slice(0, 72)}` : ""} · audience Everyone.`),
        ]);
      },

      addLog: (p, entries) => {
        set((s) => ({
          rooms: {
            ...s.rooms,
            [p]: { ...s.rooms[p], log: [...s.rooms[p].log, ...entries].slice(-MAX_LOG) },
          },
        }));
      },

      tick: (now) => {
        const rooms = get().rooms;
        for (const p of PLATFORMS) {
          const room = rooms[p];
          if (!room.session || room.session.mode !== "demo") continue;
          const res = engineTick(room, now);
          if (res.logs.length === 0 && Object.keys(res.engine).length === 0 && !res.posts) continue;
          set((s) => {
            const cur = s.rooms[p];
            return {
              rooms: {
                ...s.rooms,
                [p]: {
                  ...cur,
                  engine: { ...cur.engine, ...res.engine },
                  posts: res.posts ?? cur.posts,
                  log: [...cur.log, ...res.logs].slice(-MAX_LOG),
                },
              },
            };
          });
        }
      },

      resetRoom: (p) => {
        set((s) => ({
          rooms: { ...s.rooms, [p]: defaultRoom(p) },
        }));
      },
    }),
    {
      name: "viraldeck-v1",
      partialize: (s) => ({ rooms: s.rooms }),
      merge: (persisted, current) => {
        const p = persisted as { rooms?: Partial<Record<Platform, Partial<Room>>> } | undefined;
        return { ...current, rooms: normalizeRooms(p?.rooms) };
      },
    }
  )
);

/** A fresh candidate pool used by the demo "seed" helpers in the UI. */
export function demoSeedCandidates(): typeof DEMO_CANDIDATES {
  return DEMO_CANDIDATES;
}
