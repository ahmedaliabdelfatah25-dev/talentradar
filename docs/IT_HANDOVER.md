# IT deployment handover — Talent Radar

Audience: PlanRadar IT / platform team. Goal: host Talent Radar on company-approved infrastructure so
recruiters and leaders use it through Edge or Chrome at a private HTTPS address, with nothing installed
on their laptops.

Nothing in this document assumes that hosting, a domain, a database or Azure permissions already exist.
Section 1 lists every dependency IT has to provide.

## 1. What IT needs to provide

| # | Dependency | Purpose | Notes |
|---|---|---|---|
| 1 | Container hosting | Runs one Linux container (Node.js 22), port 8080 | Azure App Service for Containers or Azure Container Apps recommended; any Docker host works |
| 2 | PostgreSQL 14+ (16 recommended) | All application data | Azure Database for PostgreSQL Flexible Server recommended; ~1 vCPU / 2 GB is ample |
| 3 | Container registry | Stores the built image | Azure Container Registry or existing registry |
| 4 | HTTPS hostname + certificate | Private URL for users | e.g. `talent-radar.<company-domain>`; App Service managed certificate or company certificate |
| 5 | Access restriction | "Authorised colleagues only" | Entra ID SSO (section 5) and, if required, network restriction to VPN / corporate IPs |
| 6 | Entra ID app registration | Single sign-on | Client ID, secret, redirect URI |
| 7 | Secret store | Database URL, client secrets | Azure Key Vault references in app settings |
| 8 | Backup policy | Recovery | Managed PostgreSQL backups (section 8) |
| 9 | Greenhouse API credential *(optional)* | Live job sync | Created by a Greenhouse admin (section 7) |
| 10 | AI endpoint *(optional)* | Re-wording of summaries | Only if the business wants it; not needed for any feature |
| 11 | Teams webhook *(optional)* | Post weekly headline to a channel | Teams "Workflows" incoming webhook |

Sizing: one small instance (1 vCPU / 1.75 GB, e.g. App Service B1) and the smallest burstable database
tier are sufficient for the TA team. The application is stateless; all state is in PostgreSQL.

## 2. Architecture in one paragraph

A single container serves the React web application (static files) and the REST API under `/api` on port
8080. It talks to PostgreSQL over TLS. Database migrations run automatically at start-up, guarded by an
advisory lock. Sessions are opaque random tokens in `HttpOnly`, `SameSite=Lax`, `Secure` cookies, with only
their SHA-256 stored in the database. There is no other state, cache or file storage.

```
Browser (Edge/Chrome) ──HTTPS──▶ App Service / reverse proxy ──▶ container :8080 ──TLS──▶ PostgreSQL
                                                               │
                                                               ├──▶ login.microsoftonline.com (SSO, optional)
                                                               ├──▶ auth.greenhouse.io / harvest.greenhouse.io (optional)
                                                               └──▶ approved AI endpoint, Teams webhook (optional)
```

Outbound access is needed only for the optional integrations in the last three lines.

## 3. Option A — Azure (recommended)

1. **Build and push the image**
   ```bash
   az acr build --registry <registry> --image talent-radar:1.0.0 .
   ```
2. **Deploy the resources** with the starting template (review it first — it has not been deployed from
   this repository):
   ```bash
   az group create -n rg-talent-radar -l westeurope
   az deployment group create -g rg-talent-radar -f deploy/azure/main.bicep \
     -p appName=talent-radar-prod containerImage=<registry>.azurecr.io/talent-radar:1.0.0 \
        postgresAdminPassword=<secret> bootstrapAdminEmail=<first admin email> bootstrapAdminPassword=<secret>
   ```
   It creates an App Service plan and web app (HTTPS only, health check on `/api/health`), PostgreSQL
   Flexible Server 16 with a `talentradar` database, and a Key Vault holding the database URL and secrets,
   referenced from app settings through the app's managed identity.
3. **Registry pull permission:** give the web app's managed identity `AcrPull` on the registry (or configure
   registry credentials).
4. **First start:** the container applies migrations and creates the first administrator from
   `BOOTSTRAP_ADMIN_*`. Check the log stream for `First administrator created`. That person signs in, is
   forced to set a new password, then adds colleagues. Remove `BOOTSTRAP_ADMIN_PASSWORD` afterwards.
5. **Custom domain and certificate:** section 4. **SSO:** section 5.

Networking hardening to consider against company policy: VNet integration + private endpoint for
PostgreSQL instead of the template's "allow Azure services" firewall rule; App Service access restrictions
limiting inbound traffic to corporate / VPN address ranges.

## 4. HTTPS and domain

- **App Service:** add the custom domain (CNAME `talent-radar` → `<app>.azurewebsites.net` plus the TXT
  verification record), then create a free App Service managed certificate or bind a company certificate.
  Set app setting `APP_URL=https://talent-radar.<company-domain>` and restart. `httpsOnly` is already on.
- **Self-hosted (Option B):** Caddy obtains and renews a public certificate automatically for
  `APP_DOMAIN` if the DNS record points at the host and ports 80/443 are reachable. For an internal-only
  name, mount a company certificate as described in `deploy/Caddyfile`.
