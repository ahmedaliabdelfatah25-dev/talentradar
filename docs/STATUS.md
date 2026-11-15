# Status: what works, what is simulated, what needs IT authorisation

Build date: November 2026. This document is deliberately blunt so nobody is surprised at go-live.

## 1. Works now and is tested

Verified by 37 API integration tests against a real PostgreSQL database and 11 browser workflow tests
(Chromium), plus a production-mode start of the compiled server on an empty database.

| Area | Verified behaviour |
|---|---|
| Sign-in | Email + password, account lockout after 5 failures, forced change of temporary passwords (enforced server-side), sessions in httpOnly cookies, sign-out, deactivation ends sessions immediately |
| Permissions | Four roles (administrator, leadership, recruiter, viewer); 19 permissions editable per role; recruiters can only update their own vacancies; viewers are read-only and do not see internal notes |
| Executive overview | KPIs, intervention list, upcoming deadlines, overdue actions, tracker table with all 11 required columns, filters by recruiter / country / department / hiring manager / status |
| Recruiter workspace | Own vacancies, "what I must update", actions grouped overdue / today / upcoming / waiting, next priority |
| Central hiring tracker | Create, edit, archive; every required field; column chooser; CSV export; duplicate Greenhouse-ID protection; field-level audit history |
| Vacancy workspace | Milestones, latest update, timeline, next action, blockers, support, ownership, notes, Greenhouse panel, change history; quick update records what changed, date, user, status, next action, owner, deadline |
| Milestones | Admin-defined templates; per-vacancy add / remove / reorder / skip; "reached" dates; days in current stage |
| Action centre | Create, assign, comment, complete, reopen; five statuses; automatic buckets |
| Risk monitor | Ten rule-based checks, each explaining what happened / vacancy / responsible / last update / recommended action; thresholds and on/off switch per rule |
| Assistant (built-in) | Vacancy summary, weekly summary, leadership brief, outdated records, reminder drafts, bottlenecks, suggested next actions — every statement carries source references; no AI service involved |
| Leadership report | Weekly report from live data, saved snapshots, automatic weekly snapshot, changes since previous report, history and stagnation view, PDF and CSV export, browser print |
| Excel / CSV import | .xlsx and .csv, multi-sheet, header-row detection, mapping suggestions with confidence, preview, duplicate detection (Greenhouse ID, title + country, within file), missing-information checks, explicit per-row decisions, validation report (screen + CSV), audit trail, protection against importing a batch twice |
| Administration | Users, bulk reassignment, departments / countries / TA teams / statuses / job families / vacancy types, milestone templates, risk rules, permission matrix, audit log, demo-data removal |
| Interface | Light and dark themes, responsive layout, keyboard-accessible dialogs |

## 2. Simulated (clearly labelled in the product)

| Item | What is simulated | How it is labelled |
|---|---|---|
| Demonstration data | 10 fictional vacancies, 7 fictional users, 16 actions, 6 weeks of saved reports | `DEMO` tag on every record, banner in the menu, "contains fictional data" on reports and PDFs |
| Greenhouse "Simulated" mode | Job data and application counts are generated, including one deliberately missing job and one title mismatch so the error display can be seen | "Simulated data" badge in Integrations and on each vacancy's Greenhouse panel |
| Demo sign-in | One-click role buttons on the sign-in page | Only shown while the server runs with `DEMO_DATA=true` |

## 3. Implemented but not verified against PlanRadar's real systems

These are written and tested against local stand-ins. They need credentials or infrastructure that only
company IT can provide, and must be validated during onboarding.

| Item | State | What IT must provide |
|---|---|---|
| **Greenhouse live sync (Harvest API v3)** | Client implements the published v3 model — OAuth client-credentials token from `auth.greenhouse.io/token`, Bearer authentication, cursor pagination via the `Link` header, HTTP 429 back-off — and is tested against a mock server. **The resource paths and field names could not be checked against Greenhouse's reference** because their documentation hosts were unreachable from the build environment. They are configurable by environment variable. Hiring-team sync is off until its path is confirmed. | A Harvest v3 (OAuth) credential created by a Greenhouse admin with read scopes for jobs, applications, job stages, departments, offices, users; a test run and field-mapping check (IT_HANDOVER §7) |
| **Single sign-on (Microsoft Entra ID, OpenID Connect)** | Authorisation-code flow with PKCE, state and nonce checks, domain allow-list, optional auto-provisioning. Tested against a mock identity provider, not against Entra. | App registration, client secret, redirect URI (IT_HANDOVER §5) |
| **Docker image** | `Dockerfile` and `docker-compose.yml` are written; the same build steps and the compiled server were run directly. **The image itself was not built** because the build environment has no Docker daemon. | First `docker compose up --build` on the target host |
| **Azure template** (`deploy/azure/main.bicep`) | Starting template, **not deployed or compiled** from here. | Review against Azure standards, deploy to a test resource group |
| **Optional AI re-wording** | Works with any OpenAI-compatible chat endpoint (e.g. Azure OpenAI); tested against a mock. Output is discarded unless it cites the recorded facts and contains no figure that is not in them. Off by default. | A company-approved model endpoint and key, if wanted at all |
| **Microsoft Teams posting** | Sends an Adaptive Card to a channel workflow webhook. Not tested against a real tenant. | Webhook URL from a Teams workflow |

## 4. Not built (by design or deferred)

- No candidate data, no writing back to Greenhouse, no LinkedIn Recruiter or BrightHire integration.
- No email sending. Reminder drafts open in the user's own mail client (Outlook) or are copied.
- No in-app notifications or scheduled reminder emails.
- No native mobile app (the web app is responsive).
- Legacy `.xls` files are rejected with instructions to save as `.xlsx`.

## 5. Known limitations

- **PDF and right-to-left text:** PDF export embeds DejaVu Sans, which covers Latin, Greek and Cyrillic.
  Arabic text is not shaped correctly in the PDF. Use *Print* in the browser (which renders Arabic properly)
  or the CSV export for Arabic content.
- **Timezone:** deadlines and week boundaries use `Africa/Cairo`. The server reads `APP_TIMEZONE`; the web
  app has the same zone as a constant in `web/src/lib/format.ts` — change both if the team's base moves.
- **Scale:** designed for a TA team (hundreds of vacancies, tens of users). Lists are loaded whole and
  filtered in the browser; beyond a few thousand open vacancies, server-side paging would be needed.
- **Single instance scheduler:** the hourly housekeeping job (weekly snapshot, session cleanup) runs in the
  app process. Running several instances is safe for requests; the snapshot is an idempotent upsert.
- **Password sign-in** is intended for the pilot. Switch to SSO-only (`LOCAL_LOGIN_ENABLED=false`) for
  production so the company's MFA and leaver process apply.
