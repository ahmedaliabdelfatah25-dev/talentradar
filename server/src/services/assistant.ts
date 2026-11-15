import type { AuthUser } from '../auth.js';
import { config } from '../config.js';
import { pool, rows, type Db } from '../db.js';
import { dateOf, daysSince, diffDays, fmtDate, plural, today } from '../util.js';
import { buildWeeklyReport, history } from './report.js';
import { computeAlerts, type Alert } from './risks.js';
import { getVacancyDetail, listVacancies } from './vacancies.js';

/**
 * Recruitment assistant.
 *
 * The built-in engine is deterministic: every sentence is assembled from recorded
 * fields, updates, actions, milestones or rule results, and carries references to
 * the records it was built from. It needs no AI service. An optional LLM (see
 * polish()) may only re-word these statements; it is never given anything else.
 */
export interface Source { type: 'vacancy' | 'update' | 'action' | 'milestone' | 'rule' | 'report' | 'greenhouse'; id?: number | string | null; vacancyId?: number | null; label: string }
export interface Statement { text: string; sources: Source[]; tone?: 'positive' | 'warning' | 'critical' }
export interface Section { heading: string; statements: Statement[]; empty?: string }
export interface Draft { to: string; toEmail: string | null; subject: string; body: string; sources: Source[] }
export interface Insight {
  kind: string; title: string; generatedAt: string; engine: 'built-in'; basis: string;
  sections: Section[]; drafts?: Draft[];
  narrative?: string; llm?: { model: string; note?: string };
}

const vsrc = (v: { id: number; title: string }, field: string): Source => ({ type: 'vacancy', vacancyId: v.id, label: `${v.title} — ${field}` });
const usrc = (u: any, title?: string | null): Source => ({ type: 'update', id: u.id, vacancyId: u.vacancyId,
  label: `Progress update by ${u.userName ?? u.user ?? 'unknown'} on ${fmtDate(dateOf(u.createdAt ?? u.at))}${title ? ` (${title})` : ''}` });
