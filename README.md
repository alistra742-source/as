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

## Browser engine — Playwright + stock Chromium by default, Clearcote when you need it

`BROWSER_ENGINE` picks the browser; everything else in the deck is identical for both, and both
read the **same persistent profile**, so switching never logs you out.

| Engine | What it is | When to use it |
| --- | --- | --- |
| **`playwright`** (default) | Stock Chromium launched by Playwright over CDP — no chromedriver/WebDriver layer, no custom binary to fetch, `--enable-automation` stripped, and a ~35-hostname third-party blocklist applied at the DNS resolver. `navigator.webdriver` is undefined and `window.chrome` exists; nothing else is faked, because fake plugin/language lists are a tell in themselves. | Always, unless a site is actively rejecting the session. It is the faster, smaller, better-supported option, and page load is most of a publish. |
| **`clearcote`** | The open-source **[Clearcote](https://github.com/clearcotelabs/clearcote-browser)** browser — a de-Googled Chromium with fingerprint control compiled **into the engine itself** (C++), not injected via detectable JS patches: one coherent, seed-stable "machine" per platform (UA + UA-CH + TLS/JA4 + canvas/WebGL/audio/fonts/GPU all agree). SHA-256-verified and pre-downloaded at build time (`--build-arg WITH_CLEARCOTE=true`). | When a platform's risk engine is flagging the account. It buys stealth with a 150 MB binary and a slower start. |

Input is the same in both cases: every click, keystroke and scroll is a **native trusted CDP
event** driven by the human motor model in `worker/src/human.ts` (minimum-jerk cursor paths with
tremor + overshoot, Fitts-scaled speeds, key-hold dwells, eased scrolls with reading pauses,
~2% auto-corrected fat-finger typos on engine-typed captions only). On Clearcote the SDK's own
humanizer attaches on top and the log line says which one is live.

On top of the input model, the schedule itself is human-shaped, in either engine:

- **Human scheduling** — the 1-post/hour rule always holds, but every slot gets a random upward
  jitter (default up to +9 min), the first automatic pass waits a random 0–8 min after arm/boot,
  and stats reads land a few random minutes after they're due. Nothing happens on a metronome beat.
- **Idle drift** — between deck commands the logged-in session does small ambient cursor motions
  and the occasional micro-scroll, so the account never looks parked.

### What "loads faster" actually means here

- **Resolver-level tracker blocking** — analytics/ad/consent hosts map to `0.0.0.0`, so no
  connection, TLS handshake or retry timer is spent on them (`BLOCK_TRACKERS=off` disables).
- **No background noise**: networking services, component update, extensions, breakpad, sync and
  first-run are all off, disk cache capped, audio muted, scale factor pinned to 1 so the dock's
  pixel geometry never drifts.
- **Wait for the element, not for a stopwatch** — the grab and the studio paths used to sleep a
  flat 2.2–2.6 s per step (plus 1.5 s per "Next"); they now `waitForFunction` on the actual
  `input[type=file]` / player / Studio dialog and keep only a short human "read the page" beat.
- **The deck's own assets are `immutable`** — hashed files under `/assets/` were being refetched
  (~317 KB) on every reload because the worker served everything `no-cache`.

Everything is env-configurable — see `worker/env.example` (`BROWSER_ENGINE`, `BLOCK_TRACKERS`,
`CHROME_PATH`, `STEALTH_*`, `CLEARCOTE_*`). The live dock shows a **⚡ Chromium · human** (or
**🛡 Clearcote · human**) badge whose tooltip is the exact driver config the worker reported on
`ready`, so what you see is what the container is actually running.

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  One service (this repo, one Railway deploy)                               │
│                                                                            │
│  · Vite/React frontend (Main / TikTok / IG / YT, demo browser, engine UI)  │
│  · Node backend — serves the app AND the /ws socket on the same domain:    │
│      live browser stream, click/scroll/type, uploads, Groq captions +      │
│      reviews, hourly engine + metrics, login profiles                     │
│  · Browser: Playwright + stock Chromium (default) or the Clearcote build   │
│      (BROWSER_ENGINE) — raw CDP, humanized trusted input, one shared       │
│      persistent profile per platform                                       │
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

`npm test` covers the live dock's tap geometry (frame→page mapping and the aim assist) with a fake
DOM — no browser, no network, no server.

Demo mode never touches the network. The banner above the browser says SIMULATED.

## Deploy (one service, zero config)

1. **Push this repo to GitHub**, then on Railway create a service from it (repo root — the
   root `Dockerfile` is picked up automatically). That's it: the same service serves the app
   and the browser backend on one domain. The image is Debian bookworm (the same base as the
   `node:22-bookworm-slim` base) with the full Chromium runtime + font set. During the build
   **Playwright installs its Chromium** into `/opt/playwright`, and that is the browser the
   service runs. The Clearcote build is no longer fetched by default (it costs ~150 MB and a
   GitHub round trip): pass `--build-arg WITH_CLEARCOTE=true` to bake it in, then set
   `BROWSER_ENGINE=clearcote`. Either way the browser runs **headed under Xvfb**
   (`STEALTH_HEADLESS=false` in the image — headed avoids headless-mode tells, and the dock's
   geometry assumes a real window).
2. Add a **volume** mounted at `/app/data` (keeps your logins + state across restarts).
3. Set one environment variable: `GROQ_API_KEY` (get one at console.groq.com — free tier is
   plenty). Optional: `GROQ_MODEL`, `WORKER_TOKEN` (if set, paste the same value in the
   Worker card), `BROWSER_ENGINE` / `BLOCK_TRACKERS` / `CHROME_PATH`, and the stealth knobs in
   `worker/env.example` (`STEALTH_PLATFORM`,
   `STEALTH_HEADLESS`, `STEALTH_CADENCE_JITTER_MIN`, …). Sensible defaults are on out of the box.
4. Open the app, hit **＋ Live browser** in any room — it auto-connects to the same domain
   and streams the *real* platform in your dock. Click, drag to scroll, tap **Keyboard** to
   type with your phone's keyboard, log in, then hit **Start**.
5. Stuck on a **"Verify it's really you"** / choose-a-method screen? Use **Tap for me** above
   the stream: **Email** / **Password** find that row by the text it shows and press its centre
   (no coordinates at all), and **Auto-tap Email** — on by default while a deck is connected —
   watches for that screen and clears it by itself. It presses at most three times per screen and
   never acts with nobody watching; toggle it off in the same row.
6. **The login wall will not cooperate?** A tap on a 60 px row, through a resized JPEG, on a phone, is the
   hardest click in this product — so there is a door that needs none. Paste your **`sessionid`** into
   **Session cookie** under the browser: copy it from any browser where you are already signed in (DevTools
   → Application → Cookies → `www.tiktok.com`), **or** a whole `Cookie:` request header, **or** the bare
   value, **or** a cookie-editor JSON export (`EditThisCookie` / `Cookie-Editor`), **or** a `cookies.txt`
   file from `curl -b`. All five are read; anything from another site in the export (`.doubleclick.net`,
   analytics) is dropped rather than written into the profile. **Apply & sign in** writes it into the profile's own cookie jar and reloads
   the site so it notices. That jar is the persistent profile the manual tab and every engine run already
   share, so one paste covers all of it and survives a restart. **Nothing starts posting:** a signed-in
   profile only enables **Start**, and the engine arms on that press alone (and refuses a session swap while
   it is running, so a live loop can never end up publishing on an account you did not arm). The value is
   never kept in the deck's saved state, never printed in the activity log, never echoed in a toast — only
   cookie *names* and a date. TikTok's `sessionid_ss` twin is minted for you (it is the copy
   `www.tiktok.com` reads), and a pasted `sid_guard` sets the expiry instead of the 365-day default.
   **Clear** empties the jar — device ids included, so the next manual sign-in may ask for a code.

