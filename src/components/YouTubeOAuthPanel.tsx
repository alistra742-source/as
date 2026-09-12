import { Check, ExternalLink, KeyRound, Link2Off, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Room } from "../lib/types";
import { useDeck } from "../state/deck";
import { Button, Chip, Panel, PanelHeader } from "./ui";

interface OAuthStatus {
  configured: boolean;
  connected: boolean;
  expiresAt: number | null;
  scope: string | null;
  error: string | null;
}

function bearer(token: string): HeadersInit {
  return {
    authorization: `Bearer ${token || "public"}`,
    "content-type": "application/json",
    accept: "application/json",
  };
}

async function responseJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(response.ok ? "The worker returned an unreadable response." : `Worker answered HTTP ${response.status}.`);
  }
  if (!response.ok) {
    const error = parsed && typeof parsed === "object" && "error" in parsed ? String((parsed as { error: unknown }).error) : "Request failed";
    throw new Error(error);
  }
  return parsed as T;
}

/** Official YouTube API authorization, scoped to exactly one named account. */
export function YouTubeOAuthPanel({ room }: { room: Room }) {
  const accountId = room.accountId ?? "default";
  const accountName = room.accountName ?? "YouTube account";
  const token = room.live.token;
  const setLive = useDeck((state) => state.setLive);
  const [status, setStatus] = useState<OAuthStatus>({
    configured: room.live.youtubeOAuthConfigured,
    connected: room.live.youtubeOAuthConnected,
    expiresAt: null,
    scope: null,
    error: room.live.youtubeOAuthError,
  });
  const [busy, setBusy] = useState<"connect" | "disconnect" | null>(null);
  const accountIsOpen = useCallback(
    () => useDeck.getState().activeAccountIds.youtube === accountId,
    [accountId]
  );

  const loadStatus = useCallback(async () => {
    try {
      const response = await fetch(`/api/youtube/oauth/status?account=${encodeURIComponent(accountId)}`, {
        headers: bearer(token),
        cache: "no-store",
      });
      const next = await responseJson<OAuthStatus>(response);
      if (!accountIsOpen()) return;
      setStatus(next);
      setLive("youtube", {
        youtubeOAuthConfigured: next.configured,
        youtubeOAuthConnected: next.connected,
        youtubeOAuthError: next.error,
      });
    } catch (error) {
      if (!accountIsOpen()) return;
      const message = (error as Error).message;
      setStatus((prior) => ({ ...prior, error: message }));
      setLive("youtube", { youtubeOAuthError: message });
    }
  }, [accountId, token, setLive, accountIsOpen]);

  useEffect(() => {
    void loadStatus();
    const onFocus = () => {
      // Google may return access_denied without an account id. Closing that popup
      // still gives focus back, so never leave Connect spinning indefinitely.
      setBusy(null);
      void loadStatus();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; accountId?: unknown } | null;
      if (data?.type !== "viraldeck-youtube-oauth" || data.accountId !== accountId) return;
      setBusy(null);
      void loadStatus();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("message", onMessage);
    };
  }, [accountId, loadStatus]);

  async function connect() {
    setBusy("connect");
    setStatus((prior) => ({ ...prior, error: null }));
    // Open synchronously so Safari/mobile popup blocking cannot swallow Google.
    const popup = window.open("about:blank", "viraldeck-youtube-oauth", "popup,width=620,height=760");
    try {
      const response = await fetch("/api/youtube/oauth/start", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ accountId, accountName }),
      });
      const result = await responseJson<{ url: string }>(response);
      const destination = new URL(result.url);
      if (destination.protocol !== "https:" || destination.hostname !== "accounts.google.com") {
        throw new Error("The worker returned an invalid Google authorization URL.");
      }
      if (popup) popup.location.assign(destination.toString());
      else window.location.assign(destination.toString());
    } catch (error) {
      popup?.close();
      setBusy(null);
      setStatus((prior) => ({ ...prior, error: (error as Error).message }));
    }
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect Google from “${accountName}”? Existing YouTube videos are not removed.`)) return;
    setBusy("disconnect");
    try {
      const response = await fetch("/api/youtube/oauth/disconnect", {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({ accountId }),
      });
      await responseJson<{ ok: true }>(response);
      if (!accountIsOpen()) return;
      setStatus((prior) => ({ ...prior, connected: false, expiresAt: null, scope: null, error: null }));
      setLive("youtube", {
        youtubeOAuthConnected: false,
        youtubeOAuthError: null,
      });
    } catch (error) {
      setStatus((prior) => ({ ...prior, error: (error as Error).message }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Panel>
      <PanelHeader
        icon={<KeyRound className="size-4" />}
        title="Official YouTube upload connection"
        sub="Google OAuth · youtube.upload only · isolated to this named account"
        right={
          status.connected ? (
            <Chip tone="green"><Check className="size-3" /> Google connected</Chip>
          ) : status.configured ? (
            <Chip tone="amber">not connected</Chip>
          ) : (
            <Chip tone="red">setup incomplete</Chip>
          )
        }
      />
      <div className="space-y-3 p-4">
        <div className="flex items-start gap-2 rounded-xl border border-line bg-ink-900/65 p-3">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-signal-300" />
          <p className="text-[11px] leading-relaxed text-muted">
            The grant can upload videos only. Refresh/access tokens are encrypted in this account’s worker directory;
            they never enter browser localStorage, WebSocket messages, or logs. Uploads are created as
            <span className="text-slate-200"> Public</span>, explicitly marked <span className="text-slate-200">No, it’s not made for kids</span>,
            and require both settings in the returned YouTube receipt before success is shown.
          </p>
        </div>

        {status.error && (
          <p role="alert" className="rounded-lg border border-danger-500/25 bg-danger-500/10 px-3 py-2 text-xs text-danger-400">
            {status.error}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {status.connected ? (
            <>
              <Button size="sm" variant="success" onClick={() => void connect()} loading={busy === "connect"}>
                <ExternalLink className="size-3.5" /> Reconnect Google
              </Button>
              <Button size="sm" variant="danger" onClick={() => void disconnect()} loading={busy === "disconnect"}>
                <Link2Off className="size-3.5" /> Disconnect
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => void connect()} loading={busy === "connect"} disabled={!status.configured}>
              <ExternalLink className="size-3.5" /> Connect Google
            </Button>
          )}
          <span className="text-[10px] text-faint">
            Consent screen in Testing: Google may require reconnecting test-user grants after 7 days.
          </span>
        </div>

        {!status.configured && (
          <p className="text-[11px] leading-relaxed text-muted">
            Railway needs four separate values: <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>,
            <code>GOOGLE_REDIRECT_URI</code> (or <code>GOOGLE_REDIRECT_URL</code>), and <code>SCOPES</code> (or <code>GOOGLE_SCOPES</code>).
          </p>
        )}
        <p className="text-[11px] leading-relaxed text-muted">
          On Google’s testing warning, use <span className="text-slate-200">Advanced → Go to the app</span> while signed in as an allowed test user.
          Start from this button—not the raw OAuth URL—because ViralDeck adds a signed, one-time account state.
          Google may also force API uploads to Private until the Cloud project passes YouTube’s separate API compliance audit; ViralDeck rejects that as a public success.
        </p>
      </div>
    </Panel>
  );
}
