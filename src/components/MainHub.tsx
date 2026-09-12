import { ChevronRight, PlayCircle, Radar, ShieldCheck, TimerReset, TrendingUp } from "lucide-react";
import type { Platform, Room } from "../lib/types";
import { PLATFORMS } from "../lib/types";
import { useDeck } from "../state/deck";
import { Button, Chip, Panel, StatusDot, cn } from "./ui";
import { compactNumber } from "../lib/format";
import { roomAuthenticated, roomForAccount } from "../lib/accounts";

interface HubCard {
  platform: Platform;
  emoji: string;
  accent: string;
  border: string;
  name: string;
  headline: string;
  bullets: string[];
  soon?: boolean;
}

const CARDS: HubCard[] = [
  {
    platform: "tiktok",
    emoji: "🎵",
    accent: "from-rose-500/20",
    border: "hover:border-rose-500/40",
    name: "TikTok",
    headline: "Faceless growth room",
    bullets: ["Live browser to log in once", "Post a link + caption — always on Everyone", "Groq engine: 1 video/hr, 3K+ trigger"],
  },
  {
    platform: "instagram",
    emoji: "📸",
    accent: "from-violet-500/20",
    border: "hover:border-violet-500/40",
    name: "Instagram",
    headline: "Reels, same engine",
    bullets: ["Browser starts on Google for a clean sign-in", "Link + caption → posts to Everyone", "Same hourly AI review & posting loop"],
  },
  {
    platform: "youtube",
    emoji: "▶️",
    accent: "from-red-500/20",
    border: "hover:border-red-500/30",
    name: "YouTube",
    headline: "Shorts, same engine",
    bullets: ["Live browser — sign in with your Google account", "Link + caption → posts Public (Everyone)", "Same 1/hr engine, 3K+ trigger & 50K quality gate"],
  },
];

export function MainHub({ onOpen }: { onOpen: (p: Platform) => void }) {
  return (
    <div className="animate-rise space-y-6">
      <Hero onOpen={onOpen} />

      <div className="grid gap-4 md:grid-cols-3">
        {CARDS.map((c) => (
          <PlatformCard key={c.platform} card={c} onOpen={onOpen} />
        ))}
      </div>

      <HowItRuns />
    </div>
  );
}

