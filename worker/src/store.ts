import fs from "node:fs";
import path from "node:path";
import { accountDataDir, LEGACY_ACCOUNT_ID } from "./accountScope.js";
import { env, type EnginePhase, type PlatformKey } from "./config.js";
import type { ManualPublishResult } from "./protocol.js";

export interface MetricCheck {
  at: number;
  views: number;
  likes: number;
  comments: number;
}

export interface WorkerPost {
  id: string;
  /** Confirmed destination URL when the studio exposes it. */
  url: string;
  /** Original clip page; kept separately so it is never presented as the live post. */
  sourceUrl?: string;
  /** Opaque frontend publish request used to reconcile after a reconnect. */
  requestId?: string;
  caption: string;
  niche: string;
  topic?: string;
  source: "manual" | "ai";
  audience: "Everyone";
  postedAt: number;
  checks: MetricCheck[];
  verdict: string | null;
}

export interface EngineRec {
  running: boolean;
  phase: EnginePhase;
  nextRunAt: number | null;
  lastRunAt: number | null;
  message: string | null;
  cadenceHours: number;
  thresholdViews: number;
  likesFloor: number;
  niche: string;
  /** Exact account-local search phrase. Blank keeps the built-in niche cycle. */
  topic: string;
  /** Correlated manual/discovery acknowledgement survives socket reconnects and restarts. */
  manualResult: ManualPublishResult | null;
  errorCount: number;
}

export interface RigRec {
  loggedIn: boolean;
  profile: string | null;
  /**
   * A session cookie pasted into the deck, if one is installed: when, which
   * names, and when the site will stop accepting it. Only that — never the
   * value. The jar itself is the browser profile's, and that is the only place
   * a session secret should sit in this app.
   */
  cookieAt: number | null;
  cookieNames: string[];
  cookieExpiresAt: number | null;
}

interface DataFile {
  rigs: Record<PlatformKey, RigRec>;
  posts: Record<PlatformKey, WorkerPost[]>;
  engines: Record<PlatformKey, EngineRec>;
}

function blankRig(): RigRec {
  return { loggedIn: false, profile: null, cookieAt: null, cookieNames: [], cookieExpiresAt: null };
}

function freshEngine(): EngineRec {
  return {
    running: false,
    phase: "idle",
    nextRunAt: null,
    lastRunAt: null,
    message: null,
    cadenceHours: 1,
    thresholdViews: 3000,
    likesFloor: 50_000,
    niche: "stories",
    topic: "",
    manualResult: null,
    errorCount: 0,
  };
}

const MAX_POSTS = 200;

export class Store {
  private file: string;
  data: DataFile;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(platform?: PlatformKey, accountId = LEGACY_ACCOUNT_ID) {
    // Legacy/default keeps `/data/state.json`; every named account gets a wholly
    // separate state file beside its wholly separate Chromium profile.
    const dir = platform ? accountDataDir(env.dataDir, platform, accountId) : env.dataDir;
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, "state.json");
    this.data = this.load();
  }

  private load(): DataFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<DataFile>;
      const d: DataFile = {
        rigs: { tiktok: blankRig(), instagram: blankRig(), youtube: blankRig() },
        posts: { tiktok: [], instagram: [], youtube: [] },
        engines: { tiktok: freshEngine(), instagram: freshEngine(), youtube: freshEngine() },
      };
      for (const p of Object.keys(d.rigs) as PlatformKey[]) {
        d.rigs[p] = { ...d.rigs[p], ...(raw.rigs?.[p] ?? {}) };
        d.engines[p] = { ...freshEngine(), ...(raw.engines?.[p] ?? {}) };
        d.engines[p].topic =
          typeof d.engines[p].topic === "string"
            ? d.engines[p].topic.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80)
            : "";
        const result = d.engines[p].manualResult;
        if (
          !result ||
          typeof result.requestId !== "string" ||
          !["accepted", "succeeded", "failed"].includes(result.status) ||
          typeof result.message !== "string" ||
          !Number.isFinite(result.at)
        ) {
          d.engines[p].manualResult = null;
        }
        d.posts[p] = raw.posts?.[p] ?? [];
      }
      return d;
    } catch {
      return {
        rigs: { tiktok: blankRig(), instagram: blankRig(), youtube: blankRig() },
        posts: { tiktok: [], instagram: [], youtube: [] },
        engines: { tiktok: freshEngine(), instagram: freshEngine(), youtube: freshEngine() },
      };
    }
  }

  private writeNow() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch {
      /* disk hiccups are non-fatal */
    }
  }

  save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow();
    }, 250);
  }

  /** Persist an accepted publish before network/browser work can be interrupted. */
  saveImmediate() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.writeNow();
  }

  /**
   * Legacy compatibility accounts share `/data/state.json`, so deletion must
   * clear exactly one platform instead of recursively deleting the data root.
   * Persist synchronously/atomically: the HTTP API must not acknowledge deletion
   * while an old debounced save can still put the account back.
   */
  resetPlatform(p: PlatformKey) {
    this.data.rigs[p] = blankRig();
    this.data.posts[p] = [];
    this.data.engines[p] = freshEngine();
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const temp = `${this.file}.${process.pid}.${Date.now()}.delete.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch (error) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {
        /* preserve the original persistence error */
      }
      throw error;
    }
  }

  rig(p: PlatformKey): RigRec {
    return this.data.rigs[p];
  }
  engine(p: PlatformKey): EngineRec {
    return this.data.engines[p];
  }
  posts(p: PlatformKey): WorkerPost[] {
    return this.data.posts[p];
  }

  setLoggedIn(p: PlatformKey, loggedIn: boolean, profile: string | null = null) {
    const r = this.rig(p);
    if (r.loggedIn !== loggedIn || (profile && r.profile !== profile)) {
      r.loggedIn = loggedIn;
      if (profile) r.profile = profile;
      this.save();
    }
  }

  setCookie(p: PlatformKey, at: number | null, names: string[], expiresAt: number | null = null) {
    const r = this.rig(p);
    r.cookieAt = at;
    r.cookieNames = names;
    r.cookieExpiresAt = expiresAt;
    this.save();
  }

  patchEngine(p: PlatformKey, patch: Partial<EngineRec>) {
    Object.assign(this.engine(p), patch);
    this.save();
  }

  addPost(p: PlatformKey, post: WorkerPost) {
    const arr = this.posts(p);
    arr.push(post);
    if (arr.length > MAX_POSTS) arr.splice(0, arr.length - MAX_POSTS);
    this.save();
  }

  updatePost(p: PlatformKey, id: string, patch: Partial<WorkerPost>) {
    const arr = this.posts(p);
    const i = arr.findIndex((x) => x.id === id);
    if (i >= 0) {
      arr[i] = { ...arr[i], ...patch };
      this.save();
    }
  }
}
