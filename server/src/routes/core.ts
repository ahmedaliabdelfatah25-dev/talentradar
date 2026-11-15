import { Router, type Request } from 'express';
import { z } from 'zod';
import { audit, diff } from '../audit.js';
import { actor, can, requirePerm, type AuthUser } from '../auth.js';
import { one, pool, rows, tx } from '../db.js';
import { getSetting, loadRefs, RISK_RULES } from '../settings.js';
import { ACTION_STATUS, addDays, badRequest, dateOf, forbidden, HEALTH, notFound, OPEN_ACTION_STATUSES, PRIORITIES, toCsv, today } from '../util.js';
import * as assistant from '../services/assistant.js';
import { buildWeeklyReport, history, primaryTeam, reportCsv, reportPdf, saveSnapshot } from '../services/report.js';
import { computeAlerts, interventionIds } from '../services/risks.js';
import { addUpdate, archiveVacancy, createVacancy, getVacancyDetail, listVacancies, saveMilestones, updateVacancy, type VacancyFilters } from '../services/vacancies.js';

export const core = Router();
const idParam = (req: Request, name = 'id') => {
  const n = Number(req.params[name]);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('Invalid id');
  return n;
};
const num = (v: unknown) => (v === undefined || v === '' ? undefined : Number(v) || undefined);
const filtersFrom = (q: Request['query']): VacancyFilters => ({
  q: typeof q.q === 'string' && q.q.trim() ? q.q.trim().slice(0, 100) : undefined,
  recruiterId: num(q.recruiterId), countryId: num(q.countryId), departmentId: num(q.departmentId), taTeamId: num(q.taTeamId),
  statusId: num(q.statusId), hiringManager: typeof q.hiringManager === 'string' ? q.hiringManager : undefined,
  overall: typeof q.overall === 'string' ? q.overall : undefined, priority: typeof q.priority === 'string' ? q.priority : undefined,
});

// ───────────── Reference data for forms and filters ─────────────
core.get('/meta', async (_req, res) => {
  const refs = await loadRefs();
  const team = await primaryTeam();
  const hm = await rows<{ hiringManager: string }>(pool, `SELECT DISTINCT hiring_manager FROM vacancies WHERE hiring_manager IS NOT NULL AND archived_at IS NULL ORDER BY 1`);
  res.json({
    teams: refs.teams, countries: refs.countries, departments: refs.departments, statuses: refs.statuses,
    users: refs.users.map((u: any) => ({ id: u.id, name: u.name, email: u.email, role: u.role, jobTitle: u.jobTitle, isActive: u.isActive })),
    jobFamilies: refs.lookups.filter((l: any) => l.type === 'job_family' && l.isActive).map((l: any) => l.label),
    vacancyTypes: refs.lookups.filter((l: any) => l.type === 'vacancy_type' && l.isActive).map((l: any) => l.label),
    templates: refs.templates.filter((t: any) => t.isActive), hiringManagers: hm.map((h) => h.hiringManager),
    health: HEALTH, priorities: PRIORITIES, actionStatuses: ACTION_STATUS, primaryTeam: team,
    hasDemoData: !!(await one(pool, 'SELECT 1 AS x FROM vacancies WHERE is_demo AND archived_at IS NULL LIMIT 1')),
  });
});

// ───────────── Vacancies ─────────────
core.get('/vacancies', requirePerm('vacancies.view'), async (req, res) => {
  res.json(await listVacancies(filtersFrom(req.query), req.user));
});

