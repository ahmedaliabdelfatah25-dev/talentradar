-- Talent Radar — initial schema
-- Conventions: integer identity keys, timestamptz for instants, date for calendar days.
-- Greenhouse remains the system of record for candidates; nothing candidate-level is stored here.

-- ───────────── Reference data (admin-configurable) ─────────────
CREATE TABLE ta_teams (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true,
  sort_order  int NOT NULL DEFAULT 0
);

CREATE TABLE countries (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  iso_code    text,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE departments (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  is_active   boolean NOT NULL DEFAULT true
);

-- Vacancy statuses are configurable labels grouped into four fixed categories.
-- The category drives behaviour (KPIs, risk rules); the label is what people see.
CREATE TABLE vacancy_statuses (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key         text NOT NULL UNIQUE,
  label       text NOT NULL,
  category    text NOT NULL CHECK (category IN ('active','on_hold','filled','cancelled')),
  sort_order  int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE lookup_values (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type        text NOT NULL CHECK (type IN ('job_family','vacancy_type')),
  label       text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0,
  is_active   boolean NOT NULL DEFAULT true,
  UNIQUE (type, label)
);

-- ───────────── Users, sessions, permissions ─────────────
CREATE TABLE users (
  id                    int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email                 text NOT NULL,
  name                  text NOT NULL,
  role                  text NOT NULL CHECK (role IN ('admin','leadership','recruiter','viewer')),
  job_title             text,
  ta_team_id            int REFERENCES ta_teams(id),
  password_hash         text,
  sso_subject           text,
  is_active             boolean NOT NULL DEFAULT true,
  must_change_password  boolean NOT NULL DEFAULT false,
  failed_logins         int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  is_demo               boolean NOT NULL DEFAULT false,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id           text PRIMARY KEY,               -- SHA-256 of the opaque cookie token
  user_id      int NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  ip           text,
  user_agent   text
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE role_permissions (
  role        text NOT NULL,
  permission  text NOT NULL,
  PRIMARY KEY (role, permission)
);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  updated_by  int REFERENCES users(id)
);

-- ───────────── Milestone templates ─────────────
-- Operational milestones owned by this application. They are NOT Greenhouse
-- application stages (which describe a single candidate's progress).
CREATE TABLE milestone_templates (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  is_default  boolean NOT NULL DEFAULT false,
  is_active   boolean NOT NULL DEFAULT true
);

CREATE TABLE milestone_template_items (
  id                  int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  template_id         int NOT NULL REFERENCES milestone_templates(id) ON DELETE CASCADE,
  name                text NOT NULL,
  position            int NOT NULL,
  default_offset_days int            -- planned date = opening date + offset (optional)
);

-- ───────────── Vacancies (the Excel replacement) ─────────────
CREATE TABLE vacancies (
  id                    int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- identification
  greenhouse_job_id     text,
  title                 text NOT NULL,
  country_id            int REFERENCES countries(id),        -- where the vacancy is located
  city                  text,
  department_id         int REFERENCES departments(id),
  job_family            text,
  vacancy_type          text,
  -- ownership
  ta_team_id            int REFERENCES ta_teams(id),         -- who recruits for it (independent of location)
  recruiter_id          int REFERENCES users(id),
  hiring_manager        text,
  hiring_manager_email  text,
  department_owner      text,
  stakeholders          text,
  -- recruitment information
  opening_date          date,
  target_hire_date      date,
  priority              text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  current_stage         text,                                -- denormalised from vacancy_milestones
  status_id             int NOT NULL REFERENCES vacancy_statuses(id),
  health                text NOT NULL DEFAULT 'on_track'
                          CHECK (health IN ('on_track','needs_attention','awaiting_feedback','blocked')),
  progress_update       text,
  -- operational tracking
  latest_achievement    text,
  next_action           text,
  action_owner          text,
  action_deadline       date,
  current_blocker       text,
  support_required      text,
  internal_notes        text,
  -- outcome
  closure_date          date,
  -- integration
  greenhouse_snapshot   jsonb,
  greenhouse_synced_at  timestamptz,
  -- bookkeeping
  is_demo               boolean NOT NULL DEFAULT false,
  archived_at           timestamptz,
  created_by            int REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  last_update_at        timestamptz,                         -- last operational progress update
  last_update_by        int REFERENCES users(id)
);
CREATE UNIQUE INDEX vacancies_gh_uq ON vacancies (greenhouse_job_id)
  WHERE greenhouse_job_id IS NOT NULL AND archived_at IS NULL;
CREATE INDEX vacancies_recruiter_idx ON vacancies (recruiter_id);
CREATE INDEX vacancies_status_idx ON vacancies (status_id);

CREATE TABLE vacancy_milestones (
  id             int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vacancy_id     int NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  name           text NOT NULL,
  position       int NOT NULL,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_progress','completed','skipped')),
  planned_date   date,           -- when the milestone is planned to be reached
  started_date   date,           -- when it was actually reached (became the current stage)
  completed_date date,           -- when the vacancy moved on to a later milestone
  notes          text
);
CREATE INDEX vacancy_milestones_vacancy_idx ON vacancy_milestones (vacancy_id, position);

-- Each progress update stores a snapshot of the operational state at that moment,
-- which is what makes history, weekly reporting and AI summaries traceable.
CREATE TABLE vacancy_updates (
  id               int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vacancy_id       int NOT NULL REFERENCES vacancies(id) ON DELETE CASCADE,
  user_id          int REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  summary          text NOT NULL,                -- what changed
  achievement      text,
  stage            text,
  status_label     text,
  status_category  text,
  health           text,
  next_action      text,
  action_owner     text,
  action_deadline  date,
  blocker          text,
  support_required text,
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','import','system'))
);
CREATE INDEX vacancy_updates_vacancy_idx ON vacancy_updates (vacancy_id, created_at DESC);

-- ───────────── Action centre ─────────────
CREATE TABLE actions (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title         text NOT NULL,
  description   text,
  vacancy_id    int REFERENCES vacancies(id) ON DELETE SET NULL,
  assignee_id   int REFERENCES users(id),
  waiting_on    text,                           -- stakeholder we are waiting for, if any
  due_date      date,
  priority      text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','critical')),
  status        text NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','in_progress','waiting_feedback','completed','cancelled')),
  is_demo       boolean NOT NULL DEFAULT false,
  created_by    int REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);
CREATE INDEX actions_assignee_idx ON actions (assignee_id, status);
CREATE INDEX actions_vacancy_idx ON actions (vacancy_id);

CREATE TABLE action_comments (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action_id   int NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
  user_id     int REFERENCES users(id),
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ───────────── Audit trail (append-only) ─────────────
CREATE TABLE audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  user_id      int REFERENCES users(id),
  user_name    text,
  entity_type  text NOT NULL,
  entity_id    int,
  vacancy_id   int,
  action       text NOT NULL,
  summary      text,
  changes      jsonb
);
CREATE INDEX audit_entity_idx ON audit_log (entity_type, entity_id);
CREATE INDEX audit_vacancy_idx ON audit_log (vacancy_id, at DESC);
CREATE INDEX audit_at_idx ON audit_log (at DESC);

-- ───────────── Weekly report snapshots ─────────────
CREATE TABLE report_snapshots (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  week_start    date NOT NULL UNIQUE,
  week_end      date NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  generated_by  int REFERENCES users(id),
  kind          text NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual','auto','demo')),
  data          jsonb NOT NULL
);

-- ───────────── Excel / CSV migration ─────────────
CREATE TABLE import_batches (
  id           int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filename     text NOT NULL,
  file_size    int,
  file_sha256  text,
  uploaded_by  int REFERENCES users(id),
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded','imported','discarded')),
  sheets       jsonb NOT NULL,       -- parsed workbook: [{name, headerRow, columns, rows}]
  sheet_name   text,
  mapping      jsonb,
  options      jsonb,
  report       jsonb,
  imported_at  timestamptz,
  imported_by  int REFERENCES users(id)
);

CREATE TABLE import_rows (
  id          int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id    int NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number  int NOT NULL,
  raw         jsonb,
  outcome     text NOT NULL,          -- created | updated | skipped_duplicate | skipped_error | skipped_by_user
  vacancy_id  int,
  messages    jsonb
);
CREATE INDEX import_rows_batch_idx ON import_rows (batch_id, row_number);

-- ───────────── Integration sync log ─────────────
CREATE TABLE sync_runs (
  id            int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  integration   text NOT NULL,
  mode          text NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','partial','failed')),
  triggered_by  int REFERENCES users(id),
  stats         jsonb,
  errors        jsonb,
  unlinked      jsonb                 -- Greenhouse jobs seen but not present in the tracker
);
