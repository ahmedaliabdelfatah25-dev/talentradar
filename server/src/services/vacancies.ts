import { z } from 'zod';
import { audit, diff, type Actor, type Changes } from '../audit.js';
import { can, type AuthUser } from '../auth.js';
import { config } from '../config.js';
import { one, pool, rows, type Db } from '../db.js';
import { loadRefs, type Refs } from '../settings.js';
import { addDays, badRequest, forbidden, HEALTH, notFound, overallStatus, PRIORITIES, today } from '../util.js';

/** API field → column, label (for audit history) and whether a change counts as an operational progress update. */
export const FIELDS: Record<string, { col: string; label: string; operational?: boolean; ref?: 'country' | 'department' | 'team' | 'user' | 'status' }> = {
  greenhouseJobId: { col: 'greenhouse_job_id', label: 'Greenhouse job ID' },
  title: { col: 'title', label: 'Job title' },
  countryId: { col: 'country_id', label: 'Country', ref: 'country' },
  city: { col: 'city', label: 'City' },
  departmentId: { col: 'department_id', label: 'Department', ref: 'department' },
  jobFamily: { col: 'job_family', label: 'Job family' },
  vacancyType: { col: 'vacancy_type', label: 'Vacancy type' },
  taTeamId: { col: 'ta_team_id', label: 'Responsible TA team', ref: 'team' },
  recruiterId: { col: 'recruiter_id', label: 'Recruiter', ref: 'user' },
  hiringManager: { col: 'hiring_manager', label: 'Hiring manager' },
  hiringManagerEmail: { col: 'hiring_manager_email', label: 'Hiring manager email' },
  departmentOwner: { col: 'department_owner', label: 'Department owner' },
  stakeholders: { col: 'stakeholders', label: 'Additional stakeholders' },
  openingDate: { col: 'opening_date', label: 'Opening date' },
  targetHireDate: { col: 'target_hire_date', label: 'Target hiring date' },
  priority: { col: 'priority', label: 'Priority' },
  statusId: { col: 'status_id', label: 'Vacancy status', operational: true, ref: 'status' },
  health: { col: 'health', label: 'Vacancy health', operational: true },
  progressUpdate: { col: 'progress_update', label: 'Progress update', operational: true },
  latestAchievement: { col: 'latest_achievement', label: 'Latest achievement', operational: true },
  nextAction: { col: 'next_action', label: 'Next action', operational: true },
  actionOwner: { col: 'action_owner', label: 'Action owner', operational: true },
  actionDeadline: { col: 'action_deadline', label: 'Action deadline', operational: true },
  currentBlocker: { col: 'current_blocker', label: 'Current blocker', operational: true },
  supportRequired: { col: 'support_required', label: 'Support required', operational: true },
  internalNotes: { col: 'internal_notes', label: 'Internal notes' },
  closureDate: { col: 'closure_date', label: 'Closure date' },
};

const str = (max = 4000) => z.string().max(max).nullish();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD').nullish().or(z.literal(''));
const idRef = z.number().int().positive().nullish();

export const vacancySchema = z.object({
  greenhouseJobId: str(60), title: z.string().trim().min(2, 'Job title is required').max(200),
  countryId: idRef, city: str(120), departmentId: idRef, jobFamily: str(120), vacancyType: str(120),
  taTeamId: idRef, recruiterId: idRef, hiringManager: str(160), hiringManagerEmail: str(200), departmentOwner: str(160),
  stakeholders: str(600), openingDate: dateStr, targetHireDate: dateStr,
  priority: z.enum(PRIORITIES).optional(), statusId: idRef, health: z.enum(Object.keys(HEALTH) as [string, ...string[]]).optional(),
  progressUpdate: str(), latestAchievement: str(), nextAction: str(600), actionOwner: str(160), actionDeadline: dateStr,
  currentBlocker: str(), supportRequired: str(), internalNotes: str(8000), closureDate: dateStr,
  milestoneTemplateId: idRef,
});

