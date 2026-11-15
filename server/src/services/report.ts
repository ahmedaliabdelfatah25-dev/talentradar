import fs from 'node:fs';
import PDFDocument from 'pdfkit';
import { one, pool, rows, type Db } from '../db.js';
import { getSetting } from '../settings.js';
import { addDays, dateOf, daysSince, diffDays, fmtDate, HEALTH, OPEN_ACTION_STATUSES, toCsv, today, TZ, weekRange } from '../util.js';
import { computeAlerts } from './risks.js';
import { listVacancies } from './vacancies.js';

export interface ReportData {
  meta: { team: string; teamId: number | null; weekStart: string; weekEnd: string; generatedAt: string; previousWeekStart: string | null; containsDemoData: boolean };
  kpis: Record<string, number>;
  vacancies: any[];
  changes: { vacancyId: number; title: string; type: string; from: string | null; to: string | null }[];
  unchangedCount: number;
  workload: any[];
  activity: { updates: any[]; actionsCompleted: any[]; milestonesCompleted: any[] };
  outstandingActions: any[];
  overdueMilestones: any[];
  blockers: any[];
  supportRequired: any[];
  upcomingDeadlines: any[];
  alertCounts: { rule: string; label: string; severity: string; count: number }[];
}

export async function primaryTeam(db: Db = pool): Promise<{ id: number | null; name: string }> {
  const general = await getSetting('general', db);
  const t = await one<any>(db, 'SELECT id, name FROM ta_teams WHERE lower(name) = lower($1)', [general.primaryTeam])
    ?? await one<any>(db, 'SELECT id, name FROM ta_teams ORDER BY sort_order, id LIMIT 1');
  return t ?? { id: null, name: general.primaryTeam };
}

export function computeKpis(vacancies: any[], extra: { overdueActions: number; upcomingDeadlines: number; stale: number }) {
  const active = vacancies.filter((v) => v.statusCategory === 'active');
  const h = (k: string) => active.filter((v) => v.health === k).length;
  return {
    active: active.length, onTrack: h('on_track'), needsAttention: h('needs_attention'), awaitingFeedback: h('awaiting_feedback'),
    blocked: h('blocked'), onHold: vacancies.filter((v) => v.statusCategory === 'on_hold').length,
    hired: vacancies.filter((v) => v.statusCategory === 'filled').length,
    cancelled: vacancies.filter((v) => v.statusCategory === 'cancelled').length,
    overdueActions: extra.overdueActions, upcomingDeadlines: extra.upcomingDeadlines, staleVacancies: extra.stale,
  };
}

