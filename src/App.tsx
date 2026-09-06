import { useEffect, useState } from "react";
import { Activity, LayoutGrid, Youtube } from "lucide-react";
import type { Platform } from "./lib/types";
import { useDeck } from "./state/deck";
import { MainHub } from "./components/MainHub";
import { PlatformRoom } from "./components/PlatformRoom";
import { Chip, StatusDot, cn } from "./components/ui";

type Tab = "main" | Platform;

const TABS: { id: Tab; label: string; icon?: "grid" | "yt" }[] = [
  { id: "main", label: "Main", icon: "grid" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" },
  { id: "youtube", label: "YouTube", icon: "yt" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("main");

  // Demo engine pump — drives demo sessions' hourly loop while the tab is open.
  useEffect(() => {
    const t = window.setInterval(() => useDeck.getState().tick(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="deck-bg flex min-h-dvh flex-col">
      <Header tab={tab} onTab={setTab} />
      <main className="mx-auto w-full max-w-6xl flex-1 px-3 pb-14 pt-5 sm:px-6">
        {tab === "main" ? (
          <MainHub onOpen={(p) => setTab(p)} />
        ) : (
          <PlatformRoom platform={tab} onBackToMain={() => setTab("main")} />
        )}
      </main>
      <footer className="border-t border-line-soft py-3 text-center text-[11px] text-faint">
        ViralDeck — your growth engine. Posting rules: 1×/hour · Everyone · 3K+/hr trigger ·
        Groq quality gate at 50K+ likes.
      </footer>
    </div>
  );
}

function Header({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const rooms = useDeck((s) => s.rooms);
  const liveRunning = (["tiktok", "instagram"] as Platform[]).filter(
    (p) => rooms[p].engine.running
  ).length;

  return (
    <header className="sticky top-0 z-30 border-b border-line-soft bg-ink-950/85 backdrop-blur">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-3 py-2.5 sm:px-6">
        <button onClick={() => onTab("main")} className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-xl bg-gradient-to-br from-amber-300 to-amber-600 font-mono text-sm font-black text-ink-950 shadow-[0_0_18px_-4px_rgba(245,158,11,0.7)]">
            VD
          </span>
          <span className="hidden flex-col items-start leading-none sm:flex">
            <span className="text-[15px] font-black tracking-tight text-white">ViralDeck</span>
            <span className="text-[10px] font-medium text-muted">AI growth · faceless content</span>
          </span>
        </button>

        <nav className="ml-2 flex flex-1 items-center gap-1 overflow-x-auto scrollbar-slim sm:ml-6">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition-colors",
                tab === t.id
                  ? "bg-ink-800 text-amber-300"
                  : "text-muted hover:text-slate-200"
              )}
            >
              {t.icon === "grid" && <LayoutGrid className="size-4" />}
              {t.icon === "yt" && <Youtube className="size-4 text-red-500" />}
              {t.label}
              {t.id !== "main" &&
                t.id !== "youtube" &&
                rooms[t.id as Platform].session && (
                  <span
                    className={cn(
                      "size-1.5 rounded-full",
                      rooms[t.id as Platform].session!.state === "logged-in"
                        ? "bg-signal-400"
                        : "bg-faint"
                    )}
                  />
                )}
              {tab === t.id && (
                <span className="absolute inset-x-2 -bottom-[1px] h-0.5 rounded-full bg-amber-400" />
              )}
            </button>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-1.5">
          {liveRunning > 0 ? (
            <Chip tone="green">
              <StatusDot tone="green" className="!size-1.5" />
              {liveRunning} engine{liveRunning > 1 ? "s" : ""} live
            </Chip>
          ) : (
            <Chip tone="neutral">
              <Activity className="size-3" />
              idle
            </Chip>
          )}
        </div>
      </div>
    </header>
  );
}