export const updateSchema = z.object({
  summary: z.string().trim().min(3, 'Say briefly what changed').max(2000),
  achievement: str(), health: z.enum(Object.keys(HEALTH) as [string, ...string[]]).optional(), statusId: idRef,
  stageMilestoneId: idRef, nextAction: str(600), actionOwner: str(160), actionDeadline: dateStr,
  blocker: str(), supportRequired: str(), createAction: z.boolean().optional(), actionAssigneeId: idRef,
});

export const milestonesSchema = z.object({
  milestones: z.array(z.object({
    id: z.number().int().positive().optional(), name: z.string().trim().min(1).max(120),
    status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
    plannedDate: dateStr, startedDate: dateStr, completedDate: dateStr, notes: str(1000),
  })).min(1, 'A vacancy needs at least one milestone').max(40),
});

/** Trim strings and turn '' into null, for keys that were actually sent. */
function normalise<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    out[k] = typeof v === 'string' ? (v.trim() === '' ? null : v.trim()) : v;
  }
  return out as T;
}

const SELECT = `
  SELECT v.*, c.name AS country, d.name AS department, t.name AS ta_team, u.name AS recruiter, u.email AS recruiter_email,
         s.label AS status, s.category AS status_category, lu.name AS last_update_by_name,
         (SELECT count(*) FROM vacancy_milestones m WHERE m.vacancy_id = v.id AND m.status = 'completed') AS milestones_done,
         (SELECT count(*) FROM vacancy_milestones m WHERE m.vacancy_id = v.id AND m.status <> 'skipped') AS milestones_total,
         (SELECT $1::date - m.started_date FROM vacancy_milestones m WHERE m.vacancy_id = v.id AND m.status = 'in_progress' ORDER BY m.position LIMIT 1) AS days_in_stage,
         (SELECT count(*) FROM actions a WHERE a.vacancy_id = v.id AND a.status IN ('open','in_progress','waiting_feedback')) AS open_actions,
         (SELECT count(*) FROM actions a WHERE a.vacancy_id = v.id AND a.status IN ('open','in_progress','waiting_feedback')
                                           AND a.due_date < $1::date) AS overdue_actions
    FROM vacancies v
    JOIN vacancy_statuses s ON s.id = v.status_id
    LEFT JOIN countries c ON c.id = v.country_id
    LEFT JOIN departments d ON d.id = v.department_id
    LEFT JOIN ta_teams t ON t.id = v.ta_team_id
    LEFT JOIN users u ON u.id = v.recruiter_id
    LEFT JOIN users lu ON lu.id = v.last_update_by`;

export interface VacancyFilters {
  q?: string; recruiterId?: number; countryId?: number; departmentId?: number; taTeamId?: number; hiringManager?: string;
  statusId?: number; overall?: string; health?: string; priority?: string; includeArchived?: boolean;
}

function decorate(v: any, user?: AuthUser) {
  v.overall = overallStatus(v.statusCategory, v.health);
  v.greenhouseUrl = v.greenhouseJobId ? config.greenhouse.jobUrlTemplate.replace('{id}', encodeURIComponent(v.greenhouseJobId)) : null;
  if (user && !can(user, 'notes.view')) delete v.internalNotes;
  return v;
}

