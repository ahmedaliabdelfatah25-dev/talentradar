# Database design

PostgreSQL 14+ (developed and tested on 16). Schema source: `server/migrations/001_init.sql`.

## Conventions

- Integer identity primary keys; `timestamptz` for instants; `date` for calendar days (deadlines).
- Calendar-day logic ("today", overdue, week boundaries) uses the business timezone (`APP_TIMEZONE`).
- No candidate-level data is stored anywhere.

## Tables

| Group | Table | Purpose |
|---|---|---|
| Reference | `ta_teams`, `countries`, `departments`, `lookup_values` | Admin-managed lists. `lookup_values` holds job families and vacancy types |
| Reference | `vacancy_statuses` | Configurable status labels, each in one of four fixed categories: `active`, `on_hold`, `filled`, `cancelled`. The category drives KPIs and rules; the label is free |
| Reference | `milestone_templates`, `milestone_template_items` | Named milestone sequences with an optional planned day offset from the opening date |
| People | `users` | Email, name, role, optional password hash (scrypt), optional SSO subject, lockout counters |
| People | `sessions` | SHA-256 of the session token, expiry, IP, user agent |
| People | `role_permissions` | Which role holds which permission |
| Config | `settings` | JSON settings: risk-rule thresholds, reporting week, primary team, Greenhouse mode |
| Core | `vacancies` | The Excel replacement — one row per vacancy (see below) |
| Core | `vacancy_milestones` | Each vacancy's own milestone list: position, status, planned / reached / completed dates |
| Core | `vacancy_updates` | Progress updates, each with a snapshot of stage, status, health, next action, owner, deadline, blocker |
| Core | `actions`, `action_comments` | Action centre |
| History | `audit_log` | Append-only: who changed what, when, with field-level before/after as JSON |
| History | `report_snapshots` | One saved weekly report per week (JSON), for history and "changes since last report" |
| Migration | `import_batches`, `import_rows` | Each upload, its mapping, its totals and a per-row outcome |
| Integration | `sync_runs` | Each Greenhouse synchronisation: stats, issues, jobs not in the tracker |
| System | `schema_migrations` | Applied migration files |

### `vacancies` — field groups

| Group | Columns |
|---|---|
| Identification | `greenhouse_job_id` (unique among non-archived rows), `title`, `country_id`, `city`, `department_id`, `job_family`, `vacancy_type` |
| Ownership | `ta_team_id` (responsible team — independent of `country_id`), `recruiter_id`, `hiring_manager`, `hiring_manager_email`, `department_owner`, `stakeholders` |
| Recruitment information | `opening_date`, `target_hire_date`, `priority`, `current_stage` (derived from milestones), `status_id`, `health`, `progress_update`, `last_update_at`, `last_update_by` |
| Operational tracking | `latest_achievement`, `next_action`, `action_owner`, `action_deadline`, `current_blocker`, `support_required`, `internal_notes` |
| Outcome | status category `filled` / `cancelled` / `on_hold`, `closure_date` |
| Integration | `greenhouse_snapshot` (JSON summary), `greenhouse_synced_at` |
| Bookkeeping | `is_demo`, `archived_at`, `created_by`, `created_at`, `updated_at` |

`health` is one of `on_track`, `needs_attention`, `awaiting_feedback`, `blocked` and is set by the
recruiter — it is never computed. The single "overall status" shown in the product is: Hired / Cancelled /
On hold when the status category says so, otherwise the health.

### Milestones

A milestone is *reached* when it becomes the vacancy's current stage (`started_date`) and *completed* when
the vacancy moves on (`completed_date`). `status` is `pending`, `in_progress` (the current stage — at most
one), `completed` or `skipped`. `vacancies.current_stage` is a denormalised copy of the current
milestone's name, maintained by the server. Only `pending` milestones past their `planned_date` count as
delayed.

## Relationships

```
ta_teams ─┐            ┌─ vacancy_milestones
countries ─┤           ├─ vacancy_updates ── users
departments┼─ vacancies┼─ actions ── action_comments
statuses ──┤           └─ audit_log (by vacancy_id)
users ─────┘
milestone_templates ── milestone_template_items      import_batches ── import_rows
```

Deleting a vacancy is a soft delete (`archived_at`); milestones and updates cascade only on a hard delete
(used when removing demonstration data).

## Migrations

Add a new file `server/migrations/00N_description.sql`. Files run once, in name order, each in its own
transaction, at application start or via `node server/dist/cli.js migrate`. Never edit a migration that has
been applied to a real environment — add a new one.
