# Architecture

## Principles

1. **Useful first, beautiful second, intelligent third.** Core tracking never depends on AI or on an
   integration being available.
2. **Greenhouse is the system of record.** Talent Radar owns only what was tracked by hand in Excel:
   ownership, progress, next actions, deadlines, blockers, support requests.
3. **Everything shown can be traced.** Alerts are rules over recorded fields; assistant statements cite
   records; reports are computed from the live tables; every change is audited.
4. **One deployable unit.** A single container plus PostgreSQL. No queue, cache or file store to operate.

## Components

```
┌──────────────────────────── container (Node.js 22) ────────────────────────────┐
│  Express 5                                                                     │
│   ├─ static React app (web/dist)            → everything except /api           │
│   └─ /api  REST                                                                │
│        auth      login, logout, me, password change, OIDC SSO                  │
│        core      meta, vacancies, updates, milestones, actions, dashboards,    │
│                  risks, assistant, reports                                     │
│        admin     import, users, reference data, templates, permissions,        │
│                  settings, audit, demo data, integrations                      │
│  services                                                                      │
│        vacancies   tracker records, milestones, quick updates, audit diffs     │
│        risks       rule engine (pure function of recorded data + thresholds)   │
│        report      weekly report builder, snapshots, history, CSV, PDF         │
│        assistant   deterministic summaries with source references; optional    │
│                    LLM re-wording behind a traceability guard                  │
│        importer    Excel/CSV parsing, mapping suggestion, preview, commit      │
│        greenhouse  demo adapter + Harvest v3 adapter, sync run log             │
│  scheduler        hourly: weekly snapshot, session cleanup, optional sync      │
└───────────────────────────────────┬────────────────────────────────────────────┘
                                    │ TLS
                              PostgreSQL 16
```

Frontend: React 19 single-page app, React Router, TanStack Query for server state, Tailwind CSS 4 with a
small token-based design system (`web/src/index.css`, `web/src/components/ui.tsx`). Fonts are bundled, so
the browser never contacts a third party.

## The three experiences

| Role | Lands on | Sees |
|---|---|---|
| Leadership, viewer, administrator | `/overview` | KPIs, intervention list, deadlines, overdue actions, tracker table |
| Recruiter | `/workspace` | Own vacancies, what to update, own actions, next priority |
| Administrator | plus `/admin`, `/import` | Users, assignment, configuration, permissions, integrations, audit |

Navigation items and API routes are both gated by the same permission set returned from `/api/auth/me`.

## Key design decisions

**Vacancy location vs responsible team.** `vacancies.country_id` says where the role is; `ta_team_id` says
who recruits for it. The overview and the weekly report are scoped to the *primary TA team* setting
(Egypt TA), regardless of country.

**Status model.** Two recorded facts: a configurable *vacancy status* that belongs to one of four fixed
categories (active / on hold / filled / cancelled) and a recruiter-set *health* (on track / needs attention
/ awaiting feedback / blocked). One derived label is shown everywhere: closed and on-hold outcomes win,
otherwise the health. Nothing about health is computed or predicted.

**Milestones are per vacancy.** Templates only seed a new vacancy's milestone list; afterwards the list
belongs to the vacancy and can be reordered, extended or skipped. A milestone is *reached* when it becomes
the current stage. They are explicitly separate from Greenhouse application stages, which are shown in
their own panel as counts.

**Quick update = snapshot.** Each progress update stores the stage, status, health, next action, owner,
deadline and blocker as they were at that moment. Timeline, weekly "activities", bottleneck analysis and
assistant summaries all read these snapshots, which is why they are traceable.

**Risk rules, not scores.** `services/risks.ts` evaluates ten rules over recorded dates and fields against
admin-set thresholds. Each alert carries the triggering fact in words. Alerts are computed on request and
never stored, so they cannot drift from the data.

**Reports from the same database.** `buildWeeklyReport` is used by the overview, the report page, the PDF,
the CSV and the assistant. A weekly snapshot (manual or automatic) stores the report JSON so history and
"changes since the previous report" compare like with like.