const asrc = (a: any): Source => ({ type: 'action', id: a.id, vacancyId: a.vacancyId ?? null, label: `Action #${a.id}: ${a.title}` });
const rsrc = (a: Alert): Source => ({ type: 'rule', id: a.rule, vacancyId: a.vacancyId, label: `Risk rule “${a.ruleLabel}”${a.vacancyTitle ? ` on ${a.vacancyTitle}` : ''}` });
const rep = (label: string): Source => ({ type: 'report', label });
const list = (items: string[], max = 4) => (items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} and ${items.length - max} more`);
const rel = (date: string) => {
  const n = diffDays(today(), date);
  return n === 0 ? 'today' : n > 0 ? `in ${plural(n, 'day')}` : `${plural(-n, 'day')} ago`;
};
const firstName = (name: string) => name.split(' ')[0];
const make = (kind: string, title: string, basis: string, sections: Section[], drafts?: Draft[]): Insight =>
  ({ kind, title, generatedAt: new Date().toISOString(), engine: 'built-in', basis, sections, drafts });

// 1 ── Vacancy progress summary
export async function vacancySummary(id: number, user: AuthUser, db: Db = pool): Promise<Insight> {
  const v = await getVacancyDetail(id, user, db);
  const alerts = (await computeAlerts({}, db)).filter((a) => a.vacancyId === id);
  const where: Statement[] = [{
    text: `${v.title}${v.country ? ` (${[v.city, v.country].filter(Boolean).join(', ')})` : ''} is ${v.overall.label.toLowerCase()} at stage “${v.currentStage ?? 'not set'}”, with ${v.milestonesDone} of ${v.milestonesTotal} milestones complete.`,
    sources: [vsrc(v, 'status, health and stage'), vsrc(v, 'milestones')],
    tone: v.overall.key === 'blocked' ? 'critical' : v.overall.key === 'on_track' || v.overall.key === 'hired' ? 'positive' : 'warning',
  }];
  if (v.openingDate) {
    where.push({ text: `It was opened on ${fmtDate(v.openingDate)} (${rel(v.openingDate)})${v.targetHireDate ? `; the target hiring date is ${fmtDate(v.targetHireDate)} (${rel(v.targetHireDate)})` : '; no target hiring date is recorded'}${v.closureDate ? `; it was closed on ${fmtDate(v.closureDate)}` : ''}.`,
      sources: [vsrc(v, 'opening, target and closure dates')] });
  }
  where.push({ text: `Recruiter: ${v.recruiter ?? 'not assigned'}. Hiring manager: ${v.hiringManager ?? 'not recorded'}. Responsible team: ${v.taTeam ?? 'not recorded'}.`, sources: [vsrc(v, 'ownership')] });

  const progress: Statement[] = v.updates.slice(0, 4).map((u: any) => ({ text: `${fmtDate(dateOf(u.createdAt))} — ${u.userName ?? 'Unknown'}: ${u.summary}`, sources: [usrc(u)] }));
  if (v.latestAchievement) progress.push({ text: `Latest achievement recorded: ${v.latestAchievement}`, sources: [vsrc(v, 'latest achievement')], tone: 'positive' });

  const next: Statement[] = v.nextAction
    ? [{ text: `Next action: “${v.nextAction}”, owned by ${v.actionOwner ?? 'nobody (no owner recorded)'}${v.actionDeadline ? `, due ${fmtDate(v.actionDeadline)} (${rel(v.actionDeadline)})` : ', with no deadline recorded'}.`,
        sources: [vsrc(v, 'next action, owner and deadline')], tone: v.actionDeadline && v.actionDeadline < today() && v.statusCategory === 'active' ? 'critical' : undefined }]
    : [];
  const risks: Statement[] = [];
  if (v.currentBlocker) risks.push({ text: `Blocker: ${v.currentBlocker}`, sources: [vsrc(v, 'current blocker')], tone: 'critical' });
  if (v.supportRequired) risks.push({ text: `Support required: ${v.supportRequired}`, sources: [vsrc(v, 'support required')], tone: 'warning' });
  for (const a of alerts) risks.push({ text: `${a.ruleLabel}: ${a.what}`, sources: [rsrc(a)], tone: a.severity === 'high' ? 'critical' : 'warning' });

  const open = v.actions.filter((a: any) => !['completed', 'cancelled'].includes(a.status));
  const sections: Section[] = [
    { heading: 'Where it stands', statements: where },
    { heading: 'Recent progress', statements: progress, empty: 'No progress updates have been recorded yet.' },
    { heading: 'Next step', statements: next, empty: 'No next action is recorded.' },
    { heading: 'Blockers, support and risk checks', statements: risks, empty: 'No blocker, support request or rule-based alert is recorded.' },
    { heading: 'Open actions', statements: open.map((a: any) => ({ text: `${a.title} — ${a.assignee ?? 'unassigned'}${a.dueDate ? `, due ${fmtDate(a.dueDate)} (${rel(a.dueDate)})` : ''}${a.waitingOn ? `, waiting for ${a.waitingOn}` : ''}.`, sources: [asrc(a)] })),
      empty: 'No open actions are linked to this vacancy.' },
  ];
  const g = v.greenhouseSnapshot;
  if (g) {
    sections.push({ heading: 'Greenhouse (candidate pipeline, read-only)', statements: [{
      text: `Greenhouse reported ${g.activeApplications ?? 0} active applications${g.byStage?.length ? ` (${g.byStage.map((s: any) => `${s.stage}: ${s.count}`).join(', ')})` : ''} at the last synchronisation on ${fmtDate(dateOf(v.greenhouseSyncedAt))}.`,
      sources: [{ type: 'greenhouse', vacancyId: v.id, label: `Greenhouse job ${v.greenhouseJobId} — ${g.mode === 'demo' ? 'simulated demo data' : 'synchronised snapshot'}` }] }] });
  }
  return make('vacancy_summary', `Progress summary — ${v.title}`, 'Vacancy record, its progress updates, milestones, linked actions and rule-based alerts.', sections);
}

// 2 ── Weekly status summary
export async function weeklySummary(db: Db = pool): Promise<Insight> {
  const r = await buildWeeklyReport(db);
  const k = r.kpis;
  const act = r.vacancies.filter((v) => v.statusCategory === 'active');
  const by = (h: string) => act.filter((v) => v.health === h);
  const headline: Statement[] = [{
    text: `${r.meta.team} is managing ${plural(k.active, 'active vacancy', 'active vacancies')}: ${k.onTrack} on track, ${k.needsAttention} needing attention, ${k.awaitingFeedback} awaiting feedback and ${k.blocked} blocked. ${plural(k.onHold, 'vacancy is', 'vacancies are')} on hold and ${plural(k.hired, 'hire has', 'hires have')} been completed.`,
    sources: [rep(`Vacancy status counts for the week starting ${fmtDate(r.meta.weekStart)}`)] }];

  const progress: Statement[] = [];
  const updatedIds = [...new Set(r.activity.updates.map((u) => u.vacancyId))];
  if (r.activity.updates.length) {
    progress.push({ text: `${plural(r.activity.updates.length, 'progress update was', 'progress updates were')} recorded across ${plural(updatedIds.length, 'vacancy', 'vacancies')} this week.`,
      sources: r.activity.updates.slice(0, 8).map((u) => usrc(u, u.title)) });
    for (const vid of updatedIds.slice(0, 8)) {
      const u = r.activity.updates.find((x) => x.vacancyId === vid)!;
      progress.push({ text: `${u.title}: ${u.summary}`, sources: [usrc(u)] });
    }
  }
  for (const c of r.changes.filter((x) => x.type === 'Stage')) {
    progress.push({ text: `${c.title} moved from “${c.from ?? '—'}” to “${c.to ?? '—'}”.`, tone: 'positive',
      sources: [rep(`Comparison with the saved report for the week starting ${fmtDate(r.meta.previousWeekStart)}`), { type: 'vacancy', vacancyId: c.vacancyId, label: `${c.title} — current stage` }] });
  }
  if (r.activity.actionsCompleted.length) {
    progress.push({ text: `${plural(r.activity.actionsCompleted.length, 'action was', 'actions were')} completed: ${list(r.activity.actionsCompleted.map((a) => a.title))}.`,
      sources: r.activity.actionsCompleted.map(asrc), tone: 'positive' });
  }
  if (r.activity.milestonesCompleted.length) {
    progress.push({ text: `${plural(r.activity.milestonesCompleted.length, 'milestone was', 'milestones were')} completed: ${list(r.activity.milestonesCompleted.map((m) => `${m.name} (${m.title})`))}.`,
      sources: r.activity.milestonesCompleted.map((m) => ({ type: 'milestone' as const, id: m.id, vacancyId: m.vacancyId, label: `Milestone “${m.name}” completed ${fmtDate(m.completedDate)} (${m.title})` })), tone: 'positive' });
  }

  const attention: Statement[] = [];
  for (const v of by('blocked')) attention.push({ text: `${v.title} is blocked${v.blocker ? `: ${v.blocker}` : ' (no blocker description recorded)'}.`, sources: [vsrc(v, 'health and current blocker')], tone: 'critical' });
  for (const v of by('awaiting_feedback')) attention.push({ text: `${v.title} is awaiting feedback${v.nextAction ? ` — outstanding: “${v.nextAction}”${v.actionOwner ? ` (${v.actionOwner})` : ''}` : ''}.`, sources: [vsrc(v, 'health and next action')], tone: 'warning' });
  for (const v of by('needs_attention')) attention.push({ text: `${v.title} needs attention${v.progressUpdate ? `: ${v.progressUpdate}` : ''}`, sources: [vsrc(v, 'health and progress update')], tone: 'warning' });
  const overdue = r.outstandingActions.filter((a) => a.overdue);
  if (overdue.length) attention.push({ text: `${plural(overdue.length, 'action is', 'actions are')} overdue: ${list(overdue.map((a) => `${a.title} (${a.assignee ?? 'unassigned'})`))}.`, sources: overdue.map(asrc), tone: 'critical' });
  for (const s of r.supportRequired) attention.push({ text: `Support requested on ${s.title}: ${s.supportRequired}`, sources: [{ type: 'vacancy', vacancyId: s.vacancyId, label: `${s.title} — support required` }], tone: 'warning' });

  const coming: Statement[] = r.upcomingDeadlines.slice(0, 8).map((u) => ({ text: `${fmtDate(u.date)} — ${u.kind}: ${u.what}${u.title && u.kind !== 'Target hiring date' ? ` (${u.title})` : ''}${u.owner ? ` — ${u.owner}` : ''}.`,
    sources: [u.actionId ? { type: 'action', id: u.actionId, vacancyId: u.vacancyId, label: `Action #${u.actionId}: ${u.what}` } : { type: 'vacancy', vacancyId: u.vacancyId, label: `${u.title} — ${u.kind.toLowerCase()}` }] }));

  return make('weekly_summary', `Weekly recruitment status — week of ${fmtDate(r.meta.weekStart)}`,
    'The live weekly report: vacancy records, progress updates, actions and milestones recorded in this application.', [
      { heading: 'Headline', statements: headline },
      { heading: 'Progress this week', statements: progress, empty: 'No progress updates, completed actions or completed milestones were recorded this week.' },
      { heading: 'Needs attention', statements: attention, empty: 'Nothing is flagged as blocked, awaiting feedback, needing attention or overdue.' },
      { heading: 'Coming up', statements: coming, empty: 'No deadlines fall in the coming period.' },
    ]);
}

