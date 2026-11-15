import { audit, SYSTEM } from '../audit.js';
import { config } from '../config.js';
import { one, pool, rows } from '../db.js';
import { getSetting } from '../settings.js';
import { badRequest } from '../util.js';

/**
 * Greenhouse integration adapter.
 *
 * Greenhouse stays the system of record. This application only stores, per linked
 * vacancy, a small read-only snapshot (job title/status, hiring team names and
 * aggregate application counts). No candidate profile is ever copied.
 *
 *  - mode "off":  manual operation, nothing is called.
 *  - mode "demo": simulated fictional data, so the workflow can be shown before IT approval.
 *  - mode "live": Harvest API v3 with OAuth client credentials (requires IT authorisation).
 */
export interface GhJob {
  id: string;
  title: string;
  status: string;                 // open | closed | draft
  requisitionId: string | null;
  department: string | null;
  office: string | null;
  openedAt: string | null;
  closedAt: string | null;
  hiringManagers: string[];
  recruiters: string[];
  activeApplications: number;
  byStage: { stage: string; count: number }[];
  hired: number;
  rejected: number;
}
export interface SyncIssue { level: 'error' | 'warning'; jobId?: string; vacancyId?: number; message: string }
interface GhClient { fetchJobs(report: (i: SyncIssue) => void): Promise<GhJob[]> }

// ───────────── Demo adapter (fictional data) ─────────────
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const DEMO_STAGES = ['Application review', 'Recruiter screen', 'Hiring manager interview', 'Panel interview', 'Offer'];

class DemoClient implements GhClient {
  async fetchJobs(report: (i: SyncIssue) => void): Promise<GhJob[]> {
    const linked = await rows<any>(pool, `SELECT v.*, s.category, d.name AS department, c.name AS country, u.name AS recruiter
        FROM vacancies v JOIN vacancy_statuses s ON s.id = v.status_id LEFT JOIN departments d ON d.id = v.department_id
        LEFT JOIN countries c ON c.id = v.country_id LEFT JOIN users u ON u.id = v.recruiter_id
       WHERE v.greenhouse_job_id IS NOT NULL AND v.archived_at IS NULL ORDER BY v.id`);
    const jobs: GhJob[] = [];
    linked.forEach((v, i) => {
      if (i === linked.length - 1 && linked.length > 3) return; // simulate one job the API user cannot see
      const h = hash(v.greenhouseJobId);
      const closed = ['filled', 'cancelled'].includes(v.category);
      const depth = closed ? 0 : 1 + (h % DEMO_STAGES.length);
      const byStage = closed ? [] : DEMO_STAGES.slice(0, depth).map((stage, j) => ({ stage, count: Math.max(1, ((h >> (j * 3)) % 9) + (depth - j)) }));
      jobs.push({
        id: v.greenhouseJobId, title: i === 1 ? `${v.title} (m/f/d)` : v.title, status: closed ? 'closed' : 'open',
        requisitionId: `REQ-${String(h % 9000 + 1000)}`, department: v.department, office: [v.city, v.country].filter(Boolean).join(', ') || null,
        openedAt: v.openingDate, closedAt: v.closureDate, hiringManagers: v.hiringManager ? [v.hiringManager] : [], recruiters: v.recruiter ? [v.recruiter] : [],
        activeApplications: byStage.reduce((s, x) => s + x.count, 0), byStage, hired: v.category === 'filled' ? 1 : 0, rejected: 5 + (h % 40),
      });
      if (!v.hiringManager) report({ level: 'warning', jobId: v.greenhouseJobId, vacancyId: v.id, message: `Job ${v.greenhouseJobId} has no hiring manager in Greenhouse.` });
    });
    jobs.push(
      { id: 'DEMO-4012877', title: 'Sales Development Representative — DACH (demo)', status: 'open', requisitionId: 'REQ-7731', department: 'Sales', office: 'Vienna, Austria',
        openedAt: null, closedAt: null, hiringManagers: ['Katharina Vogl (demo)'], recruiters: [], activeApplications: 12, byStage: [{ stage: 'Application review', count: 9 }, { stage: 'Recruiter screen', count: 3 }], hired: 0, rejected: 4 },
      { id: 'DEMO-4012903', title: 'Customer Support Specialist — Arabic (demo)', status: 'open', requisitionId: 'REQ-7742', department: 'Customer Support', office: 'Cairo, Egypt',
        openedAt: null, closedAt: null, hiringManagers: ['Hany Lotfy (demo)'], recruiters: [], activeApplications: 5, byStage: [{ stage: 'Application review', count: 5 }], hired: 0, rejected: 0 },
    );
    return jobs;
  }
}

