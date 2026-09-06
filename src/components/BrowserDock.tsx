import { useCallback, useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Globe,
  Home,
  Keyboard,
  Loader2,
  Lock,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  WifiOff,
  X,
} from "lucide-react";
import type { Platform } from "../lib/types";
import { START_URL } from "../lib/types";
import type { RemoteCmd } from "../lib/protocol";
import { connectLive, defaultWorkerUrl, sendBusCmd } from "../lib/liveBus";
import { useDeck } from "../state/deck";
import { Chip, StatusDot, cn } from "./ui";
import { DemoBrowser } from "./DemoBrowser";

export function BrowserDock({ platform }: { platform: Platform }) {
  const session = useDeck((s) => s.rooms[platform].session);
  const isLive = session?.mode === "live";
  return (
    <div className="panel flex flex-col overflow-hidden rounded-2xl border border-line-soft bg-ink-850">
      <DockToolbar platform={platform} />
      {session ? (isLive ? <LiveViewport platform={platform} /> : <DemoViewport platform={platform} />) : (
        <NoSession platform={platform} />
      )}
    </div>
  );
}

/* -------------------------------- toolbar -------------------------------- */

function DockToolbar({ platform }: { platform: Platform }) {
  const room = useDeck((s) => s.rooms[platform]);
  const setSession = useDeck((s) => s.setSession);
  const openDemo = useDeck((s) => s.openDemoSession);
  const closeSession = useDeck((s) => s.closeSession);
  const [urlDraft, setUrlDraft] = useState(room.session?.url ?? "");

  useEffect(() => setUrlDraft(room.session?.url ?? ""), [room.session?.url]);

  const loggedIn = room.session?.state === "logged-in";
  const isLive = room.session?.mode === "live";

  return (
    <div className="border-b border-line-soft">
      <div className="flex items-center gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <StatusDot tone={loggedIn ? "green" : isLive ? "amber" : "neutral"} pulse={isLive} />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
            {room.session ? (loggedIn ? "Signed in" : isLive ? "Browser live" : "Browser open") : "No session"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {room.session?.mode === "demo" && <Chip tone="amber" className="font-mono">SIMULATED</Chip>}
          {room.session?.mode === "live" && <Chip tone="green">live worker</Chip>}
          {room.session && (
            <button
              onClick={() => closeSession(platform)}
              className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-ink-700 hover:text-danger-400"
              title="Close browser session"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 px-3 pb-2.5">
        <button
          disabled={!room.session}
          onClick={() => openDemo(platform)}
          className="flex size-7 items-center justify-center rounded-lg border border-line bg-ink-800 text-slate-300 hover:bg-ink-700 disabled:opacity-30"
          title="Reopen demo session"
        >
          <RotateCcw className="size-3.5" />
        </button>
        <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-line bg-ink-900/80 px-2.5">
          <Lock className="size-3 shrink-0 text-faint" />
          <input
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && urlDraft.trim()) {
                const target = /^https?:\/\//.test(urlDraft.trim()) ? urlDraft.trim() : `https://${urlDraft.trim()}`;
                if (room.session?.mode === "demo") setSession(platform, { url: target });
                else sendBusCmd(platform, { t: "navigate", url: target });
                setUrlDraft(target);
              }
            }}
            spellCheck={false}
            placeholder="Enter a web address…"
            className="min-w-0 flex-1 bg-transparent font-mono text-[12px] text-slate-300 outline-none placeholder:text-faint"
          />
        </div>
      </div>
      <div className="scrollbar-slim flex items-center gap-1.5 overflow-x-auto px-3 pb-2.5">
        {(
          platform === "tiktok"
            ? [START_URL.tiktok, "https://www.tiktok.com/foryou"]
            : platform === "instagram"
              ? [START_URL.instagram, "https://www.instagram.com/"]
              : [START_URL.youtube, "https://www.youtube.com/shorts", "https://studio.youtube.com/"]
        ).map((u) => (
          <button
            key={u}
            onClick={() => {
              if (room.session?.mode === "live") sendBusCmd(platform, { t: "navigate", url: u });
              else if (room.session) setSession(platform, { url: u });
            }}
            className={cn(
              "whitespace-nowrap rounded-md border border-line px-2 py-1 text-[11px] font-medium text-muted hover:bg-ink-700 hover:text-slate-200",
              room.session?.url === u && "border-amber-500/30 bg-amber-400/10 text-amber-300"
            )}
          >
            {u.replace("https://www.", "")}
          </button>
        ))}
        {platform === "instagram" && (
          <span className="whitespace-nowrap text-[10px] text-faint">starts on Google — same flow as TikTok</span>
        )}
        {platform === "youtube" && room.session?.mode === "live" && (
          <span className="whitespace-nowrap text-[10px] text-faint">log in on youtube.com · uploads run via Studio</span>
        )}
      </div>
    </div>
  );
}

/* ----------------------------- demo viewport ------------------------------ */