// 3 ── Outdated or incomplete records
export async function outdatedRecords(db: Db = pool): Promise<Insight> {
  const alerts = await computeAlerts({}, db);
  const vacs = await listVacancies({ overall: 'active' }, undefined, db);
  const stale = alerts.filter((a) => a.rule === 'stale_update');
  const missing: Statement[] = [];
  for (const v of vacs) {
    const gaps = [
      !v.recruiterId && 'recruiter', !v.hiringManager && 'hiring manager', !v.nextAction && 'next action',
      v.nextAction && !v.actionOwner && 'action owner', v.nextAction && !v.actionDeadline && 'action deadline',
      !v.targetHireDate && 'target hiring date', !v.openingDate && 'opening date', !v.greenhouseJobId && 'Greenhouse job ID',
    ].filter(Boolean) as string[];
    if (gaps.length) missing.push({ text: `${v.title} has no ${list(gaps, 6)} recorded.`, sources: [vsrc(v, 'empty fields')], tone: 'warning' });
  }
  const past = alerts.filter((a) => a.rule === 'next_action_overdue');
  return make('outdated_records', 'Outdated and incomplete records', 'Last-update dates and empty fields on active vacancy records.', [
    { heading: 'No recent progress update', statements: stale.map((a) => ({ text: `${a.vacancyTitle} (${a.recruiter ?? 'unassigned'}): ${a.what}`, sources: [rsrc(a)], tone: 'warning' as const })),
      empty: 'Every active vacancy has been updated within the configured period.' },
    { heading: 'Next action deadline already passed', statements: past.map((a) => ({ text: `${a.vacancyTitle}: ${a.what}`, sources: [rsrc(a)], tone: 'critical' as const })),
      empty: 'No recorded next action is past its deadline.' },
    { heading: 'Missing information', statements: missing, empty: 'No active vacancy is missing key information.' },
  ]);
}