/** Everything a leader needs for the week, computed from the same tables the application itself uses. */
export async function buildWeeklyReport(db: Db = pool, opts: { weekStart?: string; teamId?: number | null } = {}): Promise<ReportData> {
  const cfg = await getSetting('report', db);
  const team = await primaryTeam(db);
  const teamId = opts.teamId === undefined ? team.id : opts.teamId;
  const t = today();
  const week = opts.weekStart ? { start: opts.weekStart, end: addDays(opts.weekStart, 6) } : weekRange(t, cfg.weekStartsOn);
  const horizon = addDays(t, cfg.upcomingDays);
  const teamFilter = teamId ? { taTeamId: teamId } : {};

  const vacs = await listVacancies(teamFilter, undefined, db);
  const ids = vacs.map((v) => v.id);
  const byId = new Map(vacs.map((v) => [v.id, v]));
  const inWeek = `(%s AT TIME ZONE '${TZ}')::date BETWEEN $2 AND $3`;
  const [updates, actions, milestones, alerts, prev] = await Promise.all([
    rows<any>(db, `SELECT vu.id, vu.vacancy_id, vu.created_at, vu.summary, vu.stage, vu.health, u.name AS user_name
                     FROM vacancy_updates vu LEFT JOIN users u ON u.id = vu.user_id
                    WHERE vu.vacancy_id = ANY($1) AND ${inWeek.replace('%s', 'vu.created_at')} ORDER BY vu.created_at DESC`, [ids, week.start, week.end]),
    rows<any>(db, `SELECT a.*, u.name AS assignee FROM actions a LEFT JOIN users u ON u.id = a.assignee_id
                    WHERE (a.vacancy_id = ANY($1) OR a.vacancy_id IS NULL) ORDER BY a.due_date NULLS LAST, a.id`, [ids]),
    rows<any>(db, `SELECT * FROM vacancy_milestones WHERE vacancy_id = ANY($1) ORDER BY vacancy_id, position`, [ids]),
    computeAlerts(teamFilter, db),
    one<any>(db, 'SELECT week_start, data FROM report_snapshots WHERE week_start < $1 ORDER BY week_start DESC LIMIT 1', [week.start]),
  ]);
  const title = (id: number | null) => (id ? byId.get(id)?.title ?? null : null);
  const open = actions.filter((a) => OPEN_ACTION_STATUSES.includes(a.status));

  const upcoming: any[] = [];
  for (const v of vacs.filter((x) => ['active', 'on_hold'].includes(x.statusCategory))) {
    if (v.actionDeadline && v.actionDeadline >= t && v.actionDeadline <= horizon) {
      upcoming.push({ date: v.actionDeadline, kind: 'Next action', what: v.nextAction ?? 'Next action', owner: v.actionOwner ?? v.recruiter, vacancyId: v.id, title: v.title });
    }
    if (v.targetHireDate && v.targetHireDate >= t && v.targetHireDate <= horizon) {
      upcoming.push({ date: v.targetHireDate, kind: 'Target hiring date', what: `Target hiring date for ${v.title}`, owner: v.recruiter, vacancyId: v.id, title: v.title });
    }
  }
  for (const a of open) {
    if (a.dueDate && a.dueDate >= t && a.dueDate <= horizon) {
      upcoming.push({ date: a.dueDate, kind: 'Action', what: a.title, owner: a.assignee, vacancyId: a.vacancyId, title: title(a.vacancyId), actionId: a.id });
    }
  }
  upcoming.sort((a, b) => a.date.localeCompare(b.date));

  const slim = vacs.map((v) => ({
    id: v.id, title: v.title, country: v.country, city: v.city, department: v.department, recruiter: v.recruiter,
    hiringManager: v.hiringManager, stage: v.currentStage, status: v.status, statusCategory: v.statusCategory, health: v.health,
    overall: v.overall, priority: v.priority, lastUpdateAt: v.lastUpdateAt, progressUpdate: v.progressUpdate, nextAction: v.nextAction,
    actionOwner: v.actionOwner, actionDeadline: v.actionDeadline, blocker: v.currentBlocker, supportRequired: v.supportRequired,
    openingDate: v.openingDate, targetHireDate: v.targetHireDate, closureDate: v.closureDate,
    milestonesDone: v.milestonesDone, milestonesTotal: v.milestonesTotal, daysInStage: v.daysInStage ?? null, isDemo: v.isDemo, greenhouseJobId: v.greenhouseJobId,
  }));

  // Changes since the previous saved report (compared record by record).
  const changes: ReportData['changes'] = [];
  let unchanged = 0;
  if (prev) {
    const before = new Map<number, any>((prev.data.vacancies ?? []).map((v: any) => [v.id, v]));
    for (const v of slim) {
      const b = before.get(v.id);
      if (!b) { changes.push({ vacancyId: v.id, title: v.title, type: 'New vacancy', from: null, to: v.stage }); continue; }
      const n = changes.length;
      if (b.overall?.key !== v.overall.key) changes.push({ vacancyId: v.id, title: v.title, type: 'Status', from: b.overall?.label ?? null, to: v.overall.label });
      if ((b.stage ?? null) !== (v.stage ?? null)) changes.push({ vacancyId: v.id, title: v.title, type: 'Stage', from: b.stage ?? null, to: v.stage ?? null });
      if (changes.length === n && ['active', 'on_hold'].includes(v.statusCategory)) unchanged += 1;
    }
    for (const b of before.values()) if (!byId.has(b.id)) changes.push({ vacancyId: b.id, title: b.title, type: 'Removed from tracker', from: b.stage ?? null, to: null });
  }

  const recruiters = [...new Set(vacs.map((v) => v.recruiter ?? 'Unassigned'))].sort();
  const workload = recruiters.map((r) => {
    const mine = vacs.filter((v) => (v.recruiter ?? 'Unassigned') === r);
    const act = mine.filter((v) => v.statusCategory === 'active');
    const mineIds = new Set(mine.map((v) => v.id));
    const myOpen = open.filter((a) => (a.assignee ?? 'Unassigned') === r || (a.vacancyId && mineIds.has(a.vacancyId) && !a.assignee));
    return {
      recruiter: r, active: act.length, onTrack: act.filter((v) => v.health === 'on_track').length,
      needsAttention: act.filter((v) => ['needs_attention', 'awaiting_feedback'].includes(v.health)).length,
      blocked: act.filter((v) => v.health === 'blocked').length,
      onHold: mine.filter((v) => v.statusCategory === 'on_hold').length,
      hired: mine.filter((v) => v.statusCategory === 'filled').length,
      openActions: myOpen.length, overdueActions: myOpen.filter((a) => a.dueDate && a.dueDate < t).length,
      updatesThisWeek: updates.filter((u) => mineIds.has(u.vacancyId)).length,
    };
  });

  const stale = alerts.filter((a) => a.rule === 'stale_update').length;
  const ruleCounts = new Map<string, { rule: string; label: string; severity: string; count: number }>();
  for (const a of alerts) {
    const c = ruleCounts.get(a.rule) ?? { rule: a.rule, label: a.ruleLabel, severity: a.severity, count: 0 };
    c.count += 1;
    ruleCounts.set(a.rule, c);
  }
  const activeIds = new Set(vacs.filter((v) => v.statusCategory === 'active').map((v) => v.id));

  return {
    meta: { team: teamId ? team.name : 'All TA teams', teamId: teamId ?? null, weekStart: week.start, weekEnd: week.end,
      generatedAt: new Date().toISOString(), previousWeekStart: prev?.weekStart ?? null, containsDemoData: vacs.some((v) => v.isDemo) },
    kpis: computeKpis(vacs, { overdueActions: open.filter((a) => a.dueDate && a.dueDate < t).length, upcomingDeadlines: upcoming.length, stale }),
    vacancies: slim,
    changes, unchangedCount: unchanged,
    workload,
    activity: {
      updates: updates.map((u) => ({ id: u.id, vacancyId: u.vacancyId, title: title(u.vacancyId), at: u.createdAt, user: u.userName, summary: u.summary, stage: u.stage })),
      actionsCompleted: actions.filter((a) => a.status === 'completed' && a.completedAt && dateOf(a.completedAt) >= week.start && dateOf(a.completedAt) <= week.end)
        .map((a) => ({ id: a.id, title: a.title, vacancyId: a.vacancyId, vacancyTitle: title(a.vacancyId), assignee: a.assignee, completedAt: a.completedAt })),
      milestonesCompleted: milestones.filter((m) => m.status === 'completed' && m.completedDate >= week.start && m.completedDate <= week.end)
        .map((m) => ({ id: m.id, name: m.name, vacancyId: m.vacancyId, title: title(m.vacancyId), completedDate: m.completedDate })),
    },
    outstandingActions: open.map((a) => ({ id: a.id, title: a.title, vacancyId: a.vacancyId, vacancyTitle: title(a.vacancyId), assignee: a.assignee,
      waitingOn: a.waitingOn, dueDate: a.dueDate, priority: a.priority, status: a.status, overdue: !!a.dueDate && a.dueDate < t })),
    overdueMilestones: milestones.filter((m) => activeIds.has(m.vacancyId) && m.status === 'pending' && m.plannedDate && m.plannedDate < t)
      .map((m) => ({ id: m.id, name: m.name, vacancyId: m.vacancyId, title: title(m.vacancyId), plannedDate: m.plannedDate,
        daysLate: diffDays(m.plannedDate, t), recruiter: byId.get(m.vacancyId)?.recruiter ?? null })),
    blockers: slim.filter((v) => ['active', 'on_hold'].includes(v.statusCategory) && (v.health === 'blocked' || v.blocker))
      .map((v) => ({ vacancyId: v.id, title: v.title, recruiter: v.recruiter, blocker: v.blocker, health: v.health, overall: v.overall, lastUpdateAt: v.lastUpdateAt })),
    supportRequired: slim.filter((v) => ['active', 'on_hold'].includes(v.statusCategory) && v.supportRequired)
      .map((v) => ({ vacancyId: v.id, title: v.title, recruiter: v.recruiter, supportRequired: v.supportRequired, hiringManager: v.hiringManager })),
    upcomingDeadlines: upcoming,
    alertCounts: [...ruleCounts.values()],
  };
}

