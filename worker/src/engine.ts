import { HOUR_MS, stealth, type PlatformKey } from "./config.js";
import type { EngineSnapshot, LastPostSnapshot, ServerMsg } from "./protocol.js";
import { now } from "./protocol.js";
import { Store, type WorkerPost } from "./store.js";
import type { Page } from "playwright-core";
import { Rig, readVideoStats, scrapeCandidates, scrapeCommentSample } from "./browser.js";
import { downloadVideo, isTabGone, uploadToPlatform } from "./uploads.js";
import { groqAvailable, interpretMetrics, judgeCandidate, writeCaption } from "./groq.js";
import { jitter, readingPause, sleep, thinkingPause } from "./human.js";

const uid = () => `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const LOOP_TICK_MS = 60_000;

/**
 * Humanized cadence: the 1-post/hour rule still holds (slots are never
 * shorter than the cadence), but every scheduled time gets a random upward
 * jitter so posts and checks never land on a metronome beat — a fixed,
 * clock-perfect schedule is a classic bot tell.
 */
function jitteredCadenceMs(e: ReturnType<Store["engine"]>): number {
  return e.cadenceHours * HOUR_MS + jitter(0, stealth.cadenceJitterMin * 60_000);
}

/** Random 0–bootDelayMaxMin minutes before the first engine action. */
function warmupMs(): number {
  return jitter(0.5, Math.max(1, stealth.bootDelayMaxMin)) * 60_000;
}

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

  /** A one-line answer where the user clicked. Only for things they asked for by
   * hand — the hourly engine cycle runs unattended and must not toast. */
  private toast(text: string, tone: "info" | "ok" | "warn" | "err") {
    this.rig.broadcast({ type: "toast", text, tone });
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
    // Human stealth: a process that starts posting the instant it is armed is
    // a bot tell. Warm up for a random 0–N minutes first, then run the first
    // cycle. (When the user wants an immediate manual post, manualPost still
    // runs right away — the warm-up only gates *automatic* actions.)
    e.nextRunAt = now() + warmupMs();
    e.message = "Engine armed — warming up like a human before the first automatic pass.";
    e.errorCount = 0;
    this.store.save();
    this.log("ok", `🛰 Engine armed for ${this.platform} — 1 post/hour, ${this.audienceLabel()}, ${e.thresholdViews.toLocaleString()}+/hr trigger, ${e.likesFloor.toLocaleString()}+ likes discovery floor.`);
    this.pushEngine();
    this.ensureLoop();
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
      // A fresh boot that posts instantly is a tell — but an engine that was
      // already mid-cadence keeps its existing schedule.
      if (!e.nextRunAt) {
        e.nextRunAt = now() + warmupMs();
        e.message = "Resumed after restart — warming up before the next automatic pass.";
        this.store.save();
        this.pushEngine();
      }
    }
  }

  private ensureLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.store.engine(this.platform).running) void this.runCycle("tick");
    }, LOOP_TICK_MS);
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
      // Human stealth: never act before the jittered warm-up / next-slot time.
      if (e.nextRunAt && now() < e.nextRunAt) {
        const waitMin = Math.max(1, Math.round((e.nextRunAt - now()) / 60_000));
        e.phase = "waiting";
        e.message = e.lastRunAt
          ? `Next automatic pass in ~${waitMin} min (human-jittered).`
          : `Warming up — next automatic pass in ~${waitMin} min.`;
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
      e.nextRunAt = now() + (e.errorCount <= 3 ? 15 * 60_000 : HOUR_MS) + jitter(1, 6) * 60_000;
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
      // Human stealth: reads happen a random few minutes AFTER they become due
      // (a stats check on the exact hour mark every hour is a bot tell).
      const dueFirst = post.checks.length === 0 && age >= HOUR_MS - jitter(5, 5 + stealth.metricsJitterMin) * 60_000;
      const dueNext =
        post.checks.length > 0 &&
        post.checks.length < 4 &&
        !!last &&
        nowMs - last.at >= HOUR_MS - jitter(5, 5 + stealth.metricsJitterMin) * 60_000;
      if (!dueFirst && !dueNext) continue;
      this.log("info", `Reading stats for ${post.id.slice(-5)}…`);
      const page = await this.rig.newEnginePage();
      try {
        // Land on the page like a person: load, look, then read.
        const stats = await readVideoStats(page, post.url);
        await readingPause(400, 1200);
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
      e.nextRunAt = nowMs + jitteredCadenceMs(e);
      e.message = "Hourly slot used (manual or auto) — next post scheduled in ~1h (human-jittered).";
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
        // A human doesn't teleport between clips: read a comment sample, then
        // dwell before judging.
        const sample = await scrapeCommentSample(page, c.url).catch(() => "");
        await readingPause(600, 1600);
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
      // A human sits with the chosen clip for a beat before publishing it.
      await thinkingPause(800, 2600);
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
      e.nextRunAt = now() + jitteredCadenceMs(e);
      e.lastRunAt = now();
      e.message = `Posted “${caption.slice(0, 48)}…” — 1 of 1 slot used this hour.`;
      e.errorCount = 0;
      e.niche = NICHE_CYCLE[(NICHE_CYCLE.indexOf(niche as never) + 1) % NICHE_CYCLE.length];
      this.hitNiche = null;
      this.store.save();
      this.rig.broadcast({ type: "post-ok", postId: post.id, postedAt: post.postedAt, url: post.url });
      this.toast("Posted — check the live browser for the live link.", "ok");
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
      this.toast("A publish is already running — one at a time.", "warn");
      return false;
    }
    if (!this.store.rig(this.platform).loggedIn) {
      this.log("warn", "Manual post blocked — sign in to the platform in the live browser first.");
      this.toast("Not signed in on this profile — sign in (or paste a session cookie) first.", "warn");
      this.pushEngine();
      return false;
    }
    if (!/^https?:\/\//i.test((url || "").trim())) {
      this.log("warn", `Manual post needs a real link — got “${String(url).slice(0, 40)}”.`);
      this.toast("The source link has to be a full http(s) URL.", "warn");
      return false;
    }
    this.manualBusy = true;
    const prevPhase = e.phase;
    e.phase = "posting";
    e.message = `Publishing your link + caption (${this.audienceLabel()})…`;
    this.store.save();
    this.pushEngine();
    // Each stage lands in `message`, which the deck renders under the Post button.
    const stage = (text: string) => {
      e.message = text;
      this.store.save();
      this.pushEngine();
    };
    // A *manual* publish runs in the tab the deck is streaming, so the user watches
    // the source page open, the file hand off to the studio and Post get pressed.
    // The hourly cycle keeps its own hidden tab — nobody is watching it, and it
    // must not steal the feed the user is browsing.
    const publish = async (page: Page) => {
      stage("Fetching the video from that link…");
      const video = await downloadVideo(page, this.rig.context!, url, (t) => this.log("info", t));
      stage(`Uploading ${(video.buffer.length / 1_048_576).toFixed(1)} MB to ${this.platform}…`);
      return uploadToPlatform(this.platform, page, video, caption || "Posted via ViralDeck", (t) => this.log("info", t));
    };
    try {
      // Prefer the streamed tab; fall back to a tab of our own when there is none
      // (or one already holds it). Either way the whole run is inside this try, so
      // a throw on the way in still answers the deck instead of hanging the button.
      const inOwnTab = async () => {
        const own = await this.rig.newEnginePage();
        try {
          return await publish(own);
        } finally {
          await own.close().catch(() => undefined);
        }
      };
      const attempt = async () => (await this.rig.withVisibleTab(publish)).value ?? (await inOwnTab());
      let result: Awaited<ReturnType<typeof attempt>>;
      try {
        result = await attempt();
      } catch (err) {
        // The tab died under us (a renderer kill at the studio step is the common
        // one) — but the video is already in memory, so waiting out the reopen and
        // trying once is far more likely to post than telling the user to press
        // again. Anything the *site* objected to is not retried.
        if (!isTabGone(err)) throw err;
        stage("The tab died mid-publish — waiting for the browser and retrying once…");
        this.log("warn", `Publish lost its tab (${(err as Error).message}); waiting for the reopen, then trying once more.`);
        if (!(await this.rig.waitForRecovery())) throw err;
        await sleep(1200); // the reopened page needs its own moment before a goto
        result = await attempt();
        this.log("ok", "Retry after the tab crash got through.");
      }
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
        e.nextRunAt = now() + jitteredCadenceMs(e);
        e.phase = "waiting";
        e.message = "Manual post logged — hourly slot reserved. Metrics read starts in ~1h.";
      } else {
        e.phase = prevPhase === "paused" ? "paused" : "idle";
      }
      this.store.save();
      this.pushEngine();
      return result.ok;
    } catch (err) {
      const message = (err as Error).message;
      this.log("err", `Manual publish failed: ${message}`);
      // The deck's Post button waits for one of these two answers; without this it
      // spins for its own timeout and the user is left deciding whether anything
      // ever ran. The failure says which stage died so the fix is actionable.
      this.rig.broadcast({ type: "post-failed", message });
      this.toast(`Publish failed: ${message}`, "err");
      e.phase = prevPhase === "paused" ? "paused" : "idle";
      this.store.save();
      this.pushEngine();
      return false;
    } finally {
      this.manualBusy = false;
      // The user's tab is deliberately left where the publish put it: landing on
      // the live video page is the confirmation that it worked.
    }
  }
}
