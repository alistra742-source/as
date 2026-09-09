import { ArrowRight, Plus, ShieldCheck, UserRound, X } from "lucide-react";
import { useState } from "react";
import type { Platform } from "../lib/types";
import { cleanAccountName, roomAuthenticated, roomForAccount } from "../lib/accounts";
import { useDeck } from "../state/deck";
import { Chip, StatusDot, cn } from "./ui";

const LABEL: Record<Platform, string> = {
  tiktok: "TikTok",
  instagram: "Instagram",
  youtube: "YouTube",
};

const ACCENT: Record<Platform, string> = {
  tiktok: "from-rose-500/20 via-ink-850",
  instagram: "from-violet-500/20 via-ink-850",
  youtube: "from-red-500/20 via-ink-850",
};

/** Platform entry is an account switchboard; browser/engine controls live inside a tile. */
export function AccountMenu({ platform }: { platform: Platform }) {
  const accounts = useDeck((s) => s.accounts[platform]);
  const saved = useDeck((s) => s.accountRooms);
  const activeId = useDeck((s) => s.activeAccountIds[platform]);
  const activeRoom = useDeck((s) => s.rooms[platform]);
  const createAccount = useDeck((s) => s.createAccount);
  const selectAccount = useDeck((s) => s.selectAccount);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const finish = () => {
    const cleaned = cleanAccountName(name);
    const result = createAccount(platform, cleaned);
    if (!result.ok) {
      setError(result.error || "Could not create that account.");
      return;
    }
    setName("");
    setError(null);
    setNaming(false);
  };

  return (
    <div className="animate-rise space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-amber-300">account switchboard</p>
          <h1 className="mt-1 text-2xl font-black tracking-tight text-white">{LABEL[platform]} accounts</h1>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted">
            Each tile owns a separate persistent browser profile, login, posting engine and history. Open one to
            reach auto upload and manual upload, or add a fresh account.
          </p>
        </div>
        <Chip tone="green">
          <ShieldCheck className="size-3" /> isolated profiles stay signed in
        </Chip>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {accounts.map((account) => {
          const room = roomForAccount(platform, account, activeId, activeRoom, saved);
          const loggedIn = roomAuthenticated(room);
          const running = !!room?.engine.running;
          const posts = room?.posts.length ?? 0;
          return (
            <button
              key={account.id}
              onClick={() => selectAccount(platform, account.id)}
              className={cn(
                "group min-h-40 overflow-hidden rounded-2xl border border-line-soft bg-gradient-to-br to-ink-900 p-4 text-left transition-all hover:-translate-y-0.5 hover:border-amber-500/35 hover:shadow-[0_16px_38px_-22px_rgba(0,0,0,0.95)]",
                ACCENT[platform]
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl border border-white/10 bg-ink-950/55 text-amber-300">
                  <UserRound className="size-5" />
                </div>
                <ArrowRight className="size-4 text-faint transition-transform group-hover:translate-x-1 group-hover:text-amber-300" />
              </div>
              <p className="mt-5 truncate text-base font-extrabold text-white">{account.name}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Chip tone={loggedIn ? "green" : "neutral"}>
                  <StatusDot tone={loggedIn ? "green" : "neutral"} className="!size-1.5" />
                  {loggedIn ? "signed in" : "login needed"}
                </Chip>
                {running && <Chip tone="green">engine live</Chip>}
                {posts > 0 && <Chip tone="violet">{posts} post{posts === 1 ? "" : "s"}</Chip>}
              </div>
            </button>
          );
        })}

        <button
          aria-label={`Add a ${LABEL[platform]} account`}
          onClick={() => {
            setNaming(true);
            setError(null);
          }}
          className="group flex min-h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-amber-500/35 bg-amber-400/[0.035] p-5 text-center transition-all hover:border-amber-400/70 hover:bg-amber-400/[0.07]"
        >
          <span className="flex size-12 items-center justify-center rounded-2xl bg-amber-400 text-ink-950 shadow-[0_0_28px_-8px_rgba(245,158,11,0.75)] transition-transform group-hover:scale-105">
            <Plus className="size-6" />
          </span>
          <span>
            <span className="block text-sm font-extrabold text-slate-100">Add account</span>
            <span className="mt-0.5 block text-[11px] text-muted">fresh isolated browser profile</span>
          </span>
        </button>
      </div>

      {accounts.length === 0 && !naming && (
        <p className="rounded-xl border border-line bg-ink-900/55 px-4 py-3 text-center text-xs text-muted">
          No accounts yet. Press <span className="font-semibold text-amber-300">+</span>, give the account a name,
          then open its tile to sign in.
        </p>
      )}

      {naming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onMouseDown={() => setNaming(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`new-${platform}-account-title`}
            className="w-full max-w-sm rounded-2xl border border-line-soft bg-ink-850 p-5 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-400/10 text-amber-300">
                <Plus className="size-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 id={`new-${platform}-account-title`} className="text-base font-extrabold text-white">
                  Name this {LABEL[platform]} account
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Example: donut. This label is only for your deck; login secrets stay inside its browser profile.
                </p>
              </div>
              <button
                aria-label="Cancel account creation"
                onClick={() => setNaming(false)}
                className="text-faint hover:text-slate-200"
                title="Cancel"
              >
                <X className="size-4" />
              </button>
            </div>
            <input
              aria-label="Account name"
              autoFocus
              value={name}
              maxLength={32}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") finish();
                if (event.key === "Escape") setNaming(false);
              }}
              placeholder="donut"
              className="mt-4 h-11 w-full rounded-xl border border-line bg-ink-950 px-3 text-sm text-slate-100 outline-none placeholder:text-faint focus:border-amber-400/60"
            />
            {error && <p className="mt-2 text-xs text-danger-400">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setNaming(false)} className="rounded-lg px-3 py-2 text-xs font-semibold text-muted hover:text-slate-200">
                Cancel
              </button>
              <button
                onClick={finish}
                disabled={!cleanAccountName(name)}
                className="rounded-lg bg-amber-400 px-4 py-2 text-xs font-extrabold text-ink-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Create account
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