export async function saveSnapshot(db: Db, userId: number | null, kind: 'manual' | 'auto' | 'demo', data?: ReportData) {
  const report = data ?? (await buildWeeklyReport(db));
  const row = await one<{ id: number }>(db,
    `INSERT INTO report_snapshots (week_start, week_end, generated_by, kind, data) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (week_start) DO UPDATE SET data = EXCLUDED.data, generated_at = now(), generated_by = EXCLUDED.generated_by, kind = EXCLUDED.kind
     RETURNING id`,
    [report.meta.weekStart, report.meta.weekEnd, userId, kind, JSON.stringify(report)]);
  return { id: row!.id, report };
}

/** KPI series across saved weeks, plus how long each open vacancy has sat in its current stage. */
export async function history(db: Db = pool) {
  const snaps = await rows<any>(db, 'SELECT id, week_start, week_end, generated_at, kind, data FROM report_snapshots ORDER BY week_start');
  const live = await buildWeeklyReport(db);
  const series = snaps.filter((s) => s.weekStart < live.meta.weekStart).map((s) => ({
    id: s.id, weekStart: s.weekStart, weekEnd: s.weekEnd, kind: s.kind, kpis: s.data.kpis,
    updates: s.data.activity?.updates?.length ?? 0, actionsCompleted: s.data.activity?.actionsCompleted?.length ?? 0,
    stageChanges: (s.data.changes ?? []).filter((c: any) => c.type === 'Stage').length,
  }));
  series.push({ id: null as any, weekStart: live.meta.weekStart, weekEnd: live.meta.weekEnd, kind: 'live', kpis: live.kpis,
    updates: live.activity.updates.length, actionsCompleted: live.activity.actionsCompleted.length,
    stageChanges: live.changes.filter((c) => c.type === 'Stage').length });

  const past = snaps.filter((s) => s.weekStart < live.meta.weekStart).reverse();
  const stagnation = live.vacancies.filter((v) => ['active', 'on_hold'].includes(v.statusCategory)).map((v) => {
    let weeks = 0;
    let since: string | null = null;
    for (const s of past) {
      const b = (s.data.vacancies ?? []).find((x: any) => x.id === v.id);
      if (!b || (b.stage ?? null) !== (v.stage ?? null)) break;
      weeks += 1;
      since = s.weekStart;
    }
    const trail = [...past].reverse().map((s) => (s.data.vacancies ?? []).find((x: any) => x.id === v.id)?.stage ?? null);
    return { vacancyId: v.id, title: v.title, recruiter: v.recruiter, stage: v.stage, overall: v.overall, weeksInStage: weeks,
      inStageSince: since, daysSinceUpdate: daysSince(v.lastUpdateAt), trail: [...trail, v.stage] };
  }).sort((a, b) => b.weeksInStage - a.weeksInStage);
  return { series, stagnation, snapshotCount: snaps.length };
}

