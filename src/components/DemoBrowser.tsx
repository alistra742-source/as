import { useState } from "react";
import { AtSign, Heart, Lock, MessageCircle, Play, Search } from "lucide-react";
import type { Platform } from "../lib/types";
import { compactNumber } from "../lib/format";
import { DEMO_CANDIDATES, DEMO_USER } from "../data/demo";
import { useDeck } from "../state/deck";
import { Button } from "./ui";

const GRADS = [
  "linear-gradient(140deg,#3b2f2f,#0e0f14 70%)",
  "linear-gradient(140deg,#1f2540,#0b0d16 70%)",
  "linear-gradient(140deg,#3a1f2e,#10060c 70%)",
  "linear-gradient(140deg,#143526,#07120c 70%)",
];

export function DemoBrowser({ platform }: { platform: Platform }) {
  const sessionState = useDeck((s) => s.rooms[platform].session?.state);
  const loggedIn = sessionState === "logged-in";
  const [igRoute, setIgRoute] = useState<"google" | "ig-login">("google");

  if (platform === "tiktok") {
    return loggedIn ? <TikTokFeed /> : <LoginPage kind="tiktok" />;
  }
  if (platform === "instagram") {
    if (loggedIn) return <InstaHome />;
    if (igRoute === "ig-login") return <LoginPage kind="instagram" />;
    return <GooglePage onOpenInstagram={() => setIgRoute("ig-login")} />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="text-3xl">🚧</div>
      <p className="text-sm text-slate-300">YouTube room</p>
      <p className="text-xs text-muted">Coming in the next build — same deck, YouTube shorts.</p>
    </div>
  );
}

/* --------------------------------- Google --------------------------------- */

