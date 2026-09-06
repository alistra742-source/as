# ViralDeck — AI growth deck for faceless TikTok, Instagram & YouTube

Log into TikTok, Instagram or YouTube **once** in a browser you control from the app, then let
the engine keep the account growing on your rules:

- **1 post per hour** (manual link+caption, or an AI-discovered clip), always on **Everyone**
  (YouTube publishes as **Public** — its “Everyone”).
- After each post, the engine reads views/likes/comments every hour. Crossing **3,000 views in
  the first hour** flips it into *double-down* mode and it posts **similar** content.
- No link? Groq reviews **faceless videos with 50K+ likes** (captions + comment sentiment) and
  only posts clips that clear its quality bar.
- Niches it cycles: **faceless stories · scary stories · fun facts**.

## Stealth stack — Clearcote browser, nodriver-style human input

No vanilla Chromium anywhere. The worker drives the open-source
**[Clearcote](https://github.com/clearcotelabs/clearcote-browser)** browser — a de-Googled
Chromium with fingerprint control compiled **into the engine itself** (C++), not injected via
detectable JS patches — the **nodriver** way:

| Layer | What it does |
| --- | --- |
| **Clearcote binary** | Engine-level persona: one coherent, seed-stable “machine” per platform (UA + UA-CH + TLS/JA4 + canvas/WebGL/audio/fonts/GPU all agree). `--enable-automation` is stripped, `navigator.webdriver` stays `false`, headless-heuristic tells are masked. The verified binary is SHA-256-checked and pre-downloaded at Docker build time. |
| **nodriver-style driving** | Raw CDP, no chromedriver / WebDriver layer. Playwright-core attaches over CDP like nodriver does — no driver artifacts, and the engine neutralizes CDP `Runtime.enable` leaks. |
| **Humanized input (trusted events)** | Every click, keystroke and scroll is dispatched as a **native trusted event** (`isTrusted === true`) by the SDK's humanize layer: minimum-jerk cursor paths with tremor + overshoot, Fitts-scaled speeds, key-hold dwells, eased scrolls with reading pauses, ambient cursor drift, and ~2% fat-finger typos that are auto-corrected (engine-typed captions only — keystrokes *you* route from the deck are typed clean). |
| **Human scheduling** | The 1-post/hour rule always holds, but every slot gets a random upward jitter (default up to +9 min), the first automatic pass waits a random 0–8 min after arm/boot, and stats reads land a few random minutes after they're due. Nothing happens on a metronome beat. |
| **Idle drift** | Between deck commands the logged-in session does small ambient cursor motions and the occasional micro-scroll, so the account never looks parked. |

Everything is env-configurable — see `worker/env.example` (`STEALTH_*`, `CLEARCOTE_*`). The
live dock shows a **🛡 Clearcote · human** badge with the exact driver config.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  One service (this repo, one Railway deploy)                               │
│                                                                            │
│  · Vite/React frontend (Main / TikTok / IG / YT, demo browser, engine UI)  │
│  · Node backend — serves the app AND the /ws socket on the same domain:    │
│      live browser stream, click/scroll/type, uploads, Groq captions +      │
│      reviews, hourly engine + metrics, login profiles                     │
│  · Clearcote browser driven nodriver-style (raw CDP, humanized trusted     │
│      input) — no vanilla Chromium in the image                             │
└──────────────────────────────────────────────────────────────┬─────────────┘
                                                               │ Railway volume
                                                               ▼
                                        TikTok / Instagram / YouTube + Google
                                        (profiles + state.json)
```

- **Frontend** is a plain Vite + React + Tailwind app (no account system — it's your private
  control deck; state persists in the browser).
- **Backend** (`worker/src/`) ships in the same deploy — the root `Dockerfile` builds both and
  one process serves the app and the browser socket on the same domain, so live mode
  auto-connects with **zero configuration**. Everything sensitive (your logins, Groq key,
  browser sessions) lives on the server, never in the browser UI.

## Try it now (demo mode — no server needed)

1. `bun install && bun run dev`
2. Open **Main → TikTok** (Instagram or YouTube), press **＋ Open browser (demo)**.
3. The simulated browser opens. Type anything into the login fields (your phone keyboard pops
   up naturally because they're real inputs) and tap **Log in**.
4. Paste a link + caption under the browser and hit **Post** — watch the engine read the post,
   hit the 3,000-view trigger, and schedule "similar content". The demo compresses time
   (~45 s per simulated hour) so you can watch a full cycle; the real worker uses true hours.

Demo mode never touches the network. The banner above the browser says SIMULATED.

## Deploy (one service, zero config)

1. **Push this repo to GitHub**, then on Railway create a service from it (repo root — the
   root `Dockerfile` is picked up automatically). That's it: the same service serves the app
   and the browser backend on one domain. During the Docker build the **verified Clearcote
   browser** is downloaded and SHA-256-checked into `/app/.clearcote-browser`, so deploys
   never touch GitHub at runtime.
2. Add a **volume** mounted at `/app/data` (keeps your logins + state across restarts).
3. Set one environment variable: `GROQ_API_KEY` (get one at console.groq.com — free tier is
   plenty). Optional: `GROQ_MODEL`, `WORKER_TOKEN` (if set, paste the same value in the
   Worker card), and the stealth knobs in `worker/env.example` (`STEALTH_PLATFORM`,
   `STEALTH_HEADLESS`, `STEALTH_CADENCE_JITTER_MIN`, …). Sensible defaults are on out of the box.
4. Open the app, hit **＋ Live browser** in any room — it auto-connects to the same domain
   and streams the *real* platform in your dock. Click, drag to scroll, tap **Keyboard** to
   type with your phone's keyboard, log in, then hit **Start**.

> **Login identity warning:** the Clearcote persona is fixed per platform and derived from
> your `WORKER_TOKEN` (`STEALTH_FINGERPRINT` overrides it). Changing either **changes the
> fingerprint identity**, which can re-trigger login challenges — pick a token, keep it, and
> don't rotate it.

## Rules the engine enforces

| Rule | Value | Where |
| --- | --- | --- |
| Audience | Everyone (YouTube: visibility **Public**) | `worker/src/uploads.ts` + enforced in UI |
| Cadence | 1 post / 1 hour (slots only ever jittered *longer*) | `worker/src/engine.ts` (also demo engine) |
| Hit trigger | 3,000+ views in first hour | engine metric pass, editable per room |
| Discovery floor | 50K+ likes | `scrapeCandidates` filter + Groq judge |
| Groq roles | captions, candidate review, performance reads | `worker/src/groq.ts` |

If `GROQ_API_KEY` is missing the worker logs a warning and runs deterministic heuristics so
nothing silently breaks.

## Honest notes (read before running)

- Automating logins/posting can violate TikTok/Instagram/YouTube terms and may get accounts
  flagged. This tool keeps **your** login in **your** browser profile — no passwords are stored
  in code. The stealth stack masks automation fingerprints and behaves like a human at the
  input level, but it cannot change **where your traffic comes from**: a datacenter IP is still
  the strongest signal platforms have. For real accounts, run the worker on a connection with
  a residential-grade IP (or put a SOCKS5 proxy in front of it — Clearcote keeps the persona
  coherent with the proxy region via `geoip`, and `webrtcIp` matches the egress IP). If a
  platform challenges the session anyway, do the verification manually in the dock; the worker
  waits for the signed-in state. YouTube uploads run through **Studio**, so the logged-in
  session must be a Google account with an associated channel.
- Humanized input is deliberately slower than raw automation (a 200-char caption types over
  30–60 s, uploads take minutes) — that's the point. Engine-typed captions include the
  occasional auto-corrected typo; keystrokes you type from the deck do not.
- Page selectors used by the uploaders (`worker/src/uploads.ts`) are best-effort and change
  over time. Failures are logged to the deck activity feed and never silently swallowed — you
  can always finish an upload by hand in the live browser.
- Reposting other creators' videos: only post content you have rights to. The 50K+ discovery
  mode is a tool, not a license.
- Metric reads rely on what the public video page exposes; blocked reads are logged and retried
  next hour rather than guessed.

## YouTube (live)

The YouTube room is fully wired to the same deck flow:

- **Live browser** starts on youtube.com — sign in with your Google account (the dock also has
  one-tap links to `/shorts` and `studio.youtube.com` for verification).
- **Post a link + caption**: the worker downloads the clip and publishes it through YouTube
  Studio with the caption as the **title** and visibility **Public** (Everyone). A vertical
  clip under ~3 minutes is published as a **Short** automatically; anything else uploads as a
  regular video, so paste Shorts links for Shorts output.
- **AI auto-post**: discovery searches YouTube for the active niche (`faceless storytime
  shorts`, `scary stories shorts`, `mind blowing facts shorts`), opens each candidate to read
  its like count, and only the clips above the 50K floor go to the Groq review. Same 1/hour
  cadence and 3K+/hour double-down trigger as the other rooms; stats are read from each video's
  page.
- Studio selectors are best-effort like the TikTok/IG uploaders (they change over time) —
  failures land in the deck activity feed and you can always finish a publish by hand in the
  live browser.