export async function listVacancies(f: VacancyFilters = {}, user?: AuthUser, db: Db = pool): Promise<any[]> {
  const where: string[] = [];
  const p: unknown[] = [today()];
  const add = (sql: string, val: unknown) => { p.push(val); where.push(sql.replace('?', `$${p.length}`)); };
  if (!f.includeArchived) where.push('v.archived_at IS NULL');
  if (f.recruiterId) add('v.recruiter_id = ?', f.recruiterId);
  if (f.countryId) add('v.country_id = ?', f.countryId);
  if (f.departmentId) add('v.department_id = ?', f.departmentId);
  if (f.taTeamId) add('v.ta_team_id = ?', f.taTeamId);
  if (f.statusId) add('v.status_id = ?', f.statusId);
  if (f.priority) add('v.priority = ?', f.priority);
  if (f.hiringManager) add('lower(v.hiring_manager) = lower(?)', f.hiringManager);
  if (f.health) { add('v.health = ?', f.health); where.push(`s.category = 'active'`); }
  if (f.q) {
    p.push(`%${f.q.replace(/[%_]/g, '\\$&')}%`);
    const i = `$${p.length}`;
    where.push(`(v.title ILIKE ${i} OR v.greenhouse_job_id ILIKE ${i} OR v.hiring_manager ILIKE ${i} OR v.city ILIKE ${i} OR c.name ILIKE ${i} OR u.name ILIKE ${i})`);
  }
  switch (f.overall) {
    case undefined: case '': break;
    case 'active': where.push(`s.category = 'active'`); break;
    case 'hired': where.push(`s.category = 'filled'`); break;
    case 'cancelled': where.push(`s.category = 'cancelled'`); break;
    case 'on_hold': where.push(`s.category = 'on_hold'`); break;
    case 'open_all': where.push(`s.category IN ('active','on_hold')`); break;
    default: add('v.health = ?', f.overall); where.push(`s.category = 'active'`);
  }
  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE s.category WHEN 'active' THEN 0 WHEN 'on_hold' THEN 1 ELSE 2 END,
             CASE v.health WHEN 'blocked' THEN 0 WHEN 'needs_attention' THEN 1 WHEN 'awaiting_feedback' THEN 2 ELSE 3 END,
             v.action_deadline NULLS LAST, v.title`;
  return (await rows<any>(db, sql, p)).map((v) => decorate(v, user));
}

export async function getVacancyRow(id: number, db: Db = pool): Promise<any> {
  const v = await one<any>(db, `${SELECT} WHERE v.id = $2`, [today(), id]);
  if (!v) throw notFound('Vacancy');
  return v;
}

export const getMilestones = (vacancyId: number, db: Db = pool) =>
  rows<any>(db, 'SELECT * FROM vacancy_milestones WHERE vacancy_id = $1 ORDER BY position, id', [vacancyId]);

export async function getVacancyDetail(id: number, user: AuthUser, db: Db = pool) {
  const v = decorate(await getVacancyRow(id, db), user);
  const [milestones, updates, actions, history] = await Promise.all([
    getMilestones(id, db),
    rows<any>(db, `SELECT vu.*, u.name AS user_name FROM vacancy_updates vu LEFT JOIN users u ON u.id = vu.user_id
                    WHERE vu.vacancy_id = $1 ORDER BY vu.created_at DESC, vu.id DESC`, [id]),
    rows<any>(db, `SELECT a.*, u.name AS assignee FROM actions a LEFT JOIN users u ON u.id = a.assignee_id
                    WHERE a.vacancy_id = $1 ORDER BY (a.status IN ('completed','cancelled')), a.due_date NULLS LAST, a.id`, [id]),
    rows<any>(db, `SELECT id, at, user_name, entity_type, action, summary, changes FROM audit_log
                    WHERE vacancy_id = $1 ORDER BY at DESC, id DESC LIMIT 200`, [id]),
  ]);
  return { ...v, milestones, updates, actions, history, canEdit: canEditVacancy(user, v) };
}

export const canEditVacancy = (user: AuthUser, v: { recruiterId: number | null }) =>
  can(user, 'vacancies.edit_all') || (can(user, 'vacancies.edit_own') && v.recruiterId === user.id);

/** Replace reference ids with their names so the audit trail is readable without joins. */
function labelChanges(changes: Changes, refs: Refs): Record<string, { label: string; from: unknown; to: unknown }> {
  const name = (ref: string | undefined, v: unknown) => {
    if (v === null || v === undefined || !ref) return v;
    const id = Number(v);
    if (ref === 'country') return refs.countryById.get(id)?.name ?? v;
    if (ref === 'department') return refs.departmentById.get(id)?.name ?? v;
    if (ref === 'team') return refs.teamById.get(id)?.name ?? v;
    if (ref === 'user') return refs.userById.get(id)?.name ?? v;
    if (ref === 'status') return refs.statusById.get(id)?.label ?? v;
    return v;
  };
  const out: Record<string, { label: string; from: unknown; to: unknown }> = {};
  for (const [k, c] of Object.entries(changes)) {
    const f = FIELDS[k];
    const fmt = (v: unknown) => (k === 'health' && typeof v === 'string' ? HEALTH[v as keyof typeof HEALTH] ?? v : name(f?.ref, v));
    out[k] = { label: f?.label ?? k, from: fmt(c.from), to: fmt(c.to) };
  }
  return out;
}

function validateRefs(data: Record<string, any>, refs: Refs) {
  if (data.countryId && !refs.countryById.has(data.countryId)) throw badRequest('Unknown country');
  if (data.departmentId && !refs.departmentById.has(data.departmentId)) throw badRequest('Unknown department');
  if (data.taTeamId && !refs.teamById.has(data.taTeamId)) throw badRequest('Unknown TA team');
  if (data.statusId && !refs.statusById.has(data.statusId)) throw badRequest('Unknown vacancy status');
  if (data.recruiterId && !refs.userById.has(data.recruiterId)) throw badRequest('Unknown recruiter');
  if (data.openingDate && data.targetHireDate && data.targetHireDate < data.openingDate) {
    throw badRequest('Target hiring date cannot be before the opening date');
  }
}

async function assertGreenhouseIdFree(db: Db, ghId: string | null | undefined, exceptId?: number) {
  if (!ghId) return;
  const dup = await one<any>(db, 'SELECT id, title FROM vacancies WHERE greenhouse_job_id = $1 AND archived_at IS NULL AND id <> $2', [ghId, exceptId ?? 0]);
  if (dup) throw badRequest(`Greenhouse job ID ${ghId} is already linked to “${dup.title}”`, { duplicateOf: dup.id });
}

export async function instantiateTemplate(db: Db, vacancyId: number, templateId: number | null | undefined, openingDate: string | null, refs: Refs) {
  const tpl = refs.templates.find((t: any) => t.id === templateId) ?? refs.templates.find((t: any) => t.isDefault) ?? refs.templates[0];
  if (!tpl) return;
  for (const item of tpl.items) {
    const planned = openingDate && item.defaultOffsetDays !== null ? addDays(openingDate, item.defaultOffsetDays) : null;
    const first = item.position === 1;
    await db.query(
      `INSERT INTO vacancy_milestones (vacancy_id, name, position, status, planned_date, started_date) VALUES ($1,$2,$3,$4,$5,$6)`,
      [vacancyId, item.name, item.position, first ? 'in_progress' : 'pending', planned, first ? openingDate ?? today() : null],
    );
  }
  await recomputeStage(db, vacancyId);
}

/** current_stage = the milestone in progress; otherwise the next pending one; otherwise the last completed one. */
export async function recomputeStage(db: Db, vacancyId: number): Promise<string | null> {
  const ms = await getMilestones(vacancyId, db);
  const live = ms.filter((m) => m.status !== 'skipped');
  const cur = live.find((m) => m.status === 'in_progress') ?? live.find((m) => m.status === 'pending')
    ?? [...live].reverse().find((m) => m.status === 'completed');
  const stage = cur?.name ?? null;
  await db.query('UPDATE vacancies SET current_stage = $2 WHERE id = $1', [vacancyId, stage]);
  return stage;
}

/**
 * Move the vacancy to a milestone. A milestone is "reached" when it becomes the current stage (started_date)
 * and "completed" when the vacancy moves on. Earlier open milestones complete, later ones reopen, skipped stay skipped.
 */
export async function applyStage(db: Db, vacancyId: number, milestoneId: number, closedAsFilled: boolean) {
  const ms = await getMilestones(vacancyId, db);
  const target = ms.find((m) => m.id === milestoneId);
  if (!target) throw badRequest('That milestone does not belong to this vacancy');
  const t = today();
  for (const m of ms) {
    if (m.status === 'skipped' && m.id !== target.id) continue;
    if (m.position < target.position || (m.position === target.position && m.id < target.id)) {
      if (m.status !== 'completed') await db.query(`UPDATE vacancy_milestones SET status='completed', started_date = COALESCE(started_date, $2), completed_date = COALESCE(completed_date, $2) WHERE id=$1`, [m.id, t]);
    } else if (m.id === target.id) {
      if (closedAsFilled) await db.query(`UPDATE vacancy_milestones SET status='completed', started_date = COALESCE(started_date, $2), completed_date = COALESCE(completed_date, $2) WHERE id=$1`, [m.id, t]);
      else if (m.status !== 'in_progress') await db.query(`UPDATE vacancy_milestones SET status='in_progress', started_date = $2, completed_date = NULL WHERE id=$1`, [m.id, m.status === 'completed' ? m.startedDate ?? t : t]);
    } else if (m.status !== 'pending') {
      await db.query(`UPDATE vacancy_milestones SET status='pending', started_date = NULL, completed_date = NULL WHERE id=$1`, [m.id]);
    }
  }
}

export async function createVacancy(db: Db, user: AuthUser | null, actorInfo: Actor, raw: unknown, opts: { isDemo?: boolean; source?: string } = {}) {
  const input = normalise(vacancySchema.parse(raw)) as Record<string, any>;
  const refs = await loadRefs(db);
  if (user && !can(user, 'vacancies.assign')) input.recruiterId = user.role === 'recruiter' ? user.id : input.recruiterId ?? null;
  if (!input.statusId) input.statusId = refs.statuses.find((s: any) => s.category === 'active' && s.isActive)?.id;
  if (!input.taTeamId) input.taTeamId = refs.teams[0]?.id ?? null;
  validateRefs(input, refs);
  await assertGreenhouseIdFree(db, input.greenhouseJobId);

  const cols = ['is_demo', 'created_by', 'last_update_at', 'last_update_by'];
  const vals: unknown[] = [!!opts.isDemo, actorInfo.id, new Date(), actorInfo.id];
  for (const [k, f] of Object.entries(FIELDS)) {
    if (input[k] === undefined) continue;
    cols.push(f.col);
    vals.push(input[k]);
  }
  const category = refs.statusById.get(input.statusId)?.category;
  if (category && ['filled', 'cancelled'].includes(category) && !input.closureDate) { cols.push('closure_date'); vals.push(today()); }
  const { id } = (await one<{ id: number }>(db,
    `INSERT INTO vacancies (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, vals))!;
  await instantiateTemplate(db, id, input.milestoneTemplateId, input.openingDate ?? null, refs);
  await audit(db, actorInfo, { entityType: 'vacancy', entityId: id, vacancyId: id, action: 'created',
    summary: `Vacancy created${opts.source ? ` (${opts.source})` : ''}: ${input.title}` });
  return id;
}