// 4 ── Reminder drafts for overdue items (never sent automatically)
export async function reminderDrafts(user: AuthUser, db: Db = pool): Promise<Insight> {
  const alerts = await computeAlerts({}, db);
  const users = await rows<any>(db, 'SELECT name, email FROM users WHERE is_active');
  const vacs = await listVacancies({}, undefined, db);
  const emailOf = (name: string | null, v?: any) => {
    if (!name) return null;
    const u = users.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (u) return u.email as string;
    return v && v.hiringManager?.toLowerCase() === name.toLowerCase() ? v.hiringManagerEmail ?? null : null;
  };
  const sign = `Thank you,\n${user.name}`;
  const drafts: Draft[] = [];
  for (const a of alerts) {
    const v = vacs.find((x) => x.id === a.vacancyId);
    if (a.rule === 'action_overdue' || a.rule === 'next_action_overdue') {
      const what = a.what.replace(/\.$/, '');
      drafts.push({
        to: a.responsible, toEmail: emailOf(a.responsible, v),
        subject: `Reminder: overdue recruitment action${a.vacancyTitle ? ` — ${a.vacancyTitle}` : ''}`,
        body: `Hi ${firstName(a.responsible)},\n\nA quick reminder about an overdue item${a.vacancyTitle ? ` on the ${a.vacancyTitle} vacancy` : ''}:\n\n${what}.\n\nCould you complete it, or let me know a realistic new date so I can update the tracker? If it is already done, a one-line reply is enough.\n\n${sign}`,
        sources: [rsrc(a)],
      });
    } else if (a.rule === 'decision_outstanding') {
      drafts.push({
        to: a.responsible, toEmail: emailOf(a.responsible, v),
        subject: `Feedback needed${a.vacancyTitle ? ` — ${a.vacancyTitle}` : ''}`,
        body: `Hi ${firstName(a.responsible)},\n\nWe are waiting for your feedback${a.vacancyTitle ? ` on the ${a.vacancyTitle} vacancy` : ''} and cannot move forward without it:\n\n${a.what}\n\nCould you share your decision or a date by which we can expect it?\n\n${sign}`,
        sources: [rsrc(a)],
      });
    } else if (a.rule === 'stale_update' && a.recruiter && a.recruiter !== user.name) {
      drafts.push({
        to: a.recruiter, toEmail: emailOf(a.recruiter),
        subject: `Please update the tracker — ${a.vacancyTitle}`,
        body: `Hi ${firstName(a.recruiter)},\n\n${a.vacancyTitle}: ${a.what}\n\nCould you add a short progress update in Talent Radar (one sentence is fine, even if nothing has changed) and confirm the next action and deadline?\n\n${sign}`,
        sources: [rsrc(a)],
      });
    }
  }
  return make('reminders', 'Draft reminders for overdue items', 'Rule-based alerts for overdue actions, outstanding decisions and records without a recent update. Drafts are never sent automatically.',
    [{ heading: 'Drafts', statements: drafts.map((d) => ({ text: `${d.to}: ${d.subject}`, sources: d.sources })), empty: 'Nothing is overdue, so there is nothing to chase.' }], drafts);
}

