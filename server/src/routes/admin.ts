import { Router, type Request } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { audit, diff } from '../audit.js';
import { actor, assertPasswordPolicy, hashPassword, invalidatePermissionCache, PERMISSIONS, requirePerm, ROLES } from '../auth.js';
import { config } from '../config.js';
import { one, pool, rows, tx } from '../db.js';
import { clearDemoData, seedDemoData } from '../seed/demo.js';
import { getSetting, loadRefs, RISK_RULES, setSetting } from '../settings.js';
import { aiStatus } from '../services/assistant.js';
import { greenhouseStatus, HarvestV3Client, runGreenhouseSync } from '../services/greenhouse.js';
import { batchReport, batchReportCsv, commitBatch, createBatch, previewBatch } from '../services/importer.js';
import { buildWeeklyReport } from '../services/report.js';
import { createVacancy } from '../services/vacancies.js';
import { badRequest, fmtDate, HttpError, notFound } from '../util.js';
import { randomPassword } from './auth.js';

export const admin = Router();
const idParam = (req: Request) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
};

// ───────────── Excel / CSV migration ─────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
admin.post('/import/upload', requirePerm('import.run'), upload.single('file'), async (req, res) => {
  if (!req.file) throw badRequest('Choose a file to upload');
  res.status(201).json(await createBatch(req.user!, req.file));
});
admin.post('/import/:id/preview', requirePerm('import.run'), async (req, res) => {
  res.json(await previewBatch(idParam(req), req.body));
});
admin.post('/import/:id/commit', requirePerm('import.run'), async (req, res) => {
  res.json(await commitBatch(req.user!, idParam(req), req.body));
});
admin.post('/import/:id/discard', requirePerm('import.run'), async (req, res) => {
  const id = idParam(req);
  const r = await pool.query(`UPDATE import_batches SET status = 'discarded', sheets = '[]'::jsonb WHERE id = $1 AND status = 'uploaded'`, [id]);
  if (r.rowCount) await audit(pool, actor(req), { entityType: 'import', entityId: id, action: 'discarded', summary: 'Upload discarded without importing' });
  res.json({ ok: true });
});
admin.get('/import/batches', requirePerm('import.run'), async (_req, res) => {
  res.json(await rows<any>(pool, `SELECT b.id, b.filename, b.file_size, b.status, b.uploaded_at, b.imported_at, b.report->'totals' AS totals, u.name AS uploaded_by
                                    FROM import_batches b LEFT JOIN users u ON u.id = b.uploaded_by ORDER BY b.uploaded_at DESC LIMIT 100`));
});
admin.get('/import/:id/report', requirePerm('import.run'), async (req, res) => {
  if (req.query.format === 'csv') {
    const { filename, csv } = await batchReportCsv(idParam(req));
    return void res.type('text/csv').attachment(filename).send(csv);
  }
  res.json(await batchReport(idParam(req)));
});