// ───────────── CSV ─────────────
export function reportCsv(r: ReportData): string {
  const head = ['Section', 'Vacancy', 'Country', 'Department', 'Recruiter', 'Hiring manager', 'Stage', 'Status', 'Last update',
    'Detail', 'Owner', 'Date'];
  const out: unknown[][] = [];
  const d = (v: any) => (v ? String(v).slice(0, 10) : '');
  for (const v of r.vacancies) {
    out.push(['Portfolio', v.title, v.country, v.department, v.recruiter, v.hiringManager, v.stage, v.overall.label, d(v.lastUpdateAt),
      v.nextAction ? `Next: ${v.nextAction}` : '', v.actionOwner, d(v.actionDeadline)]);
  }
  for (const c of r.changes) out.push(['Change since previous report', c.title, '', '', '', '', '', '', '', `${c.type}: ${c.from ?? '—'} → ${c.to ?? '—'}`, '', '']);
  for (const w of r.workload) {
    out.push(['Recruiter workload', '', '', '', w.recruiter, '', '', '', '',
      `Active ${w.active}; on track ${w.onTrack}; attention ${w.needsAttention}; blocked ${w.blocked}; on hold ${w.onHold}; open actions ${w.openActions}; overdue actions ${w.overdueActions}`, '', '']);
  }
  for (const u of r.activity.updates) out.push(['Activity: progress update', u.title, '', '', '', '', u.stage, '', d(dateOf(u.at)), u.summary, u.user, d(dateOf(u.at))]);
  for (const a of r.activity.actionsCompleted) out.push(['Activity: action completed', a.vacancyTitle, '', '', '', '', '', '', '', a.title, a.assignee, d(dateOf(a.completedAt))]);
  for (const m of r.activity.milestonesCompleted) out.push(['Activity: milestone completed', m.title, '', '', '', '', m.name, '', '', m.name, '', d(m.completedDate)]);
  for (const a of r.outstandingActions) out.push([a.overdue ? 'Outstanding action (overdue)' : 'Outstanding action', a.vacancyTitle, '', '', '', '', '', a.status, '', a.title, a.assignee, d(a.dueDate)]);
  for (const m of r.overdueMilestones) out.push(['Overdue milestone', m.title, '', '', m.recruiter, '', m.name, '', '', `${m.daysLate} days past planned date`, m.recruiter, d(m.plannedDate)]);
  for (const b of r.blockers) out.push(['Blocker', b.title, '', '', b.recruiter, '', '', b.overall.label, d(b.lastUpdateAt), b.blocker ?? 'No description recorded', b.recruiter, '']);
  for (const s of r.supportRequired) out.push(['Support required', s.title, '', '', s.recruiter, s.hiringManager, '', '', '', s.supportRequired, s.recruiter, '']);
  for (const u of r.upcomingDeadlines) out.push(['Upcoming deadline', u.title, '', '', '', '', '', '', '', `${u.kind}: ${u.what}`, u.owner, d(u.date)]);
  return toCsv(head, out);
}

