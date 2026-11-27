# Workflow Automation Engine

A small React + Vite dashboard backed by an Express API and persistent SQLite database.

## Requirements

- Node.js 20 or newer
- npm

## Run locally

Install dependencies from the repository root:

```sh
npm run install:all
```

Start the API and frontend in separate terminals:

```sh
npm run dev:backend
npm run dev:frontend
```

Open the Vite URL printed in the frontend terminal (usually http://localhost:5173). The API listens on http://localhost:3001. SQLite data is stored in `backend/data/workflows.sqlite` and is created automatically. Set `DB_FILE` to change its path or `PORT` to change the API port.

## API

- `POST /api/workflows` — create `{ "name": "...", "definition": { "startAt": "step-id", "steps": [...] } }`
- `POST /api/workflows/generate` — generate a validated workflow from `{ "description": "..." }`; returns `name`, `definition`, and `source` (`groq` or `fallback`)
- `GET /api/workflows` — list workflows
- `POST /api/workflows/:id/trigger` — trigger with `{ "data": { ... } }`
- `GET /api/runs` — list runs
- `GET /api/runs/:id` — run details, trigger data, and logs
- `GET /api/messages` — simulated messages

Workflow definitions use step IDs and `next`/`trueNext`/`falseNext` references. Supported step types are `task`, `condition`, `wait`, and `message`. Conditions support `equals`, `not_equals`, `greater_than`, and `less_than`. The demo workflow is inserted automatically when the database has no workflows. A qualifying order waits five seconds before recording its simulated follow-up message.

Natural-language generation uses Groq when `GROQ_API_KEY` is set (the model defaults to `openai/gpt-oss-120b`; override it with `GROQ_MODEL`). Without a key, a rule-based parser supports order triggers, amount thresholds, waits, and message descriptions. Generated definitions are validated before they are returned. New workflows must be saved explicitly and are not triggered automatically. The dashboard polls persisted messages and displays dismissible simulated-message notifications.

Run backend checks with `npm test` from `backend/`. They exercise scheduler restart recovery, fallback generation, workflow validation, and message idempotency.