core.get('/vacancies/export.csv', requirePerm('vacancies.view'), async (req, res) => {
  const list = await listVacancies(filtersFrom(req.query), req.user);
  const notes = can(req.user!, 'notes.view');
  const head = ['Greenhouse job ID', 'Job title', 'Country', 'City', 'Department', 'Job family', 'Vacancy type', 'Responsible TA team', 'Recruiter',
    'Hiring manager', 'Department owner', 'Additional stakeholders', 'Opening date', 'Target hiring date', 'Priority', 'Current recruitment stage',
    'Vacancy status', 'Vacancy health', 'Overall status', 'Progress update', 'Last updated', 'Latest achievement', 'Next action', 'Action owner',
    'Action deadline', 'Current blocker', 'Support required', ...(notes ? ['Internal notes'] : []), 'Closure date', 'Demonstration data'];
  const data = list.map((v) => [v.greenhouseJobId, v.title, v.country, v.city, v.department, v.jobFamily, v.vacancyType, v.taTeam, v.recruiter,
    v.hiringManager, v.departmentOwner, v.stakeholders, v.openingDate, v.targetHireDate, v.priority, v.currentStage, v.status,
    HEALTH[v.health as keyof typeof HEALTH], v.overall.label, v.progressUpdate, v.lastUpdateAt ? dateOf(v.lastUpdateAt) : '', v.latestAchievement,
    v.nextAction, v.actionOwner, v.actionDeadline, v.currentBlocker, v.supportRequired, ...(notes ? [v.internalNotes] : []), v.closureDate, v.isDemo ? 'Yes' : 'No']);
  res.type('text/csv').attachment(`talent-radar-hiring-tracker-${today()}.csv`).send(toCsv(head, data));
});

core.post('/vacancies', requirePerm('vacancies.create'), async (req, res) => {
  const id = await tx((db) => createVacancy(db, req.user!, actor(req), req.body));
  res.status(201).json(await getVacancyDetail(id, req.user!));
});

core.get('/vacancies/:id', requirePerm('vacancies.view'), async (req, res) => {
  res.json(await getVacancyDetail(idParam(req), req.user!));
});

core.patch('/vacancies/:id', requirePerm('vacancies.edit_own', 'vacancies.edit_all'), async (req, res) => {
  const id = idParam(req);
  await tx((db) => updateVacancy(db, req.user!, id, req.body));
  res.json(await getVacancyDetail(id, req.user!));
});

core.post('/vacancies/:id/updates', requirePerm('vacancies.edit_own', 'vacancies.edit_all'), async (req, res) => {
  const id = idParam(req);
  await tx((db) => addUpdate(db, req.user!, id, req.body));
  res.status(201).json(await getVacancyDetail(id, req.user!));
});

core.put('/vacancies/:id/milestones', requirePerm('vacancies.edit_own', 'vacancies.edit_all'), async (req, res) => {
  const id = idParam(req);
  await tx((db) => saveMilestones(db, req.user!, id, req.body));
  res.json(await getVacancyDetail(id, req.user!));
});

core.delete('/vacancies/:id', requirePerm('vacancies.archive'), async (req, res) => {
  await tx((db) => archiveVacancy(db, req.user!, idParam(req)));
  res.json({ ok: true });
});

// ───────────── Action centre ─────────────
const actionSchema = z.object({
  title: z.string().trim().min(2, 'Action title is required').max(300), description: z.string().max(4000).nullish(),
  vacancyId: z.number().int().positive().nullish(), assigneeId: z.number().int().positive().nullish(), waitingOn: z.string().max(160).nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish().or(z.literal('')),
  priority: z.enum(PRIORITIES).optional(), status: z.enum(Object.keys(ACTION_STATUS) as [string, ...string[]]).optional(),
});
const ACTION_COLS: Record<string, string> = { title: 'title', description: 'description', vacancyId: 'vacancy_id', assigneeId: 'assignee_id',
  waitingOn: 'waiting_on', dueDate: 'due_date', priority: 'priority', status: 'status' };
const ACTION_SELECT = `SELECT a.*, u.name AS assignee, c.name AS created_by_name, v.title AS vacancy_title,
    (SELECT count(*) FROM action_comments ac WHERE ac.action_id = a.id) AS comment_count
  FROM actions a LEFT JOIN users u ON u.id = a.assignee_id LEFT JOIN users c ON c.id = a.created_by LEFT JOIN vacancies v ON v.id = a.vacancy_id`;

