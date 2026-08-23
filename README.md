# StoryForge Studio

A polished, local-first short-form story creator studio prototype. StoryForge lets you choose TikTok or Instagram, select a visual format, generate a fresh storyboard, preview motion/captions, listen to local browser narration, and export a storyboard file.

## Connecting an account

Log in by pasting the **session cookies JSON** from your own browser (a cookie-editor extension can export them). There is no OAuth flow and no redirect.

1. Pick a platform (TikTok or Instagram).
2. In “Log in with session cookies”, paste the JSON — either an array of cookie objects (`name`, `value`, optional `domain`/`path`/`expires`) or a simple `{ "sessionid": "…" }` map. A valid `sessionid` cookie is required.
3. Click **Validate & connect**. The app checks the structure locally, then asks the server to verify the session live against the platform (best-effort; if the platform check is unreachable it falls back to the local check and says so).

Cookies are used only to verify the session, are never written to the server, and are kept in your browser's local storage. Disconnect anytime from the same panel. Re-export a fresh set when a session expires.

The “Queue test post” action is a safe no-op: it confirms the draft flow without sending anything to TikTok or Instagram.

## Features

- TikTok / Instagram platform selection with a responsive creator dashboard.
- Session-cookie login with local structure validation and a best-effort live session check.
- Stickman crimes: non-graphic, documentary-style story draft with timed scene cues.
- Faceless chat stories: messenger-style preview with Maya, Leo, and an UNKNOWN sender.
- Render test format for checking the preview pipeline quickly.
- Optional server-side Groq generation. The API key stays on the server and is never sent to the client.
- Local `speechSynthesis` voice preview with a lower-pitch narrator treatment and two contrasting chat voices.
- Unique draft IDs and fresh-generation entropy to prevent reusing the same generated draft record.
- JSON storyboard export. No credentials, cookies, or platform access tokens are included in exports.
- No frontend framework or build step required.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`.

Without `GROQ_API_KEY`, the app uses its local demo story library. To enable Groq on the server, copy `.env.example` to `.env` and set the key, or set the variable in your service environment. Do not put the key in frontend code.

## Deploy

1. Create a service from this repository.
2. The service detects `package.json` and runs `npm start`.
3. Add `GROQ_API_KEY` as a variable if you want AI-generated drafts. `PORT` is provided automatically.
4. Open the generated public domain. The Node server listens on `0.0.0.0` and serves the app plus `/api/health`, `/api/generate-story`, and `/api/validate-session`.

The browser voice preview uses the visitor's installed browser voices, so exact voice availability depends on the device. It is intentionally a free preview rather than a generated audio file or a platform post.
