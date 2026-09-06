import { useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  Check,
  ChevronRight,
  CircleAlert,
  Paperclip,
  Play,
  Pause,
  Send,
  Sparkles,
  Timer,
  Zap,
} from "lucide-react";
import type { EnginePhase, LogEntry, Niche, Platform, Room } from "../lib/types";
import { NICHES, NICHE_LABEL } from "../lib/types";
import { clockTime, compactNumber, countdownLabel, timeAgo } from "../lib/format";
import { useDeck } from "../state/deck";
import { Button, Chip, NumberField, Panel, PanelHeader, StatusDot, cn } from "./ui";

/* ------------------------------- Engine panel ------------------------------ */

const STEPS: { id: EnginePhase; label: string }[] = [
  { id: "analyzing", label: "Analyze" },
  { id: "discovering", label: "Discover" },
  { id: "reviewing", label: "Review" },
];

export function EnginePanel({ room }: { room: Room }) {
  const startEngine = useDeck((s) => s.startEngine);
  const stopEngine = useDeck((s) => s.stopEngine);
  const updateEngine = useDeck((s) => s.updateEngine);
  const toggleNiche = useDeck((s) => s.toggleNiche);
  const [, force] = useState(0);
  const engine = room.engine;
  const loggedIn = room.session?.state === "logged-in";
  const hasSession = !!room.session;

  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);

  const activeStep = engine.running
    ? engine.phase === "waiting" || engine.phase === "paused" || engine.phase === "idle"
      ? 3
      : STEPS.findIndex((s) => s.id === engine.phase)
    : -1;

  return (
    <Panel>
      <PanelHeader
        icon={<Zap className="size-4" />}
        title="Growth engine"
        sub={engine.running ? "Running — 1 post / hour · audience Everyone" : "Armed when you press Start"}
        right={
          engine.running ? (
            <Button variant="danger" size="sm" onClick={() => stopEngine(room.platform)}>
              <Pause className="size-3.5" /> Pause
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => startEngine(room.platform)}
              disabled={!loggedIn || !hasSession}
              title={!hasSession ? "Open a browser session first" : !loggedIn ? "Log in in the browser first" : ""}
            >
              <Play className="size-3.5" /> Start
            </Button>
          )
        }
      />

      <div className="space-y-4 p-4">
        {!hasSession && (
          <p className="rounded-lg border border-line bg-ink-900 px-3 py-2 text-xs text-muted">
            Open a browser session above, log in, then Start will arm the engine.
          </p>
        )}
        {hasSession && !loggedIn && engine.phase !== "idle" && (
          <p className="rounded-lg border border-danger-500/25 bg-danger-500/10 px-3 py-2 text-xs text-danger-400">
            <CircleAlert className="mr-1 inline size-3.5" />
            Not signed in — the engine won't act until you log in in the browser.
          </p>
        )}

        <div>
          <div className="flex items-center justify-between">
            {STEPS.map((s, i) => (
              <div key={s.id} className="flex flex-1 items-center last:flex-none">
                <div
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold",
                    engine.running && i === activeStep
                      ? "border-amber-500/40 bg-amber-400/10 text-amber-300"
                      : engine.running && i < activeStep
                        ? "border-signal-500/25 bg-signal-500/10 text-signal-300"
                        : "border-line bg-ink-900 text-muted"
                  )}
                >
                  {engine.running && i < activeStep ? (
                    <Check className="size-3" />
                  ) : engine.running && i === activeStep ? (
                    <span className="size-1.5 animate-pulse-dot rounded-full bg-amber-400" />
                  ) : null}
                  {s.label}
                </div>
                {i < STEPS.length - 1 && <ChevronRight className="mx-0.5 size-3 shrink-0 text-faint" />}
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-xl border border-line bg-ink-900/70 p-3">
            <div className="flex items-start gap-2">
              <StatusDot tone={engine.running ? "green" : "neutral"} pulse={engine.running} className="mt-1" />
              <p className="min-w-0 flex-1 text-xs leading-relaxed text-slate-300">
                {engine.message ?? (engine.running ? "Analyzing account + algorithm…" : "Engine idle — Start when signed in.")}
              </p>
            </div>
            <div className="mt-2 flex items-center gap-2 border-t border-line-soft pt-2 text-[11px] text-muted">
              <Timer className="size-3.5 text-amber-300" />
              <span>Next check in</span>
              <span className="font-mono text-sm font-bold text-slate-100">{countdownLabel(engine.nextRunAt)}</span>
              <span className="ml-auto flex items-center gap-1">
                <AlarmClock className="size-3.5" />
                {engine.lastRunAt ? `last ${timeAgo(engine.lastRunAt)}` : "never"}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-[11px] text-muted">
            Hit target (views / 1h)
            <NumberField
              className="mt-1"
              value={engine.thresholdViews}
              onChange={(v) => updateEngine(room.platform, { thresholdViews: Math.max(100, v) })}
              suffix="views"
              min={100}
            />
          </label>
          <label className="text-[11px] text-muted">
            Discovery floor (likes)
            <NumberField
              className="mt-1"
              value={engine.likesFloor}
              onChange={(v) => updateEngine(room.platform, { likesFloor: Math.max(1000, v) })}
              suffix="likes"
              min={1000}
            />
          </label>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold text-muted uppercase tracking-wider">
            Faceless niches the AI cycles through
          </p>
          <div className="flex flex-wrap gap-1.5">
            {NICHES.map((n) => {
              const on = engine.niches.includes(n.id);
              return (
                <button
                  key={n.id}
                  onClick={() => toggleNiche(room.platform, n.id)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors",
                    on
                      ? "border-signal-500/30 bg-signal-500/10 text-signal-300"
                      : "border-line bg-ink-900 text-muted hover:text-slate-300"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-3.5 items-center justify-center rounded border",
                      on ? "border-signal-400 bg-signal-400 text-ink-950" : "border-line"
                    )}
                  >
                    {on && <Check className="size-2.5" />}
                  </span>
                  {n.label}
                </button>
              );
            })}
          </div>
        </div>

        {engine.candidates.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-semibold text-muted uppercase tracking-wider">Latest AI review</p>
            <div className="space-y-1.5">
              {engine.candidates.slice(0, 3).map((c) => (
                <div key={c.id} className="rounded-lg border border-line bg-ink-900 px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <Chip tone={c.verdict === "post" ? "green" : "neutral"}>
                      {c.verdict === "post" ? "POST" : "SKIP"}
                    </Chip>
                    <span className="truncate text-[11px] text-slate-300">{c.title}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted">{compactNumber(c.likes)} ♥</span>
                  </div>
                  {c.reason && <p className="mt-1 text-[10px] leading-relaxed text-muted">{c.reason}</p>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}

/* -------------------------------- Composer --------------------------------- */

export function ComposerPanel({ room }: { room: Room }) {
  const setComposer = useDeck((s) => s.setComposer);
  const postNow = useDeck((s) => s.postNow);
  const c = room.composer;
  const loggedIn = room.session?.state === "logged-in";
  const niche = NICHE_LABEL[room.engine.activeNiche];

  return (
    <Panel>
      <PanelHeader
        icon={<Send className="size-4" />}
        title="Post to the account"
        sub={
          room.session?.mode === "demo"
            ? "Demo mode — posting is simulated"
            : "Sent to your live browser — real publish"
        }
        right={
          <Chip tone={room.session?.mode === "demo" ? "amber" : "green"}>
            audience: Everyone
          </Chip>
        }
      />
      <div className="space-y-3 p-4">
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-muted uppercase tracking-wider">
            {room.platform === "tiktok" ? "TikTok video link" : "Reel / IG video link"}
          </span>
          <input
            value={c.url}
            onChange={(e) => setComposer(room.platform, { url: e.target.value })}
            placeholder={room.platform === "tiktok" ? "https://www.tiktok.com/@user/video/…" : "https://www.instagram.com/reel/…"}
            spellCheck={false}
            className="h-10 w-full rounded-xl border border-line bg-ink-900 px-3 font-mono text-xs text-slate-200 outline-none transition-colors placeholder:text-faint focus:border-amber-400/60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-semibold text-muted uppercase tracking-wider">Caption</span>
          <textarea
            value={c.caption}
            onChange={(e) => setComposer(room.platform, { caption: e.target.value })}
            placeholder={
              room.session?.mode === "demo"
                ? `e.g. Hello — or leave empty and let Groq write one (${niche} angle)`
                : "e.g. Hello — posted exactly as written"
            }
            rows={2}
            className="w-full resize-none rounded-xl border border-line bg-ink-900 px-3 py-2.5 text-sm text-slate-200 outline-none transition-colors placeholder:text-faint focus:border-amber-400/60"
          />
        </label>
        {c.error && (
          <p className="flex items-start gap-1.5 text-xs text-danger-400">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {c.error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="md" loading={c.busy} disabled={!loggedIn} onClick={() => postNow(room.platform)}>
            {c.url.trim() ? "Post video" : <Sparkles className="size-4" />}
            {c.url.trim() ? "" : "Find & post with AI"}
          </Button>
          {!c.url.trim() && (
            <p className="max-w-[220px] text-[11px] leading-snug text-muted">
              No link? Groq scans faceless clips with 50K+ likes, reviews comments, and posts the best one — 1/hr.
            </p>
          )}
          {!loggedIn && (
            <p className="text-[11px] text-muted">Log in in the browser above first.</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* -------------------------------- Posts list ------------------------------- */

export function PostsPanel({ room }: { room: Room }) {
  const posts = [...room.posts].reverse();
  return (
    <Panel>
      <PanelHeader
        icon={<Paperclip className="size-4" />}
        title="Posts & first-hour reads"
        sub={`${posts.length} post${posts.length === 1 ? "" : "s"} · engine checks each one hourly`}
        right={<Chip tone="amber">1 post / hr</Chip>}
      />
      <div className="divide-y divide-line-soft">
        {posts.length === 0 && (
          <p className="px-5 py-8 text-center text-xs text-muted">
            Nothing posted yet. Paste a link + caption above and hit Post — or let the AI engine run and it posts for you.
          </p>
        )}
        {posts.map((p) => {
          const latest = p.checks[p.checks.length - 1];
          const isHit = p.checks.some((m) => m.views >= room.engine.thresholdViews);
          const progress = Math.min(1, (latest?.views ?? 0) / room.engine.thresholdViews);
          return (
            <div key={p.id} className="px-4 py-3 sm:px-5">
              <div className="flex items-center gap-2">
                {p.source === "manual" ? (
                  <Chip tone="neutral">MANUAL</Chip>
                ) : (
                  <Chip tone="violet">AI PICK</Chip>
                )}
                <Chip tone="neutral">{NICHE_LABEL[p.niche]}</Chip>
                <span className="ml-auto text-[10px] text-faint">{timeAgo(p.postedAt)}</span>
                {isHit && <Chip tone="green">🔥 hit</Chip>}
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-slate-300">
                {p.caption || <span className="text-faint italic">no caption</span>}
              </p>
              <p className="mt-0.5 truncate font-mono text-[10px] text-faint">{p.url}</p>
              {latest && (
                <div className="mt-2.5">
                  <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                    <div
                      className={cn("h-full rounded-full", isHit ? "bg-amber-400" : "bg-ink-600")}
                      style={{ width: `${Math.max(4, progress * 100)}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 font-mono text-[10px] text-muted">
                    <span className="text-slate-200">👁 {compactNumber(latest.views)}</span>
                    <span>♥ {compactNumber(latest.likes)}</span>
                    <span>💬 {compactNumber(latest.comments)}</span>
                    <span className="ml-auto text-faint">read {timeAgo(latest.at)} · {room.engine.thresholdViews.toLocaleString()}+ target</span>
                  </div>
                </div>
              )}
              {p.verdict && (
                <p className={cn("mt-1.5 text-[11px] leading-snug", isHit ? "text-amber-300" : "text-muted")}>
                  {p.verdict}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ------------------------------ Activity log ------------------------------- */

const LEVEL_TONE: Record<LogEntry["level"], { dot: string; text: string }> = {
  info: { dot: "bg-sky-400/70", text: "text-slate-400" },
  ok: { dot: "bg-signal-400", text: "text-signal-300" },
  warn: { dot: "bg-amber-400", text: "text-amber-300" },
  ai: { dot: "bg-violet-400", text: "text-violet-300" },
  err: { dot: "bg-danger-500", text: "text-danger-400" },
};

export function ActivityLog({ room }: { room: Room }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const logs = [...room.log].reverse();
  useEffect(() => {
    ref.current?.scrollTo({ top: 0 });
  }, [room.log.length]);
  return (
    <Panel>
      <PanelHeader
        icon={<TerminalGlyph />}
        title="Deck activity"
        sub="engine decisions, Groq reads & events"
        right={<Chip tone="neutral">{room.log.length}</Chip>}
      />
      <div ref={ref} className="max-h-72 overflow-y-auto p-3 font-mono text-[11px] scrollbar-slim">
        {logs.map((l) => {
          const tone = LEVEL_TONE[l.level];
          return (
            <div key={l.id} className="flex gap-2 px-1 py-1 leading-relaxed">
              <span className="shrink-0 text-faint">{clockTime(l.at)}</span>
              <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", tone.dot)} />
              <span className={cn("min-w-0", tone.text)}>{l.text}</span>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function TerminalGlyph() {
  return (
    <span className="font-mono text-[11px] font-bold text-amber-300">&gt;_</span>
  );
}

/* --------------------------- Worker connect card --------------------------- */

export function WorkerCard({ room }: { room: Room }) {
  const setLive = useDeck((s) => s.setLive);
  const openDemo = useDeck((s) => s.openDemoSession);
  const live = room.live;
  return (
    <Panel>
      <PanelHeader
        icon={<span className="text-base leading-none">🛰</span>}
        title="Browser worker"
        sub={live.connected ? "Connected — real browser sessions available" : "For live mode (deploy worker/ to Railway)"}
        right={
          live.connected ? (
            <Chip tone="green">● online</Chip>
          ) : (
            <Chip tone="neutral">offline</Chip>
          )
        }
      />
      <div className="space-y-2.5 p-4">
        <label className="block">
          <span className="mb-1 block text-[10px] font-semibold text-muted uppercase">Worker WebSocket URL</span>
          <input
            value={live.wsUrl}
            onChange={(e) => setLive(room.platform, { wsUrl: e.target.value })}
            placeholder="wss://your-worker.up.railway.app/ws"
            spellCheck={false}
            className="h-9 w-full rounded-lg border border-line bg-ink-900 px-2.5 font-mono text-[11px] text-slate-200 outline-none placeholder:text-faint focus:border-amber-400/60"
          />
        </label>
        <div className="flex items-center gap-2">
          <label className="block flex-1">
            <span className="mb-1 block text-[10px] font-semibold text-muted uppercase">Token</span>
            <input
              value={live.token}
              onChange={(e) => setLive(room.platform, { token: e.target.value })}
              placeholder="from WORKER_TOKEN"
              spellCheck={false}
              className="h-9 w-full rounded-lg border border-line bg-ink-900 px-2.5 font-mono text-[11px] text-slate-200 outline-none placeholder:text-faint focus:border-amber-400/60"
            />
          </label>
          <Button variant="outline" size="sm" className="mt-[18px]" onClick={() => openDemo(room.platform)}>
            Demo session
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted">
          The worker is what makes the browser “live”. Without it the deck runs in the interactive demo mode —
          everything else (posting rules, Groq engine, hourly loop) is identical.
        </p>
      </div>
    </Panel>
  );
}