function Hero({ onOpen }: { onOpen: (p: Platform) => void }) {
  const rooms = useDeck((s) => s.rooms);
  const accounts = useDeck((s) => s.accounts);
  const saved = useDeck((s) => s.accountRooms);
  const activeIds = useDeck((s) => s.activeAccountIds);
  const managedRooms = PLATFORMS.flatMap((platform) =>
    accounts[platform]
      .map((account) => roomForAccount(platform, account, activeIds[platform], rooms[platform], saved))
      .filter((room): room is Room => room !== null)
  );
  const running = managedRooms.filter((room) => room.engine.running).length;
  const totalPosts = managedRooms.reduce((acc, room) => acc + room.posts.length, 0);
  const totalViews = managedRooms.reduce(
    (acc, room) => acc + room.posts.reduce((a, post) => a + (post.checks.at(-1)?.views ?? 0), 0),
    0
  );

  return (
    <div className="relative overflow-hidden rounded-3xl border border-line-soft panel">
      <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-amber-400/10 blur-3xl" />
      <div className="relative flex flex-col gap-6 p-6 sm:p-8 lg:flex-row lg:items-center">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Chip tone="amber">
              <Radar className="size-3" /> AI growth engine
            </Chip>
            <Chip tone="green">
              <StatusDot tone="green" className="!size-1.5" /> {running > 0 ? `${running} running` : "armed when you Start"}
            </Chip>
          </div>
          <h1 className="mt-4 text-3xl font-black leading-tight tracking-tight text-white sm:text-4xl">
            Pick a platform.
            <br />
            <span className="bg-gradient-to-r from-amber-200 via-amber-400 to-amber-500 bg-clip-text text-transparent">
              The deck grows it for you.
            </span>
          </h1>
          <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
            Log into TikTok, Instagram or YouTube once in the live browser. Then the engine posts
            faceless stories, scary stories and fun facts — one per hour, always visible to
            Everyone — and Groq reads every post's first hour to decide what to make next.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button size="lg" onClick={() => onOpen("tiktok")}>
              🎵 TikTok room
            </Button>
            <Button size="lg" variant="dark" onClick={() => onOpen("instagram")}>
              📸 Instagram room
            </Button>
            <Button size="lg" variant="dark" onClick={() => onOpen("youtube")}>
              ▶️ YouTube room
            </Button>
          </div>
        </div>
        <div className="grid shrink-0 grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-1">
          {[
            { v: String(totalPosts), l: "posts managed" },
            { v: totalViews > 0 ? compactNumber(totalViews) : "0", l: "views tracked" },
            { v: "1/hr", l: "posting cadence" },
          ].map((s) => (
            <div key={s.l} className="rounded-2xl border border-line bg-ink-900/80 px-4 py-3 text-center lg:w-44 lg:text-left">
              <div className="font-mono text-xl font-bold text-amber-300">{s.v}</div>
              <div className="text-[11px] text-muted">{s.l}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlatformCard({
  card,
  onOpen,
}: {
  card: HubCard;
  onOpen: (p: Platform) => void;
}) {
  const activeRoom = useDeck((s) => s.rooms[card.platform]);
  const accounts = useDeck((s) => s.accounts[card.platform]);
  const saved = useDeck((s) => s.accountRooms);
  const activeId = useDeck((s) => s.activeAccountIds[card.platform]);
  const rooms = accounts
    .map((account) => roomForAccount(card.platform, account, activeId, activeRoom, saved))
    .filter((room): room is Room => room !== null);
  const views = rooms.reduce(
    (total, room) => total + room.posts.reduce((sum, post) => sum + (post.checks.at(-1)?.views ?? 0), 0),
    0
  );
  const signedIn = rooms.some((room) => roomAuthenticated(room));

  return (
    <button
      disabled={card.soon}
      onClick={() => onOpen(card.platform)}
      className={cn(
        "group relative flex flex-col overflow-hidden rounded-3xl border border-line-soft text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[0_16px_40px_-20px_rgba(0,0,0,0.9)]",
        card.border,
        card.soon ? "opacity-90" : "hover:border-amber-500/25"
      )}
    >
      <div className={cn("h-28 bg-gradient-to-br to-transparent", card.accent)}>
        <div className="flex items-start justify-between px-5 pt-4">
          <span className="text-3xl drop-shadow">{card.emoji}</span>
          {card.soon && <Chip tone="neutral">soon</Chip>}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 px-5 pb-5">
        <div>
          <h3 className="text-lg font-extrabold text-white">{card.name}</h3>
          <p className="text-xs font-semibold text-amber-300">{card.headline}</p>
        </div>
        <ul className="space-y-1.5">
          {card.bullets.map((b) => (
            <li key={b} className="flex gap-1.5 text-[11px] leading-snug text-muted">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-ink-600 group-hover:bg-amber-400/70" />
              {b}
            </li>
          ))}
        </ul>
        <div className="mt-auto flex items-center gap-2 pt-3">
          {!card.soon && (
            <>
              <Chip tone={signedIn ? "green" : "neutral"}>
                <StatusDot tone={signedIn ? "green" : "neutral"} className="!size-1.5" />
                {accounts.length
                  ? `${accounts.length} account${accounts.length === 1 ? "" : "s"}${signedIn ? " · signed in" : ""}`
                  : "no accounts"}
              </Chip>
              {views > 0 && <Chip tone="violet">👁 {compactNumber(views)}</Chip>}
            </>
          )}
          <span className="ml-auto flex items-center gap-1 text-xs font-bold text-slate-300 transition-colors group-hover:text-amber-300">
            {card.soon ? "Queue it up" : "Enter room"}
            <ChevronRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </button>
  );
}

function HowItRuns() {
  const rows = [
    {
      icon: <PlayCircle className="size-4" />,
      t: "Log in once",
      d: "The + opens a live browser. Sign in yourself — no passwords ever stored. Instagram's session starts on Google.",
    },
    {
      icon: <TrendingUp className="size-4" />,
      t: "3000+ views in an hour",
      d: "After every post, Groq reads views, likes and comments. Crossing 3K views/hour tells the engine to double down on that format.",
    },
    {
      icon: <TimerReset className="size-4" />,
      t: "One post per hour",
      d: "Whether you drop a link manually or the AI picks one, the account never posts more than 1×/hour — always audience “Everyone”.",
    },
    {
      icon: <ShieldCheck className="size-4" />,
      t: "50K+ quality gate",
      d: "No link? Groq reviews faceless clips with 50K+ likes and reads the comments. Only videos that clear review get posted.",
    },
  ];
  return (
    <Panel className="p-6">
      <div className="mb-5 flex items-center gap-2">
        <span className="font-mono text-xs font-bold text-amber-300">&gt;_</span>
        <h2 className="text-base font-bold text-white">How the engine runs</h2>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.map((r, i) => (
          <div key={r.t} className="flex gap-3 rounded-2xl border border-line bg-ink-900/60 p-4">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-amber-400/10 text-amber-300">
              {r.icon}
            </div>
            <div>
              <p className="text-sm font-bold text-slate-100">
                <span className="mr-1.5 font-mono text-[10px] text-faint">0{i + 1}</span>
                {r.t}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{r.d}</p>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
