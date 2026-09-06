import { HOUR_MS, type PlatformKey } from "./config.js";
import type { EngineSnapshot, LastPostSnapshot, ServerMsg } from "./protocol.js";
import { now } from "./protocol.js";
import { Store, type WorkerPost } from "./store.js";
import { Rig, readVideoStats, scrapeCandidates, scrapeCommentSample } from "./browser.js";
import { downloadVideo, uploadToPlatform } from "./uploads.js";
import { groqAvailable, interpretMetrics, judgeCandidate, writeCaption } from "./groq.js";

const uid = () => `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const CHECK_INTERVAL_MS = 5 * 60_000;

const NICHE_CYCLE = ["stories", "scary", "facts"];

export class GrowthEngine {
  platform: PlatformKey;
  store: Store;
  rig: Rig;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private manualBusy = false;
  private hitNiche: string | null = null;

  constructor(platform: PlatformKey, store: Store, rig: Rig) {
    this.platform = platform;
    this.store = store;
    this.rig = rig;
  }

  /* ------------------------------- broadcast ------------------------------ */

  private log(level: string, text: string) {
    const at = now();
    console.log(`[${this.platform}]`, text);
    this.rig.broadcast({ type: "log", level, text, at });
  }

  snapshot(): EngineSnapshot {
    const e = this.store.engine(this.platform);
    const posts = this.store.posts(this.platform);
    const last = posts[posts.length - 1] ?? null;
    const latest = last?.checks[last.checks.length - 1];
    const lastPost: LastPostSnapshot | null = last
      ? {
          id: last.id,
          url: last.url,
          caption: last.caption,
          niche: last.niche,
          source: last.source,
          postedAt: last.postedAt,
          views: latest?.views ?? 0,
          likes: latest?.likes ?? 0,
          comments: latest?.comments ?? 0,
          verdict: last.verdict,
        }
      : null;
    return {
      running: e.running,
      phase: e.phase,
      nextRunAt: e.nextRunAt,
      lastRunAt: e.lastRunAt,
      message: e.message,
      cadenceHours: e.cadenceHours,
      thresholdViews: e.thresholdViews,
      likesFloor: e.likesFloor,
      loggedIn: this.store.rig(this.platform).loggedIn,
      lastPost,
    };
  }

  private pushEngine() {
    const msg: ServerMsg = { type: "engine", state: this.snapshot() };
    this.rig.broadcast(msg);
  }

  /* -------------------------------- lifecycle ------------------------------ */

  private audienceLabel(): string {
    return this.platform === "youtube" ? "visibility Public (Everyone)" : "audience Everyone";
  }

  start() {
    const e = this.store.engine(this.platform);
    if (e.running) return;
    e.running = true;
    e.phase = "analyzing";
    e.nextRunAt = null; // first cycle runs the initial discovery + post immediately
    e.message = "Engine armed. Analyzing account + algorithm, scanning faceless content.";
    e.errorCount = 0;
    this.store.save();
    this.log("ok", `🛰 Engine armed for ${this.platform} — 1 post/hour, ${this.audienceLabel()}, ${e.thresholdViews.toLocaleString()}+/hr trigger, ${e.likesFloor.toLocaleString()}+ likes discovery floor.`);
    this.pushEngine();
    this.ensureLoop();
    void this.runCycle("start");
  }

  stop() {
    const e = this.store.engine(this.platform);
    if (!e.running && e.phase === "idle") return;
    e.running = false;
    e.phase = "paused";
    e.nextRunAt = null;
    e.message = "Engine paused.";
    this.store.save();
    this.log("warn", "Engine paused — no posts or checks until resumed.");
    this.pushEngine();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resumeFromBoot() {
    const e = this.store.engine(this.platform);
    if (e.running) {
      this.ensureLoop();
      void this.runCycle("boot");
    }
  }

  private ensureLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.store.engine(this.platform).running) void this.runCycle("tick");
    }, CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  /* -------------------------------- run cycle ------------------------------ */

  async runCycle(reason: string) {
    const e = this.store.engine(this.platform);
    if (!e.running || this.inFlight) return;
    this.inFlight = true;
    try {
      if (!this.store.rig(this.platform).loggedIn) {
        e.phase = "analyzing";
        e.message = "Signed in? Waiting for login before the engine acts…";
        this.store.save();
        this.pushEngine();
        return;
      }
      await this.metricsPass(e);
      if (!e.running) return;
      await this.postingPass(e);
    } catch (err) {
      this.log("err", `Cycle error: ${(err as Error).message}`);
      e.errorCount += 1;
      e.phase = "error";
      e.message = `Cycle error — ${(err as Error).message.slice(0, 140)}`;
      e.nextRunAt = now() + (e.errorCount <= 3 ? 15 * 60_000 : HOUR_MS);
      this.store.save();
      this.pushEngine();
    } finally {
      this.inFlight = false;
      void reason;
    }
  }

  private async metricsPass(e: ReturnType<Store["engine"]>) {
    const posts = this.store.posts(this.platform);
    const nowMs = now();
    for (const post of posts) {
      if (!e.running) return;
      const age = nowMs - post.postedAt;
      const last = post.checks[post.checks.length - 1];
      const dueFirst = post.checks.length === 0 && age >= HOUR_MS - 5 * 60_000;
      const dueNext = post.checks.length > 0 && post.checks.length < 4 && last && nowMs - last.at >= HOUR_MS - 5 * 60_000;
      if (!dueFirst && !dueNext) continue;
      this.log("info", `Reading stats for ${post.id.slice(-5)}…`);
      const page = await this.rig.newEnginePage();
      try {
        const stats = await readVideoStats(page, post.url);
        await page.close().catch(() => undefined);
        if (stats.views == null && stats.likes == null) {
          this.log("warn", `Could not read stats for ${post.url.slice(0, 60)}… (page may block scraping) — retrying next hour.`);
          continue;
        }
        const views = stats.views ?? 0;
        const likes = stats.likes ?? 0;
        const comments = stats.comments ?? 0;
        post.checks.push({ at: now(), views, likes, comments });
        const firstHour = post.checks.length === 1;
        if (firstHour && views >= e.thresholdViews) {
          this.hitNiche = post.niche;
          this.log("ok", `🎯 ${views.toLocaleString()} views in hour one — crossed the ${e.thresholdViews.toLocaleString()} target. Doubling down on “${post.niche}”.`);
        }
        const verdict = await interpretMetrics({
          views,
          likes,
          comments,
          threshold: e.thresholdViews,
          niche: post.niche,
          priorVerdict: post.verdict,
        });
        post.verdict = verdict.verdict;
        post.audience = "Everyone";
        this.store.save();
        this.log("ai", `Groq read on ${post.id.slice(-5)}: ${verdict.verdict}`);
        this.pushEngine();
      } catch (err) {
        this.log("warn", `Stats pass failed: ${(err as Error).message}`);
      } finally {
        await page.close().catch(() => undefined);
      }
    }
  }

  private async postingPass(e: ReturnType<Store["engine"]>) {
    const nowMs = now();
    const posts = this.store.posts(this.platform);
    const recent = posts.some((p) => nowMs - p.postedAt < e.cadenceHours * HOUR_MS);

    if (e.nextRunAt && nowMs < e.nextRunAt) {
      if (recent) {
        e.message = `Hourly slot used — next auto-post in ${Math.max(1, Math.round(((e.nextRunAt ?? nowMs) - nowMs) / 60_000))} min.`;
      }
      this.store.save();
      this.pushEngine();
      return;
    }
    if (recent) {
      e.nextRunAt = nowMs + e.cadenceHours * HOUR_MS;
      e.message = "Hourly slot used (manual or auto) — next post scheduled in 1h.";
      this.store.save();
      this.pushEngine();
      return;
    }
    await this.autoPost(e);
  }

  /* -------------------------------- auto post ------------------------------ */

  private async autoPost(e: ReturnType<Store["engine"]>) {
    if (!groqAvailable()) {
      this.log("warn", "No GROQ_API_KEY set — engine uses heuristic quality checks only. Add the key for Groq caption + review intelligence.");
    }
    e.phase = "discovering";
    e.message = "Discovery: scanning feeds for faceless clips above the quality floor…";
    this.store.save();
    this.pushEngine();

    const niche = this.hitNiche && NICHE_CYCLE.includes(this.hitNiche) ? this.hitNiche : e.niche;
    const page = await this.rig.newEnginePage();
    try {
      const candidates = await scrapeCandidates(page, e.likesFloor, this.platform, niche);
      if (candidates.length === 0) {
        e.phase = "waiting";
        e.nextRunAt = now() + HOUR_MS;
        e.message = "No faceless clips above the quality floor found this pass.";
        this.log("warn", "Discovery found nothing above the quality bar — nothing posted (quality first).");
        this.store.save();
        this.pushEngine();
        return;
      }
      this.log("info", `Discovery surfaced ${candidates.length} clips at ${e.likesFloor.toLocaleString()}+ likes. Groq reviewing…`);
      e.phase = "reviewing";
      this.store.save();
      this.pushEngine();

      let best: Awaited<ReturnType<typeof judgeCandidate>> | null = null;
      let bestUrl = "";
      for (const c of candidates.slice(0, 3)) {
        const sample = await scrapeCommentSample(page, c.url).catch(() => "");
        const judge = await judgeCandidate({ niche, title: c.title, likes: c.likes, views: c.views, comments: c.comments, commentSample: sample });
        this.log("ai", judge.verdict === "post" ? `Candidate cleared: “${c.title.slice(0, 60)}…” — ${judge.reason}` : `Candidate skipped: “${c.title.slice(0, 50)}…” — ${judge.reason}`);
        if (judge.verdict === "post" && !best) {
          best = judge;
          bestUrl = c.url;
        }
        if (best) break;
      }
      if (!best) {
        e.phase = "waiting";
        e.nextRunAt = now() + HOUR_MS;
        e.message = "Review passed nothing — quality bar held.";
        this.log("warn", "Groq review passed no candidates this cycle — nothing posted.");
        this.store.save();
        this.pushEngine();
        return;
      }

      e.phase = "posting";
      e.message = `Publishing chosen clip — ${this.audienceLabel()}…`;
      this.store.save();
      this.pushEngine();

      const caption = best.caption || (await writeCaption({ niche, hook: best.angle }));
      const video = await downloadVideo(page, this.rig.context!, bestUrl, (t) => this.log("info", t));
      const result = await uploadToPlatform(this.platform, page, video, caption, (t) => this.log("info", t));
      const post: WorkerPost = {
        id: uid(),
        url: bestUrl,
        caption,
        niche,
        source: "ai",
        audience: "Everyone",
        postedAt: now(),
        checks: [],
        verdict: null,
      };
      this.store.addPost(this.platform, post);
      e.phase = "waiting";
      e.nextRunAt = now() + e.cadenceHours * HOUR_MS;
      e.message = `Posted “${caption.slice(0, 48)}…” — 1 of 1 slot used this hour.`;
      e.errorCount = 0;
      e.niche = NICHE_CYCLE[(NICHE_CYCLE.indexOf(niche as never) + 1) % NICHE_CYCLE.length];
      this.hitNiche = null;
      this.store.save();
      this.rig.broadcast({ type: "post-ok", postId: post.id, postedAt: post.postedAt, url: post.url });
      this.log(result.ok ? "ok" : "warn", result.ok ? `📤 Auto-posted (${this.audienceLabel()}). Verdict stored — first read in ~1h.` : `Auto-post result: ${result.message}`);
      this.pushEngine();
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  /* -------------------------------- manual post ----------------------------- */

  async manualPost(url: string, caption: string) {
    const e = this.store.engine(this.platform);
    if (this.manualBusy) {
      this.log("warn", "A publish is already in progress — one at a time.");
      return false;
    }
    if (!this.store.rig(this.platform).loggedIn) {
      this.log("warn", "Manual post blocked — sign in to the platform in the live browser first.");
      this.pushEngine();
      return false;
    }
    this.manualBusy = true;
    const prevPhase = e.phase;
    e.phase = "posting";
    e.message = `Publishing your link + caption (${this.audienceLabel()})…`;
    this.store.save();
    this.pushEngine();
    const page = await this.rig.newEnginePage();
    try {
      const video = await downloadVideo(page, this.rig.context!, url, (t) => this.log("info", t));
      const result = await uploadToPlatform(
        this.platform,
        page,
        video,
        caption || "Posted via ViralDeck",
        (t) => this.log("info", t)
      );
      const post: WorkerPost = {
        id: uid(),
        url,
        caption: caption || "Posted via ViralDeck",
        niche: e.niche,
        source: "manual",
        audience: "Everyone",
        postedAt: now(),
        checks: [],
        verdict: null,
      };
      this.store.addPost(this.platform, post);
      this.rig.broadcast({ type: "post-ok", postId: post.id, postedAt: post.postedAt, url: post.url });
      this.log("ok", `✅ Manual publish done — ${this.audienceLabel()}, caption “${(caption || "Posted via ViralDeck").slice(0, 60)}”.`);
      e.lastRunAt = now();
      if (e.running) {
        e.nextRunAt = now() + e.cadenceHours * HOUR_MS;
        e.phase = "waiting";
        e.message = "Manual post logged — hourly slot reserved. Metrics read starts in ~1h.";
      } else {
        e.phase = prevPhase === "paused" ? "paused" : "idle";
      }
      this.store.save();
      this.pushEngine();
      return result.ok;
    } catch (err) {
      this.log("err", `Manual publish failed: ${(err as Error).message}`);
      e.phase = prevPhase === "paused" ? "paused" : "idle";
      this.store.save();
      this.pushEngine();
      return false;
    } finally {
      this.manualBusy = false;
      await page.close().catch(() => undefined);
    }
  }
}
