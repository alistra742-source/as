import { ArrowLeft, Gauge, Radio } from "lucide-react";
import type { Platform, Room } from "../lib/types";
import { NICHE_LABEL } from "../lib/types";
import { useDeck } from "../state/deck";
import { AccountMenu } from "./AccountMenu";
import { BrowserDock } from "./BrowserDock";
import { YouTubeOAuthPanel } from "./YouTubeOAuthPanel";
import {
  ActivityLog,
  ComposerPanel,
  EnginePanel,
  PostsPanel,
  SessionCookiePanel,
  WorkerCard,
} from "./panels";
import { Chip, StatusDot, cn } from "./ui";
import { compactNumber } from "../lib/format";
import { roomAuthenticated } from "../lib/accounts";

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
  const activeAccountId = useDeck((s) => s.activeAccountIds[platform]);
  const leaveAccount = useDeck((s) => s.leaveAccount);

  if (!activeAccountId) return <AccountMenu platform={platform} />;

  const meta = META[platform];
  return (
    <div className="animate-rise space-y-4">
      <button
        onClick={() => leaveAccount(platform)}
        className="inline-flex items-center gap-2 rounded-xl border border-line bg-ink-850 px-3 py-2 text-xs font-bold text-slate-300 transition-colors hover:border-amber-500/35 hover:text-amber-300"
      >
        <ArrowLeft className="size-3.5" /> Back to {meta.title} accounts
      </button>
      <RoomHeader room={room} meta={meta} />
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_390px]">
        <div className="space-y-4">
          {platform === "youtube" && <YouTubeOAuthPanel room={room} />}
          <BrowserDock platform={platform} />
          <SessionCookiePanel room={room} />
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
  const authenticated = roomAuthenticated(room);
  const oauthOnly =
    room.platform === "youtube" &&
    room.live.youtubeOAuthConnected &&
    room.session?.state !== "logged-in";
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
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
            {room.accountName || meta.title}{" "}
            <span className="bg-gradient-to-r from-amber-300 to-amber-500 bg-clip-text text-transparent">
              · {meta.title}
            </span>
          </h1>
          <p className="mt-0.5 max-w-xl text-xs text-muted">{meta.blurb}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:ml-auto">
        <Chip tone={authenticated ? "green" : "neutral"}>
          <StatusDot tone={authenticated ? "green" : "neutral"} className="!size-1.5" />
          {authenticated ? (oauthOnly ? "Google connected" : "signed in") : room.session ? "browser open" : "no session"}
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
  const authenticated = roomAuthenticated(room);
  return (
    <span className="flex items-center gap-1 text-[11px] text-muted">
      <Gauge className="size-3.5" />
      {authenticated ? "authenticated" : room.session ? "session open" : "no session"} ·{" "}
      {room.engine.running ? "engine running" : "engine idle"}
    </span>
  );
}