function GooglePage({ onOpenInstagram }: { onOpenInstagram: () => void }) {
  const [q, setQ] = useState("");
  const [searched, setSearched] = useState(false);
  return (
    <div className="flex h-full flex-col items-center overflow-y-auto bg-white text-neutral-800">
      <div className="mt-6 flex flex-col items-center">
        <div className="flex items-end text-3xl font-bold tracking-tight">
          <span className="text-[#4285F4]">G</span>
          <span className="text-[#EA4335]">o</span>
          <span className="text-[#FBBC05]">o</span>
          <span className="text-[#4285F4]">g</span>
          <span className="text-[#34A853]">l</span>
          <span className="text-[#EA4335]">e</span>
        </div>
        <div className="mt-1 font-mono text-[9px] text-neutral-400">simulated page — search & open Instagram</div>
      </div>
      <div className="mt-5 flex w-full max-w-[300px] items-center gap-2 rounded-full border border-neutral-300 px-4 py-2 shadow-sm">
        <Search className="size-4 text-neutral-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setSearched(true)}
          placeholder="instagram"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </div>
      {!searched && (
        <button onClick={onOpenInstagram} className="mt-4 flex items-center gap-2 rounded-lg bg-[#0095F6] px-4 py-2 text-sm font-semibold text-white">
          <AtSign className="size-4" /> Continue to Instagram login →
        </button>
      )}
      {searched && (
        <div className="mt-4 w-full max-w-[300px] space-y-2 px-2">
          <button
            onClick={onOpenInstagram}
            className="block w-full rounded-lg border border-neutral-200 p-3 text-left hover:bg-neutral-50"
          >
            <p className="text-sm text-[#1a0dab]">Instagram</p>
            <p className="text-xs text-neutral-600">Login to continue to your account</p>
          </button>
          <div className="rounded-lg border border-neutral-200 p-3">
            <p className="text-sm text-[#1a0dab]">Railway — Deploy</p>
            <p className="text-xs text-neutral-500">where the browser worker lives</p>
          </div>
          <div className="rounded-lg border border-neutral-200 p-3">
            <p className="text-sm text-[#1a0dab]">Groq — Fast AI inference</p>
            <p className="text-xs text-neutral-500">powering the caption + review engine</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------- Login ---------------------------------- */

function LoginPage({ kind }: { kind: "tiktok" | "instagram" }) {
  const setUrl = useDeck((s) => s.setSession);
  const markLoggedIn = useDeck((s) => s.markDemoLoggedIn);
  const platform: Platform = kind;
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");

  const submit = (fill: boolean) => {
    if (fill) {
      setUser(DEMO_USER[kind]);
      setPass("demo-pass");
    }
    window.setTimeout(() => {
      markLoggedIn(platform);
      setUrl(platform, { url: kind === "tiktok" ? "https://www.tiktok.com/foryou" : "https://www.instagram.com/" });
    }, 350);
  };

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 overflow-y-auto p-6"
      style={{
        background:
          kind === "tiktok"
            ? "linear-gradient(180deg,#05070b 0%,#0a0d13 60%,#15070b 100%)"
            : "linear-gradient(160deg,#fafafa,#f3f0fa)",
      }}
    >
      <div className="flex size-16 items-center justify-center rounded-3xl text-4xl">
        {kind === "tiktok" ? "🎵" : "📸"}
      </div>
      <h1 className={`text-2xl font-extrabold tracking-tight ${kind === "tiktok" ? "text-white" : "text-neutral-900"}`}>
        {kind === "tiktok" ? "TikTok" : "Instagram"}
        <span className="ml-2 align-middle font-mono text-[10px] font-medium text-amber-400">simulated</span>
      </h1>
      <p className={`text-center text-xs ${kind === "tiktok" ? "text-neutral-400" : "text-neutral-500"}`}>
        This page only exists for the preview demo.
        <br />
        Type anything — “Log in” marks the session as signed in.
      </p>

      <div className="mt-2 w-full max-w-[280px] space-y-2">
        <label
          className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 ${
            kind === "tiktok" ? "border-neutral-800 bg-white/5" : "border-neutral-300 bg-white"
          }`}
        >
          <AtSign className={`size-4 ${kind === "tiktok" ? "text-neutral-500" : "text-neutral-400"}`} />
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="Username / email"
            autoCapitalize="none"
            className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${
              kind === "tiktok" ? "text-white placeholder:text-neutral-600" : "text-neutral-900"
            }`}
          />
        </label>
        <label
          className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 ${
            kind === "tiktok" ? "border-neutral-800 bg-white/5" : "border-neutral-300 bg-white"
          }`}
        >
          <Lock className={`size-4 ${kind === "tiktok" ? "text-neutral-500" : "text-neutral-400"}`} />
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Password"
            className={`min-w-0 flex-1 bg-transparent text-sm outline-none ${
              kind === "tiktok" ? "text-white placeholder:text-neutral-600" : "text-neutral-900"
            }`}
          />
        </label>
        <Button
          size="lg"
          variant={kind === "tiktok" ? "primary" : "dark"}
          className="w-full"
          onClick={() => submit(false)}
        >
          Log in
        </Button>
        <Button size="sm" variant="outline" className="w-full" onClick={() => submit(true)}>
          ⚡ One-tap demo account
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------ TikTok feed -------------------------------- */

function TikTokFeed() {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#05070b]">
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-xl font-extrabold tracking-tight text-white">
          TikTok<span className="align-middle font-mono text-[9px] font-normal text-amber-400"> sim</span>
        </span>
        <span className="ml-auto flex items-center gap-1 text-[10px] text-neutral-400">
          <span className="size-1.5 rounded-full bg-emerald-400" /> signed in · {DEMO_USER.tiktok}
        </span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto pb-3 px-3 scrollbar-slim">
        {DEMO_CANDIDATES.slice(0, 4).map((c, i) => (
          <FeedCard key={c.id} i={i} likes={Math.round(c.likes * 0.35)} caption={c.title} />
        ))}
      </div>
    </div>
  );
}

function FeedCard({ i, likes, caption }: { i: number; likes: number; caption: string }) {
  const [liked, setLiked] = useState(false);
  const [count, setCount] = useState(likes);
  return (
    <div className="relative flex h-[380px] overflow-hidden rounded-2xl" style={{ background: GRADS[i % GRADS.length] }}>
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/35 to-transparent p-3 pt-14">
        <p className="text-[13px] font-semibold leading-snug text-white">{caption}</p>
        <p className="mt-1 text-[11px] text-neutral-300">#fyp #faceless{[" #storytime", " #scary", " #facts"][i % 3]}</p>
      </div>
      <div className="absolute bottom-14 right-2 flex flex-col items-center gap-3.5">
        <button onClick={() => { setLiked((v) => !v); setCount((c) => (liked ? c - 1 : c + 1)); }} className="flex flex-col items-center gap-0.5">
          <Heart className={`size-7 drop-shadow ${liked ? "fill-rose-500 text-rose-500" : "text-white"}`} />
          <span className="text-[10px] font-semibold text-white">{compactNumber(count)}</span>
        </button>
        <div className="flex flex-col items-center gap-0.5">
          <MessageCircle className="size-7 text-white" />
          <span className="text-[10px] text-white">…</span>
        </div>
        <div className="flex flex-col items-center gap-0.5">
          <Play className="size-7 text-white" />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------- Instagram home ------------------------------- */

function InstaHome() {
  return (
    <div className="flex h-full flex-col overflow-hidden bg-black text-white">
      <div className="flex items-center gap-2 border-b border-neutral-900 px-3 py-2">
        <span className="text-sm font-extrabold tracking-tight">
          Instagram<span className="align-middle font-mono text-[9px] font-normal text-amber-400"> sim</span>
        </span>
        <span className="ml-auto text-[10px] text-neutral-500">{DEMO_USER.instagram} ✓</span>
      </div>
      <div className="grid flex-1 grid-cols-3 gap-1 overflow-y-auto p-1 scrollbar-slim">
        {DEMO_CANDIDATES.slice(0, 9).map((c, i) => (
          <div
            key={c.id}
            className="relative aspect-square overflow-hidden rounded-md"
            style={{ background: GRADS[(i + 1) % GRADS.length] }}
          >
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[8px] font-bold uppercase tracking-wider text-white/50">{["story", "scary", "facts"][i % 3]}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-around border-t border-neutral-900 py-1.5 text-[10px] text-neutral-400">
        <span>Home</span><span>Search</span><span>Reels</span><span>Profile</span>
      </div>
    </div>
  );
}