// ───────────── Live adapter: Harvest API v3 ─────────────
// Verified from Greenhouse's published guidance: OAuth client-credentials token from
// auth.greenhouse.io/token (client id/secret as HTTP Basic), Bearer token on requests,
// cursor pagination through the Link rel="next" header, HTTP 429 on rate limit.
// Resource paths and field names below follow the v3 naming but could not be exercised
// without credentials — they are overridable by environment variable and must be
// confirmed against the tenant during IT onboarding (see docs/IT_HANDOVER.md §7).
const PATHS = {
  jobs: process.env.GREENHOUSE_PATH_JOBS ?? '/jobs',
  applications: process.env.GREENHOUSE_PATH_APPLICATIONS ?? '/applications',
  jobStages: process.env.GREENHOUSE_PATH_JOB_STAGES ?? '/job_stages',
  departments: process.env.GREENHOUSE_PATH_DEPARTMENTS ?? '/departments',
  offices: process.env.GREENHOUSE_PATH_OFFICES ?? '/offices',
  hiringTeam: process.env.GREENHOUSE_PATH_HIRING_TEAM ?? '', // optional; left empty until confirmed
  users: process.env.GREENHOUSE_PATH_USERS ?? '/users',
};

export class HarvestV3Client implements GhClient {
  private token: { value: string; expires: number } | undefined;
  private pending: Promise<string> | undefined;
  constructor(private c = config.greenhouse, private fetchImpl: typeof fetch = fetch) {}

