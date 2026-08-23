# StoryForge Studio

A polished, local-first short-form story creator studio prototype for Railway. StoryForge lets you choose TikTok or Instagram, select a visual format, generate a fresh storyboard, preview motion/captions, listen to local browser narration, and export a storyboard file.

## Safety boundary

This project intentionally does **not** accept, validate, store, or use session cookies. Session-cookie import can expose an account and bypass platform security. The connection control is a local demo state; production publishing should be implemented with each platform's approved OAuth and creator APIs, with least-privilege scopes and revocation support.

The “Queue test post” action is also a safe no-op: it confirms the draft flow without sending anything to TikTok or Instagram.

## Features

- TikTok / Instagram platform selection with a responsive creator dashboard.
- Stickman crimes: non-graphic, documentary-style story draft with timed scene cues.
- Faceless chat stories: messenger-style preview with Maya, Leo, and an UNKNOWN sender.
- Render test format for checking the preview pipeline quickly.
- Optional server-side Groq generation. The API key stays on the server and is never sent to the client.
- Local `speechSynthesis` voiceover with a lower-pitch narrator treatment and two contrasting chat voices.
- Live vertical canvas renderer that matches the generated post format: animated outlined stickman, open explaining pose, talking mouth, scene cues, timed captions, and 9:16 output.
- Browser-side WebM demo export from the live canvas, with a progress state and download action.
- Unique draft IDs and fresh-generation entropy to prevent reusing the same generated draft record.
- JSON storyboard export. No credentials, cookies, or platform access tokens are included.
- No frontend framework or build step required.

## Run locally

```bash
npm start
```

Open `http://localhost:3000`.

Without `GROQ_API_KEY`, the app uses its local demo story library. To enable Groq on the server, copy `.env.example` to `.env` and set the key, or set the variable in your Railway service environment. Do not put the key in frontend code.

## Deploy on Railway

1. Create a Railway service from this repository.
2. Railway detects `package.json` and runs `npm start`.
3. Add `GROQ_API_KEY` as a Railway variable if you want AI-generated drafts. `PORT` is provided by Railway automatically.
4. Open the generated public domain. The Node server listens on `0.0.0.0` and serves the app plus `/api/health` and `/api/generate-story`.

The browser voiceover uses the visitor's installed browser voices, so exact voice availability depends on the device. It plays live while the canvas is rendered. The downloaded WebM contains the vertical visual/caption track; embedding a spoken audio track requires adding a server-side TTS provider.