// ───────────── Users ─────────────
const userSchema = z.object({
  email: z.string().trim().toLowerCase().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, 'Enter a valid email address').max(200),
  name: z.string().trim().min(2).max(120), role: z.enum(ROLES), jobTitle: z.string().max(120).nullish(),
  taTeamId: z.number().int().positive().nullish(), isActive: z.boolean().optional(), password: z.string().max(200).optional(),
});
admin.get('/admin/users', requirePerm('admin.users'), async (_req, res) => {
  res.json(await rows<any>(pool, `SELECT u.id, u.email, u.name, u.role, u.job_title, u.ta_team_id, u.is_active, u.is_demo, u.last_login_at, u.created_at,
      (u.sso_subject IS NOT NULL) AS sso_linked, (u.password_hash IS NOT NULL) AS has_password,
      (SELECT count(*) FROM vacancies v JOIN vacancy_statuses s ON s.id = v.status_id WHERE v.recruiter_id = u.id AND v.archived_at IS NULL AND s.category IN ('active','on_hold')) AS open_vacancies
    FROM users u ORDER BY u.is_active DESC, u.name`));
});
admin.post('/admin/users', requirePerm('admin.users'), async (req, res) => {
  const d = userSchema.parse(req.body);
  if (await one(pool, 'SELECT 1 AS x FROM users WHERE lower(email) = $1', [d.email])) throw new HttpError(409, 'A user with this email already exists');
  // Without SSO the administrator hands over a one-time password which must be changed at first sign-in.
  const temp = config.localLogin ? d.password || randomPassword() : null;
  if (temp) assertPasswordPolicy(temp);
  const u = (await one<any>(pool, `INSERT INTO users (email, name, role, job_title, ta_team_id, password_hash, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [d.email, d.name, d.role, d.jobTitle?.trim() || null, d.taTeamId ?? null, temp ? await hashPassword(temp) : null, !!temp]))!;
  await audit(pool, actor(req), { entityType: 'user', entityId: u.id, action: 'created', summary: `User ${d.name} (${d.email}) created as ${d.role}` });
  res.status(201).json({ id: u.id, temporaryPassword: temp });
});
admin.patch('/admin/users/:id', requirePerm('admin.users'), async (req, res) => {
  const id = idParam(req);
  const d = userSchema.partial().parse(req.body) as Record<string, any>;
  const before = await one<any>(pool, 'SELECT * FROM users WHERE id = $1', [id]);
  if (!before) throw notFound('User');
  const losingAdmin = before.role === 'admin' && before.isActive && ((d.role && d.role !== 'admin') || d.isActive === false);
  if (losingAdmin && (await one<{ n: number }>(pool, `SELECT count(*) AS n FROM users WHERE role = 'admin' AND is_active AND id <> $1`, [id]))!.n === 0) {
    throw badRequest('At least one active administrator is required');
  }
  const cols: Record<string, string> = { email: 'email', name: 'name', role: 'role', jobTitle: 'job_title', taTeamId: 'ta_team_id', isActive: 'is_active' };
  const changes = diff(before, d, Object.keys(cols));
  const sets: string[] = [];
  const vals: unknown[] = [id];
  for (const k of Object.keys(changes)) { vals.push(d[k]); sets.push(`${cols[k]} = $${vals.length}`); }
  if (sets.length) await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, vals);
  if (d.isActive === false || changes.role) await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  if (sets.length) await audit(pool, actor(req), { entityType: 'user', entityId: id, action: 'edited', summary: `User ${before.name} updated`, changes });
  res.json({ ok: true });
});
admin.post('/admin/users/:id/reset-password', requirePerm('admin.users'), async (req, res) => {
  const id = idParam(req);
  const u = await one<any>(pool, 'SELECT name FROM users WHERE id = $1', [id]);
  if (!u) throw notFound('User');
  const temp = randomPassword();
  await pool.query('UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL WHERE id = $1', [id, await hashPassword(temp)]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  await audit(pool, actor(req), { entityType: 'user', entityId: id, action: 'password_reset', summary: `Password reset for ${u.name}` });
  res.json({ temporaryPassword: temp });
});

// ───────────── Vacancy assignment ─────────────
admin.post('/admin/assign', requirePerm('vacancies.assign'), async (req, res) => {
  const d = z.object({ vacancyIds: z.array(z.number().int().positive()).min(1).max(500), recruiterId: z.number().int().positive().nullable() }).parse(req.body);
  const rec = d.recruiterId ? await one<any>(pool, 'SELECT id, name FROM users WHERE id = $1 AND is_active', [d.recruiterId]) : null;
  if (d.recruiterId && !rec) throw badRequest('Unknown or inactive recruiter');
  await tx(async (db) => {
    for (const v of await rows<any>(db, `SELECT v.id, v.title, u.name AS recruiter FROM vacancies v LEFT JOIN users u ON u.id = v.recruiter_id WHERE v.id = ANY($1) AND v.recruiter_id IS DISTINCT FROM $2`, [d.vacancyIds, d.recruiterId])) {
      await db.query('UPDATE vacancies SET recruiter_id = $2, updated_at = now() WHERE id = $1', [v.id, d.recruiterId]);
      await audit(db, actor(req), { entityType: 'vacancy', entityId: v.id, vacancyId: v.id, action: 'assigned',
        summary: `Recruiter changed to ${rec?.name ?? 'unassigned'}`, changes: { recruiterId: { label: 'Recruiter', from: v.recruiter, to: rec?.name ?? null } } });
    }
  });
  res.json({ ok: true });
});

// ───────────── Reference data: teams, countries, departments, statuses, job families, vacancy types ─────────────
const REF: Record<string, { table: string; label: string; nameCol: string; extra?: (d: any) => Record<string, unknown>; fixed?: Record<string, unknown>; usedBy?: string }> = {
  teams: { table: 'ta_teams', label: 'TA team', nameCol: 'name', usedBy: 'ta_team_id' },
  countries: { table: 'countries', label: 'Country', nameCol: 'name', extra: (d) => ({ iso_code: d.isoCode?.trim().toUpperCase() || null }), usedBy: 'country_id' },
  departments: { table: 'departments', label: 'Department', nameCol: 'name', usedBy: 'department_id' },
  statuses: { table: 'vacancy_statuses', label: 'Vacancy status', nameCol: 'label', extra: (d) => ({ category: d.category, sort_order: d.sortOrder ?? 50 }), usedBy: 'status_id' },
  jobFamilies: { table: 'lookup_values', label: 'Job family', nameCol: 'label', fixed: { type: 'job_family' } },
  vacancyTypes: { table: 'lookup_values', label: 'Vacancy type', nameCol: 'label', fixed: { type: 'vacancy_type' } },
};
const refSchema = z.object({ name: z.string().trim().min(1).max(120), isActive: z.boolean().optional(), isoCode: z.string().max(3).nullish(),
  category: z.enum(['active', 'on_hold', 'filled', 'cancelled']).optional(), sortOrder: z.number().int().optional() });

admin.get('/admin/reference', requirePerm('admin.config'), async (_req, res) => {
  const refs = await loadRefs();
  const usage = async (col: string) => new Map((await rows<any>(pool, `SELECT ${col} AS id, count(*) AS n FROM vacancies WHERE archived_at IS NULL AND ${col} IS NOT NULL GROUP BY 1`)).map((r) => [r.id, r.n]));
  const [t, c, d, s] = await Promise.all([usage('ta_team_id'), usage('country_id'), usage('department_id'), usage('status_id')]);
  const withUse = (list: any[], m: Map<number, number>) => list.map((x) => ({ ...x, inUse: m.get(x.id) ?? 0 }));
  res.json({
    teams: withUse(refs.teams, t), countries: withUse(refs.countries, c), departments: withUse(refs.departments, d), statuses: withUse(refs.statuses, s),
    jobFamilies: refs.lookups.filter((l: any) => l.type === 'job_family'), vacancyTypes: refs.lookups.filter((l: any) => l.type === 'vacancy_type'),
    templates: refs.templates,
  });
});
admin.post('/admin/reference/:type', requirePerm('admin.config'), async (req, res) => {
  const def = REF[String(req.params.type)];
  if (!def) throw notFound('Reference type');
  const d = refSchema.parse(req.body);
  if (req.params.type === 'statuses' && !d.category) throw badRequest('Choose the category this status belongs to');
  const data: Record<string, unknown> = { [def.nameCol]: d.name, ...(def.fixed ?? {}), ...(def.extra?.(d) ?? {}) };
  if (req.params.type === 'statuses') data.key = `${d.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}_${Date.now().toString(36)}`;
  const cols = Object.keys(data);
  const r = await one<{ id: number }>(pool, `INSERT INTO ${def.table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(data));
  await audit(pool, actor(req), { entityType: 'reference', entityId: r!.id, action: 'created', summary: `${def.label} “${d.name}” added` });
  res.status(201).json({ id: r!.id });
});
admin.patch('/admin/reference/:type/:id', requirePerm('admin.config'), async (req, res) => {
  const def = REF[String(req.params.type)];
  if (!def) throw notFound('Reference type');
  const id = idParam(req);
  const d = refSchema.partial().parse(req.body);
  const before = await one<any>(pool, `SELECT * FROM ${def.table} WHERE id = $1`, [id]);
  if (!before) throw notFound(def.label);
  const data: Record<string, unknown> = {};
  if (d.name !== undefined) data[def.nameCol] = d.name;
  if (d.isActive !== undefined) data.is_active = d.isActive;
  if (req.params.type === 'countries' && d.isoCode !== undefined) data.iso_code = d.isoCode?.trim().toUpperCase() || null;
  if (req.params.type === 'statuses') {
    if (d.sortOrder !== undefined) data.sort_order = d.sortOrder;
    if (d.category && d.category !== before.category) {
      const used = (await one<{ n: number }>(pool, 'SELECT count(*) AS n FROM vacancies WHERE status_id = $1 AND archived_at IS NULL', [id]))!.n;
      if (used) throw badRequest(`This status is used by ${used} vacancies, so its category cannot change. Add a new status instead.`);
      data.category = d.category;
    }
    if (d.isActive === false && (await one<{ n: number }>(pool, `SELECT count(*) AS n FROM vacancy_statuses WHERE category = $1 AND is_active AND id <> $2`, [before.category, id]))!.n === 0) {
      throw badRequest('Each category needs at least one active status');
    }
  }
  const cols = Object.keys(data);
  if (cols.length) {
    await pool.query(`UPDATE ${def.table} SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...Object.values(data)]);
    await audit(pool, actor(req), { entityType: 'reference', entityId: id, action: 'edited', summary: `${def.label} “${before[def.nameCol === 'label' ? 'label' : 'name']}” updated`, changes: data });
  }
  res.json({ ok: true });
});

// ───────────── Milestone templates ─────────────
const templateSchema = z.object({
  name: z.string().trim().min(2).max(120), description: z.string().max(400).nullish(), isDefault: z.boolean().optional(), isActive: z.boolean().optional(),
  items: z.array(z.object({ name: z.string().trim().min(1).max(120), defaultOffsetDays: z.number().int().min(0).max(1000).nullish() })).min(1).max(30),
});
async function writeTemplate(req: Request, id: number | null) {
  const d = templateSchema.parse(req.body);
  return tx(async (db) => {
    if (d.isDefault) await db.query('UPDATE milestone_templates SET is_default = false');
    let tid = id;
    if (tid) {
      const r = await db.query('UPDATE milestone_templates SET name=$2, description=$3, is_default = COALESCE($4, is_default), is_active = COALESCE($5, is_active) WHERE id=$1',
        [tid, d.name, d.description ?? null, d.isDefault ?? null, d.isActive ?? null]);
      if (!r.rowCount) throw notFound('Template');
      await db.query('DELETE FROM milestone_template_items WHERE template_id = $1', [tid]);
    } else {
      tid = (await one<{ id: number }>(db, 'INSERT INTO milestone_templates (name, description, is_default) VALUES ($1,$2,$3) RETURNING id', [d.name, d.description ?? null, !!d.isDefault]))!.id;
    }
    let pos = 0;
    for (const it of d.items) await db.query('INSERT INTO milestone_template_items (template_id, name, position, default_offset_days) VALUES ($1,$2,$3,$4)', [tid, it.name, ++pos, it.defaultOffsetDays ?? null]);
    if (!(await one(db, 'SELECT 1 AS x FROM milestone_templates WHERE is_default AND is_active'))) throw badRequest('One active template must be the default');
    await audit(db, actor(req), { entityType: 'template', entityId: tid, action: id ? 'edited' : 'created',
      summary: `Milestone template “${d.name}” ${id ? 'updated' : 'created'}: ${d.items.map((i) => i.name).join(' → ')}` });
    return tid;
  });
}
admin.post('/admin/templates', requirePerm('admin.config'), async (req, res) => { res.status(201).json({ id: await writeTemplate(req, null) }); });
admin.put('/admin/templates/:id', requirePerm('admin.config'), async (req, res) => { res.json({ id: await writeTemplate(req, idParam(req)) }); });

// ───────────── Role permissions ─────────────
admin.get('/admin/permissions', requirePerm('admin.permissions'), async (_req, res) => {
  const granted = await rows<any>(pool, 'SELECT role, permission FROM role_permissions');
  res.json({ roles: ROLES, permissions: Object.entries(PERMISSIONS).map(([key, label]) => ({ key, label })),
    matrix: Object.fromEntries(ROLES.map((r) => [r, r === 'admin' ? Object.keys(PERMISSIONS) : granted.filter((g) => g.role === r).map((g) => g.permission)])) });
});
admin.put('/admin/permissions', requirePerm('admin.permissions'), async (req, res) => {
  const d = z.object({ matrix: z.record(z.string(), z.array(z.string())) }).parse(req.body);
  await tx(async (db) => {
    for (const role of ROLES.filter((r) => r !== 'admin')) {
      if (!d.matrix[role]) continue;
      const perms = d.matrix[role].filter((p) => p in PERMISSIONS && !p.startsWith('admin.'));
      await db.query('DELETE FROM role_permissions WHERE role = $1', [role]);
      for (const p of perms) await db.query('INSERT INTO role_permissions (role, permission) VALUES ($1,$2)', [role, p]);
    }
    await audit(db, actor(req), { entityType: 'permissions', action: 'edited', summary: 'Role permissions updated', changes: d.matrix });
  });
  invalidatePermissionCache();
  res.json({ ok: true });
});

// ───────────── Settings (risk rules, reporting, general) ─────────────
admin.get('/admin/settings', requirePerm('admin.config'), async (_req, res) => {
  res.json({ general: await getSetting('general'), report: await getSetting('report'), riskRules: await getSetting('risk.rules'), riskRuleDefinitions: RISK_RULES });
});
admin.put('/admin/settings/:key', requirePerm('admin.config'), async (req, res) => {
  const key = String(req.params.key);
  if (key === 'risk.rules') {
    const allowed = new Map(RISK_RULES.map((r) => [r.key as string, r]));
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(z.record(z.string(), z.record(z.string(), z.union([z.boolean(), z.number().min(0).max(365)]))).parse(req.body))) {
      const def = allowed.get(k);
      if (!def) continue;
      out[k] = { enabled: v.enabled !== false };
      for (const p of Object.keys(def.params)) if (typeof v[p] === 'number') out[k][p] = Math.round(v[p] as number);
    }
    await setSetting('risk.rules', out, req.user!.id);
  } else if (key === 'report') {
    const d = z.object({ weekStartsOn: z.number().int().min(0).max(6), upcomingDays: z.number().int().min(1).max(90), autoSnapshot: z.boolean() }).parse(req.body);
    await setSetting('report', d, req.user!.id);
  } else if (key === 'general') {
    const d = z.object({ organisation: z.string().trim().min(1).max(80), primaryTeam: z.string().trim().min(1).max(120) }).parse(req.body);
    if (!(await one(pool, 'SELECT 1 AS x FROM ta_teams WHERE lower(name) = lower($1)', [d.primaryTeam]))) throw badRequest('The primary team must be one of the configured TA teams');
    await setSetting('general', d, req.user!.id);
  } else throw notFound('Setting');
  await audit(pool, actor(req), { entityType: 'settings', action: 'edited', summary: `Settings “${key}” updated`, changes: req.body });
  res.json({ ok: true });
});

// ───────────── Audit log ─────────────
admin.get('/audit', requirePerm('audit.view'), async (req, res) => {
  const where: string[] = [];
  const p: unknown[] = [];
  if (typeof req.query.entityType === 'string' && req.query.entityType) { p.push(req.query.entityType); where.push(`a.entity_type = $${p.length}`); }
  if (typeof req.query.q === 'string' && req.query.q.trim()) { p.push(`%${req.query.q.trim()}%`); where.push(`(a.summary ILIKE $${p.length} OR a.user_name ILIKE $${p.length})`); }
  if (Number(req.query.before)) { p.push(Number(req.query.before)); where.push(`a.id < $${p.length}`); }
  res.json(await rows<any>(pool, `SELECT a.*, v.title AS vacancy_title FROM audit_log a LEFT JOIN vacancies v ON v.id = a.vacancy_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT 100`, p));
});

// ───────────── Demonstration data ─────────────
admin.post('/admin/demo-data', requirePerm('admin.config'), async (req, res) => {
  if (await one(pool, 'SELECT 1 AS x FROM vacancies WHERE is_demo LIMIT 1')) throw badRequest('Demonstration data is already loaded');
  await seedDemoData();
  await audit(pool, actor(req), { entityType: 'settings', action: 'demo_loaded', summary: 'Demonstration data loaded' });
  res.json({ ok: true });
});
admin.delete('/admin/demo-data', requirePerm('admin.config'), async (req, res) => {
  const removed = await clearDemoData(req.user!.id);
  await audit(pool, actor(req), { entityType: 'settings', action: 'demo_removed', summary: 'Demonstration data removed', changes: removed });
  res.json(removed);
});

// ───────────── Integrations ─────────────
admin.get('/integrations', requirePerm('admin.integrations'), async (_req, res) => {
  res.json({
    greenhouse: await greenhouseStatus(), ai: aiStatus(),
    sso: { enabled: config.sso.enabled, issuer: config.sso.issuer || null, autoProvision: config.sso.autoProvision, localLogin: config.localLogin,
      redirectUri: `${config.appUrl || '<APP_URL>'}/api/auth/sso/callback` },
    teams: { configured: !!config.teams.webhookUrl },
  });
});
admin.put('/integrations/greenhouse', requirePerm('admin.integrations'), async (req, res) => {
  const d = z.object({ mode: z.enum(['off', 'demo', 'live']), autoApply: z.boolean() }).parse(req.body);
  if (d.mode === 'live' && !(config.greenhouse.clientId && config.greenhouse.clientSecret)) {
    throw badRequest('Live mode needs Greenhouse credentials. IT must set GREENHOUSE_CLIENT_ID and GREENHOUSE_CLIENT_SECRET in the hosting environment first.');
  }
  await setSetting('greenhouse', d, req.user!.id);
  await audit(pool, actor(req), { entityType: 'integration', action: 'edited', summary: `Greenhouse integration set to ${d.mode}${d.autoApply ? ' (apply Greenhouse values automatically)' : ''}` });
  res.json(await greenhouseStatus());
});
admin.post('/integrations/greenhouse/test', requirePerm('admin.integrations'), async (_req, res) => {
  res.json(await new HarvestV3Client().testConnection());
});
admin.post('/integrations/greenhouse/sync', requirePerm('admin.integrations'), async (req, res) => {
  res.json(await runGreenhouseSync(req.user!.id));
});
admin.get('/integrations/greenhouse/runs', requirePerm('admin.integrations'), async (_req, res) => {
  res.json(await rows<any>(pool, `SELECT r.*, u.name AS triggered_by_name FROM sync_runs r LEFT JOIN users u ON u.id = r.triggered_by
                                    WHERE r.integration = 'greenhouse' ORDER BY r.started_at DESC LIMIT 20`));
});
/** Add a Greenhouse job that is not yet tracked. Only identification fields are copied; operational fields start empty. */
admin.post('/integrations/greenhouse/link', requirePerm('admin.integrations'), async (req, res) => {
  const d = z.object({ runId: z.number().int().positive(), jobId: z.string().min(1).max(60), recruiterId: z.number().int().positive().nullish() }).parse(req.body);
  const run = await one<any>(pool, 'SELECT unlinked, mode FROM sync_runs WHERE id = $1', [d.runId]);
  const job = (run?.unlinked ?? []).find((j: any) => j.id === d.jobId);
  if (!job) throw notFound('Greenhouse job');
  const refs = await loadRefs();
  const dept = refs.departments.find((x: any) => x.name.toLowerCase() === (job.department ?? '').toLowerCase());
  const [city, country] = String(job.office ?? '').split(',').map((s: string) => s.trim());
  const c = refs.countries.find((x: any) => x.name.toLowerCase() === (country ?? city ?? '').toLowerCase());
  const id = await tx((db) => createVacancy(db, null, actor(req), { title: job.title, greenhouseJobId: job.id, departmentId: dept?.id, countryId: c?.id,
    city: country ? city : null, hiringManager: job.hiringManagers?.[0] ?? null, recruiterId: d.recruiterId ?? null },
  { source: `Greenhouse ${run.mode} sync`, isDemo: run.mode === 'demo' }));
  res.status(201).json({ id });
});

/** Posts the weekly headline to a Teams channel through an incoming-webhook workflow, if IT has configured one. */
admin.post('/integrations/teams/post-weekly', requirePerm('admin.integrations', 'reports.generate'), async (_req, res) => {
  if (!config.teams.webhookUrl) throw badRequest('No Teams webhook is configured. IT must set TEAMS_WEBHOOK_URL in the hosting environment.');
  const r = await buildWeeklyReport();
  const k = r.kpis;
  const card = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4',
    body: [
      { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: `${r.meta.team} — recruitment status, week of ${fmtDate(r.meta.weekStart)}` },
      { type: 'FactSet', facts: [['Active vacancies', k.active], ['On track', k.onTrack], ['Needs attention', k.needsAttention], ['Awaiting feedback', k.awaitingFeedback],
        ['Blocked', k.blocked], ['On hold', k.onHold], ['Hired', k.hired], ['Overdue actions', k.overdueActions]].map(([title, value]) => ({ title: String(title), value: String(value) })) },
      ...(r.meta.containsDemoData ? [{ type: 'TextBlock', isSubtle: true, text: 'Contains demonstration data.' }] : []),
    ],
    actions: config.appUrl ? [{ type: 'Action.OpenUrl', title: 'Open Talent Radar', url: `${config.appUrl}/reports` }] : [],
  } }] };
  const out = await fetch(config.teams.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(card), signal: AbortSignal.timeout(15000) });
  if (!out.ok) throw new HttpError(502, `Teams returned HTTP ${out.status}`);
  res.json({ ok: true });
});
