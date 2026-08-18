# Remix Arcade

Remix Arcade is a mobile-first web app for making and playing small AI-generated games. Players can browse a swipeable arcade, describe a new 2D or 3D game, publish it, and create their own version of somebody else's game.

This repository contains the full web app, the local development server, and the Cloudflare deployment code.

## Main features

- Prompt-based 2D and 3D game generation
- Swipeable feed of playable games
- Remix history, creator pages, likes, comments, follows, and sharing
- Background generation jobs with retry and status handling
- AI-generated game covers
- Ownership-protected game updates
- Rate limits, usage tracking, analytics, and content reports
- Local Node.js server and a Cloudflare Workers + D1 production path

## Project structure

| Path | Purpose |
| --- | --- |
| `public/index.html` | Mobile frontend and game-generation client |
| `server.js` | Local Express server and API |
| `worker/index.mjs` | Cloudflare Worker API and D1 storage |
| `worker/generation-workflow.ts` | Retried background AI-generation workflow |
| `db/` and `drizzle/` | Database schema and migration |
| `scripts/verify-generator.cjs` | Automated checks for the generation pipeline |

## Run locally

Requirements: Node.js 20 or newer and an API key for one of the supported AI providers.

```bash
npm ci
```

Create a local environment file from the example:

```powershell
Copy-Item .env.example .env
```

On macOS or Linux, use `cp .env.example .env` instead. Open `.env`, choose a provider, and add your own API key. The key is read by the server and is not sent to the browser.

Start the app:

```bash
npm run dev
```

Then open `http://localhost:3000`.

To test from a phone, connect it to the same network as the computer and open `http://YOUR-COMPUTER-IP:3000`.

## Check the project

```bash
npm test
npm run build
```

## Deployment

The production setup uses Cloudflare Workers, D1, static assets, and a durable generation workflow. After configuring the Cloudflare bindings and secrets for your own account, deploy with:

```bash
npm run deploy
```

The local Express server is also kept as a lightweight development and fallback environment. Local data is written to `data/storage.json`, which is intentionally excluded from Git.

## Configuration

`.env.example` documents the available provider, model, rate-limit, storage, and server settings. Real API keys belong only in `.env` or in the deployment platform's secret store; neither is committed to this repository.