export async function updateVacancy(db: Db, user: AuthUser, id: number, raw: unknown) {
  const before = await getVacancyRow(id, db);
  if (!canEditVacancy(user, before)) throw forbidden('You can only update vacancies assigned to you');
  const input = normalise(vacancySchema.partial().parse(raw)) as Record<string, any>;
  delete input.milestoneTemplateId;
  if ('title' in input && !input.title) throw badRequest('Job title is required');
  if ('recruiterId' in input && input.recruiterId !== before.recruiterId && !can(user, 'vacancies.assign')) {
    throw forbidden('You do not have permission to reassign vacancies');
  }
  if ('statusId' in input && !input.statusId) delete input.statusId;
  const refs = await loadRefs(db);
  validateRefs({ openingDate: before.openingDate, targetHireDate: before.targetHireDate, ...input }, refs);
  if ('greenhouseJobId' in input) await assertGreenhouseIdFree(db, input.greenhouseJobId, id);

  // Closing or reopening keeps the closure date consistent with the status category.
  if (input.statusId && input.statusId !== before.statusId) {
    const cat = refs.statusById.get(input.statusId)!.category;
    if (['filled', 'cancelled'].includes(cat) && !input.closureDate && !before.closureDate) input.closureDate = today();
    if (cat === 'active' && !('closureDate' in input)) input.closureDate = null;
  }
  const changes = diff(before, input, Object.keys(FIELDS));
  if (!Object.keys(changes).length) return id;

  const sets: string[] = ['updated_at = now()'];
  const vals: unknown[] = [id];
  for (const k of Object.keys(changes)) { vals.push(input[k]); sets.push(`${FIELDS[k].col} = $${vals.length}`); }
  if (Object.keys(changes).some((k) => FIELDS[k].operational)) {
    vals.push(user.id);
    sets.push(`last_update_at = now()`, `last_update_by = $${vals.length}`);
  }
  await db.query(`UPDATE vacancies SET ${sets.join(', ')} WHERE id = $1`, vals);
  const labelled = labelChanges(changes, refs);
  await audit(db, { id: user.id, name: user.name }, { entityType: 'vacancy', entityId: id, vacancyId: id, action: 'edited',
    summary: `Edited ${Object.values(labelled).map((c) => c.label.toLowerCase()).join(', ')}`, changes: labelled });
  return id;
}