**Assistant without AI.** `services/assistant.ts` assembles sentences from recorded data and attaches
source references (vacancy field, update, action, milestone, rule, report). If a company-approved
OpenAI-compatible endpoint is configured, `polish()` sends it *only* the numbered statements and asks for a
re-wording with citations; the result is discarded unless it cites valid statement numbers and contains no
figure absent from them. The built-in statements are always shown underneath as evidence.

**Import never overwrites silently.** The preview classifies every row; duplicates default to *skip*;
updating an existing record requires an explicit per-row choice and goes through the same audited update
path as a manual edit; each row's outcome is stored.

**Greenhouse behind an adapter.** `GhClient` has a demo implementation (fictional data) and a Harvest v3
implementation. The sync refreshes a JSON snapshot per linked vacancy and records mismatches rather than
overwriting, unless an administrator opts in to auto-apply.

## Security model

- Sessions: 256-bit random token in an `HttpOnly`, `SameSite=Lax`, `Secure` cookie; only its SHA-256 is
  stored; 12-hour lifetime; deleted on sign-out, deactivation, role change and password reset.
- Passwords: scrypt with per-user salt, 10+ characters, lockout after five failures, temporary passwords
  must be changed before any other API call succeeds.
- SSO: OpenID Connect authorisation code with PKCE, state and nonce; users matched by email; optional
  domain allow-list and auto-provisioning.
- Authorisation: `requirePerm(...)` on every route; recruiters may update only vacancies assigned to them;
  internal notes are removed from responses for roles without `notes.view`; administration permissions
  cannot be granted to non-admin roles; the last active administrator cannot be demoted or deactivated.
- Cross-site protections: same-origin check on state-changing requests in addition to `SameSite` cookies;
  strict Content-Security-Policy; framing denied by default.
- Input: zod validation on every write; parameterised SQL only; upload size limit; CSV formula
  neutralisation on export.
- Audit: append-only log of sign-ins, record changes (field-level), imports, configuration and permission
  changes, integration runs.

## API overview

All endpoints are under `/api`, JSON, cookie-authenticated.

| Area | Endpoints |
|---|---|
| Auth | `GET auth/config` · `POST auth/login` · `POST auth/logout` · `GET auth/me` · `POST auth/change-password` · `GET auth/sso/login` · `GET auth/sso/callback` |
| Reference | `GET meta` |
| Vacancies | `GET vacancies` (filters) · `GET vacancies/export.csv` · `POST vacancies` · `GET/PATCH/DELETE vacancies/:id` · `POST vacancies/:id/updates` · `PUT vacancies/:id/milestones` |
| Actions | `GET/POST actions` · `GET/PATCH actions/:id` · `POST actions/:id/comments` |
| Dashboards | `GET dashboard/overview` · `GET dashboard/my` |
| Risks | `GET risks` |
| Assistant | `GET assistant/status` · `GET assistant/{weekly,brief,outdated,reminders,bottlenecks,suggestions}` · `GET assistant/vacancy/:id` (`?polish=1` optional) |
| Reports | `GET reports/weekly` · `GET reports/history` · `GET/POST reports/snapshots` · `GET reports/snapshots/:id` · `GET reports/export?format=pdf|csv` |
| Import | `POST import/upload` · `POST import/:id/preview` · `POST import/:id/commit` · `POST import/:id/discard` · `GET import/batches` · `GET import/:id/report` |
| Admin | `admin/users` · `admin/assign` · `admin/reference` · `admin/templates` · `admin/permissions` · `admin/settings` · `admin/demo-data` · `GET audit` |
| Integrations | `GET integrations` · `PUT integrations/greenhouse` · `POST integrations/greenhouse/{test,sync,link}` · `GET integrations/greenhouse/runs` · `POST integrations/teams/post-weekly` |

## Testing

- `server/test/api.test.ts` — 37 integration tests through the HTTP layer against PostgreSQL, including a
  mock Greenhouse v3 server, a mock OIDC identity provider and a mock LLM endpoint.
- `e2e/workflows.spec.ts` — 11 Chromium tests covering the leader, recruiter, administrator and viewer
  journeys end to end.
