import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  ComposerState,
  EnginePhase,
  EngineState,
  LogEntry,
  ManagedAccount,
  Niche,
  Platform,
  PostRecord,
  Room,
  SessionState,
} from "../lib/types";
import { PLATFORMS, START_URL, type BrowserSession } from "../lib/types";
import type { EngineSnapshot } from "../lib/protocol";
import { uid } from "../lib/format";
import { accountNameTaken, accountRoomKey, cleanAccountName, withoutAccount } from "../lib/accounts";
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

function defaultRoom(platform: Platform, account?: Pick<ManagedAccount, "id" | "name">): Room {
  return {
    platform,
    ...(account ? { accountId: account.id, accountName: account.name } : {}),
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
      youtubeOAuthConfigured: false,
      youtubeOAuthConnected: false,
      youtubeOAuthError: null,
    },
    collapsed: false,
  };
}

function normalizeRoom(partial: Partial<Room>): Room {
  const platform = partial.platform ?? "tiktok";
  const d = defaultRoom(platform);
  const base: Room = {
    platform,
    ...(partial.accountId ? { accountId: partial.accountId } : {}),
    ...(partial.accountName ? { accountName: partial.accountName } : {}),
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

function emptyAccounts(): Record<Platform, ManagedAccount[]> {
  return { tiktok: [], instagram: [], youtube: [] };
}

function emptyActiveAccounts(): Record<Platform, string | null> {
  return { tiktok: null, instagram: null, youtube: null };
}

function meaningfulLegacyRoom(room: Room): boolean {
  return !!(
    room.session ||
    room.posts.length ||
    room.engine.running ||
    room.live.cookieAt ||
    room.live.wsUrl ||
    room.live.token ||
    room.composer.url.trim() ||
    room.composer.caption.trim() ||
    room.log.length > 2
  );
}

interface DeckState {
  /** The room currently open for each platform; blank while its account menu is up. */
  rooms: Record<Platform, Room>;
  accounts: Record<Platform, ManagedAccount[]>;
  accountRooms: Record<string, Room>;
  activeAccountIds: Record<Platform, string | null>;
  createAccount: (p: Platform, name: string) => { ok: boolean; error?: string; id?: string };
  deleteAccount: (p: Platform, accountId: string) => Promise<{ ok: boolean; error?: string }>;
  selectAccount: (p: Platform, accountId: string) => boolean;
  leaveAccount: (p: Platform) => void;
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
  applyLivePostOk: (p: Platform, url: string, requestId?: string) => void;
  /** Undo only the failed request's optimistic record and report its reason. */
  applyLivePostFailed: (p: Platform, message: string, requestId?: string) => void;
  // ---- logs / misc ----
  addLog: (p: Platform, entries: LogEntry[]) => void;
  tick: (now: number) => void;
  resetRoom: (p: Platform) => void;
}

export const useDeck = create<DeckState>()(
  persist(
    (set, get) => ({
      rooms: normalizeRooms(),
      accounts: emptyAccounts(),
      accountRooms: {},
      activeAccountIds: emptyActiveAccounts(),

      createAccount: (p, rawName) => {
        const name = cleanAccountName(rawName);
        if (!name) return { ok: false, error: "Give this account a name first." };
        if (accountNameTaken(get().accounts[p], name)) {
          return { ok: false, error: `An account named “${name}” already exists in ${p}.` };
        }
        let id = uid("acct");
        while (get().accounts[p].some((account) => account.id === id)) id = uid("acct");
        const account: ManagedAccount = { id, name, platform: p, createdAt: Date.now(), lastOpenedAt: null };
        const room = defaultRoom(p, account);
        set((s) => ({
          accounts: { ...s.accounts, [p]: [...s.accounts[p], account] },
          accountRooms: { ...s.accountRooms, [accountRoomKey(p, id)]: room },
        }));
        return { ok: true, id };
      },

      deleteAccount: async (p, accountId) => {
        const before = get();
        const account = before.accounts[p].find((item) => item.id === accountId);
        if (!account) return { ok: false, error: "That account no longer exists in this deck." };
        const key = accountRoomKey(p, accountId);
        const room = before.activeAccountIds[p] === accountId ? before.rooms[p] : before.accountRooms[key];
        const token = room?.live.token || "public";
        try {
          const response = await fetch("/api/accounts/delete", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body: JSON.stringify({ platform: p, accountId }),
          });
          const text = await response.text();
          let result: { ok?: unknown; deleted?: { platform?: unknown; accountId?: unknown }; error?: unknown } = {};
          try {
            result = JSON.parse(text) as typeof result;
          } catch {
            return { ok: false, error: `The worker returned an unreadable deletion response (HTTP ${response.status}).` };
          }
          if (!response.ok) {
            const message = typeof result.error === "string" ? result.error : `Worker answered HTTP ${response.status}.`;
            return {
              ok: false,
              error:
                response.status === 401
                  ? "The worker token is missing or wrong. Open this account, save the correct Worker token, then try Delete again."
                  : message,
            };
          }
          if (result.ok !== true || result.deleted?.platform !== p || result.deleted?.accountId !== accountId) {
            return { ok: false, error: "The worker did not confirm the exact account that was deleted." };
          }

          // Only a scope-matching server acknowledgement is allowed to erase the
          // menu tile and its local composer/history snapshot.
          disconnectLive(p, accountId);
          set((s) => {
            const records = withoutAccount(s.accounts, s.accountRooms, p, accountId);
            const wasActive = s.activeAccountIds[p] === accountId;
            return {
              ...records,
              ...(wasActive ? { rooms: { ...s.rooms, [p]: defaultRoom(p) } } : {}),
              activeAccountIds: wasActive
                ? { ...s.activeAccountIds, [p]: null }
                : s.activeAccountIds,
            };
          });
          return { ok: true };
        } catch (error) {
          return { ok: false, error: (error as Error).message || "Could not reach the worker to delete this account." };
        }
      },

      selectAccount: (p, accountId) => {
        const account = get().accounts[p].find((item) => item.id === accountId);
        if (!account) return false;
        const outgoingId = get().activeAccountIds[p];
        if (outgoingId) disconnectLive(p, outgoingId);
        set((s) => {
          const outgoingId = s.activeAccountIds[p];
          const saved = { ...s.accountRooms };
          if (outgoingId) {
            saved[accountRoomKey(p, outgoingId)] = {
              ...s.rooms[p],
              live: { ...s.rooms[p].live, connected: false },
            };
          }
          const key = accountRoomKey(p, account.id);
          const prior = normalizeRoom(saved[key] ?? defaultRoom(p, account));
          const session: BrowserSession = prior.session ?? {
            id: uid("ses"),
            platform: p,
            mode: "live",
            state: "connecting",
            url: START_URL[p],
            startedAt: Date.now(),
          };
          const room: Room = {
            ...prior,
            accountId: account.id,
            accountName: account.name,
            session,
            live: { ...prior.live, connected: false, lastError: null },
          };
          saved[key] = room;
          return {
            rooms: { ...s.rooms, [p]: room },
            accountRooms: saved,
            activeAccountIds: { ...s.activeAccountIds, [p]: account.id },
            accounts: {
              ...s.accounts,
              [p]: s.accounts[p].map((item) =>
                item.id === account.id ? { ...item, lastOpenedAt: Date.now() } : item
              ),
            },
          };
        });
        return true;
      },

      leaveAccount: (p) => {
        const outgoingId = get().activeAccountIds[p];
        if (outgoingId) disconnectLive(p, outgoingId);
        set((s) => {
          const accountId = s.activeAccountIds[p];
          const saved = { ...s.accountRooms };
          if (accountId) {
            saved[accountRoomKey(p, accountId)] = {
              ...s.rooms[p],
              live: { ...s.rooms[p].live, connected: false },
            };
          }
          return {
            rooms: { ...s.rooms, [p]: defaultRoom(p) },
            accountRooms: saved,
            activeAccountIds: { ...s.activeAccountIds, [p]: null },
          };
        });
      },

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
        const accountId = get().rooms[p].accountId ?? "default";
        disconnectLive(p, accountId);
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
        const accountId = room.accountId ?? "default";
        const c = room.composer;
        if (c.busy) return;
        const youtubeOAuth = p === "youtube" && room.live.youtubeOAuthConnected;
        if (!room.session || (room.session.state !== "logged-in" && !youtubeOAuth)) {
          get().setComposer(p, {
            error: p === "youtube"
              ? "Connect Google (or sign in inside the browser) first, then post."
              : "Log in first inside the browser, then come back and post.",
          });
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
          if (!isLiveConnected(p, room.accountId ?? "default")) {
            get().setComposer(p, { error: "Worker not connected — check the worker URL/token." });
            return;
          }
          const now = Date.now();
          const optimistic: PostRecord = draftPost(
            p,
            { url, caption: c.caption.trim() || "Posted via ViralDeck", niche: room.engine.activeNiche, source: "manual" },
            now
          );
          const ok = sendBusRaw(p, room.accountId ?? "default", {
            type: "post",
            url,
            caption: c.caption.trim() || "Posted via ViralDeck",
            requestId: optimistic.id,
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
            const timeoutError =
              "The worker has not answered in 8 minutes — the browser may be stuck on a challenge. Check the activity log.";
            const current = get();
            if (current.activeAccountIds[p] === accountId) {
              if (current.rooms[p].composer.busy) {
                current.setComposer(p, { busy: false, error: timeoutError });
              }
              return;
            }
            // The user may have switched from Personal to Brand while Personal's
            // publish was running. Update only Personal's hidden snapshot; a late
            // timer is never allowed to put its error on Brand's composer.
            set((s) => {
              const key = accountRoomKey(p, accountId);
              const saved = s.accountRooms[key];
              if (!saved?.composer.busy) return {};
              return {
                accountRooms: {
                  ...s.accountRooms,
                  [key]: { ...saved, composer: { ...saved.composer, busy: false, error: timeoutError } },
                },
              };
            });
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
          if (get().activeAccountIds[p] !== accountId) {
            // Demo work is local-only, so leaving its account cancels the fake
            // publish and clears only that account's hidden busy flag.
            set((s) => {
              const key = accountRoomKey(p, accountId);
              const saved = s.accountRooms[key];
              if (!saved) return {};
              return {
                accountRooms: {
                  ...s.accountRooms,
                  [key]: {
                    ...saved,
                    composer: { ...saved.composer, busy: false },
                    log: [...saved.log, logEntry("warn", "Demo publish canceled when this account was left.")].slice(-MAX_LOG),
                  },
                },
              };
            });
            return;
          }
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
        const youtubeOAuth = p === "youtube" && room.live.youtubeOAuthConnected;
        if (!room.session || (room.session.state !== "logged-in" && !youtubeOAuth)) {
          get().addLog(p, [
            logEntry(
              "warn",
              p === "youtube"
                ? "Start blocked — connect Google or sign in to YouTube in this account browser first."
                : "Start blocked — log in to the platform in the browser first (demo: tap Log in)."
            ),
          ]);
          return;
        }
        if (room.session.mode === "live") {
          if (!isLiveConnected(p, room.accountId ?? "default")) {
            get().addLog(p, [logEntry("err", "Worker not connected — connect it in the Worker card first.")]);
            return;
          }
          sendBusRaw(p, room.accountId ?? "default", { type: "engine", action: "start" });
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
          sendBusRaw(p, room.accountId ?? "default", { type: "engine", action: "stop" });
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
          const optimistic = room.composer.lastPostedId
            ? posts.find((post) => post.id === room.composer.lastPostedId)
            : undefined;
          const lastIsOptimistic = !!(
            optimistic &&
            last &&
            last.source === "manual" &&
            last.requestId === optimistic.id &&
            optimistic.url === last.sourceUrl &&
            optimistic.caption === last.caption
          );
          if (last) {
            const idx = posts.findIndex(
              (pr) =>
                (pr.url === last.url || (!!last.sourceUrl && pr.url === last.sourceUrl)) &&
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
          let composer = room.composer;
          if (snap.manualBusy === false && room.composer.busy) {
            if (optimistic && !lastIsOptimistic) {
              posts = posts.filter((post) => post.id !== optimistic.id);
            }
            composer = {
              ...room.composer,
              busy: false,
              lastPostedId: null,
              error: lastIsOptimistic
                ? null
                : room.composer.error || "The worker is no longer publishing this request; no success receipt was returned.",
            };
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
                composer,
                posts,
              },
            },
          };
        });
      },

      applyLivePostFailed: (p, message, requestId) => {
        set((s) => {
          const room = s.rooms[p];
          // `post-failed` is manual-only, so an older worker without correlation
          // can safely fall back to the one current manual placeholder.
          const failedId = requestId ?? room.composer.lastPostedId ?? undefined;
          const isCurrent = !!failedId && room.composer.lastPostedId === failedId;
          return {
            rooms: {
              ...s.rooms,
              [p]: {
                ...room,
                // A history entry for a video that was never published is worse
                // than no feedback. The request id prevents a late failure from
                // deleting a newer account-local publish.
                posts: failedId ? room.posts.filter((post) => post.id !== failedId) : room.posts,
                composer: isCurrent
                  ? { ...room.composer, busy: false, error: message, lastPostedId: null }
                  : room.composer,
              },
            },
          };
        });
      },

      applyLivePostOk: (p, url, requestId) => {
        set((s) => {
          const room = s.rooms[p];
          const isCurrent = !!requestId && room.composer.lastPostedId === requestId;
          return {
            rooms: {
              ...s.rooms,
              [p]: {
                ...room,
                // Only the matching manual placeholder can receive this receipt.
                // Auto-publish events intentionally have no request id and cannot
                // clear or relabel a manual operation that happens at the same time.
                posts:
                  requestId && url
                    ? room.posts.map((post) => (post.id === requestId ? { ...post, url } : post))
                    : room.posts,
                composer: isCurrent
                  ? { ...room.composer, busy: false, error: null, lastPostedId: null }
                  : room.composer,
                log: [
                  ...room.log,
                  logEntry(
                    "ok",
                    `✅ ${requestId ? "Live" : "Automatic"} publish confirmed${url ? ` — ${url.slice(0, 72)}` : ""} · audience Everyone.`
                  ),
                ].slice(-MAX_LOG),
              },
            },
          };
        });
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
        set((s) => {
          const id = s.activeAccountIds[p];
          const account = id ? s.accounts[p].find((item) => item.id === id) : undefined;
          return { rooms: { ...s.rooms, [p]: defaultRoom(p, account) } };
        });
      },
    }),
    {
      name: "viraldeck-v1",
      partialize: (s) => {
        // The open room is fresher than its menu snapshot. Overlay it at write
        // time so a refresh never loses a caption, post receipt or engine state.
        const accountRooms = { ...s.accountRooms };
        for (const platform of PLATFORMS) {
          const accountId = s.activeAccountIds[platform];
          if (!accountId) continue;
          accountRooms[accountRoomKey(platform, accountId)] = {
            ...s.rooms[platform],
            live: { ...s.rooms[platform].live, connected: false },
          };
        }
        return { accounts: s.accounts, accountRooms };
      },
      merge: (persisted, current) => {
        const raw = persisted as
          | {
              rooms?: Partial<Record<Platform, Partial<Room>>>;
              accounts?: Partial<Record<Platform, ManagedAccount[]>>;
              accountRooms?: Record<string, Partial<Room>>;
            }
          | undefined;
        const accounts = emptyAccounts();
        const accountRooms: Record<string, Room> = {};
        for (const platform of PLATFORMS) {
          const candidateAccounts = raw?.accounts?.[platform];
          const seenIds = new Set<string>();
          const listed = (Array.isArray(candidateAccounts) ? candidateAccounts : [])
            .filter((account): account is ManagedAccount => {
              if (
                !account ||
                typeof account !== "object" ||
                typeof account.id !== "string" ||
                !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(account.id) ||
                seenIds.has(account.id)
              ) {
                return false;
              }
              seenIds.add(account.id);
              return true;
            })
            .map((account) => ({
              ...account,
              name: cleanAccountName(typeof account.name === "string" ? account.name : "") || "Account",
              platform,
              createdAt: Number.isFinite(account.createdAt) ? account.createdAt : Date.now(),
              lastOpenedAt: Number.isFinite(account.lastOpenedAt) ? account.lastOpenedAt : null,
            }));
          accounts[platform] = listed;
          for (const account of listed) {
            const key = accountRoomKey(platform, account.id);
            accountRooms[key] = normalizeRoom({
              ...(raw?.accountRooms?.[key] ?? defaultRoom(platform, account)),
              platform,
              accountId: account.id,
              accountName: account.name,
            });
          }

          // One-time migration: the pre-account app had one persistent profile
          // per platform. Put it behind an account tile without moving its disk
          // profile, cookies, posts or running-engine state.
          if (!listed.length && raw?.rooms?.[platform]) {
            const legacy = normalizeRoom(raw.rooms[platform] as Partial<Room>);
            if (meaningfulLegacyRoom(legacy)) {
              const account: ManagedAccount = {
                id: "default",
                name: `Existing ${platform === "youtube" ? "YouTube" : platform[0].toUpperCase() + platform.slice(1)} account`,
                platform,
                createdAt: legacy.session?.startedAt ?? Date.now(),
                lastOpenedAt: null,
              };
              accounts[platform] = [account];
              accountRooms[accountRoomKey(platform, account.id)] = {
                ...legacy,
                accountId: account.id,
                accountName: account.name,
                live: { ...legacy.live, connected: false },
              };
            }
          }
        }
        return {
          ...current,
          rooms: normalizeRooms(),
          accounts,
          accountRooms,
          activeAccountIds: emptyActiveAccounts(),
        };
      },
    }
  )
);

/** A fresh candidate pool used by the demo "seed" helpers in the UI. */
export function demoSeedCandidates(): typeof DEMO_CANDIDATES {
  return DEMO_CANDIDATES;
}
