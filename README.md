# Remix Arcade

Remix Arcade is a mobile-first arcade prototype where people can swipe through tiny games, create a new game from a prompt, and remix existing games.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Create your local environment file:

```bash
cp .env.example .env
```

PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Put your Yunwu API key in `.env`:

```env
AI_PROVIDER=yunwu
YUNWU_API_KEY=sk-your-real-yunwu-key
YUNWU_BASE_URL=https://yunwu.ai/v1
YUNWU_MODEL=gpt-5.6-luna
AI_EFFORT=high
```

If your Yunwu dashboard shows a different exact model name, replace `YUNWU_MODEL` with that model.
For lower beta costs, try `AI_EFFORT=medium`; for quality-first game generation, use `AI_EFFORT=high`.

4. Start the app:

```bash
npm run dev
```

5. Open `http://localhost:3000`.

To test on a phone, connect the phone and computer to the same Wi-Fi network, then open `http://YOUR-COMPUTER-IP:3000` on the phone. The server binds to `HOST=0.0.0.0` for local-network access. Windows may ask you to allow Node.js through the private-network firewall.

## Meta Muse Spark 1.1

Muse Spark uses Meta's separate Model API; a Yunwu key cannot access it. After receiving a Meta Model API key, use:

```env
AI_PROVIDER=meta
META_API_KEY=your-meta-model-api-key
META_BASE_URL=https://api.meta.ai/v1
META_MODEL=muse-spark-1.1
```

## What changed from the single HTML prototype

- The frontend lives at `public/index.html`.
- Shared games are saved through `/api/storage`.
- AI generation goes through the server, so the API key is never shipped to the browser.
- Visitor-only data like name, follows, and streak stays in that visitor's browser.
- The beta supports Yunwu and Meta through OpenAI-compatible chat completions APIs, plus an optional Anthropic fallback.
- Game generation continues while the visitor browses inside the app and reports completion through a global build notification. Refreshing the page still interrupts an active build.

## Publish

This app can deploy to any Node.js host that supports a long-running web service.

Use these settings:

- Build command: `npm install`
- Start command: `npm start`
- Required environment variables: a supported `AI_PROVIDER` and its matching API key
- Optional environment variables: provider base/model settings, `AI_REQUESTS_PER_IP_PER_HOUR`, `AI_REQUESTS_GLOBAL_PER_DAY`, `DATA_FILE`, `HOST`, `PORT`

Important: this MVP saves shared games to `data/storage.json`. For a serious public launch, use a real database or attach persistent disk storage on your host. If the host has an ephemeral filesystem, generated games may disappear when the service restarts.

## Beta Budget Controls

These `.env` values keep the free beta from burning through all API credit at once:

```env
AI_REQUESTS_PER_IP_PER_HOUR=6
AI_REQUESTS_GLOBAL_PER_DAY=80
AI_MAX_TOKENS=8000
AI_EFFORT=medium
```

One game creation usually uses two AI calls: one for game code and one for cover art. Lower the daily number if you want the 35 RMB test budget to last longer.

## Production checklist

- Replace JSON-file storage with Postgres, Supabase, Redis, or another durable database.
- Add real auth if creator identity matters.
- Add moderation before publishing user-generated games widely.
- Add spending controls around AI generation.
- Add analytics for activation, creations, remixes, and retention.
