import { HOUR_MS, type PlatformKey } from "./config.js";
import {
  ENGINE_LOOP_TICK_MS,
  cadenceDurationMs,
  initialEngineRunAt,
  latestConfirmedPostAt,
  metricsReadDue,
  nextConfirmedPostAt,
} from "./engineSchedule.js";
import type { EngineSnapshot, LastPostSnapshot, ManualPublishResult, ServerMsg } from "./protocol.js";
import { now } from "./protocol.js";
import { Store, type WorkerPost } from "./store.js";
import type { Page } from "playwright-core";
import { Rig, readVideoStats, scrapeCandidates, scrapeCommentSample } from "./browser.js";
import { downloadVideo, isTabGone, uploadToPlatform } from "./uploads.js";
import { enhanceVideoForUpload } from "./mediaEnhance.js";
import { uploadYouTubeWithOAuth, youtubeOAuthConnected } from "./youtubeOAuth.js";
import { groqAvailable, interpretMetrics, judgeCandidate, writeCaption } from "./groq.js";
import { jitter, readingPause, sleep, thinkingPause } from "./human.js";
import { publishReceipt, type PublishReceipt } from "./publishReceipt.js";
import { cleanDiscoveryTopic, isTopicMatch, metadataWatermarkRisk } from "./discovery.js";
import { screenVideoForDiscovery } from "./mediaEnhance.js";
import { recoverInterruptedManualResult } from "./manualResult.js";