// 5 ── Recurring bottlenecks
const THEMES: [string, RegExp][] = [
  ['Budget or headcount approval', /budget|headcount|approval|approve|sign[- ]?off|finance/i],
  ['Hiring manager feedback or availability', /feedback|decision|availab|respon|calendar|unavailable|no reply/i],
  ['Compensation or offer terms', /salary|compensation|offer|package|counter[- ]?offer|expectation/i],
  ['Candidate pipeline', /pipeline|candidates|sourcing|talent pool|market|applicants/i],
  ['Role definition', /requirement|job description|profile|scope|re-?scop/i],
  ['Relocation, visa or legal', /visa|relocat|work permit|legal|contract/i],
];
export async function bottlenecks(db: Db = pool): Promise<Insight> {
  const vacs = await listVacancies({}, undefined, db);
  const byId = new Map(vacs.map((v) => [v.id, v]));
  const ids = vacs.map((v) => v.id);
  const [ms, ups, acts] = await Promise.all([
    rows<any>(db, 'SELECT * FROM vacancy_milestones WHERE vacancy_id = ANY($1) ORDER BY vacancy_id, position', [ids]),
    rows<any>(db, `SELECT vu.*, u.name AS user_name FROM vacancy_updates vu LEFT JOIN users u ON u.id = vu.user_id WHERE vu.vacancy_id = ANY($1) ORDER BY vu.created_at`, [ids]),
    rows<any>(db, `SELECT a.*, u.name AS assignee FROM actions a LEFT JOIN users u ON u.id = a.assignee_id WHERE a.status IN ('open','in_progress','waiting_feedback')`),
  ]);

  // (a) Time spent at each milestone, from the recorded "reached" and "moved on" dates.
  const dur = new Map<string, { days: number; v: any; m: any }[]>();
  for (const m of ms) {
    if (m.status !== 'completed' || !m.startedDate || !m.completedDate || m.completedDate < m.startedDate) continue;
    if (!dur.has(m.name)) dur.set(m.name, []);
    dur.get(m.name)!.push({ days: diffDays(m.startedDate, m.completedDate), v: byId.get(m.vacancyId), m });
  }
  const slow: Statement[] = [...dur.entries()].filter(([, d]) => d.length >= 2)
    .map(([name, d]) => ({ name, d, avg: Math.round(d.reduce((s, x) => s + x.days, 0) / d.length), max: d.reduce((a, b) => (b.days > a.days ? b : a)) }))
    .sort((a, b) => b.avg - a.avg).slice(0, 5)
    .map((x) => ({ text: `Vacancies spent ${plural(x.avg, 'day')} on average at “${x.name}” (${plural(x.d.length, 'vacancy', 'vacancies')}; longest: ${x.max.v.title}, ${plural(x.max.days, 'day')}).`,
      sources: x.d.map((e) => ({ type: 'milestone' as const, id: e.m.id, vacancyId: e.v.id, label: `“${x.name}” on ${e.v.title}: reached ${fmtDate(e.m.startedDate)}, moved on ${fmtDate(e.m.completedDate)} (${plural(e.days, 'day')})` })) }));
  for (const v of vacs.filter((x) => x.statusCategory === 'active' && (x.daysInStage ?? 0) >= 14).sort((a, b) => b.daysInStage - a.daysInStage).slice(0, 4)) {
    slow.push({ text: `${v.title} has now been at “${v.currentStage}” for ${plural(v.daysInStage, 'day')}.`, sources: [vsrc(v, 'current milestone and the date it was reached')], tone: 'warning' });
  }

  // (b) Where vacancies that are not on track currently sit.
  const off = vacs.filter((v) => v.statusCategory === 'active' && v.health !== 'on_track');
  const stages = new Map<string, any[]>();
  for (const v of off) stages.set(v.currentStage ?? 'No stage', [...(stages.get(v.currentStage ?? 'No stage') ?? []), v]);
  const waiting: Statement[] = [...stages.entries()].sort((a, b) => b[1].length - a[1].length)
    .map(([stage, vs]) => ({ text: `${vs.length} of ${off.length} vacancies that are not on track are at “${stage}”: ${list(vs.map((v) => v.title))}.`,
      sources: vs.map((v) => vsrc(v, 'health and current stage')), tone: 'warning' as const }));

  // (c) Feedback waits, counted from recorded updates and open actions.
  const fb = ups.filter((u) => u.health === 'awaiting_feedback');
  const feedback: Statement[] = [];
  if (fb.length) {
    const vs = [...new Set(fb.map((u) => u.vacancyId))].map((id) => byId.get(id)!);
    const hms = [...new Set(vs.map((v) => v.hiringManager).filter(Boolean))];
    feedback.push({ text: `“Awaiting feedback” was recorded in ${plural(fb.length, 'progress update')} across ${plural(vs.length, 'vacancy', 'vacancies')}${hms.length ? `; hiring managers on those vacancies: ${list(hms as string[])}` : ''}.`,
      sources: fb.slice(-8).map((u) => usrc(u, byId.get(u.vacancyId)?.title)), tone: 'warning' });
  }
  const wf = acts.filter((a) => a.status === 'waiting_feedback');
  const who = new Map<string, any[]>();
  for (const a of wf) who.set(a.waitingOn ?? 'not specified', [...(who.get(a.waitingOn ?? 'not specified') ?? []), a]);
  for (const [name, as] of who) feedback.push({ text: `${plural(as.length, 'open action is', 'open actions are')} waiting for ${name}: ${list(as.map((a) => a.title))}.`, sources: as.map(asrc), tone: 'warning' });

  // (d) Blocker themes by keyword match over recorded blocker text.
  const texts = new Map<number, string>();
  for (const u of ups) if (u.blocker) texts.set(u.vacancyId, `${texts.get(u.vacancyId) ?? ''} ${u.blocker}`);
  for (const v of vacs) if (v.currentBlocker) texts.set(v.id, `${texts.get(v.id) ?? ''} ${v.currentBlocker}`);
  const themes: Statement[] = THEMES.map(([label, re]) => ({ label, vs: [...texts.entries()].filter(([, t]) => re.test(t)).map(([id]) => byId.get(id)!) }))
    .filter((x) => x.vs.length >= 2).sort((a, b) => b.vs.length - a.vs.length)
    .map((x) => ({ text: `“${x.label}” appears in recorded blockers on ${x.vs.length} vacancies: ${list(x.vs.map((v) => v.title))}.`, sources: x.vs.map((v) => vsrc(v, 'blocker text (keyword match)')), tone: 'warning' as const }));

  return make('bottlenecks', 'Recurring recruitment bottlenecks', 'Milestone completion dates, health recorded in progress updates, blocker text and open actions. Counts only — no prediction.', [
    { heading: 'Where time is being spent', statements: slow, empty: 'Not enough completed milestones with dates yet (at least two vacancies per milestone are needed).' },
    { heading: 'Where off-track vacancies are sitting', statements: waiting, empty: 'All active vacancies are on track.' },
    { heading: 'Waiting for feedback', statements: feedback, empty: 'No feedback waits have been recorded.' },
    { heading: 'Recurring blocker themes', statements: themes, empty: 'No blocker theme appears on two or more vacancies.' },
  ]);
}