> **Input note (why clicks now land):** the Clearcote SDK installs its humanize wrapper via
> `context.browser()`, which Playwright returns as `null` for persistent contexts — the exact
> launch path a logged-in profile needs. So the wrapper silently never attached and every
> click/keystroke was plain Playwright input. The worker now attaches the wrapper itself on
> every page (`worker/src/humanizeAttach.ts`); the deploy log prints
> `control tab input: Clearcote humanized (trusted, persona-driven)` on connect, and each tap
> logs the element it hit (`tap @ (x,y) → button "Log in"; focus: …`) so a "click did nothing"
> report is diagnosable from the log.

> **Input engine note:** on the **Playwright** engine there is no SDK wrapper to attach, and that
> is not a downgrade — `worker/src/human.ts` drives the same mouse/keyboard model itself, and the
> `control tab input: PLAIN PLAYWRIGHT` line says exactly that rather than pretending otherwise.

> **Tap-escalation note (why a tap used to end in `DOM click on html "{"mssdk"… did nothing
> either`):** when a press hit something the page ignored, the probe climbed up to 8 ancestors
> looking for a control, reached `<html>`, and decided the document element *was* the control.
> `html`'s `innerText` starts with the site's inline boot JSON — which is where that absurd label
> came from — and the click did nothing because clicking the document element is not clicking
> anything. The climb now **stops at `<body>`**, and an escalation is only attempted for a node
> that could plausibly answer: a viewport-sized container is still clickable (that is how these
> modals get dismissed) but is logged as *full-page container: this press dismisses the overlay*,
> and a press that resolves to the page background is reported as that, with no fake fallback
> pretending to try harder.