  /** One token request at a time, reused until shortly before it expires. */
  private accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return Promise.resolve(this.token.value);
    this.pending ??= this.requestToken().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async requestToken(): Promise<string> {
    if (!this.c.clientId || !this.c.clientSecret) throw new Error('Greenhouse credentials are not configured (GREENHOUSE_CLIENT_ID / GREENHOUSE_CLIENT_SECRET).');
    const res = await this.fetchImpl(this.c.tokenUrl, {
      method: 'POST', signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Basic ${Buffer.from(`${this.c.clientId}:${this.c.clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (!res.ok) throw new Error(`Greenhouse token request failed with HTTP ${res.status}. Check the client ID, secret and granted scopes.`);
    const j: any = await res.json();
    if (!j.access_token) throw new Error('Greenhouse token response did not contain an access token.');
    this.token = { value: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.token.value;
  }

  /** Follows Link rel="next" until exhausted. A cursor URL is used exactly as returned (no extra parameters). */
  async list(path: string, params: Record<string, string> = {}, maxPages = 200): Promise<any[]> {
    let url: string | null = `${this.c.baseUrl}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`;
    const out: any[] = [];
    for (let page = 0; url && page < maxPages; page++) {
      let res: Response | undefined;
      for (let attempt = 0; attempt < 5; attempt++) {
        res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
        if (res.status !== 429) break;
        await new Promise((r) => setTimeout(r, Math.min(30, Number(res!.headers.get('retry-after')) || 2 ** attempt) * 1000));
      }
      if (!res!.ok) throw new Error(`Greenhouse ${path} returned HTTP ${res!.status}${res!.status === 403 ? ' — the credential is missing the required scope' : ''}.`);
      const body: any = await res!.json();
      out.push(...(Array.isArray(body) ? body : body?.data ?? body?.results ?? []));
      const next: string | undefined = (res!.headers.get('link') ?? '').split(',').map((p) => p.match(/<([^>]+)>;\s*rel="next"/)?.[1]).find(Boolean);
      url = next ?? null;
    }
    return out;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    try {
      await this.accessToken();
      const res = await this.fetchImpl(`${this.c.baseUrl}${PATHS.jobs}`, { headers: { authorization: `Bearer ${this.token!.value}`, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      return res.ok ? { ok: true, message: 'Token issued and the jobs endpoint responded.' }
        : { ok: false, message: `Token issued, but ${PATHS.jobs} returned HTTP ${res.status}.` };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  async fetchJobs(report: (i: SyncIssue) => void): Promise<GhJob[]> {
    const optional = async (label: string, path: string) => {
      if (!path) return [];
      try { return await this.list(path); } catch (err) { report({ level: 'warning', message: `${label} could not be read: ${(err as Error).message}` }); return []; }
    };
    const [jobs, apps, stages, depts, offices, team, users] = await Promise.all([
      this.list(PATHS.jobs), optional('Applications', PATHS.applications), optional('Job stages', PATHS.jobStages),
      optional('Departments', PATHS.departments), optional('Offices', PATHS.offices), optional('Hiring team', PATHS.hiringTeam), optional('Users', PATHS.users),
    ]);
    if (!PATHS.hiringTeam) report({ level: 'warning', message: 'Hiring-team synchronisation is not configured (GREENHOUSE_PATH_HIRING_TEAM); recruiter and hiring manager are not compared.' });
    const name = (list: any[]) => new Map(list.map((x) => [String(x.id), x.name ?? [x.first_name, x.last_name].filter(Boolean).join(' ')]));
    const stageName = name(stages), deptName = name(depts), officeName = name(offices), userName = name(users);
    const first = (v: any) => (Array.isArray(v) ? v[0] : v);
    return jobs.map((j) => {
      const id = String(j.id);
      const mine = apps.filter((a) => String(a.job_id ?? first(a.job_ids) ?? first(a.jobs)?.id) === id);
      const active = mine.filter((a) => (a.status ?? 'active') === 'active');
      const counts = new Map<string, number>();
      for (const a of active) {
        const s = a.current_stage?.name ?? stageName.get(String(a.current_stage_id ?? a.stage_id)) ?? 'Unknown stage';
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      const people = (role: RegExp) => team.filter((t) => String(t.job_id) === id && role.test(String(t.role ?? t.responsibility ?? t.type ?? '')))
        .map((t) => t.name ?? userName.get(String(t.user_id)) ?? `User ${t.user_id}`);
      return {
        id, title: j.name ?? j.title ?? `Job ${id}`, status: String(j.status ?? 'open'), requisitionId: j.requisition_id ?? null,
        department: first(j.departments)?.name ?? deptName.get(String(j.department_id ?? first(j.department_ids))) ?? null,
        office: first(j.offices)?.name ?? officeName.get(String(first(j.office_ids) ?? j.office_id)) ?? null,
        openedAt: j.opened_at?.slice(0, 10) ?? null, closedAt: j.closed_at?.slice(0, 10) ?? null,
        hiringManagers: people(/hiring.?manager/i), recruiters: people(/recruiter/i),
        activeApplications: active.length, byStage: [...counts.entries()].map(([stage, count]) => ({ stage, count })),
        hired: mine.filter((a) => a.status === 'hired').length, rejected: mine.filter((a) => a.status === 'rejected').length,
      };
    });
  }
}

export async function greenhouseStatus() {
  const s = await getSetting('greenhouse');
  const last = await one<any>(pool, `SELECT r.*, u.name AS triggered_by_name FROM sync_runs r LEFT JOIN users u ON u.id = r.triggered_by
                                      WHERE integration = 'greenhouse' ORDER BY started_at DESC LIMIT 1`);
  const linked = await one<{ n: number; synced: number }>(pool, `SELECT count(*) FILTER (WHERE greenhouse_job_id IS NOT NULL) AS n,
      count(*) FILTER (WHERE greenhouse_synced_at IS NOT NULL) AS synced FROM vacancies WHERE archived_at IS NULL`);
  return {
    mode: s.mode, autoApply: s.autoApply, credentialsConfigured: !!(config.greenhouse.clientId && config.greenhouse.clientSecret),
    baseUrl: config.greenhouse.baseUrl, tokenUrl: config.greenhouse.tokenUrl, linkedVacancies: linked?.n ?? 0, syncedVacancies: linked?.synced ?? 0, lastRun: last ?? null,
  };
}

let running = false;
/** Pulls jobs, refreshes the snapshot on linked vacancies and records every problem — nothing fails silently. */
export async function runGreenhouseSync(userId: number | null, clientOverride?: GhClient) {
  const s = await getSetting('greenhouse');
  if (s.mode === 'off') throw badRequest('Greenhouse synchronisation is switched off. Choose demo or live mode in the integration settings first.');
  if (running) throw badRequest('A synchronisation is already running.');
  running = true;
  const run = (await one<{ id: number }>(pool, `INSERT INTO sync_runs (integration, mode, triggered_by) VALUES ('greenhouse',$1,$2) RETURNING id`, [s.mode, userId]))!;
  const issues: SyncIssue[] = [];
  const stats = { jobsRead: 0, vacanciesLinked: 0, vacanciesUpdated: 0, mismatches: 0, valuesApplied: 0, unlinkedJobs: 0 };
  try {
    const client = clientOverride ?? (s.mode === 'demo' ? new DemoClient() : new HarvestV3Client());
    const jobs = await client.fetchJobs((i) => issues.push(i));
    stats.jobsRead = jobs.length;
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const linked = await rows<any>(pool, `SELECT v.id, v.title, v.greenhouse_job_id, v.hiring_manager, u.name AS recruiter FROM vacancies v
                                           LEFT JOIN users u ON u.id = v.recruiter_id WHERE v.greenhouse_job_id IS NOT NULL AND v.archived_at IS NULL`);
    stats.vacanciesLinked = linked.length;
    for (const v of linked) {
      const j = byId.get(v.greenhouseJobId);
      if (!j) {
        issues.push({ level: 'error', jobId: v.greenhouseJobId, vacancyId: v.id, message: `“${v.title}”: job ID ${v.greenhouseJobId} was not returned by Greenhouse (closed, deleted, mistyped, or outside the API user’s permissions).` });
        continue;
      }
      const mismatches: { field: string; tracker: string | null; greenhouse: string | null }[] = [];
      const same = (a?: string | null, b?: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
      if (!same(v.title, j.title)) mismatches.push({ field: 'Job title', tracker: v.title, greenhouse: j.title });
      if (j.hiringManagers.length && !j.hiringManagers.some((h) => same(h, v.hiringManager))) mismatches.push({ field: 'Hiring manager', tracker: v.hiringManager, greenhouse: j.hiringManagers.join(', ') });
      if (j.recruiters.length && !j.recruiters.some((r) => same(r, v.recruiter))) mismatches.push({ field: 'Recruiter', tracker: v.recruiter, greenhouse: j.recruiters.join(', ') });
      stats.mismatches += mismatches.length;
      if (s.autoApply) {
        // Greenhouse is authoritative for identity fields; applying them is opt-in and always audited.
        const title = mismatches.find((m) => m.field === 'Job title');
        const hm = mismatches.find((m) => m.field === 'Hiring manager');
        if (title || hm) {
          await pool.query('UPDATE vacancies SET title = COALESCE($2, title), hiring_manager = COALESCE($3, hiring_manager), updated_at = now() WHERE id = $1',
            [v.id, title?.greenhouse ?? null, hm ? j.hiringManagers[0] : null]);
          const changes: Record<string, unknown> = {};
          if (title) changes.title = { label: 'Job title', from: title.tracker, to: title.greenhouse };
          if (hm) changes.hiringManager = { label: 'Hiring manager', from: hm.tracker, to: j.hiringManagers[0] };
          await audit(pool, SYSTEM, { entityType: 'vacancy', entityId: v.id, vacancyId: v.id, action: 'greenhouse_sync', summary: 'Values applied from Greenhouse (authoritative source)', changes });
          stats.valuesApplied += Object.keys(changes).length;
        }
      }
      const snapshot = { mode: s.mode, title: j.title, status: j.status, requisitionId: j.requisitionId, department: j.department, office: j.office,
        hiringManagers: j.hiringManagers, recruiters: j.recruiters, activeApplications: j.activeApplications, byStage: j.byStage, hired: j.hired, rejected: j.rejected,
        mismatches: s.autoApply ? mismatches.filter((m) => m.field === 'Recruiter') : mismatches };
      await pool.query('UPDATE vacancies SET greenhouse_snapshot = $2, greenhouse_synced_at = now() WHERE id = $1', [v.id, JSON.stringify(snapshot)]);
      stats.vacanciesUpdated += 1;
    }
    const known = new Set(linked.map((v) => v.greenhouseJobId));
    const unlinked = jobs.filter((j) => !known.has(j.id) && j.status === 'open')
      .map((j) => ({ id: j.id, title: j.title, department: j.department, office: j.office, hiringManagers: j.hiringManagers, activeApplications: j.activeApplications }));
    stats.unlinkedJobs = unlinked.length;
    const status = issues.some((i) => i.level === 'error') ? 'partial' : 'success';
    await pool.query(`UPDATE sync_runs SET finished_at = now(), status = $2, stats = $3, errors = $4, unlinked = $5 WHERE id = $1`,
      [run.id, status, JSON.stringify(stats), JSON.stringify(issues), JSON.stringify(unlinked)]);
    await audit(pool, { id: userId, name: userId ? 'User' : 'System' }, { entityType: 'integration', entityId: run.id, action: 'greenhouse_sync',
      summary: `Greenhouse sync (${s.mode}) ${status}: ${stats.vacanciesUpdated}/${stats.vacanciesLinked} linked vacancies refreshed, ${issues.length} issue(s)` });
    return { id: run.id, status, stats, issues, unlinked };
  } catch (err) {
    issues.push({ level: 'error', message: (err as Error).message });
    await pool.query(`UPDATE sync_runs SET finished_at = now(), status = 'failed', stats = $2, errors = $3 WHERE id = $1`, [run.id, JSON.stringify(stats), JSON.stringify(issues)]);
    return { id: run.id, status: 'failed', stats, issues, unlinked: [] };
  } finally {
    running = false;
  }
}