/** Buckets are derived from recorded status and due date — nothing has to be maintained by hand. */
function bucket(a: any, t: string, soon: string): string {
  if (a.status === 'completed' || a.status === 'cancelled') return 'done';
  if (a.dueDate && a.dueDate < t) return 'overdue';
  if (a.status === 'waiting_feedback') return 'waiting';
  if (a.dueDate === t) return 'today';
  if (a.dueDate && a.dueDate <= soon) return 'upcoming';
  return 'later';
}
const withBuckets = (list: any[]) => { const t = today(); const soon = addDays(t, 14); return list.map((a) => ({ ...a, bucket: bucket(a, t, soon) })); };
const canManageAction = (u: AuthUser, a: { assigneeId: number | null; createdBy: number | null }) =>
  can(u, 'actions.manage_all') || (can(u, 'actions.manage_own') && (a.assigneeId === u.id || a.createdBy === u.id));

core.get('/actions', requirePerm('vacancies.view'), async (req, res) => {
  const where: string[] = ['(v.id IS NULL OR v.archived_at IS NULL)'];
  const p: unknown[] = [];
  if (num(req.query.assigneeId)) { p.push(num(req.query.assigneeId)); where.push(`a.assignee_id = $${p.length}`); }
  if (num(req.query.vacancyId)) { p.push(num(req.query.vacancyId)); where.push(`a.vacancy_id = $${p.length}`); }
  if (req.query.scope !== 'all') where.push(`(a.status IN ('open','in_progress','waiting_feedback') OR a.updated_at > now() - interval '30 days')`);
  const list = await rows<any>(pool, `${ACTION_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.due_date NULLS LAST,
    CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, a.id`, p);
  res.json(withBuckets(list).map((a) => ({ ...a, canManage: canManageAction(req.user!, a) })));
});

core.get('/actions/:id', requirePerm('vacancies.view'), async (req, res) => {
  const a = await one<any>(pool, `${ACTION_SELECT} WHERE a.id = $1`, [idParam(req)]);
  if (!a) throw notFound('Action');
  const comments = await rows<any>(pool, `SELECT c.*, u.name AS user_name FROM action_comments c LEFT JOIN users u ON u.id = c.user_id WHERE c.action_id = $1 ORDER BY c.created_at`, [a.id]);
  res.json({ ...withBuckets([a])[0], comments, canManage: canManageAction(req.user!, a) });
});