> **Caption note (why a publish went out without one):** *"Caption editor not found — posting
> without a caption"* was a selector list going stale around TikTok's studio redesigns, and the
> failure is invisible because the video still posts. `worker/src/captionPick.ts` now **ranks**
> every editable box on the page — label proximity via `aria-label` / `aria-labelledby` / the
> heading above it, `contenteditable` + `role=textbox`, width, and a hard veto on the two decoys
> (search, comment) — then fills the winner with `Input.insertText` so a `#hashtag` cannot open
> the suggestion popup and eat the next character, dismisses that popup with `Escape`, and reads
> the box back to confirm text is actually in it. The log says what it chose
> (`Caption → DIV "Description" (536x120)`), and a miss prints the boxes it *did* see, so the
> next redesign shows up as a readable line instead of a captionless post.
>
> **TikTok's editing-tour popup:** after a file is accepted, Studio sometimes covers the whole
> editor with **“New editing features added” → “Got it”**. The uploader now finds that exact button
> inside that exact card and auto-clicks it before caption, audience, and Post. It starts with a
> normal trusted Playwright click, re-finds the button if React replaces it, verifies the card is
> gone, and stops with a readable error instead of silently posting behind an overlay if TikTok
> ignores all bounded attempts.

> **Tap-path note (why a tap on a small row used to do nothing):** a tap travels from a pixel in the
> deck to a coordinate in a remote page, and three separate things were breaking it. (1) **The
> mapping.** The deck divided the press point by the viewport *box*, but the streamed frame is
> `object-contain` inside it — when the remote window's ratio isn't 64/45 (headed Chromium under
> Xvfb: it isn't) the image is letterboxed and every tap is pulled toward the vertical centre: the row
> you aimed at and the row the browser pressed were different places (measured skew ~16 px on a login
> row, ~40 px on a modal's back arrow, ~67 px near the footer). `src/lib/tapMapping.ts` now measures
> against the displayed image, and the box adopts the frame's own ratio so the black bars are gone.
> (2) **The gesture.** A press was discarded as "a drag" if *any single* `movementY` sample exceeded
> 2 px — which a thumb on glass does on almost every tap — so the tap was never sent at all (and the
> page scrolled a few px instead). Scroll now begins at 5 px of travel and only cancels the click
> past 12 px. (3) **The aim.** A fingertip lands on the gap between two rows, or on the `<span>`
> whose handler lives on the parent `<div>` (that is how TikTok's "verify it's really you" list is
> built), and a well-formed trusted click on nothing looks exactly like a broken browser. The worker
> now clamps a press into the nearest control's box (`worker/src/tapAim.ts`: ≤16 px of travel,
> clamped never centred, viewport-filling containers ignored so tapping a backdrop to dismiss a modal
> stays a tap on the backdrop) and logs `tap nudged to "Password" (+0px, 6px)`. Every tap also logs
> what it hit and whether the page moved under the glide (`tap @ (430,421) → div "Password" … · page
> moved 240px mid-press`), so a "click did nothing" report is a diagnosable sentence.
>
> And the pixel path is no longer required at all: **Tap for me → Email / Password** and
> **Auto-tap Email** (`{ t: "click-label" }` / `{ t: "auto-verify" }`, `findLabelTarget` in
> `worker/src/tapAim.ts`) ask the *page* where the control is and press the middle of the answer —
> matching the smallest element that says it, climbing to the row that owns the handler, searching
> every frame so a login screen rendered inside an iframe is found too, and scrolling the row into
> view before pressing. A tap that has to survive a letterbox, a resized window and a pinch-zoom can
> miss; a tap that says "press the thing labelled Email" cannot. Auto-tap presses at most three times
> per screen and only while a deck socket is connected, so nothing ever taps your account unwatched.
>
> **When the press lands and nothing happens.** A trusted click can still be ignored — the row's handler is
> attached by a framework that has not finished hydrating, or the listener sits on an ancestor the hit-test
> never reaches. So every press, **Tap for me** or your own finger, is watched: `activityProbe` installs a
> `MutationObserver` plus a title/text/scroll/focus fingerprint, and if the page shows no sign of having
> answered, the worker escalates to a DOM-level click on the control it marked with `data-vd-tap`
> (`pointerover → pointerdown → mouseover → mousedown → pointerup → mouseout → mouseup → click`, with the
> `buttons` bits a real release carries; mouse-only when `PointerEvent` is absent, and an `<a>` is followed
> by its own `href`). Only then, and only on a control you named or the node under your own tap — a press
> that demonstrably worked is never followed up, and a probe that could not run counts as answered so we
> never escalate blind. The log and toast say which path fired
> (`Tapped "Email" — the pointer press was ignored, the DOM click worked`), because "it worked, but not the
> way you asked" is the answer a remote control owes you.
>
> **Protocol version.** `PROTOCOL_VERSION` (8: Playwright/Clearcote engine identity; 6: a failed publish
> answers; 5: cookie login; 4: label taps and the DOM escalation) travels
> on `auth` and comes back on `ready`, so a deck newer than the worker warns on connect and an unknown
> command fails loudly — `This worker does not understand "click-label" (protocol v5) — redeploy it` —
> instead of a button that does nothing. `src/lib/protocol.ts` and `worker/src/protocol.ts` are mirrors: bump
> both.
>
> **Publishing: any source, one destination.** The composer's link field takes a **TikTok, Instagram or
> YouTube** URL — the room's platform is only where it is *posted*. The old grab looked at
> `document.querySelector("video").src`, which is a `blob:` on TikTok and YouTube (MSE), so the publish died
> with "could not resolve a downloadable mp4" and nothing else was said. `worker/src/sourceGrab.ts` now reads
> the page's own embedded state instead — `__UNIVERSAL_DATA_FOR_REHYDRATION__` / `__SIGI_STATE__` for TikTok,
> `video_versions` + `og:video` for Instagram, `ytInitialPlayerResponse.streamingData.formats[]` for YouTube —
> with a tolerant URL scan rather than a schema assumption, plus every response the player actually fetched
> while the page loaded. TikTok's current extensionless `v16-webapp-prime.tiktok.com/video/...` play address
> is recognised directly (the old host regex accidentally required `webapp.` and lost `webapp-prime.`), and
> the worker also captures the matching item-detail XHR. If the heavy share page still exposes only previews,
> it tries TikTok's official `/player/v1/{postId}` surface and one fresh-page signature before giving up.
> Candidates are ranked (own CDN + real mp4 + 480–1440p first; manifests, posters and DRM-tagged formats last)
> and tried in order, and an attempt counts as a success only when the bytes begin with `ftyp`/`moov`/EBML —
> an S3 `AccessDenied` XML page and a bot-wall login screen are both HTTP 200, and
> uploading one of those as if it were footage is how you get a publish that "succeeded" and shows a black
> video. Failures name the platform, how many candidates were tried and what the page showed instead
> (`TikTok: fetched 3 candidate URLs and none of them gave a playable video (a login wall) — open the link
> once in the live browser…`), and they arrive as a toast **and** on the Post button — a publish that cannot
> run is no longer allowed to look like nothing happened.
>
> **A host check, because a login wall is full of real mp4s.** The first run of the new grab "succeeded" and
> uploaded 0.2 MB of `sf16-website-login.neutral.ttwstatic.com/.../bg.mp4` — TikTok's *login screen* background
> loop, then the studio never opened. Byte checks cannot catch that (it is a valid mp4), so `mediaHostOk`
> requires a **media** host (`v16-webapp.tiktok.com`, `tiktokcdn*`, `.../aweme/v1/play/`, `cdninstagram`,
> `googlevideo`) and vetoes asset/telemetry infrastructure (`ttwstatic`, `sf16-gecko`, `static.`, `mssdk`,
> `mon.snssdk`), with a 300 KB floor on top; when every candidate is an asset the log says *"the page offered N
> video URLs, all from its static/login host — that is what a login or challenge wall looks like from here"*
> instead of blaming your link. YouTube answers a datacenter IP with
> `LOGIN_REQUIRED` ("Sign in to confirm you're not a browser") more often than not; that is now reported as
> the site's verdict, not as a broken deck.
>
> **A manual upload runs in the tab you are watching; source retrieval does not.** Opening the source in the
> streamed tab made a failed CDN fetch look like the deck had chosen to watch the video instead of uploading it.
> Post now resolves/downloads the source in one short-lived background tab, closes it, then drives only the
> destination studio in the streamed tab (input lock held, ambient cursor and login polling parked): you watch
> the file attach, the product-tour popup close, the caption land and Post get pressed. The worker reports
> success only after the uploader confirms it, and only a destination URL is labelled **Live publish** — the
> old path incorrectly broadcast the source URL even when `uploadTikTok` had returned `ok:false`. With no
> browser tab open the studio falls back to its own page. The hourly engine cycle remains hidden and cannot
> steal the feed you are browsing.
>
> **Studio reachability.** TikTok's upload page has lived at two URLs, so `uploadTikTok` tries `/upload` then
> `/tiktokstudio/upload`, clicks the "Upload video" trigger if the `<input type=file>` is mounted lazily, and
> distinguishes "bounced to a login wall" (re-paste the session cookie) from "no file input at all" (the studio
> changed layout) — those two need opposite fixes and one vague error message used to cover both.
> The Session cookie panel has a **Can it post?** button for exactly this: it opens the studio in the streamed
> tab and reports whether a file input appeared, so "this session cannot write" is a ten-second answer instead
> of a 40-second publish that ends in a log line.
>
> **Post means TikTok's enabled submit control, not text that happens to say Post.** Studio's current final
> control is `button[data-e2e="post_video_button"]`; it exists while processing but remains
> `aria-disabled="true"` / `data-disabled="true"`. The worker now waits up to three minutes for that named
> control to become enabled (retaining the old `post_button` only for classic Studio), keeps an already-selected
> Everyone menu closed, and handles TikTok's exact `Post now` / `Post anyway` confirmation once. A resolved
> `click()` is only progress: success requires the post-create endpoint, a newly appearing upload-success
> marker, a new `/video/{id}` destination, or Studio's known post-success redirect to `/tiktokstudio/content`.
> Otherwise the run reports the measured button state and visible Studio error; it never invents a publish.
>
> **TikTok Description must equal the requested caption before Post.** Studio pre-fills that field from the
> uploaded basename, which used to leave public posts named `clip-<timestamp>` when its new 757×21 DraftJS
> editor sat just outside the viewport. The picker now recognizes `.public-DraftEditor-content`,
> `contenteditable="plaintext-only"`, caption metadata, and the filename-prefill shape even off-screen; it
> scrolls there, selects all, replaces the filename, and verifies the normalized text exactly. The upload's
> fallback filename is caption-derived as well. If readback still contains `clip-…` or differs from the
> requested caption, the worker stops before Post rather than publishing the wrong name.
>
> **Signed-in state has hysteresis.** "The avatar is gone" is weak evidence — it is gone during hydration, on
> a watch page, on Studio's post-success screen and on a tab that just restarted — so a negative must survive
> three observations spaced at least four seconds apart before the worker calls the session dead; a burst of
> navigation events is one look, not three. A usable Studio upload control and `/tiktokstudio/content` count as
> signed-in evidence, while an actual login-wall URL still flips immediately. When a session installed from a
> pasted cookie dies within half an hour,
> the log says the real reason (the site ended it because this browser doesn't match the one it came from)
> instead of blaming the user for being logged out.
>
> **The tab that "keeps crashing" was probably never an OOM.** Two failures look identical — the kernel killing a
> renderer, and V8 aborting one because the page's JS hit `--max-old-space-size` — and only the first shows up in
> the cgroup OOM counter. The deck's old 384 MB V8 cap was set for a tiny container, and TikTok's upload studio
> (a heavy SPA that also decodes the file you just handed it) dies at that ceiling with gigabytes free. So: the
> cap now **scales with the container** (`cgroupMemoryMb()` → ~30% of its memory, 512–2560 MB, pin with
> `STEALTH_V8_HEAP_MB`), and every crash line says which one it was — *"the kernel OOM-killed it (used/limit, N
> kills)"* vs *"NOT a kernel OOM (…4 GB free) — the renderer ended itself, which means V8's 1024 MB heap cap"*.
> A wrong diagnosis here costs an afternoon of resizing boxes that were never the problem.
>
> And the diet itself was a suspect: with `--renderer-process-limit=3`, Chromium
> **discards** a renderer to stay under the ceiling — "Target crashed" at 399 MB used of an 8000 MB box. So the
> diet (renderer limit + site isolation off) now applies **only under 3 GB**, and `STEALTH_SITE_ISOLATION=true`
> overrides either way. Every launch prints which mode it is in, every crash line quotes the tail of Chromium's
> own log (`--enable-logging=file` → `<profile>/chrome-self.log`), and a verdict that the numbers refute is not
> printed at all: "NOT memory (7601 MB free) — the browser ended this renderer on purpose". After 6 deaths in a
> row the reopen backs off to one every 20 s instead of thrashing, and says why once.
>
> **A crash cannot leave a second browser alive.** Crash recovery used to *forget* the context
> (`teardown()`), and the next launch deleted the profile's `SingletonLock` and started **another** Chromium on
> the same profile dir — memory doubling (321 MB → 601 → 1277 in one log), the two trees fighting over the
> profile, and a page that dies every few seconds forever. `teardown()` now closes the context it drops, and
> `launchContext` first **reaps any stray Chromium whose command line holds this profile's path** (only when we
> have no live context of our own; the profile path is the match, so nothing else on the box can be hit) and
> logs *"Reaping N orphaned browser process(es) still holding this profile…"*.
>
> **A publish that loses its tab retries once.** "Manual publish failed: locator.count: Target page, context or
> browser has been closed" was a *crash* wearing an error: the video was already downloaded, 20 MB of it, and the
> run died because the reopened tab wasn't ready. `isTabGone` recognises the closed-target family, waits for the
> recovery (`waitForRecovery`), and re-tries the studio hand-off once. Refusals from the *site* are never
> retried — the studio will just say no again.
>
> Both sides of the geometry, the cookie parser and the source grab are unit-tested with no browser:
> `npm test`.