const uid = () => `wp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

const NICHE_CYCLE = ["stories", "scary", "facts"];

/** Async browser work can be paused from another websocket while this call is
 * awaiting. Keep that externally-mutated phase instead of restoring its entry
 * phase when the exact manual request reaches a terminal receipt. */
function manualShouldRemainPaused(e: ReturnType<Store["engine"]>, entryPhase: string): boolean {
  return !e.running && (e.phase === "paused" || entryPhase === "paused");
}

export class GrowthEngine {
  platform: PlatformKey;
  store: Store;
  rig: Rig;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private manualBusy = false;
  private manualRequestId: string | null = null;
  private hitNiche: string | null = null;

  /** Used only to avoid hibernating an account while its manual/auto job runs. */
  isBusy(): boolean {
    return this.inFlight || this.manualBusy;
  }

  /** A connected YouTube OAuth grant is a destination login even when the
   * optional Studio browser itself is signed out. Other platforms stay browser-only. */
  private publishAuthenticated(): boolean {
    return (
      this.store.rig(this.platform).loggedIn ||
      (this.platform === "youtube" && youtubeOAuthConnected(this.rig.accountId))
    );
  }

  constructor(platform: PlatformKey, store: Store, rig: Rig) {
    this.platform = platform;
    this.store = store;
    this.rig = rig;
    const engine = this.store.engine(this.platform);
    // `accepted` is flushed before browser/network work begins. If a process died
    // there, the new runtime converts that durable acknowledgement into the exact
    // correlated failure the reconnecting deck is waiting for.
    if (engine.manualResult?.status === "accepted") {
      engine.manualResult = recoverInterruptedManualResult(engine.manualResult, now()) ?? null;
      engine.phase = engine.running ? "waiting" : "idle";
      engine.message = engine.manualResult?.message ?? "The interrupted publish was not confirmed.";
      if (engine.running && !engine.nextRunAt) engine.nextRunAt = now() + 15 * 60_000;
      this.store.saveImmediate();
    }
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
          sourceUrl: last.sourceUrl,
          requestId: last.requestId,
          caption: last.caption,
          niche: last.niche,
          topic: last.topic,
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
      topic: e.topic,
      // This wire field drives the browser-session badge only. YouTube OAuth is
      // separate destination authentication and must not pretend Chromium itself
      // is signed in.
      loggedIn: this.store.rig(this.platform).loggedIn,
      manualBusy: this.manualBusy,
      manualRequestId: this.manualRequestId,
      manualResult: e.manualResult,
      lastPost,
    };
  }

  private pushEngine() {
    const msg: ServerMsg = { type: "engine", state: this.snapshot() };
    this.rig.broadcast(msg);
  }

  configure(input: { topic?: unknown; thresholdViews?: unknown; likesFloor?: unknown }) {
    const e = this.store.engine(this.platform);
    if (input.topic !== undefined) e.topic = cleanDiscoveryTopic(input.topic);
    const threshold = Number(input.thresholdViews);
    const likes = Number(input.likesFloor);
    if (Number.isFinite(threshold)) e.thresholdViews = Math.round(Math.min(100_000_000, Math.max(100, threshold)));
    if (Number.isFinite(likes)) e.likesFloor = Math.round(Math.min(1_000_000_000, Math.max(1_000, likes)));
    this.store.save();
    this.pushEngine();
  }

  private validRequestId(value: unknown): string | null {
    return typeof value === "string" && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(value) ? value : null;
  }

  private acceptManualRequest(requestId: string, message: string) {
    const e = this.store.engine(this.platform);
    this.manualBusy = true;
    this.manualRequestId = requestId;
    e.manualResult = { requestId, status: "accepted", message, at: now() };
    // This is the recovery boundary: a process restart can now answer this exact
    // request instead of leaving the deck to infer a result from a boolean.
    this.store.saveImmediate();
    this.pushEngine();
  }

  private finishManualRequest(
    requestId: string,
    status: "succeeded" | "failed",
    message: string,
    post?: Pick<WorkerPost, "id" | "postedAt"> & { liveUrl?: string }
  ) {
    const result: ManualPublishResult = {
      requestId,
      status,
      message: message.slice(0, 2_000),
      at: now(),
      ...(post ? { postId: post.id, postedAt: post.postedAt, ...(post.liveUrl ? { url: post.liveUrl } : {}) } : {}),
    };
    this.store.engine(this.platform).manualResult = result;
    this.store.saveImmediate();
  }

  /** Status recovery is itself correlated; elapsed time never settles a request. */
  reportManualStatus(rawRequestId: unknown) {
    const requestId = this.validRequestId(rawRequestId);
    if (!requestId) return;
    const e = this.store.engine(this.platform);
    if (this.manualRequestId === requestId || e.manualResult?.requestId === requestId) {
      this.pushEngine();
      return;
    }
    const post = this.store.posts(this.platform).find((item) => item.requestId === requestId);
    if (post) {
      this.finishManualRequest(requestId, "succeeded", "The worker recovered the confirmed publish from account history.", {
        id: post.id,
        postedAt: post.postedAt,
        liveUrl: post.url !== post.sourceUrl ? post.url : undefined,
      });
      this.pushEngine();
      return;
    }
    const message = "The worker has no record of accepting this request, so no publish is confirmed. Reconnect and try it again.";
    this.rig.broadcast({ type: "post-failed", requestId, message });
  }

  /* -------------------------------- lifecycle ------------------------------ */

  private audienceLabel(): string {
    return this.platform === "youtube" ? "visibility Public (Everyone)" : "audience Everyone";
  }

  /** Manual and automatic entry points share the same confirmed one-post/hour
   * boundary. A button press is not permission to overlap a still-reserved slot. */
  private cadenceBlockMessage(e: ReturnType<Store["engine"]>): string | null {
    const latest = latestConfirmedPostAt(this.store.posts(this.platform));
    if (latest === null) return null;
    const opensAt = nextConfirmedPostAt(latest, e.cadenceHours);
    const remaining = opensAt - now();
    if (remaining <= 0) return null;
    const minutes = Math.max(1, Math.ceil(remaining / 60_000));
    return `The confirmed one-post/hour slot is still reserved for ${minutes} more minute${minutes === 1 ? "" : "s"}. Nothing new was uploaded.`;
  }

  start() {
    const e = this.store.engine(this.platform);
    if (e.running) return;
    const startedAt = now();
    const latest = latestConfirmedPostAt(this.store.posts(this.platform));
    const reservedUntil = latest === null ? null : nextConfirmedPostAt(latest, e.cadenceHours);
    const resumesReservedSlot = reservedUntil !== null && reservedUntil > startedAt;
    e.running = true;
    e.phase = resumesReservedSlot ? "waiting" : "analyzing";
    // A genuinely open slot means now. The previous randomized warm-up plus the
    // first minute-long interval tick could leave a newly armed topic inert for
    // almost nine minutes. A confirmed, still-active slot is never bypassed.
    e.nextRunAt = resumesReservedSlot ? reservedUntil : initialEngineRunAt(startedAt);
    e.message = resumesReservedSlot
      ? `Engine resumed — the confirmed one-hour wait still has ${Math.max(1, Math.ceil((reservedUntil - startedAt) / 60_000))} min left.`
      : e.topic
        ? `Engine armed — starting the first “${e.topic}” analysis and publish now.`
        : "Engine armed — starting the first account analysis and publish now.";
    e.errorCount = 0;
    this.store.save();
    this.log(
      "ok",
      resumesReservedSlot
        ? `🛰 Engine resumed for ${this.platform} — preserving the confirmed +1h boundary before Growth AI analyzes and posts again.`
        : `🛰 Engine armed for ${this.platform} — first publish pass queued now; after a confirmed post, Growth AI waits exactly 1h before analyzing and posting again (${this.audienceLabel()}, ${e.thresholdViews.toLocaleString()}+/hr trigger, ${e.likesFloor.toLocaleString()}+ likes discovery floor).`
    );
    this.pushEngine();
    this.ensureLoop();
    // Do not make a fresh Start wait for the fallback timer. `inFlight` prevents
    // this direct call and an interval tick from ever overlapping.
    void this.runCycle("start");
  }

  stop(): boolean {
    const e = this.store.engine(this.platform);
    // Multiple tabs, delayed clicks, and account cleanup may repeat Stop. Once
    // stopped, another request is a no-op and must not append another pause line.
    if (!e.running) {
      if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
      }
      this.pushEngine();
      return false;
    }
    e.running = false;
    e.phase = "paused";
    e.nextRunAt = null;
    e.message = this.manualBusy
      ? "Engine paused — the current publish keeps its exact request until a receipt; future cycles are stopped."
      : this.inFlight
        ? "Engine paused — the current automatic pass will stop before upload, or finish its receipt if submission already began."
        : "Engine paused.";
    this.store.save();
    this.log(
      "warn",
      this.manualBusy
        ? "Engine paused — the in-flight publish will still finish with its correlated receipt; no later posts or checks will start."
        : this.inFlight
          ? "Engine paused — the current pass is stopping safely; an already-started destination submission will still return its strict receipt."
          : "Engine paused — no posts or checks until resumed."
    );
    this.pushEngine();
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return true;
  }

  resumeFromBoot() {
    const e = this.store.engine(this.platform);
    if (!e.running) return;

    const resumedAt = now();
    const latest = latestConfirmedPostAt(this.store.posts(this.platform));
    const confirmedBoundary = latest === null ? null : nextConfirmedPostAt(latest, e.cadenceHours);
    const interruptedRequest =
      e.manualResult?.status === "failed" && /worker restarted before a success receipt/i.test(e.manualResult.message);
    let changed = false;

    if (interruptedRequest && e.nextRunAt) {
      // Do not immediately repeat an upload whose process died after acceptance:
      // the correlated failure must remain visible long enough to inspect.
    } else if (confirmedBoundary !== null) {
      // Migrate old +jitter state on boot as well: history is the source of truth.
      const exactNext = confirmedBoundary > resumedAt ? confirmedBoundary : initialEngineRunAt(resumedAt);
      e.nextRunAt = exactNext;
      changed = true;
      e.phase = confirmedBoundary > resumedAt ? "waiting" : "analyzing";
      e.message = confirmedBoundary > resumedAt
        ? "Resumed after restart — preserving the exact confirmed +1h boundary."
        : "Resumed after restart — the full hour is complete, continuing Growth AI now.";
    } else if ((!e.nextRunAt || (!e.lastRunAt && e.phase !== "error" && !interruptedRequest))) {
      // A legacy initial warm-up has no confirmed post and no completed pass. It
      // is safe—and required—to replace it with an immediate first cycle.
      e.nextRunAt = initialEngineRunAt(resumedAt);
      e.phase = "analyzing";
      e.message = "Resumed after restart — continuing the due Growth AI pass now.";
      changed = true;
    }

    if (changed) {
      this.store.save();
      this.pushEngine();
    }
    this.ensureLoop();
    // A persisted future boundary returns at the schedule gate; a due or
    // missing boundary resumes immediately instead of waiting for a timer tick.
    void this.runCycle("boot");
  }

  private ensureLoop() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.store.engine(this.platform).running) void this.runCycle("tick");
    }, ENGINE_LOOP_TICK_MS);
    this.timer.unref?.();
  }

  /* -------------------------------- run cycle ------------------------------ */

  async runCycle(reason: string) {
    const e = this.store.engine(this.platform);
    if (!e.running || this.inFlight || this.manualBusy) return;
    this.inFlight = true;
    try {
      if (!this.publishAuthenticated()) {
        const message = "Signed in? Waiting for a browser login or YouTube Google connection before the engine acts…";
        if (e.phase !== "analyzing" || e.message !== message) {
          e.phase = "analyzing";
          e.message = message;
          this.store.save();
          this.pushEngine();
        }
        return;
      }
      const cycleAt = now();
      if (e.nextRunAt !== null && cycleAt < e.nextRunAt) {
        const waitMs = e.nextRunAt - cycleAt;
        const waitMin = Math.max(1, Math.ceil(waitMs / 60_000));
        const message = `Confirmed hourly slot opens in ${waitMin} min — Growth AI will analyze fresh data, then publish.`;
        // The deck derives its live countdown from nextRunAt. Avoid rewriting the
        // same account state every ten seconds while the exact boundary is future.
        if (e.phase !== "waiting" || e.message !== message) {
          e.phase = "waiting";
          e.message = message;
          this.store.save();
          this.pushEngine();
        }
        return;
      }

      const hourlyBoundaryFinished = e.phase === "waiting" && e.nextRunAt !== null;
      if (hourlyBoundaryFinished) {
        e.phase = "analyzing";
        e.message = "The full hour finished — Growth AI is analyzing fresh metrics and content before the next publish.";
        this.store.save();
        this.log("ai", "🕐 Full one-hour wait finished — analyzing fresh post data and content before publishing the next slot.");
        this.pushEngine();
      }

      await this.metricsPass(e);
      if (!e.running) return;
      await this.postingPass(e);
    } catch (err) {
      this.log("err", `Cycle error: ${(err as Error).message}`);
      e.errorCount += 1;
      if (e.running) {
        e.phase = "error";
        e.message = `Cycle error — ${(err as Error).message.slice(0, 140)}`;
        e.nextRunAt = now() + (e.errorCount <= 3 ? 15 * 60_000 : HOUR_MS) + jitter(1, 6) * 60_000;
      } else {
        e.phase = "paused";
        e.nextRunAt = null;
        e.message = `Engine remains paused. The in-flight pass ended with: ${(err as Error).message.slice(0, 120)}`;
      }
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
      const last = post.checks[post.checks.length - 1];
      // A "first-hour" read must contain a full hour of performance. Humanized
      // page interaction remains, but schedule jitter may never pull this read
      // (or a later hourly read) in front of its data boundary.
      if (post.checks.length >= 4 || !metricsReadDue(post.postedAt, last?.at ?? null, nowMs)) continue;
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
    const latestPostedAt = latestConfirmedPostAt(posts);
    const slotOpensAt = latestPostedAt === null ? null : nextConfirmedPostAt(latestPostedAt, e.cadenceHours);

    // History is authoritative even if nextRunAt was lost in a restart. Never
    // add another hour from "now": preserve the boundary derived from the most
    // recent destination success receipt.
    if (slotOpensAt !== null && nowMs < slotOpensAt) {
      const waitMin = Math.max(1, Math.ceil((slotOpensAt - nowMs) / 60_000));
      e.phase = "waiting";
      e.nextRunAt = slotOpensAt;
      e.message = `Confirmed hourly slot opens in ${waitMin} min — Growth AI will analyze fresh data, then publish.`;
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
    const topic = cleanDiscoveryTopic(e.topic);
    e.message = topic
      ? `Discovery: searching exactly for “${topic}” above the quality floor…`
      : "Discovery: scanning feeds for faceless clips above the quality floor…";
    this.store.save();
    this.pushEngine();

    const niche = this.hitNiche && NICHE_CYCLE.includes(this.hitNiche) && !topic ? this.hitNiche : e.niche;
    const page = await this.rig.newEnginePage();
    try {
      const candidates = await scrapeCandidates(page, e.likesFloor, this.platform, niche, topic);
      if (!e.running) {
        e.phase = "paused";
        e.nextRunAt = null;
        e.message = "Engine paused before discovery could begin a publish.";
        this.store.save();
        this.pushEngine();
        return;
      }
      if (candidates.length === 0) {
        const completedAt = now();
        e.phase = "waiting";
        e.lastRunAt = completedAt;
        e.nextRunAt = completedAt + cadenceDurationMs(e.cadenceHours);
        e.message = topic
          ? `No relevant “${topic}” clips above the engagement floor found this pass — analyzing fresh results again in 1h.`
          : "No faceless clips above the quality floor found this pass — analyzing fresh results again in 1h.";
        this.log("warn", `Discovery found nothing ${topic ? `relevant to “${topic}” ` : ""}above the quality bar — nothing posted (quality first).`);
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
      let bestTitle = "";
      let bestSourceVideo: Awaited<ReturnType<typeof downloadVideo>> | null = null;
      for (const c of candidates.slice(0, 6)) {
        if (!e.running) break;
        const watermarkHint = metadataWatermarkRisk(c.title);
        if (watermarkHint) {
          this.log("warn", `Candidate skipped before download: metadata signals “${watermarkHint}”.`);
          continue;
        }
        if (topic && !isTopicMatch(topic, c.title, c.url)) {
          this.log("warn", `Candidate skipped as unrelated to “${topic}”: “${c.title.slice(0, 70)}”.`);
          continue;
        }
        // A human doesn't teleport between clips: read a comment sample, then
        // dwell before judging.
        const sample = await scrapeCommentSample(page, c.url).catch(() => "");
        await readingPause(600, 1600);
        const judge = await judgeCandidate({ niche: topic || niche, title: c.title, likes: c.likes, views: c.views, comments: c.comments, commentSample: sample });
        this.log("ai", judge.verdict === "post" ? `Candidate cleared: “${c.title.slice(0, 60)}…” — ${judge.reason}` : `Candidate skipped: “${c.title.slice(0, 50)}…” — ${judge.reason}`);
        if (judge.verdict !== "post") continue;
        try {
          const sourceVideo = await downloadVideo(page, this.rig.context!, c.url, (t) => this.log("info", t));
          await screenVideoForDiscovery(sourceVideo, (t) => this.log("info", t));
          best = judge;
          bestUrl = c.url;
          bestTitle = c.title;
          bestSourceVideo = sourceVideo;
          break;
        } catch (error) {
          this.log("warn", `Candidate rejected after download: ${(error as Error).message}. Trying the next relevant clip.`);
        }
      }
      if (!e.running) {
        e.phase = "paused";
        e.nextRunAt = null;
        e.message = "Engine paused during review — no automatic upload was started.";
        this.store.save();
        this.pushEngine();
        return;
      }
      if (!best || !bestSourceVideo) {
        const completedAt = now();
        e.phase = "waiting";
        e.lastRunAt = completedAt;
        e.nextRunAt = completedAt + cadenceDurationMs(e.cadenceHours);
        e.message = "Review passed nothing — quality bar held. Growth AI will analyze fresh results again in 1h.";
        this.log("warn", "Groq review passed no candidates this cycle — nothing posted.");
        this.store.save();
        this.pushEngine();
        return;
      }

      e.phase = "posting";
      e.message = `Publishing chosen clip — ${this.audienceLabel()}…`;
      this.store.save();
      this.pushEngine();

      const caption = await writeCaption({ niche, topic, sourceTitle: bestTitle, hook: best.angle });
      // A human sits with the chosen clip for a beat before publishing it.
      await thinkingPause(800, 2600);
      const video = await enhanceVideoForUpload(bestSourceVideo, (t) => this.log("info", t));
      if (!e.running) {
        e.phase = "paused";
        e.nextRunAt = null;
        e.message = "Engine paused before the automatic uploader was opened.";
        this.store.save();
        this.pushEngine();
        return;
      }
      const result =
        this.platform === "youtube" && youtubeOAuthConnected(this.rig.accountId)
          ? await uploadYouTubeWithOAuth(this.rig.accountId, video, caption, (t) => this.log("info", t))
          : await uploadToPlatform(this.platform, page, video, caption, (t) => this.log("info", t));
      const receipt = publishReceipt(result, bestUrl);
      if (!receipt.confirmed) throw new Error(`Publish was not confirmed: ${receipt.error}`);
      const post: WorkerPost = {
        id: uid(),
        // Never label the source clip as our live post. TikTok/Instagram return
        // the destination URL; platforms that do not expose it keep the source
        // only as a metrics fallback, while the success event omits a fake link.
        url: receipt.recordUrl,
        sourceUrl: bestUrl,
        caption,
        niche,
        topic: topic || undefined,
        source: "ai",
        audience: "Everyone",
        postedAt: now(),
        checks: [],
        verdict: null,
      };
      this.store.addPost(this.platform, post);
      e.lastRunAt = post.postedAt;
      if (e.running) {
        e.phase = "waiting";
        e.nextRunAt = nextConfirmedPostAt(post.postedAt, e.cadenceHours);
        e.message = `Posted “${caption.slice(0, 48)}…” — confirmed. Waiting one full hour before Growth AI analyzes and posts again.`;
      } else {
        // Once the destination action has started, abandoning it can create an
        // unknown duplicate. Keep its strict receipt, then honor Pause.
        e.phase = "paused";
        e.nextRunAt = null;
        e.message = `Automatic publish confirmed for “${caption.slice(0, 48)}…”; the engine remains paused.`;
      }
      e.errorCount = 0;
      e.niche = NICHE_CYCLE[(NICHE_CYCLE.indexOf(niche as never) + 1) % NICHE_CYCLE.length];
      this.hitNiche = null;
      this.store.save();
      this.rig.broadcast({ type: "post-ok", postId: post.id, postedAt: post.postedAt, url: receipt.liveUrl });
      this.toast("Posted — check the live browser for the live link.", "ok");
      this.log("ok", `📤 Auto-posted (${this.audienceLabel()}). Verdict stored — first read starts only after the full 1h boundary.`);
      this.pushEngine();
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async publishPreparedVideo(
    video: Awaited<ReturnType<typeof downloadVideo>>,
    caption: string,
    sourceUrl: string,
    stage: (text: string) => void
  ): Promise<PublishReceipt> {
    const useYouTubeApi = this.platform === "youtube" && youtubeOAuthConnected(this.rig.accountId);
    let result: { ok: boolean; message: string; liveUrl?: string };
    if (useYouTubeApi) {
      stage(`Uploading ${(video.buffer.length / 1_048_576).toFixed(1)} MB quality-approved master through the official YouTube API…`);
      result = await uploadYouTubeWithOAuth(this.rig.accountId, video, caption, (t) => this.log("info", t));
      if (result.liveUrl) {
        stage("YouTube confirmed the public video — opening its destination in the live browser…");
        await this.rig
          .withVisibleTab(async (visible) => {
            await visible.goto(result.liveUrl!, { waitUntil: "domcontentloaded", timeout: 45_000 });
            return true;
          })
          .catch(() => undefined);
      }
    } else {
      stage(`Uploading ${(video.buffer.length / 1_048_576).toFixed(1)} MB quality-approved master to ${this.platform} in the live browser…`);
      const publish = (page: Page) => uploadToPlatform(this.platform, page, video, caption, (t) => this.log("info", t));
      const inOwnTab = async () => {
        const own = await this.rig.newEnginePage();
        try {
          return await publish(own);
        } finally {
          await own.close().catch(() => undefined);
        }
      };
      const attempt = async () => (await this.rig.withVisibleTab(publish)).value ?? (await inOwnTab());
      try {
        result = await attempt();
      } catch (err) {
        if (!isTabGone(err)) throw err;
        stage("The upload tab died mid-publish — waiting for the browser and retrying the same file once…");
        this.log("warn", `Upload lost its tab (${(err as Error).message}); waiting for the reopen, then retrying the same file once.`);
        if (!(await this.rig.waitForRecovery())) throw err;
        await sleep(1200);
        result = await attempt();
        this.log("ok", "Retry after the upload-tab crash got through.");
      }
    }
    return publishReceipt(result, sourceUrl);
  }

  /* -------------------------------- manual post ----------------------------- */

  async manualDiscoverPost(rawTopic: string, suppliedCaption: string, rawRequestId?: string) {
    const e = this.store.engine(this.platform);
    const requestId = this.validRequestId(rawRequestId);
    if (!requestId) {
      this.rig.broadcast({ type: "post-failed", message: "The discovery request id was missing or malformed." });
      return false;
    }
    const reject = (message: string, persist = true) => {
      this.log("warn", message);
      if (persist) this.finishManualRequest(requestId, "failed", message);
      this.rig.broadcast({ type: "post-failed", message, requestId });
      this.toast(message, "warn");
      this.pushEngine();
      return false;
    };
    const topic = cleanDiscoveryTopic(rawTopic);
    if (!topic) return reject("Enter what to upload about (for example “donut smp” or “drdonutt”).");
    if (this.manualBusy) return reject("A publish is already running on this named account — wait for its receipt, then try again.", false);
    if (this.inFlight) return reject("The automatic engine is using this account browser right now — retry when this pass finishes.");
    if (!this.publishAuthenticated()) {
      return reject("Not signed in on this account — use the browser, session cookie, or YouTube Connect Google first.");
    }
    const cadenceBlock = this.cadenceBlockMessage(e);
    if (cadenceBlock) return reject(cadenceBlock);

    const prevPhase = e.phase;
    e.topic = topic;
    e.phase = "discovering";
    e.message = `Searching for “${topic}” on video result pages…`;
    this.acceptManualRequest(requestId, e.message);
    const stage = (text: string) => {
      e.message = text;
      this.store.save();
      this.pushEngine();
    };

    try {
      if (!groqAvailable()) {
        this.log("warn", "No GROQ_API_KEY set — relevance/engagement/quality gates still run, with a deterministic source-inspired caption.");
      }
      const page = await this.rig.newEnginePage();
      let selected:
        | {
            sourceUrl: string;
            sourceTitle: string;
            video: Awaited<ReturnType<typeof downloadVideo>>;
            angle: string | null;
          }
        | null = null;
      const rejected: string[] = [];
      try {
        const candidates = await scrapeCandidates(page, e.likesFloor, this.platform, e.niche, topic);
        if (!candidates.length) {
          throw new Error(
            `No relevant “${topic}” video exposed at least ${e.likesFloor.toLocaleString()} likes. Nothing was posted; try a broader spelling or lower the discovery floor.`
          );
        }
        this.log(
          "info",
          `Found ${candidates.length} relevant “${topic}” candidate${candidates.length === 1 ? "" : "s"} above the engagement floor — screening downloadable quality and watermarks.`
        );
        e.phase = "reviewing";
        stage(`Reviewing ${candidates.length} relevant result${candidates.length === 1 ? "" : "s"} for quality and watermarks…`);
        for (const candidate of candidates.slice(0, 6)) {
          const metadataMark = metadataWatermarkRisk(candidate.title);
          if (metadataMark) {
            rejected.push(`metadata watermark (${metadataMark})`);
            this.log("warn", `Skipped “${candidate.title.slice(0, 60)}”: metadata signals ${metadataMark}.`);
            continue;
          }
          if (!isTopicMatch(topic, candidate.title, candidate.url)) {
            rejected.push("low topic relevance");
            continue;
          }
          const comments = await scrapeCommentSample(page, candidate.url).catch(() => "");
          await readingPause(500, 1400);
          const judgement = await judgeCandidate({
            niche: topic,
            title: candidate.title,
            likes: candidate.likes,
            views: candidate.views,
            comments: candidate.comments,
            commentSample: comments,
          });
          if (judgement.verdict !== "post") {
            rejected.push(`review: ${judgement.reason}`);
            this.log("ai", `Skipped “${candidate.title.slice(0, 60)}”: ${judgement.reason}`);
            continue;
          }
          stage(`Downloading a relevant “${topic}” candidate for pixel-level quality and watermark checks…`);
          try {
            const video = await downloadVideo(page, this.rig.context!, candidate.url, (text) => this.log("info", text));
            await screenVideoForDiscovery(video, (text) => this.log("info", text));
            selected = {
              sourceUrl: candidate.url,
              sourceTitle: candidate.title,
              video,
              angle: judgement.angle,
            };
            break;
          } catch (error) {
            rejected.push((error as Error).message);
            this.log("warn", `Candidate failed download/quality/watermark screening: ${(error as Error).message}. Trying another result.`);
          }
        }
      } finally {
        await page.close().catch(() => undefined);
      }
      if (!selected) {
        const why = rejected.slice(-3).join("; ");
        throw new Error(
          `No “${topic}” candidate passed every relevance, engagement, downloadable-720p, and visible-watermark check${why ? ` (${why})` : ""}. Nothing was posted.`
        );
      }

      const caption = (suppliedCaption.trim() ? suppliedCaption : "") || (await writeCaption({
        niche: e.niche,
        topic,
        sourceTitle: selected.sourceTitle,
        hook: selected.angle,
      }));
      stage("Selected a clean high-quality source — preparing the 1080p upload master and source-inspired caption…");
      const video = await enhanceVideoForUpload(selected.video, (text) => this.log("info", text));
      await thinkingPause(800, 2400);
      e.phase = "posting";
      const receipt = await this.publishPreparedVideo(video, caption, selected.sourceUrl, stage);
      if (!receipt.confirmed) throw new Error(receipt.error);

      const post: WorkerPost = {
        id: uid(),
        url: receipt.recordUrl,
        sourceUrl: selected.sourceUrl,
        requestId,
        caption,
        niche: e.niche,
        topic,
        source: "ai",
        audience: "Everyone",
        postedAt: now(),
        checks: [],
        verdict: null,
      };
      this.store.addPost(this.platform, post);
      this.finishManualRequest(requestId, "succeeded", "The searched video passed every gate and the destination uploader returned a verified receipt.", {
        id: post.id,
        postedAt: post.postedAt,
        liveUrl: receipt.liveUrl,
      });
      this.rig.broadcast({
        type: "post-ok",
        postId: post.id,
        postedAt: post.postedAt,
        url: receipt.liveUrl,
        requestId,
      });
      this.log(
        "ok",
        `✅ Searched “${topic}”, selected a quality-approved watermark-screened source, and verified the destination publish${
          receipt.liveUrl ? ` at ${receipt.liveUrl.slice(0, 90)}` : " in Studio"
        }.`
      );
      e.lastRunAt = post.postedAt;
      e.errorCount = 0;
      if (e.running) {
        e.nextRunAt = nextConfirmedPostAt(post.postedAt, e.cadenceHours);
        e.phase = "waiting";
        e.message = `Posted a “${topic}” pick — confirmed. Waiting one full hour before Growth AI analyzes and posts again.`;
      } else {
        const pausedDuringPublish = manualShouldRemainPaused(e, prevPhase);
        e.phase = pausedDuringPublish ? "paused" : "idle";
        e.message = pausedDuringPublish
          ? `Publish confirmed for “${topic}”; the engine remains paused.`
          : `Posted a quality-approved “${topic}” video.`;
      }
      this.store.save();
      this.pushEngine();
      this.toast(`Posted a clean “${topic}” pick.`, "ok");
      return true;
    } catch (error) {
      const message = (error as Error).message;
      this.log("err", `Topic discovery publish failed: ${message}`);
      this.finishManualRequest(requestId, "failed", message);
      this.rig.broadcast({ type: "post-failed", message, requestId });
      this.toast(`Publish failed: ${message}`, "err");
      const pausedDuringPublish = manualShouldRemainPaused(e, prevPhase);
      e.phase = pausedDuringPublish ? "paused" : e.running ? "analyzing" : "idle";
      if (e.running) e.nextRunAt = initialEngineRunAt(now());
      e.message = `${pausedDuringPublish ? "Engine remains paused. " : ""}Nothing posted for “${topic}”: ${message.slice(0, 130)}`;
      this.store.save();
      this.pushEngine();
      return false;
    } finally {
      if (this.manualRequestId === requestId) {
        this.manualBusy = false;
        this.manualRequestId = null;
      }
      this.pushEngine();
    }
  }

  async manualPost(url: string, caption: string, rawRequestId?: string) {
    const e = this.store.engine(this.platform);
    const requestId = this.validRequestId(rawRequestId);
    if (!requestId) {
      this.rig.broadcast({ type: "post-failed", message: "The publish request id was missing or malformed." });
      return false;
    }
    const reject = (message: string, detail = message, persist = true) => {
      this.log("warn", detail);
      if (persist) this.finishManualRequest(requestId, "failed", message);
      this.rig.broadcast({ type: "post-failed", message, requestId });
      this.toast(message, "warn");
      this.pushEngine();
      return false;
    };
    if (this.manualBusy) {
      return reject("A publish is already running on this named account — wait for its receipt, then try again.", undefined, false);
    }
    if (this.inFlight) {
      return reject("The automatic engine is using this account browser right now — retry when this pass finishes.");
    }
    if (!this.publishAuthenticated()) {
      return reject(
        "Not signed in on this account — use the browser, session cookie, or YouTube Connect Google first.",
        "Manual post blocked — sign in to the browser or connect this named YouTube account to Google first."
      );
    }
    if (!/^https?:\/\//i.test((url || "").trim())) {
      return reject(
        "The source link has to be a full http(s) URL.",
        `Manual post needs a real link — got “${String(url).slice(0, 40)}”.`
      );
    }
    const cadenceBlock = this.cadenceBlockMessage(e);
    if (cadenceBlock) return reject(cadenceBlock);
    const prevPhase = e.phase;
    e.phase = "posting";
    e.message = `Publishing your link + caption (${this.audienceLabel()})…`;
    this.acceptManualRequest(requestId, e.message);
    // Each stage lands in `message`, which the deck renders under the Post button.
    const stage = (text: string) => {
      e.message = text;
      this.store.save();
      this.pushEngine();
    };
    try {
      // Resolve/download the source in a short-lived background tab. The streamed
      // tab is reserved for the destination studio, so pressing Post can no longer
      // strand the user on the source video when a CDN candidate fails.
      const grabInBackground = async () => {
        const sourcePage = await this.rig.newEnginePage();
        try {
          return await downloadVideo(sourcePage, this.rig.context!, url, (t) => this.log("info", t));
        } finally {
          await sourcePage.close().catch(() => undefined);
        }
      };
      stage("Fetching the source in a temporary background tab — the live browser is reserved for the upload studio…");
      let video: Awaited<ReturnType<typeof grabInBackground>>;
      try {
        video = await grabInBackground();
      } catch (err) {
        if (!isTabGone(err)) throw err;
        stage("The background source tab died — retrying the source once in a clean tab…");
        this.log("warn", `Source tab disappeared (${(err as Error).message}); retrying once without moving the live browser.`);
        video = await grabInBackground();
      }

      stage("Inspecting source quality and preparing a clean upload master…");
      video = await enhanceVideoForUpload(video, (t) => this.log("info", t));
      const finalCaption = caption.trim() ? caption : "Posted via ViralDeck";
      const receipt = await this.publishPreparedVideo(video, finalCaption, url, stage);
      if (!receipt.confirmed) throw new Error(receipt.error);
      const post: WorkerPost = {
        id: uid(),
        url: receipt.recordUrl,
        sourceUrl: url,
        requestId,
        caption: finalCaption,
        niche: e.niche,
        source: "manual",
        audience: "Everyone",
        postedAt: now(),
        checks: [],
        verdict: null,
      };
      this.store.addPost(this.platform, post);
      this.finishManualRequest(requestId, "succeeded", "The destination uploader returned a verified success receipt.", {
        id: post.id,
        postedAt: post.postedAt,
        liveUrl: receipt.liveUrl,
      });
      this.rig.broadcast({
        type: "post-ok",
        postId: post.id,
        postedAt: post.postedAt,
        url: receipt.liveUrl,
        requestId,
      });
      this.log(
        "ok",
        `✅ Manual publish verified${receipt.liveUrl ? ` at ${receipt.liveUrl.slice(0, 90)}` : " by the studio"} — ` +
          `${this.audienceLabel()}, caption “${finalCaption.slice(0, 60)}”.`
      );
      e.lastRunAt = post.postedAt;
      if (e.running) {
        e.nextRunAt = nextConfirmedPostAt(post.postedAt, e.cadenceHours);
        e.phase = "waiting";
        e.message = "Manual post confirmed — waiting one full hour before Growth AI analyzes and posts again.";
      } else {
        const pausedDuringPublish = manualShouldRemainPaused(e, prevPhase);
        e.phase = pausedDuringPublish ? "paused" : "idle";
        e.message = pausedDuringPublish ? "Manual publish confirmed; the engine remains paused." : "Manual publish confirmed.";
      }
      this.store.save();
      this.pushEngine();
      return true;
    } catch (err) {
      const message = (err as Error).message;
      this.log("err", `Manual publish failed: ${message}`);
      // The deck's Post button waits for one of these two answers; without this it
      // spins for its own timeout and the user is left deciding whether anything
      // ever ran. The failure says which stage died so the fix is actionable.
      this.finishManualRequest(requestId, "failed", message);
      this.rig.broadcast({ type: "post-failed", message, requestId });
      this.toast(`Publish failed: ${message}`, "err");
      const pausedDuringPublish = manualShouldRemainPaused(e, prevPhase);
      e.phase = pausedDuringPublish ? "paused" : e.running ? "analyzing" : "idle";
      if (e.running) e.nextRunAt = initialEngineRunAt(now());
      e.message = pausedDuringPublish
        ? `Engine remains paused. Manual publish failed: ${message.slice(0, 130)}`
        : `Manual publish failed: ${message.slice(0, 150)}`;
      this.store.save();
      this.pushEngine();
      return false;
    } finally {
      if (this.manualRequestId === requestId) {
        this.manualBusy = false;
        this.manualRequestId = null;
      }
      // Reconnects receive the persisted request-specific terminal result.
      this.pushEngine();
      // The user's tab is left where the destination studio put it. The source
      // page lived only in the temporary background tab and is already closed.
    }
  }
}