/** The recruiter's quick update: one short sentence plus only the fields that changed. */
export async function addUpdate(db: Db, user: AuthUser, id: number, raw: unknown) {
  const before = await getVacancyRow(id, db);
  if (!canEditVacancy(user, before)) throw forbidden('You can only update vacancies assigned to you');
  const input = normalise(updateSchema.parse(raw)) as Record<string, any>;
  const refs = await loadRefs(db);
  if (input.statusId && !refs.statusById.has(input.statusId)) throw badRequest('Unknown vacancy status');

  const patch: Record<string, unknown> = { progressUpdate: input.summary };
  if (input.achievement) patch.latestAchievement = input.achievement;
  if (input.health) patch.health = input.health;
  if (input.statusId) patch.statusId = input.statusId;
  for (const [from, to] of [['nextAction', 'nextAction'], ['actionOwner', 'actionOwner'], ['actionDeadline', 'actionDeadline'],
    ['blocker', 'currentBlocker'], ['supportRequired', 'supportRequired']] as const) {
    if (from in input) patch[to] = input[from];
  }
  const statusId = (patch.statusId as number | undefined) ?? before.statusId;
  const category = refs.statusById.get(statusId)!.category;
  if (statusId !== before.statusId) {
    if (['filled', 'cancelled'].includes(category) && !before.closureDate) patch.closureDate = today();
    if (category === 'active') patch.closureDate = null;
  }
  const changes = diff(before, patch, Object.keys(FIELDS));
  const sets = ['updated_at = now()', 'last_update_at = now()', 'last_update_by = $2'];
  const vals: unknown[] = [id, user.id];
  for (const k of Object.keys(changes)) { vals.push(patch[k]); sets.push(`${FIELDS[k].col} = $${vals.length}`); }
  await db.query(`UPDATE vacancies SET ${sets.join(', ')} WHERE id = $1`, vals);

  if (input.stageMilestoneId) await applyStage(db, id, input.stageMilestoneId, category === 'filled');
  else if (category === 'filled' && before.statusCategory !== 'filled') {
    // A hire closes whatever was in progress and any milestone literally named "Hired".
    await db.query(`UPDATE vacancy_milestones SET status='completed', started_date = COALESCE(started_date, $2), completed_date = COALESCE(completed_date, $2)
                     WHERE vacancy_id = $1 AND (status = 'in_progress' OR lower(name) = 'hired') AND status <> 'skipped'`, [id, today()]);
  }
  const stage = await recomputeStage(db, id);
  const after = await getVacancyRow(id, db);

  const upd = (await one<{ id: number }>(db,
    `INSERT INTO vacancy_updates (vacancy_id, user_id, summary, achievement, stage, status_label, status_category, health,
                                  next_action, action_owner, action_deadline, blocker, support_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [id, user.id, input.summary, input.achievement ?? null, stage, after.status, after.statusCategory, after.health,
      after.nextAction, after.actionOwner, after.actionDeadline, after.currentBlocker, after.supportRequired]))!;

  const labelled = labelChanges(changes, refs) as Record<string, any>;
  delete labelled.progressUpdate;
  if (stage !== before.currentStage) labelled.currentStage = { label: 'Recruitment stage', from: before.currentStage, to: stage };
  await audit(db, { id: user.id, name: user.name }, { entityType: 'vacancy', entityId: id, vacancyId: id, action: 'progress_update',
    summary: input.summary, changes: Object.keys(labelled).length ? labelled : undefined });

  if (input.createAction && after.nextAction) {
    const owner = (after.actionOwner ?? '').toLowerCase();
    const assignee = input.actionAssigneeId ?? refs.users.find((u: any) => u.isActive && u.name.toLowerCase() === owner)?.id ?? user.id;
    const waitingOn = refs.users.some((u: any) => u.name.toLowerCase() === owner) ? null : after.actionOwner;
    const a = (await one<{ id: number }>(db,
      `INSERT INTO actions (title, vacancy_id, assignee_id, waiting_on, due_date, priority, status, created_by, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [after.nextAction, id, assignee, waitingOn, after.actionDeadline, after.priority, waitingOn ? 'waiting_feedback' : 'open', user.id, after.isDemo]))!;
    await audit(db, { id: user.id, name: user.name }, { entityType: 'action', entityId: a.id, vacancyId: id, action: 'created',
      summary: `Action created from next action: ${after.nextAction}` });
  }
  return upd.id;
}