// 6 ── Suggested next actions
export async function suggestions(db: Db = pool): Promise<Insight> {
  const alerts = await computeAlerts({}, db);
  const vacs = await listVacancies({ overall: 'open_all' }, undefined, db);
  const ms = await rows<any>(db, 'SELECT * FROM vacancy_milestones WHERE vacancy_id = ANY($1) ORDER BY vacancy_id, position', [vacs.map((v) => v.id)]);
  const out: Statement[] = [];
  for (const v of vacs) {
    const mine = alerts.filter((a) => a.vacancyId === v.id);
    if (mine.length) {
      for (const a of mine.slice(0, 2)) {
        out.push({ text: `${v.title}: ${a.recommended} — because ${a.what.charAt(0).toLowerCase()}${a.what.slice(1)}`, sources: [rsrc(a)], tone: a.severity === 'high' ? 'critical' : 'warning' });
      }
      continue;
    }
    const plan = ms.filter((m) => m.vacancyId === v.id && m.status !== 'skipped');
    const i = plan.findIndex((m) => m.status === 'in_progress');
    const nxt = i >= 0 ? plan[i + 1] : plan.find((m) => m.status === 'pending');
    if (nxt) {
      out.push({ text: `${v.title}: confirm what is still needed to move from “${v.currentStage}” to “${nxt.name}”${nxt.plannedDate ? ` (planned for ${fmtDate(nxt.plannedDate)})` : ''} — because no rule-based alert is open and “${nxt.name}” is the next milestone in this vacancy's plan.`,
        sources: [{ type: 'milestone', id: nxt.id, vacancyId: v.id, label: `${v.title} — milestone plan` }] });
    }
  }
  return make('suggestions', 'Suggested next actions', 'Open rule-based alerts and each vacancy’s own milestone plan. Suggestions restate recorded facts; they do not predict outcomes.',
    [{ heading: 'By vacancy', statements: out, empty: 'No open vacancies to suggest actions for.' }]);
}