// ───────────── PDF ─────────────
const FONT_CANDIDATES: [string, string][] = [
  [process.env.PDF_FONT_REGULAR ?? '', process.env.PDF_FONT_BOLD ?? ''],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf'],
  ['/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf', '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf'],
];
const unicodeFont = FONT_CANDIDATES.find(([r, b]) => r && b && fs.existsSync(r) && fs.existsSync(b));
/** The built-in PDF fonts only cover Latin-1; replace what they cannot draw. */
const latin = (s: string) => s.replace(/→/g, '->').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...')
  .replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ]/g, '?');

interface Col { head: string; width: number; get: (row: any) => unknown }

export function reportPdf(r: ReportData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 44, left: 40, right: 40 }, bufferPages: true,
      info: { Title: `Talent Radar weekly report ${r.meta.weekStart}`, Author: 'Talent Radar' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const REG = unicodeFont ? 'tr-regular' : 'Helvetica';
    const BOLD = unicodeFont ? 'tr-bold' : 'Helvetica-Bold';
    if (unicodeFont) { doc.registerFont(REG, unicodeFont[0]); doc.registerFont(BOLD, unicodeFont[1]); }
    const tx = (v: unknown) => { const s = v === null || v === undefined || v === '' ? '—' : String(v); return unicodeFont ? s : latin(s); };
    const W = doc.page.width - 80;
    const bottom = () => doc.page.height - 50;
    const INK = '#111418', MUTED = '#5b6470', RULE = '#d9dee5', BAND = '#f3f5f8';

    const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
    const h1 = (s: string) => { ensure(60); doc.moveDown(0.8).font(BOLD).fontSize(12.5).fillColor(INK).text(tx(s), 40); doc.moveDown(0.3); };
    const note = (s: string) => { doc.font(REG).fontSize(8.5).fillColor(MUTED).text(tx(s), 40, doc.y, { width: W }); doc.moveDown(0.3); };

    const table = (cols: Col[], data: any[], empty: string) => {
      if (!data.length) return note(empty);
      const scale = W / cols.reduce((s, c) => s + c.width, 0);
      const widths = cols.map((c) => c.width * scale);
      const pad = 4;
      const drawRow = (cells: string[], bold: boolean) => {
        doc.font(bold ? BOLD : REG).fontSize(bold ? 7.5 : 8);
        const heights = cells.map((c, i) => doc.heightOfString(c, { width: widths[i] - pad * 2 }));
        const h = Math.max(...heights) + pad * 2;
        if (doc.y + h > bottom()) { doc.addPage(); if (!bold) drawRow(cols.map((c) => c.head.toUpperCase()), true); doc.font(REG).fontSize(8); }
        const y = doc.y;
        if (bold) doc.rect(40, y, W, h).fill(BAND);
        let x = 40;
        cells.forEach((c, i) => {
          doc.fillColor(bold ? MUTED : INK).text(c, x + pad, y + pad, { width: widths[i] - pad * 2 });
          x += widths[i];
        });
        doc.moveTo(40, y + h).lineTo(40 + W, y + h).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.x = 40;
        doc.y = y + h;
      };
      drawRow(cols.map((c) => c.head.toUpperCase()), true);
      for (const row of data) drawRow(cols.map((c) => tx(c.get(row))), false);
      doc.moveDown(0.4);
    };

    // Header
    doc.font(BOLD).fontSize(18).fillColor(INK).text('Talent Radar — weekly recruitment report', 40, 40);
    doc.font(REG).fontSize(10).fillColor(MUTED)
      .text(tx(`${r.meta.team} · week ${fmtDate(r.meta.weekStart)} – ${fmtDate(r.meta.weekEnd)} · generated ${fmtDate(dateOf(r.meta.generatedAt))}`));
    if (r.meta.containsDemoData) {
      doc.moveDown(0.3).font(BOLD).fontSize(9).fillColor('#a04a00').text('DEMONSTRATION DATA — this report contains fictional records.');
    }
    doc.moveDown(0.8);

    // KPI row
    const k = r.kpis;
    const tiles: [string, number][] = [['Active', k.active], ['On track', k.onTrack], ['Needs attention', k.needsAttention],
      ['Awaiting feedback', k.awaitingFeedback], ['Blocked', k.blocked], ['On hold', k.onHold], ['Hired', k.hired],
      ['Overdue actions', k.overdueActions], ['Deadlines ahead', k.upcomingDeadlines]];
    const tw = W / tiles.length;
    const ty = doc.y;
    tiles.forEach(([label, value], i) => {
      const x = 40 + i * tw;
      doc.roundedRect(x + 2, ty, tw - 4, 44, 5).lineWidth(0.6).strokeColor(RULE).stroke();
      doc.font(BOLD).fontSize(17).fillColor(INK).text(String(value), x + 9, ty + 7, { width: tw - 16 });
      doc.font(REG).fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x + 9, ty + 29, { width: tw - 16 });
    });
    doc.x = 40;
    doc.y = ty + 52;

    h1(`Vacancies managed by ${r.meta.team}`);
    table([
      { head: 'Vacancy', width: 150, get: (v) => v.title }, { head: 'Location', width: 70, get: (v) => [v.city, v.country].filter(Boolean).join(', ') },
      { head: 'Recruiter', width: 75, get: (v) => v.recruiter }, { head: 'Hiring manager', width: 75, get: (v) => v.hiringManager },
      { head: 'Stage', width: 85, get: (v) => v.stage }, { head: 'Status', width: 70, get: (v) => v.overall.label },
      { head: 'Last update', width: 55, get: (v) => fmtDate(v.lastUpdateAt ? dateOf(v.lastUpdateAt) : null) },
      { head: 'Next action', width: 140, get: (v) => v.nextAction }, { head: 'Owner', width: 70, get: (v) => v.actionOwner },
      { head: 'Deadline', width: 55, get: (v) => fmtDate(v.actionDeadline) },
    ], r.vacancies, 'No vacancies recorded.');

    h1('Changes since the previous report');
    if (!r.meta.previousWeekStart) note('No earlier saved report exists to compare against.');
    else {
      note(`Compared with the report for the week starting ${fmtDate(r.meta.previousWeekStart)}. ${r.unchangedCount} open vacancies show no change in stage or status.`);
      table([{ head: 'Vacancy', width: 240, get: (c) => c.title }, { head: 'Change', width: 120, get: (c) => c.type },
        { head: 'From', width: 180, get: (c) => c.from }, { head: 'To', width: 180, get: (c) => c.to }], r.changes, 'No stage or status changes.');
    }

    h1('Recruiter workload');
    table([{ head: 'Recruiter', width: 160, get: (w) => w.recruiter }, { head: 'Active', width: 60, get: (w) => w.active },
      { head: 'On track', width: 60, get: (w) => w.onTrack }, { head: 'Attention', width: 60, get: (w) => w.needsAttention },
      { head: 'Blocked', width: 60, get: (w) => w.blocked }, { head: 'On hold', width: 60, get: (w) => w.onHold },
      { head: 'Hired', width: 60, get: (w) => w.hired }, { head: 'Open actions', width: 70, get: (w) => w.openActions },
      { head: 'Overdue actions', width: 80, get: (w) => w.overdueActions }, { head: 'Updates this week', width: 90, get: (w) => w.updatesThisWeek }],
    r.workload, 'No recruiters assigned.');

    h1('Activities completed this week');
    table([{ head: 'Date', width: 60, get: (u) => fmtDate(dateOf(u.at)) }, { head: 'Vacancy', width: 170, get: (u) => u.title },
      { head: 'Progress update', width: 400, get: (u) => u.summary }, { head: 'By', width: 90, get: (u) => u.user }],
    r.activity.updates, 'No progress updates were recorded this week.');
    table([{ head: 'Completed', width: 60, get: (a) => fmtDate(dateOf(a.completedAt)) }, { head: 'Action', width: 330, get: (a) => a.title },
      { head: 'Vacancy', width: 220, get: (a) => a.vacancyTitle }, { head: 'By', width: 110, get: (a) => a.assignee }],
    r.activity.actionsCompleted, 'No actions were completed this week.');
    table([{ head: 'Completed', width: 60, get: (m) => fmtDate(m.completedDate) }, { head: 'Milestone', width: 300, get: (m) => m.name },
      { head: 'Vacancy', width: 360, get: (m) => m.title }], r.activity.milestonesCompleted, 'No milestones were completed this week.');

    h1('Outstanding actions');
    table([{ head: 'Due', width: 60, get: (a) => fmtDate(a.dueDate) }, { head: 'Action', width: 290, get: (a) => (a.overdue ? `OVERDUE — ${a.title}` : a.title) },
      { head: 'Vacancy', width: 190, get: (a) => a.vacancyTitle }, { head: 'Assigned to', width: 100, get: (a) => a.assignee },
      { head: 'Waiting on', width: 100, get: (a) => a.waitingOn }], r.outstandingActions, 'No open actions.');

    h1('Overdue milestones');
    table([{ head: 'Planned', width: 60, get: (m) => fmtDate(m.plannedDate) }, { head: 'Milestone', width: 220, get: (m) => m.name },
      { head: 'Vacancy', width: 260, get: (m) => m.title }, { head: 'Days late', width: 60, get: (m) => m.daysLate },
      { head: 'Recruiter', width: 120, get: (m) => m.recruiter }], r.overdueMilestones, 'No milestones are past their planned date.');

    h1('Recruitment blockers');
    table([{ head: 'Vacancy', width: 220, get: (b) => b.title }, { head: 'Blocker', width: 380, get: (b) => b.blocker ?? 'Marked blocked — no description recorded' },
      { head: 'Recruiter', width: 120, get: (b) => b.recruiter }], r.blockers, 'No blockers recorded.');

    h1('Support required');
    table([{ head: 'Vacancy', width: 220, get: (s) => s.title }, { head: 'Support requested', width: 380, get: (s) => s.supportRequired },
      { head: 'Recruiter', width: 120, get: (s) => s.recruiter }], r.supportRequired, 'No support requests recorded.');

    h1('Important upcoming deadlines');
    table([{ head: 'Date', width: 60, get: (u) => fmtDate(u.date) }, { head: 'Type', width: 90, get: (u) => u.kind },
      { head: 'What', width: 300, get: (u) => u.what }, { head: 'Vacancy', width: 180, get: (u) => u.title },
      { head: 'Owner', width: 100, get: (u) => u.owner }], r.upcomingDeadlines, 'No deadlines in the coming period.');

    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font(REG).fontSize(7.5).fillColor(MUTED).text(
        tx(`Talent Radar · ${r.meta.team} · week of ${fmtDate(r.meta.weekStart)}${r.meta.containsDemoData ? ' · DEMONSTRATION DATA' : ''} · page ${i + 1} of ${range.count}`),
        40, doc.page.height - 34, { width: W, align: 'center', lineBreak: false });
    }
    doc.end();
  });
}

export const healthLabel = (k: string) => HEALTH[k as keyof typeof HEALTH] ?? k;