> **Login identity warning:** on `BROWSER_ENGINE=clearcote` the persona is fixed per platform
> and derived from your `WORKER_TOKEN` (`STEALTH_FINGERPRINT` overrides it). Changing either
> **changes the fingerprint identity**, which can re-trigger login challenges — pick a token,
> keep it, and don't rotate it. On the **Playwright** engine there is no synthetic persona at
> all: the browser reports itself consistently with the machine it runs on, which is the
> coherent thing to be, and nothing about it depends on your token.

> **Resources — read this if TikTok "doesn't load":** a TikTok tab alone is **600–900 MB** in
> its renderer process; headed Chromium (Playwright's build + Xvfb) needs roughly **1.5–2 GB
> RAM**
> per service to be comfortable. When the container is smaller, the kernel OOM-kills the
> renderer: the dock shows *"… Target crashed"* (or *"The browser process was killed right
> after start"*) and the tab goes dark. The worker now (a) runs the browser on a memory diet
> (one renderer per site, no GPU process, capped JS heap, Chrome's own OOM intervention),
> (b) **auto-reopens a crashed tab at the same URL** and logs *"TAB CRASHED … container memory
> X of Y, N OOM kill(s)"* to the deploy log so you can see it *was* memory, and (c) surfaces
> launch progress/errors in the dock instead of a silent "waiting for first frame". If crashes
> keep coming: **Railway → service → Settings → Resources → raise memory to ≥ 2 GB**, or set
> `STEALTH_HEADLESS=true` (no Xvfb, ~40 % less memory; slightly weaker stealth).

> **Container note:** Docker/Railway containers don't grant `CAP_SYS_NICE`, so `setpriority()`
> returns `EPERM`. Release Chromium silently ignores that; Clearcote's pre-release builds have
> DCHECKs enabled and would fatal (`base/process/process_linux.cc` `DPCHECK(result == 0)`).
> The image therefore builds a tiny `setpriority` shim (`worker/nice-shim.c`) and preloads it
> into the browser (`STEALTH_NICE_SHIM`) — priorities stay at their defaults, exactly as in a
> release build.

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
