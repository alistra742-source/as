# ViralDeck — AI growth deck for faceless TikTok & Instagram content

Log into TikTok or Instagram **once** in a browser you control from the app, then let the
engine keep the account growing on your rules:

- **1 post per hour** (manual link+caption, or an AI-discovered clip), always on **Everyone**.
- After each post, the engine reads views/likes/comments every hour. Crossing **3,000 views in
  the first hour** flips it into *double-down* mode and it posts **similar** content.
- No link? Groq reviews **faceless videos with 50K+ likes** (captions + comment sentiment) and
  only posts clips that clear its quality bar.
- Niches it cycles: **faceless stories · scary stories · fun facts**.

## Architecture

```
┌──────────────────────────┐        WebSocket         ┌───────────────────────────────┐
│  ViralDeck frontend      │  frames + commands       │  automation worker  (worker/) │
│  (this repo, Vite/React) │ ───────────────────────► │  Node + Playwright Chromium   │
│                          │ ◄─────────────────────── │  · persistent login profiles  │
│  · Main / TikTok / IG    │   live browser stream    │  · remote click/scroll/type   │
│  · demo browser (no net) │                          │  · uploads (audience Everyone)│
│  · composer, engine UI   │                          │  · Groq captions + reviews    │
└──────────────────────────┘                          │  · hourly engine + metrics    │
        ▲                                             └───────────────┬───────────────┘
        │ localStorage deck state                                     │ Railway volume
        └─────────────────────────────────────────────────────────────▼───────────────
                             TikTok / Instagram / Google (profiles + state.json)
```

- **Frontend** is a plain Vite + React + Tailwind app (no account system — it's your private
  control deck; state persists in the browser).
- **`worker/`** is the piece you host. It can run anywhere with Docker — the repo ships a
  Railway-friendly `Dockerfile` (Playwright Chromium preinstalled). Everything sensitive
  (your logins, Groq key, browser sessions) lives here, never in the browser UI.

## Try it now (demo mode — no server needed)

1. `bun install && bun run dev`
2. Open **Main → TikTok** (or Instagram), press **＋ Open browser (demo)**.
3. The simulated browser opens. Type anything into the login fields (your phone keyboard pops
   up naturally because they're real inputs) and tap **Log in**.
4. Paste a link + caption under the browser and hit **Post** — watch the engine read the post,
   hit the 3,000-view trigger, and schedule "similar content". The demo compresses time
   (~45 s per simulated hour) so you can watch a full cycle; the real worker uses true hours.

Demo mode never touches the network. The banner above the browser says SIMULATED.

## Real mode — connect your Railway worker

1. **Push this repo to GitHub**, then on Railway create a new service from it with
   **Root Directory = `worker`** (Dockerfile is picked up automatically).
2. Add a **volume** mounted at `/app/data` (keeps your logins + state across restarts).
3. Set environment variables: `WORKER_TOKEN` (long random string) and `GROQ_API_KEY`
   (get one at console.groq.com — free tier is plenty). Optional:
   `GROQ_MODEL`, `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` (cloud browsers with
   residential-grade IPs — use these if TikTok blocks datacenter logins).
4. In the app, open **TikTok room → Worker card** and paste
   `wss://<your-service>.up.railway.app/ws` plus the token, then open a browser session —
   it now streams the *real* TikTok in your dock. Click, drag to scroll, tap **Keyboard** to
   type with your phone's keyboard, log in, then hit **Start**.

## Rules the engine enforces

| Rule | Value | Where |
| --- | --- | --- |
| Audience | Everyone | `worker/src/uploads.ts` + enforced in UI |
| Cadence | 1 post / 1 hour | `worker/src/engine.ts` (also demo engine) |
| Hit trigger | 3,000+ views in first hour | engine metric pass, editable per room |
| Discovery floor | 50K+ likes | `scrapeCandidates` filter + Groq judge |
| Groq roles | captions, candidate review, performance reads | `worker/src/groq.ts` |

If `GROQ_API_KEY` is missing the worker logs a warning and runs deterministic heuristics so
nothing silently breaks.

## Honest notes (read before running)

- Automating logins/posting can violate TikTok/Instagram terms and may get accounts flagged.
  This tool keeps **your** login in **your** browser profile — no passwords are stored in code —
  but platform anti-bot heuristics (datacenter IPs, headless fingerprints) may still challenge
  sessions. If TikTok/IG challenge your session, do the verification manually in the dock; the
  worker waits for the signed-in state.
- Page selectors used by the uploaders (`worker/src/uploads.ts`) are best-effort and change
  over time. Failures are logged to the deck activity feed and never silently swallowed — you
  can always finish an upload by hand in the live browser.
- Reposting other creators' videos: only post content you have rights to. The 50K+ discovery
  mode is a tool, not a license.
- Metric reads rely on what the public video page exposes; blocked reads are logged and retried
  next hour rather than guessed.

## YouTube

The room is scaffolded (tab → "coming next"). The worker already accepts `youtube` as a
platform for the browser rig; Shorts upload + analytics wiring is the next build.
