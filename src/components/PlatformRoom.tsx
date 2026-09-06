import { Gauge, Radio } from "lucide-react";
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
import { Chip, StatusDot, cn } from "./ui";
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
    tag: "Shorts growth room",
    blurb: "Sign in with Google once in the browser, then videos + Shorts post 1/hr — visibility Public (Everyone) — with the same AI engine.",
  },
};

const THEME: Record<Platform, { emoji: string; cls: string }> = {
  tiktok: { emoji: "🎵", cls: "border-rose-500/30 bg-rose-500/10" },
  instagram: { emoji: "📸", cls: "border-violet-500/30 bg-violet-500/10" },
  youtube: { emoji: "▶️", cls: "border-red-500/30 bg-red-500/10" },
};

export function PlatformRoom({
  platform,
}: {
  platform: Platform;
}) {
  const room = useDeck((s) => s.rooms[platform]);

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
  return (      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-3">
          <div
            className={cn(
              "flex size-11 items-center justify-center rounded-2xl border text-xl",
              THEME[room.platform].cls
            )}
          >
            {THEME[room.platform].emoji}
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

export function MiniStatus({ platform }: { platform: Platform }) {
  const room = useDeck((s) => s.rooms[platform]);
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted">
      <Gauge className="size-3.5" />
      {room.session ? (room.session.state === "logged-in" ? "signed in" : "session open") : "no session"} ·{" "}
      {room.engine.running ? "engine running" : "engine idle"}
    </span>
  );
}