- The application sends HSTS, a strict Content-Security-Policy, `X-Frame-Options: DENY` and marks cookies
  `Secure` when `NODE_ENV=production`. `TRUST_PROXY` must equal the number of proxies in front of it (1 for
  App Service or Caddy) so client IPs and HTTPS detection are correct.
- To embed the app as a Microsoft Teams tab, set `FRAME_ANCESTORS` (see `.env.example`); otherwise framing
  stays forbidden.

## 5. Authentication and single sign-on

The application supports password sign-in (for the pilot) and OpenID Connect SSO. For production use SSO
only, so MFA, conditional access and the leaver process are enforced by Entra ID.

1. Entra admin centre → **App registrations → New registration**. Single tenant. Redirect URI (Web):
   `https://<host>/api/auth/sso/callback`.
2. **Certificates & secrets → New client secret.** Store it in Key Vault.
3. **Token configuration → Add optional claim → ID token → `email`** (the app also accepts
   `preferred_username`). API permissions: the defaults (`openid`, `profile`, `email`) are enough.
4. Optionally **Enterprise applications → Properties → Assignment required = Yes** and assign the TA team
   and leadership group, so only they can obtain a token.
5. App settings:
   ```
   SSO_ENABLED=true
   SSO_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
   SSO_CLIENT_ID=<application (client) id>
   SSO_CLIENT_SECRET=<Key Vault reference>
   SSO_ALLOWED_DOMAINS=<company email domain>
   SSO_AUTO_PROVISION=false          # administrators add users first; true = new users become SSO_DEFAULT_ROLE
   LOCAL_LOGIN_ENABLED=false         # after SSO is confirmed working
   ```
6. Users are matched by email. An administrator creates each person in *Administration → Users* with the
   right role; at first SSO sign-in the account is linked to the Entra subject.

Roles and what they may do are configured inside the application (*Administration → Permissions*).
Keep at least one administrator who can sign in before switching password sign-in off.

**Verification status:** the flow is implemented with the `openid-client` library (authorisation code +
PKCE, state and nonce validation) and passes an automated test against a mock identity provider. It has
not been exercised against PlanRadar's tenant — plan a short test with one account.

## 6. Database setup and migrations

- Create an empty database and a login that owns it. Provide it as
  `DATABASE_URL=postgres://user:password@host:5432/talentradar` and set `DATABASE_SSL=true` for managed
  PostgreSQL.
- **Migrations** are plain SQL files in `server/migrations/`, applied in filename order at every start and
  recorded in `schema_migrations`. Applying is idempotent and protected by an advisory lock, so several
  instances can start together. To run them explicitly: `node server/dist/cli.js migrate`.
- **Reference data** (statuses, default milestone templates, countries, departments, permissions) is
  inserted only into empty tables and never overwrites edits.
- **Upgrades:** deploy the new image; new migrations apply at start. Take a backup first (section 8).
- **Demo data:** never set `DEMO_DATA=true` in production. If a pilot database contains demo records,
  remove them in *Administration → Data and settings* or with `node server/dist/cli.js clear-demo`.

## 7. Greenhouse integration (optional, needs authorisation)

Talent Radar works fully without Greenhouse access: records are linked by a Greenhouse job ID typed or
imported by the team, and each vacancy links out to Greenhouse. Live synchronisation is an add-on.

What it reads (read-only): jobs, application counts per stage, hiring outcomes, department / office names.
What it stores: per linked vacancy, a small snapshot — job title and status, hiring-team names, counts by
stage. **No candidate profiles are copied and nothing is written to Greenhouse.**

Steps:

1. A Greenhouse administrator opens **Configure → Dev Center → API Credentials → Create new credential**
   and chooses **Harvest V3 (OAuth)** (client-credentials flow for a custom integration). Greenhouse announced
   the removal of Harvest v1/v2 for 31 August 2026, so v3 is the version to use.
2. Grant **read (list) scopes only** for: jobs, applications, job stages, departments, offices, users
   (scope names look like `harvest:jobs:list`). No candidate scopes are required.
3. Store the client ID and secret as `GREENHOUSE_CLIENT_ID` / `GREENHOUSE_CLIENT_SECRET`.
4. In Talent Radar: *Administration → Integrations → Test live connection*, then switch mode to **Live** and
   **Synchronise now**. Every problem is listed on screen and kept in the run history.
5. **Validate the field mapping.** The client follows the published v3 authentication and pagination model
   and is tested against a mock, but the build environment could not reach Greenhouse's reference
   documentation, so resource paths and field names are best-effort. After the first live run, compare three
   or four vacancies' Greenhouse panel with Greenhouse itself. If a resource is named differently in your
   tenant, override it without code changes:
   `GREENHOUSE_PATH_JOBS`, `GREENHOUSE_PATH_APPLICATIONS`, `GREENHOUSE_PATH_JOB_STAGES`,
   `GREENHOUSE_PATH_DEPARTMENTS`, `GREENHOUSE_PATH_OFFICES`, `GREENHOUSE_PATH_USERS`,
   `GREENHOUSE_PATH_HIRING_TEAM` (empty by default — hiring-team comparison is skipped until set).
   Field mapping lives in one function, `HarvestV3Client.fetchJobs` in `server/src/services/greenhouse.ts`.