core.post('/actions', requirePerm('actions.manage_own', 'actions.manage_all'), async (req, res) => {
  const d = actionSchema.parse(req.body);
  const status = d.status ?? 'open';
  const a = await tx(async (db) => {
    const row = (await one<any>(db,
      `INSERT INTO actions (title, description, vacancy_id, assignee_id, waiting_on, due_date, priority, status, created_by, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [d.title, d.description?.trim() || null, d.vacancyId ?? null, d.assigneeId ?? req.user!.id, d.waitingOn?.trim() || null, d.dueDate || null,
        d.priority ?? 'medium', status, req.user!.id, status === 'completed' ? new Date() : null]))!;
    await audit(db, actor(req), { entityType: 'action', entityId: row.id, vacancyId: row.vacancyId, action: 'created', summary: `Action created: ${row.title}` });
    return row;
  });
  res.status(201).json(a);
});

core.patch('/actions/:id', requirePerm('actions.manage_own', 'actions.manage_all'), async (req, res) => {
  const id = idParam(req);
  const d = actionSchema.partial().parse(req.body) as Record<string, any>;
  await tx(async (db) => {
    const before = await one<any>(db, 'SELECT * FROM actions WHERE id = $1 FOR UPDATE', [id]);
    if (!before) throw notFound('Action');
    if (!canManageAction(req.user!, before)) throw forbidden('You can only change actions assigned to or created by you');
    for (const k of ['description', 'waitingOn', 'dueDate']) if (k in d && (d[k] === '' || d[k] === undefined)) d[k] = null;
    const changes = diff(before, d, Object.keys(ACTION_COLS));
    if (!Object.keys(changes).length) return;
    const sets = ['updated_at = now()'];
    const vals: unknown[] = [id];
    for (const k of Object.keys(changes)) { vals.push(d[k]); sets.push(`${ACTION_COLS[k]} = $${vals.length}`); }
    if (changes.status) sets.push(`completed_at = ${d.status === 'completed' ? 'now()' : 'NULL'}`);
    await db.query(`UPDATE actions SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(db, actor(req), { entityType: 'action', entityId: id, vacancyId: d.vacancyId ?? before.vacancyId,
      action: changes.status?.to === 'completed' ? 'completed' : 'edited',
      summary: changes.status ? `Action “${before.title}” marked ${ACTION_STATUS[d.status as keyof typeof ACTION_STATUS].toLowerCase()}` : `Action “${before.title}” edited`, changes });
  });
  res.json(await one<any>(pool, `${ACTION_SELECT} WHERE a.id = $1`, [id]));
});

core.post('/actions/:id/comments', requirePerm('actions.manage_own', 'actions.manage_all'), async (req, res) => {
  const id = idParam(req);
  const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
  if (!(await one(pool, 'SELECT 1 AS x FROM actions WHERE id = $1', [id]))) throw notFound('Action');
  await pool.query('INSERT INTO action_comments (action_id, user_id, body) VALUES ($1,$2,$3)', [id, req.user!.id, body]);
  await pool.query('UPDATE actions SET updated_at = now() WHERE id = $1', [id]);
  res.status(201).json({ ok: true });
});

// ───────────── Dashboards ─────────────
core.get('/dashboard/overview', requirePerm('vacancies.view'), async (req, res) => {
  const team = await primaryTeam();
  const teamId = req.query.teamId === 'all' ? null : num(req.query.teamId) ?? team.id;
  const filter = teamId ? { taTeamId: teamId } : {};
  const [report, vacancies, alerts] = await Promise.all([buildWeeklyReport(pool, { teamId }), listVacancies(filter, req.user), computeAlerts(filter)]);
  const need = interventionIds(alerts);
  const reasons = (id: number) => alerts.filter((a) => a.vacancyId === id && ['blocked', 'behind_timeline', 'next_action_overdue', 'support_required'].includes(a.rule))
    .map((a) => ({ rule: a.rule, label: a.ruleLabel, what: a.what, recommended: a.recommended, severity: a.severity }));
  res.json({
    team: report.meta.team, teamId, kpis: report.kpis,
    vacancies: vacancies.map((v) => ({ ...v, alertCount: alerts.filter((a) => a.vacancyId === v.id).length, needsIntervention: need.has(v.id) })),
    intervention: vacancies.filter((v) => need.has(v.id)).map((v) => ({ id: v.id, title: v.title, recruiter: v.recruiter, country: v.country, overall: v.overall,
      supportRequired: v.supportRequired, lastUpdateAt: v.lastUpdateAt, isDemo: v.isDemo, reasons: reasons(v.id) })),
    upcomingDeadlines: report.upcomingDeadlines, overdueActions: report.outstandingActions.filter((a) => a.overdue),
    alertCounts: report.alertCounts, week: { start: report.meta.weekStart, end: report.meta.weekEnd },
  });
});

core.get('/dashboard/my', requirePerm('vacancies.view'), async (req, res) => {
  const me = req.user!;
  const [vacancies, alerts, actions, cfg] = await Promise.all([
    listVacancies({ recruiterId: me.id }, me), computeAlerts({ recruiterId: me.id }),
    rows<any>(pool, `${ACTION_SELECT} WHERE a.assignee_id = $1 AND a.status IN ('open','in_progress','waiting_feedback') AND (v.id IS NULL OR v.archived_at IS NULL)
      ORDER BY a.due_date NULLS LAST, CASE a.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`, [me.id]),
    getSetting('risk.rules'),
  ]);
  const acts = withBuckets(actions).map((a) => ({ ...a, canManage: true }));
  const open = vacancies.filter((v) => ['active', 'on_hold'].includes(v.statusCategory));
  const stale = new Set(alerts.filter((a) => ['stale_update', 'no_next_action', 'next_action_overdue'].includes(a.rule)).map((a) => a.vacancyId));
  // "Next priority" is a plain ordering of what is already recorded: overdue first, then due today, by priority.
  const rank = (a: any) => ({ overdue: 0, today: 1, upcoming: 2, waiting: 3, later: 4 } as Record<string, number>)[a.bucket] ?? 5;
  const next = [...acts].sort((a, b) => rank(a) - rank(b) || PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9'))[0] ?? null;
  res.json({
    vacancies: open.map((v) => ({ ...v, alerts: alerts.filter((a) => a.vacancyId === v.id) })),
    closedCount: vacancies.length - open.length,
    needsUpdate: open.filter((v) => stale.has(v.id)).map((v) => ({ id: v.id, title: v.title, lastUpdateAt: v.lastUpdateAt,
      reasons: alerts.filter((a) => a.vacancyId === v.id && ['stale_update', 'no_next_action', 'next_action_overdue'].includes(a.rule)).map((a) => a.what) })),
    actions: acts, nextPriority: next, alerts, staleDays: (cfg.stale_update as any)?.days ?? 7,
  });
});

// ───────────── Risk monitor ─────────────
core.get('/risks', requirePerm('risks.view'), async (req, res) => {
  const alerts = await computeAlerts(filtersFrom(req.query));
  const cfg = await getSetting('risk.rules');
  res.json({ alerts, rules: RISK_RULES.map((r) => ({ ...r, config: cfg[r.key] })), generatedAt: new Date().toISOString() });
});

// ───────────── Recruitment assistant ─────────────
core.get('/assistant/status', requirePerm('assistant.use'), (_req, res) => {
  res.json(assistant.aiStatus());
});
core.get('/assistant/vacancy/:id', requirePerm('assistant.use'), async (req, res) => {
  const out = await assistant.vacancySummary(idParam(req), req.user!);
  res.json(req.query.polish === '1' ? await assistant.polish(out) : out);
});
core.get('/assistant/:kind', requirePerm('assistant.use'), async (req, res) => {
  const kinds: Record<string, () => Promise<assistant.Insight>> = {
    weekly: () => assistant.weeklySummary(), brief: () => assistant.leadershipBrief(), outdated: () => assistant.outdatedRecords(),
    reminders: () => assistant.reminderDrafts(req.user!), bottlenecks: () => assistant.bottlenecks(), suggestions: () => assistant.suggestions(),
  };
  const fn = kinds[String(req.params.kind)];
  if (!fn) throw notFound('Assistant view');
  const out = await fn();
  res.json(req.query.polish === '1' && req.params.kind !== 'reminders' ? await assistant.polish(out) : out);
});

// ───────────── Leadership reporting ─────────────
core.get('/reports/weekly', requirePerm('reports.view'), async (_req, res) => {
  res.json(await buildWeeklyReport());
});
core.get('/reports/history', requirePerm('reports.view'), async (_req, res) => {
  res.json(await history());
});
core.get('/reports/snapshots', requirePerm('reports.view'), async (_req, res) => {
  res.json(await rows<any>(pool, `SELECT s.id, s.week_start, s.week_end, s.generated_at, s.kind, u.name AS generated_by, s.data->'kpis' AS kpis
                                    FROM report_snapshots s LEFT JOIN users u ON u.id = s.generated_by ORDER BY s.week_start DESC`));
});
core.get('/reports/snapshots/:id', requirePerm('reports.view'), async (req, res) => {
  const s = await one<any>(pool, 'SELECT data FROM report_snapshots WHERE id = $1', [idParam(req)]);
  if (!s) throw notFound('Report');
  res.json(s.data);
});
core.post('/reports/snapshots', requirePerm('reports.generate'), async (req, res) => {
  const { id, report } = await saveSnapshot(pool, req.user!.id, 'manual');
  await audit(pool, actor(req), { entityType: 'report', entityId: id, action: 'snapshot_saved', summary: `Weekly report saved for the week starting ${report.meta.weekStart}` });
  res.status(201).json({ id, weekStart: report.meta.weekStart });
});
core.get('/reports/export', requirePerm('reports.view'), async (req, res) => {
  const snapId = num(req.query.snapshotId);
  const data = snapId ? (await one<any>(pool, 'SELECT data FROM report_snapshots WHERE id = $1', [snapId]))?.data : await buildWeeklyReport();
  if (!data) throw notFound('Report');
  const name = `talent-radar-weekly-report-${data.meta.weekStart}`;
  if (req.query.format === 'csv') return void res.type('text/csv').attachment(`${name}.csv`).send(reportCsv(data));
  if (req.query.format === 'pdf') return void res.type('application/pdf').attachment(`${name}.pdf`).send(await reportPdf(data));
  throw badRequest('format must be pdf or csv');
});