function DemoViewport({ platform }: { platform: Platform }) {
  return (
    <div className="relative bg-ink-950">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex justify-center">
        <div className="mt-1.5 rounded-full border border-amber-500/30 bg-ink-950/90 px-3 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-amber-300">
          DEMO BROWSER — interactive, no real network
        </div>
      </div>
      <div className="mx-auto aspect-[9/16] max-h-[560px] w-full max-w-[420px] overflow-hidden sm:rounded-b-2xl">
        <DemoBrowser platform={platform} />
      </div>
    </div>
  );
}

/* ------------------------------ live viewport ------------------------------ */

function LiveViewport({ platform }: { platform: Platform }) {
  const room = useDeck((s) => s.rooms[platform]);
  const setLive = useDeck((s) => s.setLive);
  const setSession = useDeck((s) => s.setSession);
  const addLog = useDeck((s) => s.addLog);
  const applyLiveEngine = useDeck((s) => s.applyLiveEngine);
  const applyLivePostOk = useDeck((s) => s.applyLivePostOk);
  const [frame, setFrame] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const { wsUrl, token } = room.live;

  useEffect(() => {
    // Empty URL = same-origin auto-connect (single-service deploy).
    const url = wsUrl.trim() || defaultWorkerUrl();
    const disconnect = connectLive(platform, url, token, {
      onFrame: (data) => setFrame(data),
      onNav: (url) => {
        setSession(platform, { url });
      },
      onLogin: (loggedIn) => setSession(platform, { state: loggedIn ? "logged-in" : "open" }),
      onLog: (level, text) => {
        const known = ["info", "ok", "warn", "ai", "err"];
        addLog(platform, [
          {
            id: `l-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            at: Date.now(),
            level: (known.includes(level) ? level : "info") as "info",
            text,
          },
        ]);
      },
      onEngine: (state) => applyLiveEngine(platform, state),
      onPostOk: (_id, _at, url) => applyLivePostOk(platform, url),
      onReady: (url) => {
        setSession(platform, { url, state: "open" });
      },
      onInputFocus: () => setKbOpen(true),
      onError: (message) => setLive(platform, { lastError: message }),
      onStateChange: (ok) => {
        setConnected(ok);
        if (!ok) {
          // Auto-retry while the room is open and the worker is configured.
          window.setTimeout(() => setAttempt((a) => a + 1), 6000);
        }
      },
    });
    return disconnect;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, wsUrl, token, attempt]);

  useEffect(() => setLive(platform, { connected }), [connected, platform, setLive]);

  const send = useCallback((cmd: RemoteCmd) => sendBusCmd(platform, cmd), [platform]);

  const onPointerDown = () => {
    drag.current = { x: 0, y: 0, moved: false };
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const dy = e.movementY;
    if (Math.abs(dy) > 2 || drag.current.moved) {
      drag.current.moved = true;
      send({ t: "scroll", dy });
    }
  };
  const onPointerUp = (e: RPointerEvent<HTMLDivElement>) => {
    const el = viewportRef.current;
    const wasDrag = drag.current?.moved;
    drag.current = null;
    if (!el || wasDrag) return;
    const rect = el.getBoundingClientRect();
    send({
      t: "tap",
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    });
  };

  return (
    <div className="bg-ink-950">
      <div className="mx-auto max-w-[900px]">
        <div className="flex items-center gap-2 px-3 pb-2 pt-2.5">
          <IconBtn onClick={() => send({ t: "back" })} title="Back"><ArrowLeft className="size-3.5" /></IconBtn>
          <IconBtn onClick={() => send({ t: "forward" })} title="Forward"><ArrowRight className="size-3.5" /></IconBtn>
          <IconBtn onClick={() => send({ t: "reload" })} title="Reload"><RefreshCw className="size-3.5" /></IconBtn>
          <IconBtn onClick={() => send({ t: "home" })} title="Platform home"><Home className="size-3.5" /></IconBtn>
          <div className="ml-1 flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-ink-900 px-2">
            <Globe className="size-3 shrink-0 text-faint" />
            <span className="truncate font-mono text-[11px] text-slate-400">{room.session?.url ?? ""}</span>
          </div>
          <button
            onClick={() => setKbOpen((v) => !v)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-semibold transition-colors",
              kbOpen
                ? "border-amber-500/50 bg-amber-400/15 text-amber-300"
                : "border-line bg-ink-800 text-slate-300 hover:bg-ink-700"
            )}
          >
            <Keyboard className="size-3.5" />
            Keyboard
          </button>
        </div>

        {!connected && (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Loader2 className="size-6 animate-spin text-amber-400" />
            <p className="text-sm text-muted">Connecting to your Railway browser worker…</p>
            {room.live.lastError && <p className="max-w-sm px-4 text-xs text-danger-400">{room.live.lastError}</p>}
          </div>
        )}

        {connected && (
          <div className="px-3 pb-3">
            <div
              ref={viewportRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={() => (drag.current = null)}
              onWheel={(e) => send({ t: "scroll", dy: e.deltaY })}
              className="relative aspect-[16/10] w-full cursor-crosshair touch-none select-none overflow-hidden rounded-xl border border-line bg-ink-900"
            >
              {frame ? (
                <img src={`data:image/jpeg;base64,${frame}`} alt="Live browser" draggable={false} className="h-full w-full object-contain" />
              ) : (
                <div className="flex h-full items-center justify-center text-xs text-faint">waiting for first frame…</div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-2">
                <div className="flex items-center gap-1.5 rounded-full border border-line bg-ink-950/85 px-3 py-1 text-[10px] text-slate-300">
                  <MousePointer2 className="size-3 text-amber-300" />
                  tap to click · drag to scroll · tap a field and your phone keyboard opens
                </div>
              </div>
            </div>
          </div>
        )}

        {kbOpen && connected && <TypeCapture onKey={(cmd) => send(cmd)} onClose={() => setKbOpen(false)} />}
      </div>
    </div>
  );
}

function IconBtn({ children, onClick, title }: { children: React.ReactNode; onClick: () => void; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="flex size-6 items-center justify-center rounded-md text-faint hover:bg-ink-700 hover:text-slate-200"
    >
      {children}
    </button>
  );
}

/* ------------------------------ type capture ------------------------------ */

/**
 * Real, visible capture bar: focusing it summons the user's OWN device
 * keyboard (a zero-size hidden input does not work on iOS). Every keystroke is
 * forwarded to the focused field in the live browser; the bar itself never
 * accumulates text. No in-app keypad — the device keyboard does all the work.
 */
function TypeCapture({ onKey, onClose }: { onKey: (cmd: RemoteCmd) => void; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    // Keep focus so keystrokes keep flowing to the live browser.
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="border-t border-line-soft bg-ink-900 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Keyboard className="size-4 shrink-0 text-amber-300" />
        <p className="flex-1 text-xs text-muted">
          Your device keyboard is live — what you type goes into the focused field in the browser.
        </p>
        <button
          onClick={onClose}
          title="Done typing"
          className="flex size-6 items-center justify-center rounded-md text-faint hover:text-slate-200"
        >
          <X className="size-4" />
        </button>
      </div>
      <input
        ref={inputRef}
        autoFocus
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        value=""
        onBeforeInput={(e) => e.preventDefault()}
        onChange={() => {
          /* keystrokes are forwarded from keydown; this bar never stores text */
        }}
        onKeyDown={(e) => {
          if (e.key === "Backspace") {
            e.preventDefault();
            onKey({ t: "key", key: "Backspace" });
          } else if (e.key === "Enter") {
            e.preventDefault();
            onKey({ t: "key", key: "Enter" });
          } else if (e.key.length === 1) {
            e.preventDefault();
            onKey({ t: "type", text: e.key });
          }
        }}
        placeholder="Type here — it goes to the live browser field"
        className="h-11 w-full rounded-xl border border-amber-500/30 bg-ink-950 px-3 text-base text-slate-200 caret-amber-400 outline-none placeholder:text-faint focus:border-amber-400/60"
      />
    </div>
  );
}

/* ------------------------------- no session ------------------------------- */

function NoSession({ platform }: { platform: Platform }) {
  const room = useDeck((s) => s.rooms[platform]);
  const openDemo = useDeck((s) => s.openDemoSession);
  const openLive = useDeck((s) => s.openLiveSession);
  // Always enabled — with an empty Worker card the deck auto-connects to the
  // same-domain backend (single-service deploy).
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <div className="flex size-14 items-center justify-center rounded-2xl border border-dashed border-line bg-ink-800 text-amber-300">
        {platform === "tiktok" ? "🎵" : platform === "youtube" ? "▶️" : "📸"}
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-200">No browser session yet</p>
        <p className="mx-auto mt-1 max-w-sm text-xs text-muted">
          Log in once in the live browser, then the engine takes over. No worker connected yet? The
          interactive demo below shows the exact same flow.
        </p>
      </div>
      <div className="flex flex-col items-center gap-2">
        <button
          onClick={() => openLive(platform)}
          title="Open a real browser driven by the app's backend"
          className="inline-flex items-center gap-2 rounded-xl bg-amber-400 px-5 py-2.5 text-sm font-bold text-ink-950 shadow-[0_0_22px_-6px_rgba(245,158,11,0.6)] hover:bg-amber-300 active:scale-[0.98]"
        >
          <span className="text-base leading-none">＋</span> Live browser
        </button>
        <button
          onClick={() => openDemo(platform)}
          className="inline-flex items-center gap-2 rounded-xl border border-line bg-ink-800 px-4 py-2 text-xs font-semibold text-slate-300 hover:bg-ink-700"
        >
          Try the interactive demo instead
        </button>
      </div>
      <p className="max-w-xs text-[11px] text-faint">
        Live connects to this app's backend automatically (Worker card is optional) — or just start with the demo.
      </p>
    </div>
  );
}

export function LiveDisconnectedHint() {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-line bg-ink-800/60 p-3 text-xs text-muted">
      <WifiOff className="mt-0.5 size-4 shrink-0 text-faint" />
      <p>
        Live mode needs the Node backend — deploy this repo as one service (it serves the app
        <span className="text-slate-300"> and</span> the browser socket). The deck auto-connects on the same domain;
        the <span className="text-slate-300">Worker card</span> fields are only for pointing at a separate worker.
      </p>
    </div>
  );
}