6. Optional: `GREENHOUSE_SYNC_HOURS=6` refreshes automatically; `GREENHOUSE_JOB_URL_TEMPLATE` sets the
   "Open in Greenhouse" link format (EU tenants may use a different host).

By default differences between the tracker and Greenhouse are **shown, not applied**. An administrator can
switch on "apply Greenhouse's job title and hiring manager automatically"; each applied value is audited.

## 8. Backup and recovery

Everything worth backing up is in the PostgreSQL database.

- **Azure Database for PostgreSQL:** automated backups with point-in-time restore are on by default; the
  template sets 14 days' retention. Recovery = restore the server to a point in time, point `DATABASE_URL`
  at the restored server, restart the app.
- **Self-hosted:** the `backup` service in `docker-compose.yml` runs `deploy/backup.sh` every 24 hours:
  `pg_dump` custom-format dumps in `./backups`, verified with `pg_restore --list`, 30 days' retention
  (`BACKUP_RETENTION_DAYS`). Copy `./backups` off the host (the script does not do this).
- **Restore from a dump:** stop the app, then
  `DATABASE_URL=… sh deploy/restore.sh backups/talentradar-<timestamp>.dump`, then start the app.
- **Test the restore** once before go-live and at least yearly: restore into a scratch database, start a
  container against it, sign in.
- Suggested targets for this workload: RPO 24 h (dumps) or minutes (managed PITR); RTO under 2 hours.
- The audit log is append-only from the application's point of view; database administrators can still
  alter it, so restrict direct database access.

## 9. Option B — single VM with Docker Compose

For a company-approved Linux VM (2 vCPU / 4 GB) with Docker:

```bash
git clone <repository> && cd talent-radar
cp .env.example .env      # APP_URL, APP_DOMAIN, POSTGRES_PASSWORD, BOOTSTRAP_ADMIN_* at minimum
docker compose up -d --build
docker compose logs -f app
```

This starts the app, PostgreSQL 16 with a persistent volume, Caddy for HTTPS and the nightly backup
service. Update with `git pull && docker compose up -d --build`.

## 10. Configuration reference

All settings are environment variables; `.env.example` documents each one. Secrets (`DATABASE_URL`,
`*_SECRET`, `*_PASSWORD`, `*_KEY`, `TEAMS_WEBHOOK_URL`) should be Key Vault references or a root-only
`.env`. Secrets are never stored in the database or returned by the API.

## 11. Monitoring and operations

- **Health:** `GET /api/health` → `200 {"status":"ok"}` when the database is reachable, `503` otherwise.
- **Logs:** JSON lines on stdout/stderr (App Service log stream / Log Analytics / `docker compose logs`).
  Server errors carry a short reference that is also shown to the user.
- **Audit:** sign-ins, failed sign-ins, every record change, imports, permission and settings changes are
  in the `audit_log` table and visible in *Administration → Audit log*.
- **Admin recovery:** `node server/dist/cli.js create-admin <email> "<name>" <temporary password>`.
- **Rate limiting:** sign-in attempts are limited per IP (30 per 15 minutes) and accounts lock for 15
  minutes after 5 failures.

## 12. Security summary

| Topic | Implementation |
|---|---|
| Transport | HTTPS only in production, HSTS |
| Authentication | Entra ID OIDC (PKCE) or scrypt-hashed passwords; server-side sessions, revocable |
| Authorisation | Role-based permissions checked on every API route; row-level rule for recruiters |
| Browser | Strict CSP (no inline scripts, no third-party origins), `SameSite=Lax` cookies + same-origin check on state-changing requests, framing denied |
| Data | Parameterised SQL throughout; uploads limited to 10 MB, parsed in memory, never executed; CSV exports neutralise spreadsheet formulas |
| Privacy | No candidate data. Personal data is limited to employee names, work emails and hiring-manager names. Self-hosted fonts — the browser contacts no third party |
| Dependencies | `npm audit` reported 0 known vulnerabilities at build time; re-run in CI |

Before go-live, IT should run its usual security review / penetration test; none has been performed on
this build.

## 13. Go-live checklist

- [ ] Image built and pushed; container starts; `/api/health` returns 200
- [ ] Custom domain bound, certificate valid, `APP_URL` set
- [ ] Database on managed PostgreSQL with backups; restore tested once
- [ ] First administrator signed in and changed password; `BOOTSTRAP_ADMIN_PASSWORD` removed
- [ ] SSO tested with one account; `LOCAL_LOGIN_ENABLED=false`
- [ ] `DEMO_DATA` unset or `false`; demo records removed
- [ ] Users created with correct roles; permission matrix reviewed with the TA lead
- [ ] Excel tracker imported; validation report reviewed and filed
- [ ] (Optional) Greenhouse credential created, connection tested, field mapping validated
- [ ] Access restriction agreed (Entra assignment and/or network)
- [ ] Security review completed
- [ ] Team told that the Excel tracker is read-only from the cut-over date
