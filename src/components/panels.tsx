import { useEffect, useRef, useState } from "react";
import {
  AlarmClock,
  Check,
  ChevronRight,
  CircleAlert,
  KeyRound,
  Paperclip,
  ShieldCheck,
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
import { sendBusCmd, sendBusCookie } from "../lib/liveBus";

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
            Source video link — TikTok, Instagram or YouTube
          </span>
          <input
            value={c.url}
            onChange={(e) => setComposer(room.platform, { url: e.target.value })}
            placeholder="https://www.tiktok.com/@user/video/… · /reel/… · watch?v=…"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            className="h-10 w-full rounded-xl border border-line bg-ink-900 px-3 font-mono text-xs text-slate-200 outline-none transition-colors placeholder:text-faint focus:border-amber-400/60"
          />
          <span className="mt-1 block text-[11px] leading-snug text-muted">
            The link is where the video is *taken from* — any of the three sites works, and it is published to{" "}
            <span className="text-slate-300">{room.platform === "tiktok" ? "TikTok" : room.platform === "youtube" ? "YouTube" : "Instagram"}</span>.
            The worker pulls the file the source page itself plays (its own mp4, not a screenshot), so
            cross-posting a Reel to TikTok is the normal case. If a site refuses this server, the log says
            which stage refused it.
          </span>
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
        {c.busy && room.engine.message && (
          <p className="flex items-start gap-1.5 text-xs text-amber-300">
            <Timer className="mt-0.5 size-3.5 shrink-0 animate-pulse" /> {room.engine.message}
          </p>
        )}
        {c.error && (
          <p className="flex items-start gap-1.5 text-xs text-danger-400">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {c.error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="md"
            loading={c.busy}
            disabled={!loggedIn}
            title={!loggedIn ? "Sign in in the browser (or paste a session cookie) first" : ""}
            onClick={() => postNow(room.platform)}
          >
            {c.url.trim() ? (c.busy ? "Grabbing video + publishing…" : "Post video") : <Sparkles className="size-4" />}
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
        sub={live.connected ? "Connected — remote browser sessions ready" : "Optional — empty = auto-connect to this app's backend"}
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
            placeholder="leave empty to auto-connect (same domain)"
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
              placeholder="optional (only if the backend sets WORKER_TOKEN)"
              spellCheck={false}
              className="h-9 w-full rounded-lg border border-line bg-ink-900 px-2.5 font-mono text-[11px] text-slate-200 outline-none placeholder:text-faint focus:border-amber-400/60"
            />
          </label>
          <Button variant="outline" size="sm" className="mt-[18px]" onClick={() => openDemo(room.platform)}>
            Demo session
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted">
          Deployed as one service, the app serves its own browser backend — leave both fields empty and live
          mode just works. Set a custom URL/token only when pointing at a separate worker. The worker launches
          <span className="text-slate-300"> stock Chromium through Playwright</span> by default (raw CDP, no
          WebDriver layer, every click/keypress sent as trusted humanized input), and can switch to the
          <span className="text-slate-300"> Clearcote</span> anti-fingerprint build with
          <span className="font-mono"> BROWSER_ENGINE=clearcote</span> — same profile dir, so the switch keeps
          your logins. The dock badge above shows which one is live.
        </p>
      </div>
    </Panel>
  );
}

/* ------------------------- Sign in with a session cookie ------------------------- */

const COOKIE_FIELD: Record<Platform, { name: string; site: string; via: string }> = {
  tiktok: {
    name: "sessionid",
    site: "https://www.tiktok.com",
    via: "DevTools → Application → Cookies → www.tiktok.com → copy the value of sessionid",
  },
  instagram: {
    name: "sessionid",
    site: "https://www.instagram.com",
    via: "DevTools → Application → Cookies → www.instagram.com → copy the value of sessionid",
  },
  youtube: {
    name: "SID",
    site: "https://www.youtube.com",
    via: "DevTools → Application → Cookies → www.youtube.com → copy the value of SID",
  },
};

/**
 * Login without touching the remote browser.
 *
 * The verification screen in a streamed tab is the one place this product can
 * stall: a 60 px row that has to be hit through a JPEG, at the wrong scale, on a
 * phone. The click path has three fallbacks now, and this is the fourth door —
 * paste the cookie your own signed-in browser already holds and the profile
 * becomes you, no coordinates involved.
 *
 * It deliberately stops at "signed in". The engine arms only on the deck's Start
 * button, and this panel never touches it; if the engine is already running the
 * write is refused, because swapping the session out from under a posting loop
 * would make it publish on an account that was never armed.
 */
export function SessionCookiePanel({ room }: { room: Room }) {
  const p = room.platform;
  const live = room.live;
  const addLog = useDeck((s) => s.addLog);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"apply" | "clear" | null>(null);
  const hint = COOKIE_FIELD[p];
  const loggedIn = room.session?.state === "logged-in";
  const installed = !!live.cookieAt;
  const running = room.engine.running;

  // The worker answers with cookie-state once the jar is written (and on every
  // connect), so that is the only honest signal that the paste finished.
  useEffect(() => {
    setBusy(null);
  }, [live.cookieAt, live.cookieNames.join(",")]);
  useEffect(() => {
    if (!busy) return;
    const t = window.setTimeout(() => setBusy(null), 45_000);
    return () => window.clearTimeout(t);
  }, [busy]);

  const log = (level: "info" | "ok" | "warn", text: string) =>
    addLog(p, [{ id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), level, text }]);

  function apply() {
    const raw = value.trim();
    if (!raw) return;
    if (running) return;
    if (!sendBusCookie(p, "apply", raw)) {
      log("warn", "No worker socket open — the live browser above has to be connected before there is a profile to sign in.");
      return;
    }
    // Drop the paste from component state immediately: it should not linger in a
    // render, a React tree snapshot, or anything that gets persisted.
    setValue("");
    setBusy("apply");
    log("info", `Installing a ${raw.length}-character session in the ${p} profile and reloading the site…`);
  }

  function clear() {
    if (!sendBusCookie(p, "clear")) {
      log("warn", "No worker socket open — nothing to clear.");
      return;
    }
    setBusy("clear");
    log("info", "Emptying this profile's cookie jar (signs the session out, device ids included).");
  }

  return (
    <Panel>
      <PanelHeader
        icon={<KeyRound className="size-4" />}
        title="Session cookie — sign in without clicking"
        sub={`Paste ${hint.name} from a browser already signed in to ${hint.site}`}
        right={
          loggedIn ? (
            <Chip tone="green">● signed in</Chip>
          ) : installed ? (
            <Chip tone="amber">cookie installed</Chip>
          ) : (
            <Chip tone="neutral">no cookie</Chip>
          )
        }
      />
      <div className="space-y-2.5 p-4">
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={3}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          enterKeyHint="done"
          placeholder={`${hint.name}=abc123…   ·   or the whole Cookie: header   ·   or just the bare value`}
          className="w-full resize-y rounded-lg border border-line bg-ink-900 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-slate-200 outline-none placeholder:text-faint focus:border-amber-400/60"
        />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={apply}
            loading={busy === "apply"}
            disabled={!value.trim() || running}
            title={running ? "Pause the engine before changing the session" : "Write it into the browser profile and reload"}
          >
            <Check className="size-3.5" /> Apply &amp; sign in
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={clear}
            loading={busy === "clear"}
            disabled={!installed || !live.connected}
            title={live.connected ? "Empty this profile's cookie jar" : "Open the live browser first"}
          >
            Clear
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!sendBusCmd(p, { t: "check-upload" })) {
                log("warn", "No worker socket open — there is no browser to check.");
                return;
              }
              log("info", "Asking the upload studio whether this session may post… (it opens in the browser tab)");
            }}
            disabled={!live.connected || !loggedIn}
            title={
              !live.connected
                ? "Open the live browser first"
                : !loggedIn
                  ? "Sign in first — the studio has to be reached as you"
                  : "Open the upload page and report whether it lets this session pick a file"
            }
          >
            <ShieldCheck className="size-3.5" /> Can it post?
          </Button>
          <span className="ml-auto whitespace-nowrap font-mono text-[10px] text-faint">
            {installed
              ? `${live.cookieNames.slice(0, 2).join(", ")}${
                  live.cookieNames.length > 2 ? ` +${live.cookieNames.length - 2}` : ""
                } · ${timeAgo(live.cookieAt as number)}`
              : "not saved here"}
          </span>
        </div>

        <p className="text-[11px] leading-snug text-muted">
          <span className="text-slate-300">Start is still yours.</span> Applying a cookie only makes the profile
          you — nothing is posted and the engine does not arm until you press Start. Where it came from:{" "}
          <span className="text-slate-300">{hint.via}</span> (a whole <span className="font-mono">Cookie:</span>{" "}
          header works too).
        </p>

        {running && (
          <p className="rounded-lg border border-amber-500/25 bg-amber-400/5 px-3 py-2 text-[11px] leading-snug text-amber-200">
            The engine is running on the current session — press Pause before swapping accounts, so it can never
            post on a profile you did not arm.
          </p>
        )}
        {!live.connected && (
          <p className="rounded-lg border border-line bg-ink-900 px-3 py-2 text-[11px] leading-snug text-muted">
            Not connected to a worker yet — open the live browser above so there is a profile to write into.
          </p>
        )}

        <details className="rounded-lg border border-line bg-ink-900/60 px-3 py-2">
          <summary className="cursor-pointer text-[11px] font-semibold text-slate-300">
            Where the cookie goes (read once)
          </summary>
          <ul className="mt-2 space-y-1 text-[11px] leading-snug text-muted">
            <li>
              · It is sent once, over your own worker socket, straight into the browser profile&apos;s cookie jar —
              the persistent one the manual tab and every engine run already share.
            </li>
            <li>
              · It is never written to the deck&apos;s saved state, never printed in the activity log, and never
              echoed back in a toast: only cookie <span className="text-slate-300">names</span> and dates are
              reported.
            </li>
            <li>
              · Clear empties the whole jar, including the device ids the site uses to trust this browser, so the
              next manual sign-in may ask for a code.
            </li>
            <li>
              · A TikTok session usually lives ~30 days; when it dies the site shows you signed out and you paste a
              fresh one.
            </li>
          </ul>
        </details>
      </div>
    </Panel>
  );
}