export async function saveMilestones(db: Db, user: AuthUser, id: number, raw: unknown) {
  const v = await getVacancyRow(id, db);
  if (!canEditVacancy(user, v)) throw forbidden('You can only update vacancies assigned to you');
  const { milestones } = milestonesSchema.parse(raw);
  const before = await getMilestones(id, db);
  const keep = new Set(milestones.filter((m) => m.id).map((m) => m.id));
  for (const m of milestones) if (m.id && !before.some((b) => b.id === m.id)) throw badRequest('Unknown milestone id');
  if (milestones.filter((m) => m.status === 'in_progress').length > 1) throw badRequest('Only one milestone can be in progress at a time');

  for (const b of before) if (!keep.has(b.id)) await db.query('DELETE FROM vacancy_milestones WHERE id = $1', [b.id]);
  let pos = 0;
  for (const m of milestones) {
    pos += 1;
    const reached = ['in_progress', 'completed'].includes(m.status);
    const started = reached ? (m.startedDate || m.completedDate || today()) : null;
    const completed = m.status === 'completed' ? (m.completedDate || (started! > today() ? started : today())) : null;
    const args = [m.name, pos, m.status, m.plannedDate || null, started, completed, m.notes?.trim() || null];
    if (m.id) await db.query(`UPDATE vacancy_milestones SET name=$2, position=$3, status=$4, planned_date=$5, started_date=$6, completed_date=$7, notes=$8 WHERE id=$1`, [m.id, ...args]);
    else await db.query(`INSERT INTO vacancy_milestones (vacancy_id, name, position, status, planned_date, started_date, completed_date, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, ...args]);
  }
  const stage = await recomputeStage(db, id);
  await db.query('UPDATE vacancies SET updated_at = now(), last_update_at = now(), last_update_by = $2 WHERE id = $1', [id, user.id]);
  const fmt = (list: any[]) => list.map((m) => `${m.name} [${m.status}]`).join(' → ');
  await audit(db, { id: user.id, name: user.name }, { entityType: 'vacancy', entityId: id, vacancyId: id, action: 'milestones_changed',
    summary: `Milestones updated${stage !== v.currentStage ? `; stage is now “${stage}”` : ''}`,
    changes: { milestones: { label: 'Milestones', from: fmt(before), to: fmt(milestones) } } });
}

export async function archiveVacancy(db: Db, user: AuthUser, id: number) {
  const v = await getVacancyRow(id, db);
  await db.query('UPDATE vacancies SET archived_at = now() WHERE id = $1', [id]);
  await audit(db, { id: user.id, name: user.name }, { entityType: 'vacancy', entityId: id, vacancyId: id, action: 'archived',
    summary: `Vacancy archived: ${v.title}` });
}