// 7 ── Leadership brief in business language
export async function leadershipBrief(db: Db = pool): Promise<Insight> {
  const r = await buildWeeklyReport(db);
  const h = await history(db);
  const k = r.kpis;
  const alerts = await computeAlerts(r.meta.teamId ? { taTeamId: r.meta.teamId } : {}, db);
  const act = r.vacancies.filter((v) => v.statusCategory === 'active');
  const sec: Section[] = [];

  const overall: Statement[] = [{
    text: `${r.meta.team} currently carries ${plural(k.active, 'active vacancy', 'active vacancies')}. ${k.onTrack} ${k.onTrack === 1 ? 'is' : 'are'} progressing as planned; ${k.needsAttention + k.awaitingFeedback + k.blocked} ${k.needsAttention + k.awaitingFeedback + k.blocked === 1 ? 'requires' : 'require'} follow-up (${k.blocked} blocked, ${k.awaitingFeedback} awaiting feedback, ${k.needsAttention} needing attention).`,
    sources: [rep('Current vacancy status counts')] }];
  if (k.hired || k.onHold) overall.push({ text: `${plural(k.hired, 'hire has', 'hires have')} been completed and ${plural(k.onHold, 'vacancy is', 'vacancies are')} on hold.`, sources: [rep('Current vacancy status counts')] });
  const prev = h.series.length > 1 ? h.series[h.series.length - 2] : null;
  if (prev) {
    const d = (label: string, a: number, b: number) => (a === b ? null : `${label} went from ${a} to ${b}`);
    const moves = [d('on-track vacancies', prev.kpis.onTrack, k.onTrack), d('blocked vacancies', prev.kpis.blocked, k.blocked),
      d('overdue actions', prev.kpis.overdueActions, k.overdueActions), d('completed hires', prev.kpis.hired, k.hired)].filter(Boolean) as string[];
    overall.push({ text: moves.length ? `Compared with the previous saved report (week of ${fmtDate(prev.weekStart)}): ${moves.join('; ')}.` : `The headline numbers are unchanged from the previous saved report (week of ${fmtDate(prev.weekStart)}).`,
      sources: [rep(`Saved weekly report for the week starting ${fmtDate(prev.weekStart)}`), rep('Current vacancy status counts')] });
  }
  sec.push({ heading: 'Overall position', statements: overall });

  const moved = r.changes.filter((c) => c.type === 'Stage');
  const progress: Statement[] = [{
    text: `This week the team recorded ${plural(r.activity.updates.length, 'progress update')}, completed ${plural(r.activity.actionsCompleted.length, 'action')} and closed ${plural(r.activity.milestonesCompleted.length, 'milestone')}.`,
    sources: [rep(`Activity recorded between ${fmtDate(r.meta.weekStart)} and ${fmtDate(r.meta.weekEnd)}`)] }];
  if (moved.length) progress.push({ text: `${plural(moved.length, 'vacancy', 'vacancies')} moved forward a stage: ${list(moved.map((c) => `${c.title} (now “${c.to}”)`))}.`, tone: 'positive',
    sources: moved.map((c) => ({ type: 'vacancy' as const, vacancyId: c.vacancyId, label: `${c.title} — stage change since previous report` })) });
  const stuck = h.stagnation.filter((s) => s.weeksInStage >= 3 && s.overall.key !== 'on_hold');
  if (stuck.length) progress.push({ text: `${plural(stuck.length, 'vacancy has', 'vacancies have')} stayed in the same stage for three or more weekly reports: ${list(stuck.map((s) => `${s.title} (“${s.stage}”, ${s.weeksInStage} weeks)`))}.`, tone: 'warning',
    sources: stuck.map((s) => ({ type: 'report' as const, vacancyId: s.vacancyId, label: `${s.title} — stage recorded in the last ${s.weeksInStage} saved weekly reports` })) });
  sec.push({ heading: 'Progress and momentum', statements: progress });

  const need: Statement[] = [];
  for (const a of alerts.filter((x) => ['blocked', 'behind_timeline', 'next_action_overdue'].includes(x.rule))) {
    need.push({ text: `${a.vacancyTitle} (${a.recruiter ?? 'unassigned'}) — ${a.what} Recommended: ${a.recommended}`, sources: [rsrc(a)], tone: 'critical' });
  }
  sec.push({ heading: 'Where leadership attention is needed', statements: need, empty: 'No vacancy is blocked, behind its agreed timeline or carrying an overdue next action.' });
  sec.push({ heading: 'Support requested by the team', empty: 'No support requests are recorded.',
    statements: r.supportRequired.map((s) => ({ text: `${s.title} (${s.recruiter ?? 'unassigned'}): ${s.supportRequired}`, sources: [{ type: 'vacancy' as const, vacancyId: s.vacancyId, label: `${s.title} — support required` }], tone: 'warning' as const })) });

  const stale = act.filter((v) => (daysSince(v.lastUpdateAt) ?? 999) >= 7);
  const outlook: Statement[] = r.upcomingDeadlines.slice(0, 6).map((u) => ({ text: `${fmtDate(u.date)}: ${u.kind === 'Target hiring date' ? u.what : `${u.what} (${u.title ?? 'general'})`}${u.owner ? ` — ${u.owner}` : ''}.`,
    sources: [u.actionId ? { type: 'action' as const, id: u.actionId, vacancyId: u.vacancyId, label: `Action #${u.actionId}` } : { type: 'vacancy' as const, vacancyId: u.vacancyId, label: `${u.title} — ${u.kind.toLowerCase()}` }] }));
  if (stale.length) outlook.push({ text: `Reporting confidence: ${plural(stale.length, 'active vacancy has', 'active vacancies have')} not been updated for a week or more (${list(stale.map((v) => v.title))}), so their status above may be out of date.`, tone: 'warning',
    sources: stale.map((v) => vsrc(v, 'last update date')) });
  sec.push({ heading: 'Outlook', statements: outlook, empty: 'No deadlines fall in the coming period.' });

  return make('leadership_brief', `Leadership brief — ${r.meta.team}`, 'The live weekly report, saved weekly snapshots and rule-based alerts.', sec);
}

