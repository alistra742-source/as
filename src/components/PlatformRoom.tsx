import {
  ArrowLeft,
  Clapperboard,
  Gauge,
  Radio,
  Sparkles,
} from "lucide-react";
import type { Platform, Room } from "../lib/types";
import { NICHE_LABEL } from "../lib/types";
import { useDeck } from "../state/deck";
import { BrowserDock } from "./BrowserDock";
import {
  ActivityLog,
  ComposerPanel,
  EnginePanel,
  PostsPanel,
  WorkerCard,
} from "./panels";
import { Chip, Panel, StatusDot, cn } from "./ui";
import { compactNumber } from "../lib/format";

const META: Record<Platform, { title: string; tag: string; blurb: string }> = {
  tiktok: {
    title: "TikTok",
    tag: "faceless growth room",
    blurb: "Log in once, then the engine posts 1 faceless video per hour — stories, scary stories or fun facts — always on Everyone.",
  },
  instagram: {
    title: "Instagram",
    tag: "faceless growth room",
    blurb: "Browser opens on Google (same as your note) so you can sign in cleanly. Reels post 1/hr with the same AI engine.",
  },
  youtube: {
    title: "YouTube",
    tag: "coming next",
    blurb: "Same deck, Shorts uploads and channel analytics — on the next build.",
  },
};

export function PlatformRoom({
  platform,
  onBackToMain,
}: {
  platform: Platform;
  onBackToMain?: () => void;
}) {
  const room = useDeck((s) => s.rooms[platform]);

  if (platform === "youtube") return <YouTubeSoon onBack={onBackToMain} />;

  const meta = META[platform];
  return (
    <div className="animate-rise space-y-4">
      <RoomHeader room={room} meta={meta} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_390px]">
        <div className="space-y-4">
          <BrowserDock platform={platform} />
          <ComposerPanel room={room} />
        </div>
        <div className="space-y-4">
          <EnginePanel room={room} />
          <WorkerCard room={room} />
          <PostsPanel room={room} />
          <ActivityLog room={room} />
        </div>
      </div>
    </div>
  );
}

function RoomHeader({
  room,
  meta,
}: {
  room: Room;
  meta: { title: string; tag: string; blurb: string };
}) {
  const totalViews = room.posts.reduce((acc, p) => acc + (p.checks.at(-1)?.views ?? 0), 0);
  const hits = room.posts.filter((p) =>
    p.checks.some((m) => m.views >= room.engine.thresholdViews)
  ).length;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "flex size-11 items-center justify-center rounded-2xl border text-xl",
            room.platform === "tiktok"
              ? "border-rose-500/30 bg-rose-500/10"
              : "border-violet-500/30 bg-violet-500/10"
          )}
        >
          {room.platform === "tiktok" ? "🎵" : "📸"}
        </div>
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-white">
            {meta.title}{" "}
            <span className="bg-gradient-to-r from-amber-300 to-amber-500 bg-clip-text text-transparent">
              {meta.tag}
            </span>
          </h1>
          <p className="mt-0.5 max-w-xl text-xs text-muted">{meta.blurb}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
        <Chip tone={room.session ? (room.session.state === "logged-in" ? "green" : "neutral") : "neutral"}>
          <StatusDot
            tone={room.session?.state === "logged-in" ? "green" : "neutral"}
            className="!size-1.5"
          />
          {room.session ? (room.session.state === "logged-in" ? "signed in" : "browser open") : "no session"}
        </Chip>
        <Chip tone={room.engine.running ? "green" : "neutral"}>
          <Radio className="size-3" />
          engine {room.engine.running ? "running" : "idle"}
        </Chip>
        <Chip tone="amber">{NICHE_LABEL[room.engine.activeNiche]} next</Chip>
        {totalViews > 0 && <Chip tone="violet">👁 {compactNumber(totalViews)} total views</Chip>}
        {hits > 0 && <Chip tone="green">🔥 {hits} hit{hits === 1 ? "" : "s"}</Chip>}
      </div>
    </div>
  );
}

function YouTubeSoon({ onBack }: { onBack?: () => void }) {
  return (
    <div className="animate-rise space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex size-11 items-center justify-center rounded-2xl border border-red-500/30 bg-red-500/10 text-xl">
          ▶️
        </div>
        <div>
          <h1 className="text-xl font-extrabold tracking-tight text-white">
            YouTube <span className="text-muted">· coming next</span>
          </h1>
          <p className="text-xs text-muted">You said you'd fix YouTube soon — this room is wired to accept it.</p>
        </div>
      </div>
      <Panel className="p-6">
        <div className="mx-auto max-w-md space-y-4 text-center">
          <Clapperboard className="mx-auto size-10 text-red-400" />
          <h2 className="text-lg font-bold text-white">Same deck, Shorts next</h2>
          <ul className="space-y-2 text-left text-sm text-muted">
            {[
              ["Live browser room", "Log in to YouTube Studio the same way as TikTok/IG."],
              ["Upload Shorts", "Link + caption → posts Short as “Everyone”, 1 per hour."],
              ["Groq performance loop", "3K+ views/hour flips the engine into similar-content mode."],
              ["Analytics", "Channel-level reads so the deck plans uploads around winners."],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-2.5">
                <Sparkles className="mt-0.5 size-4 shrink-0 text-amber-300" />
                <span>
                  <strong className="text-slate-200">{t}</strong> — {d}
                </span>
              </li>
            ))}
          </ul>
          {onBack && (
            <button
              onClick={onBack}
              className="inline-flex items-center gap-1.5 text-sm font-semibold text-amber-300 hover:text-amber-200"
            >
              <ArrowLeft className="size-4" /> Back to Main
            </button>
          )}
        </div>
      </Panel>
    </div>
  );
}

export function MiniStatus({ platform }: { platform: Platform }) {
  const room = useDeck((s) => s.rooms[platform]);
  if (room.platform === "youtube") return null;
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted">
      <Gauge className="size-3.5" />
      {room.session ? (room.session.state === "logged-in" ? "signed in" : "session open") : "no session"} ·{" "}
      {room.engine.running ? "engine running" : "engine idle"}
    </span>
  );
}
