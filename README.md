# Euka

> AI-assisted career system — find jobs, evaluate fit, tailor resumes, and
> auto-fill applications. Extracted from the `learn-dashboard` monorepo into a
> standalone app.

## Stack

- **Frontend**: React 19 + Vite + React Router
- **Backend**: Node.js + Express (`server.mjs`)
- **Browser automation**: Playwright (+ stealth) — the application "applier"
- **AI**: Claude API (`@anthropic-ai/sdk`) — Sonnet for complex, Haiku for cheap
- **Validation**: Zod · **Data**: YAML + JSON under `data/career/`

## Quick start

```bash
npm install
npx playwright install chromium      # for the applier / PDF rendering
cp .env.example .env                 # add your ANTHROPIC_API_KEY
npm run dev                          # server :4568 + vite :5173
```

Then open http://localhost:5173 — it redirects to `/career`.

You can also set the Anthropic key (and optional Google OAuth for Google Docs
resume sync) at runtime via **Settings → Integrations**, which persists to
`data/config.json` (gitignored).

### Scripts

| Command | What |
|---------|------|
| `npm run dev` | Express API + Vite dev server (concurrently) |
| `npm run server` | API only (`PORT=4568 node server.mjs`) |
| `npm run build` | `tsc -b && vite build` |
| `npm run init:career` | Seed `data/career/` from the example files |
| `npm run eval:snapshot` / `tune:snapshot` | Evaluator snapshot harnesses |

## Layout

| Path | Purpose |
|------|---------|
| `src/CareerApp.tsx` | App shell + routing (mounted at `/career/*`) |
| `src/career/` | All UI + backend logic (finder, evaluator, cv, applier, feedback, …) |
| `server.mjs` | Express backend — `/api/career/*` routes |
| `data/career/` | Config + state. Only `*.example.*`, fixtures, and ATS adapter configs are committed; personal data is gitignored |
| `scripts/` | Smoke tests + self-test harnesses |
| `META/00-project-room/04-career-system/` | Design specs & milestone history |

## Data & privacy

This repo is public, so `data/career/` only commits non-personal files:
example configs (`*.example.yml`), ATS adapter configs (`site-adapters/`), and
PII-free test fixtures. Your real identity, preferences, narrative, resumes,
pipeline, applications, OAuth tokens, and the Playwright browser profile are all
gitignored. Run `npm run init:career` to scaffold local data from the examples.

## Notes on the extraction

`server.mjs` was lifted from the monorepo. It still contains the dormant
Learn/Tracker routes (`/api/repos`, `/api/activity`, `/api/prs`,
`/api/learn-dirs`, `/api/tree`, file ops, `/api/claude-stats`, `/api/claude-ping`)
as dead code — the career frontend never calls them, and their startup
side-effects have been disabled. They can be pruned in a follow-up.