// ───────────── Optional LLM re-wording (provider-neutral, off by default) ─────────────
export const aiStatus = () => {
  const c = config.ai;
  const configured = c.provider === 'openai_compatible' && !!c.baseUrl && !!c.model;
  return { provider: c.provider, configured, model: configured ? c.model : null,
    description: configured ? `Optional re-wording by ${c.model} via the company-approved endpoint` : 'Built-in engine only — no external AI service is used' };
};

const SYSTEM_PROMPT = `You rewrite recruitment status facts for senior leaders.
Rules:
- Use ONLY the numbered facts provided. Do not add facts, names, numbers, dates, causes or predictions.
- Keep every figure and name exactly as given.
- After each sentence, cite the fact numbers it is based on in square brackets, e.g. [3] or [2][5].
- Write clear, plain business English in short paragraphs. No headings, no bullet points, no greetings.
- If the facts do not cover something, leave it out.`;

/** Asks the configured LLM to re-word an insight. The result is rejected unless every figure appears in the source facts. */
export async function polish(insight: Insight): Promise<Insight> {
  const st = aiStatus();
  if (!st.configured) return insight;
  const facts: string[] = [];
  for (const s of insight.sections) for (const x of s.statements) facts.push(`[${facts.length + 1}] (${s.heading}) ${x.text}`);
  if (!facts.length) return insight;
  const note = (msg: string): Insight => ({ ...insight, llm: { model: config.ai.model, note: msg } });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.ai.apiKey) headers[config.ai.apiKeyHeader] = config.ai.apiKeyHeader.toLowerCase() === 'authorization' ? `Bearer ${config.ai.apiKey}` : config.ai.apiKey;
    const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
      method: 'POST', headers, signal: AbortSignal.timeout(config.ai.timeoutMs),
      body: JSON.stringify({ model: config.ai.model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: `${insight.title}\n\nFacts:\n${facts.join('\n')}` }] }),
    });
    if (!res.ok) return note(`The AI service returned HTTP ${res.status}; showing the built-in summary.`);
    const text: string = (await res.json())?.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) return note('The AI service returned no text; showing the built-in summary.');
    // Traceability guard: citations must exist, and no figure may appear that is not in the facts.
    const cited = [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    if (!cited.length || cited.some((n) => n < 1 || n > facts.length)) return note('The AI wording did not cite the recorded facts correctly, so it was discarded.');
    const known = new Set(facts.join(' ').replace(/^\[\d+\]/gm, '').match(/\d+/g) ?? []);
    const unknown = (text.replace(/\[\d+\]/g, '').match(/\d+/g) ?? []).filter((n) => !known.has(n));
    if (unknown.length) return note(`The AI wording contained figures that are not in the recorded facts (${[...new Set(unknown)].join(', ')}), so it was discarded.`);
    return { ...insight, narrative: text, llm: { model: config.ai.model } };
  } catch (err) {
    return note(`The AI service could not be reached (${(err as Error).message}); showing the built-in summary.`);
  }
}
