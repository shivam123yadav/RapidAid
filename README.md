# RapidAid — AI-Powered Emergency Response Network

React + TypeScript + Vite frontend with an Express + MongoDB backend.

## Run it (two terminals)

```bash
# Terminal 1 — API (http://localhost:5000)
npm run server:install     # first time only
npm run server             # auto-seeds demo data on first boot

# Terminal 2 — frontend (http://localhost:3000)
npm install
npm run dev
```

The Vite dev server proxies `/api` → `http://localhost:5000`, so the
browser only ever talks to :3000 (no CORS/cookie issues in dev).

**Demo login:** `dispatcher@rapidaid.com` / `demo123` (role: Dispatcher) —
the Login page's demo buttons fill these for you. Other roles:
`crew@`, `hospital@`, `admin@`, `supervisor@`, `auditor@`, `analyst@`,
`citizen@rapidaid.com` (same password).

## Tests

```bash
npm run typecheck         # frontend strict TS check
npm run build             # production frontend build
npm run server:test       # 125 API integration tests across 15 suites (needs local MongoDB)
```

Voice pipeline checks (need both servers running, plus local MongoDB):

```bash
npm run verify:whisper          # on-device Whisper transcription, fully offline
npm run server:e2e:voice        # real audio through the live API pipeline
npm run server:verify:ui-flow   # the whole flow in headless Chrome (see below)
```

`server:verify:ui-flow` drives the real UI — login, record with a fake mic
playing `server/scripts/ui-tts.wav`, on-device transcription, upload, server
pipeline, hospital routing, then asserts the stored clip reaches a real
duration and the Play button actually advances `currentTime`. It uses
`playwright-core` (a devDependency of this root package) with the system
Chrome, so no browser download is needed. Regenerate the spoken fixture with
`server/scripts/ui-tts.ps1` (Windows SAPI).

See [`server/README.md`](server/README.md) for the API architecture,
endpoint reference, RBAC matrix, and design decisions.
