# Talent Radar — Egypt TA Control Tower

A browser-based recruitment progress tracker and leadership visibility platform for PlanRadar's Egypt Talent
Acquisition team. It replaces the team's Excel tracker with one shared, permission-controlled database of
vacancies, ownership, progress, next actions and deadlines.

It is an **operational management layer**. Greenhouse remains the ATS and the source of truth for candidates
and applications; LinkedIn Recruiter and BrightHire are untouched.

| Read this | For |
|---|---|
| [`docs/STATUS.md`](docs/STATUS.md) | What works today, what is simulated, what needs IT authorisation |
| [`docs/IT_HANDOVER.md`](docs/IT_HANDOVER.md) | Deployment, HTTPS, SSO, database, backups, go-live checklist |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Architecture, modules, security model, design decisions |
| [`docs/DATABASE.md`](docs/DATABASE.md) | Schema and migrations |
| [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md) | How leaders, recruiters and administrators use it |

## What it does

- **Executive overview** — KPIs, vacancies needing intervention, upcoming deadlines, overdue actions and the
  central tracker table with filters (leadership landing page).
- **Recruiter workspace** — my vacancies, what I must update, my overdue actions, next priority.
- **Central hiring tracker** — one structured record per vacancy (identification, ownership, recruitment
  information, operational tracking, outcome), with field-level change history. Vacancy *location* and
  *responsible TA team* are separate fields.
- **Vacancy workspace** — milestones, timeline, next action, blockers, support, Greenhouse link, history,
  and a 20-second "Update progress" dialog.
- **Configurable milestones** — templates per recruitment process, editable per vacancy; distinct from
  Greenhouse application stages.
- **Action centre** — shared tasks with owner, due date, status, comments; overdue / today / upcoming /
  waiting-on-others worked out automatically.
- **Risk monitor** — transparent, configurable rules; every alert states what happened, who is responsible
  and what to do. No predictive scores.
- **Assistant** — summaries, reminders, bottlenecks and suggestions built deterministically from recorded
  data, each statement citing its source records. Works with no AI service.
- **Leadership report** — weekly report from the same database, history and stagnation view, PDF and CSV.
- **Excel / CSV migration** — upload, column mapping, preview, duplicate detection, validation report,
  audit trail. Never overwrites silently.
- **Administration** — users, roles and permissions, reference data, statuses, risk rules, integrations,
  audit log.

## Technology

React 19 · TypeScript · Tailwind CSS 4 · Vite — Node.js 22 · Express 5 · PostgreSQL 16 — REST API — Docker.
One container serves the web app and the API on a single port; all state is in PostgreSQL.

```
server/            REST API (TypeScript)
  migrations/      SQL migrations, applied automatically at start
  src/routes/      HTTP endpoints          src/services/   domain logic (tracker, risks, report, assistant, import, Greenhouse)
  test/            API integration tests (real PostgreSQL)
web/               React single-page application
e2e/               Browser tests of the primary workflows (Playwright)
deploy/            Caddyfile, backup/restore scripts, Azure Bicep template
docs/              Documentation
Dockerfile, docker-compose.yml, .env.example
```

## Running it

End users need nothing but Edge or Chrome and the URL. The commands below are for IT and developers.

**Production (Docker):** see [`docs/IT_HANDOVER.md`](docs/IT_HANDOVER.md). In short:

```bash
cp .env.example .env        # fill in APP_URL, APP_DOMAIN, POSTGRES_PASSWORD, BOOTSTRAP_ADMIN_*
docker compose up -d --build
```

**Development / demo (fictional data):**

```bash
npm ci
createdb talentradar        # any PostgreSQL 14+; set DATABASE_URL if not the default below
npm run build -w web
DEMO_DATA=true DATABASE_URL=postgres://talentradar:talentradar_dev@127.0.0.1:5432/talentradar npm run dev -w server
# open http://localhost:8080 and pick a demo role on the sign-in page
```

`DEMO_DATA=true` loads ten fictional vacancies into an **empty** database and shows one-click demo sign-in.
Every demo record is tagged `DEMO`; an administrator removes them in *Administration → Data and settings*.

## Tests

```bash
npm test                    # 37 API integration tests against PostgreSQL database "talentradar_test" (wiped each run)
npm run build -w web && npx playwright test --config e2e/playwright.config.ts --trace off   # 11 browser workflow tests
npm run typecheck
```

The browser tests need Playwright (`npm i --no-save playwright && npx playwright install chromium`).

## Operations

```bash
node server/dist/cli.js migrate                                   # apply migrations (also runs at start)
node server/dist/cli.js create-admin <email> "<name>" <temp-pw>   # create or reset an administrator
node server/dist/cli.js clear-demo                                # remove demonstration data
sh deploy/backup.sh ; sh deploy/restore.sh <file>                 # logical backup / restore
```
