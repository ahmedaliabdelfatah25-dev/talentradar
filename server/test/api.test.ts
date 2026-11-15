import http from 'node:http';
import type { AddressInfo } from 'node:net';
import ExcelJS from 'exceljs';
import * as jose from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { bootstrap } from '../src/bootstrap.js';
import { config } from '../src/config.js';
import { pool } from '../src/db.js';
import { runScheduledTasks } from '../src/scheduler.js';
import { DEMO_PASSWORD } from '../src/seed/demo.js';
import { HarvestV3Client } from '../src/services/greenhouse.js';
import { parseDate, suggestMapping } from '../src/services/importer.js';
import { addDays, csvEscape, today, weekRange } from '../src/util.js';

const app = createApp();
const email = (n: string) => `${n}@talentradar.example`;
const agents: Record<string, ReturnType<typeof request.agent>> = {};
async function login(name: string, password = DEMO_PASSWORD) {
  const a = request.agent(app);
  const r = await a.post('/api/auth/login').send({ email: email(name), password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return a;
}
const day = (n: number) => addDays(today(), n);

beforeAll(async () => {
  expect(config.databaseUrl).toContain('talentradar_test'); // never run against a real database
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await bootstrap(); // DEMO_DATA=true → migrations, reference data and the fictional demo dataset
  agents.leader = await login('dina.abdelrahman');
  agents.admin = await login('youssef.tarek');
  agents.nour = await login('nour.el.sayed');
  agents.laila = await login('laila.hassan');
  agents.viewer = await login('stefan.huber');
});
afterAll(async () => { await pool.end(); });

describe('authentication and permissions', () => {
  it('rejects unauthenticated and wrong-password access', async () => {
    expect((await request(app).get('/api/vacancies')).status).toBe(401);
    const bad = await request(app).post('/api/auth/login').send({ email: email('dina.abdelrahman'), password: 'wrong-password-1' });
    expect(bad.status).toBe(401);
  });
  it('returns the signed-in user with role permissions', async () => {
    const me = (await agents.nour.get('/api/auth/me')).body.user;
    expect(me.role).toBe('recruiter');
    expect(me.permissions).toContain('vacancies.edit_own');
    expect(me.permissions).not.toContain('vacancies.edit_all');
  });
  it('blocks cross-site state changes', async () => {
    const r = await agents.nour.post('/api/actions').set('Origin', 'https://evil.example').send({ title: 'x-site' });
    expect(r.status).toBe(403);
  });
  it('keeps viewers read-only and hides internal notes from them', async () => {
    expect((await agents.viewer.post('/api/vacancies').send({ title: 'Nope' })).status).toBe(403);
    const list = (await agents.viewer.get('/api/vacancies')).body;
    expect(list.length).toBe(10);
    expect(list.every((v: any) => !('internalNotes' in v))).toBe(true);
    expect((await agents.viewer.get('/api/admin/users')).status).toBe(403);
  });
  it('locks an account after repeated failed sign-ins', async () => {
    const created = await agents.admin.post('/api/admin/users').send({ email: 'lock.test@talentradar.example', name: 'Lock Test', role: 'viewer' });
    expect(created.status).toBe(201);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ email: 'lock.test@talentradar.example', password: 'bad-password-9' });
    const r = await request(app).post('/api/auth/login').send({ email: 'lock.test@talentradar.example', password: created.body.temporaryPassword });
    expect(r.status).toBe(423);
  });
});

describe('demo data and leadership overview', () => {
  it('seeds ten fictional vacancies covering every status', async () => {
    const o = (await agents.leader.get('/api/dashboard/overview')).body;
    expect(o.team).toBe('Egypt TA');
    expect(o.vacancies).toHaveLength(10);
    expect(o.vacancies.every((v: any) => v.isDemo)).toBe(true);
    expect(o.kpis).toMatchObject({ active: 8, onTrack: 4, needsAttention: 2, awaitingFeedback: 1, blocked: 1, onHold: 1, hired: 1 });
    expect(new Set(o.vacancies.map((v: any) => v.country)).size).toBeGreaterThanOrEqual(7);
    const blocked = o.intervention.find((i: any) => i.title.includes('KSA'));
    expect(blocked.reasons.map((r: any) => r.rule)).toEqual(expect.arrayContaining(['blocked', 'support_required']));
    expect(o.overdueActions.length).toBeGreaterThan(0);
  });
  it('separates vacancy location from the responsible TA team', async () => {
    const v = (await agents.leader.get('/api/vacancies?q=DACH')).body[0];
    expect(v.country).toBe('Austria');
    expect(v.taTeam).toBe('Egypt TA');
  });
  it('filters by recruiter, status and search', async () => {
    const nour = (await agents.leader.get('/api/auth/me')).body && (await agents.nour.get('/api/auth/me')).body.user;
    expect((await agents.leader.get(`/api/vacancies?recruiterId=${nour.id}`)).body).toHaveLength(3);
    expect((await agents.leader.get('/api/vacancies?overall=blocked')).body).toHaveLength(1);
    expect((await agents.leader.get('/api/vacancies?overall=hired')).body[0].title).toContain('Marketing');
  });
  it('gives each recruiter their own workspace', async () => {
    const my = (await agents.nour.get('/api/dashboard/my')).body;
    expect(my.vacancies.every((v: any) => v.recruiter === 'Nour El-Sayed')).toBe(true);
    expect(my.actions.some((a: any) => a.bucket === 'overdue')).toBe(true);
    expect(my.actions.some((a: any) => a.bucket === 'today')).toBe(true);
    expect(my.nextPriority.bucket).toBe('overdue');
  });
});

describe('central hiring tracker', () => {
  let id: number;
  it('creates a vacancy with milestones from the default template', async () => {
    const meta = (await agents.nour.get('/api/meta')).body;
    const r = await agents.nour.post('/api/vacancies').send({
      title: 'Partner Manager — Nordics', greenhouseJobId: 'T-1001', countryId: meta.countries.find((c: any) => c.name === 'Sweden').id, city: 'Stockholm',
      departmentId: meta.departments[0].id, hiringManager: 'Astrid Lund', openingDate: day(-10), targetHireDate: day(50), priority: 'high',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    id = r.body.id;
    expect(r.body.recruiter).toBe('Nour El-Sayed');           // recruiters own what they create
    expect(r.body.taTeam).toBe('Egypt TA');
    expect(r.body.milestones).toHaveLength(9);
    expect(r.body.currentStage).toBe('Vacancy intake');
    expect(r.body.milestones[1].plannedDate).toBe(day(-6));    // opening date + template offset
    expect(r.body.isDemo).toBe(false);
  });
  it('validates input and refuses duplicate Greenhouse IDs', async () => {
    expect((await agents.nour.post('/api/vacancies').send({ title: '' })).status).toBe(400);
    const dup = await agents.nour.post('/api/vacancies').send({ title: 'Other', greenhouseJobId: 'T-1001' });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toContain('already linked');
    const dates = await agents.nour.post('/api/vacancies').send({ title: 'Bad dates', openingDate: day(0), targetHireDate: day(-5) });
    expect(dates.status).toBe(400);
  });
  it('records a quick update with stage, next action and an Action Centre task', async () => {
    const before = (await agents.nour.get(`/api/vacancies/${id}`)).body;
    const r = await agents.nour.post(`/api/vacancies/${id}/updates`).send({
      summary: 'Requirements signed off; sourcing has started.', stageMilestoneId: before.milestones[2].id, health: 'needs_attention',
      nextAction: 'Share first five profiles', actionOwner: 'Nour El-Sayed', actionDeadline: day(4), createAction: true,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.currentStage).toBe('Sourcing started');
    expect(r.body.milestones.slice(0, 3).map((m: any) => m.status)).toEqual(['completed', 'completed', 'in_progress']);
    expect(r.body.milestones[2].startedDate).toBe(today());
    expect(r.body.daysInStage).toBe(0);
    expect(r.body.overall.key).toBe('needs_attention');
    expect(r.body.updates[0]).toMatchObject({ summary: 'Requirements signed off; sourcing has started.', stage: 'Sourcing started', userName: 'Nour El-Sayed', nextAction: 'Share first five profiles' });
    expect(r.body.actions.map((a: any) => a.title)).toContain('Share first five profiles');
    const h = r.body.history.find((x: any) => x.action === 'progress_update');
    expect(h.changes.currentStage).toMatchObject({ from: 'Vacancy intake', to: 'Sourcing started' });
    expect(h.changes.health).toMatchObject({ from: 'On track', to: 'Needs attention' });
  });
  it('keeps a field-level edit history', async () => {
    const r = await agents.nour.patch(`/api/vacancies/${id}`).send({ hiringManager: 'Astrid Lundqvist', city: 'Gothenburg' });
    expect(r.status).toBe(200);
    const edit = r.body.history.find((x: any) => x.action === 'edited');
    expect(edit.userName).toBe('Nour El-Sayed');
    expect(edit.changes.hiringManager).toEqual({ label: 'Hiring manager', from: 'Astrid Lund', to: 'Astrid Lundqvist' });
  });
  it('stops recruiters from editing or reassigning vacancies they do not own', async () => {
    expect((await agents.laila.patch(`/api/vacancies/${id}`).send({ city: 'Malmö' })).status).toBe(403);
    expect((await agents.laila.post(`/api/vacancies/${id}/updates`).send({ summary: 'Not mine to update' })).status).toBe(403);
    const laila = (await agents.laila.get('/api/auth/me')).body.user;
    expect((await agents.nour.patch(`/api/vacancies/${id}`).send({ recruiterId: laila.id })).status).toBe(403);
    expect((await agents.leader.patch(`/api/vacancies/${id}`).send({ priority: 'critical' })).status).toBe(200); // leadership may
  });
  it('supports a vacancy-specific milestone sequence', async () => {
    const v = (await agents.nour.get(`/api/vacancies/${id}`)).body;
    const ms = v.milestones.map((m: any) => ({ id: m.id, name: m.name, status: m.status, plannedDate: m.plannedDate, startedDate: m.startedDate, completedDate: m.completedDate }));
    ms.splice(3, 0, { name: 'Technical case study', status: 'pending', plannedDate: day(12) });
    ms[5].status = 'skipped';
    const r = await agents.nour.put(`/api/vacancies/${id}/milestones`).send({ milestones: ms });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.milestones).toHaveLength(10);
    expect(r.body.milestones[3].name).toBe('Technical case study');
    expect(r.body.milestonesTotal).toBe(9); // skipped milestones are not counted
  });
  it('closes a vacancy as filled and sets the closure date', async () => {
    const meta = (await agents.nour.get('/api/meta')).body;
    const filled = meta.statuses.find((s: any) => s.category === 'filled').id;
    const v = (await agents.nour.get(`/api/vacancies/${id}`)).body;
    const r = await agents.nour.post(`/api/vacancies/${id}/updates`).send({ summary: 'Offer accepted.', statusId: filled, stageMilestoneId: v.milestones.at(-1).id });
    expect(r.body.overall.key).toBe('hired');
    expect(r.body.closureDate).toBe(today());
    expect(r.body.milestones.at(-1).status).toBe('completed');
    const reopened = await agents.nour.post(`/api/vacancies/${id}/updates`).send({ summary: 'Candidate withdrew; reopened.', statusId: meta.statuses.find((s: any) => s.category === 'active').id, stageMilestoneId: v.milestones[2].id });
    expect(reopened.body.closureDate).toBeNull();
    expect(reopened.body.currentStage).toBe('Sourcing started');
  });
  it('exports the tracker as CSV', async () => {
    const r = await agents.leader.get('/api/vacancies/export.csv');
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.text).toContain('Responsible TA team');
    expect(r.text).toContain('Partner Manager — Nordics');
    expect(csvEscape('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
  });
});

describe('action centre', () => {
  it('creates, buckets, comments on and completes actions', async () => {
    const laila = (await agents.laila.get('/api/auth/me')).body.user;
    const c = await agents.laila.post('/api/actions').send({ title: 'Call candidate about notice period', dueDate: day(-2), priority: 'high' });
    expect(c.status).toBe(201);
    const list = (await agents.laila.get(`/api/actions?assigneeId=${laila.id}`)).body;
    const mine = list.find((a: any) => a.id === c.body.id);
    expect(mine.bucket).toBe('overdue');
    expect((await agents.laila.patch(`/api/actions/${mine.id}`).send({ status: 'waiting_feedback', waitingOn: 'Tamer Shawky', dueDate: day(3) })).body.status).toBe('waiting_feedback');
    expect((await agents.laila.get(`/api/actions/${mine.id}`)).body.bucket).toBe('waiting');
    expect((await agents.laila.post(`/api/actions/${mine.id}/comments`).send({ body: 'Left a voicemail.' })).status).toBe(201);
    expect((await agents.nour.patch(`/api/actions/${mine.id}`).send({ title: 'Hijack' })).status).toBe(403);
    const done = await agents.laila.patch(`/api/actions/${mine.id}`).send({ status: 'completed' });
    expect(done.body.completedAt).toBeTruthy();
    const detail = (await agents.laila.get(`/api/actions/${mine.id}`)).body;
    expect(detail.bucket).toBe('done');
    expect(detail.comments[0].body).toBe('Left a voicemail.');
  });
});

describe('risk monitor', () => {
  it('explains every alert and respects configurable rules', async () => {
    const r = (await agents.leader.get('/api/risks')).body;
    for (const a of r.alerts) {
      expect(a.what.length).toBeGreaterThan(10);
      expect(a.recommended.length).toBeGreaterThan(10);
      expect(a.responsible).toBeTruthy();
      expect(a.what).not.toMatch(/\.\./);
    }
    const rules = new Set(r.alerts.map((a: any) => a.rule));
    for (const k of ['blocked', 'next_action_overdue', 'behind_timeline', 'stale_update', 'no_next_action', 'on_hold', 'decision_outstanding', 'milestone_delayed', 'action_overdue', 'support_required']) {
      expect(rules.has(k), `expected a ${k} alert in the demo data`).toBe(true);
    }
    const stale = r.alerts.filter((a: any) => a.rule === 'stale_update');
    expect(stale.map((a: any) => a.vacancyTitle)).toEqual(['Finance Business Partner']);
    // The current stage is never reported as a delayed milestone.
    const late = r.alerts.find((a: any) => a.rule === 'milestone_delayed' && a.vacancyTitle.includes('Ruby'));
    expect(late.what).toContain('Candidate pipeline developed');

    const cfg = (await agents.admin.get('/api/admin/settings')).body.riskRules;
    cfg.stale_update.days = 30; cfg.on_hold.enabled = false;
    expect((await agents.admin.put('/api/admin/settings/risk.rules').send(cfg)).status).toBe(200);
    const after = (await agents.leader.get('/api/risks')).body.alerts;
    expect(after.some((a: any) => a.rule === 'stale_update')).toBe(false);
    expect(after.some((a: any) => a.rule === 'on_hold')).toBe(false);
    cfg.stale_update.days = 7; cfg.on_hold.enabled = true;
    await agents.admin.put('/api/admin/settings/risk.rules').send(cfg);
  });
});

describe('leadership reporting', () => {
  it('builds the weekly report from the live database', async () => {
    const r = (await agents.leader.get('/api/reports/weekly')).body;
    expect(r.meta.team).toBe('Egypt TA');
    expect(r.meta.weekStart).toBe(weekRange(today(), 0).start);
    expect(r.vacancies.length).toBeGreaterThanOrEqual(10);
    expect(r.workload.find((w: any) => w.recruiter === 'Nour El-Sayed').active).toBeGreaterThanOrEqual(3);
    expect(r.changes.length).toBeGreaterThan(0);          // compared with last week's saved snapshot
    expect(r.blockers.some((b: any) => b.title.includes('KSA'))).toBe(true);
    expect(r.supportRequired).toHaveLength(1);
    expect(r.upcomingDeadlines.length).toBeGreaterThan(0);
    expect(r.activity.updates.length).toBeGreaterThan(0);
  });
  it('saves snapshots and exposes history and stagnation', async () => {
    expect((await agents.nour.post('/api/reports/snapshots')).status).toBe(403);
    expect((await agents.leader.post('/api/reports/snapshots')).status).toBe(201);
    const h = (await agents.leader.get('/api/reports/history')).body;
    expect(h.series.length).toBe(7);                       // six seeded weeks + the live week
    expect(h.series.at(-1).kind).toBe('live');
    const finance = h.stagnation.find((s: any) => s.title === 'Finance Business Partner');
    expect(finance.weeksInStage).toBeGreaterThanOrEqual(2);
    const snaps = (await agents.leader.get('/api/reports/snapshots')).body;
    expect(snaps.length).toBe(7);
    expect((await agents.leader.get(`/api/reports/snapshots/${snaps.at(-1).id}`)).body.vacancies.length).toBeGreaterThan(0);
  });
  it('exports PDF and CSV', async () => {
    const pdf = await agents.leader.get('/api/reports/export?format=pdf').buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((pdf.body as Buffer).length).toBeGreaterThan(5000);
    const csv = await agents.leader.get('/api/reports/export?format=csv');
    expect(csv.text).toContain('Recruiter workload');
    expect(csv.text).toContain('Support required');
  });
  it('closes the previous week automatically', async () => {
    const lastWeek = addDays(weekRange(today(), 0).start, -7);
    await pool.query('DELETE FROM report_snapshots WHERE week_start = $1', [lastWeek]);
    await runScheduledTasks();
    const s = await pool.query('SELECT kind FROM report_snapshots WHERE week_start = $1', [lastWeek]);
    expect(s.rows[0].kind).toBe('auto');
  });
});

describe('recruitment assistant', () => {
  it('works without any AI service and cites a source for every statement', async () => {
    expect((await agents.leader.get('/api/assistant/status')).body.configured).toBe(false);
    for (const kind of ['weekly', 'brief', 'outdated', 'reminders', 'bottlenecks', 'suggestions']) {
      const r = await agents.leader.get(`/api/assistant/${kind}`);
      expect(r.status, kind).toBe(200);
      expect(r.body.engine).toBe('built-in');
      const statements = r.body.sections.flatMap((s: any) => s.statements);
      expect(statements.length, `${kind} should say something about the demo data`).toBeGreaterThan(0);
      for (const st of statements) expect(st.sources.length, `${kind}: “${st.text}” has no source`).toBeGreaterThan(0);
    }
    const v = (await agents.leader.get('/api/vacancies?overall=blocked')).body[0];
    const sum = (await agents.leader.get(`/api/assistant/vacancy/${v.id}`)).body;
    expect(sum.sections[0].statements[0].text).toContain('blocked');
    expect(sum.sections.find((s: any) => s.heading === 'Recent progress').statements[0].sources[0].type).toBe('update');
    const reminders = (await agents.leader.get('/api/assistant/reminders')).body;
    expect(reminders.drafts.length).toBeGreaterThan(0);
    expect(reminders.drafts[0].body).toContain('Dina Abdelrahman');
  });
  it('accepts LLM wording only when it is traceable to the recorded facts', async () => {
    let reply = '';
    const llm = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d)).on('end', () => {
        const facts = JSON.parse(body).messages[1].content as string;
        if (reply === 'good') reply = `The team is managing its portfolio as recorded [1]. ${facts.includes('[2]') ? 'Further detail is on file [2].' : ''}`;
        res.setHeader('content-type', 'application/json').end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      });
    }).listen(0);
    Object.assign(config.ai, { provider: 'openai_compatible', baseUrl: `http://127.0.0.1:${(llm.address() as AddressInfo).port}`, model: 'mock-model', apiKey: 'k' });
    try {
      reply = 'good';
      const ok = (await agents.leader.get('/api/assistant/brief?polish=1')).body;
      expect(ok.narrative).toContain('[1]');
      expect(ok.llm.model).toBe('mock-model');
      expect(ok.sections.length).toBeGreaterThan(0);        // the evidence always travels with the wording
      reply = 'The team will certainly hire 97 people by March [1].';
      const bad = (await agents.leader.get('/api/assistant/brief?polish=1')).body;
      expect(bad.narrative).toBeUndefined();
      expect(bad.llm.note).toContain('not in the recorded facts');
      reply = 'Everything is going very well.';
      expect((await agents.leader.get('/api/assistant/brief?polish=1')).body.llm.note).toContain('did not cite');
    } finally {
      Object.assign(config.ai, { provider: 'none', baseUrl: '', model: '' });
      llm.close();
    }
  });
});

describe('Excel migration', () => {
  let batch: any;
  const mappingOf = (s: any) => Object.fromEntries(Object.entries(s.suggestedMapping).map(([k, v]: any) => [k, v.column]));
  it('parses a workbook, finds the header row and suggests a mapping', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Notes').addRow(['Internal use only']);
    const ws = wb.addWorksheet('Tracker');
    ws.addRow(['Egypt TA recruitment tracker']);
    ws.addRow([]);
    ws.addRow(['GH Job ID', 'Position', 'Country', 'Department', 'Recruiter', 'Hiring Manager', 'Opening Date', 'Target Date', 'Stage', 'Status', 'Latest Update', 'Next Step', 'Owner', 'Deadline', 'Blockers']);
    ws.addRow(['X-501', 'Solutions Engineer', 'Germany', 'Sales', 'Laila Hassan', 'Jonas Keller', new Date(Date.UTC(2026, 8, 1)), '15/12/2026', 'Interviews', 'On Track', 'Two interviews done', 'Book final panel', 'Jonas Keller', '20.11.2026', null]);
    ws.addRow(['X-502', 'Account Manager', 'Atlantis', 'Sales', 'Someone Unknown', 'Mira Costa', 'not a date', null, 'Reference checks', 'On hold', null, null, null, null, 'Budget freeze']);
    ws.addRow([null, null, 'Egypt', 'Finance', 'Nour', null, null, null, null, null, 'Row without a title', null, null, null, null]);
    ws.addRow(['DEMO-4012701', 'Senior Account Executive — DACH', 'Austria', 'Sales', 'Nour El-Sayed', 'Someone Else', null, null, 'Offer', 'Open', 'SHOULD NOT OVERWRITE', null, null, null, null]);
    ws.addRow([null, 'Finance Business Partner', 'Austria', 'Finance', 'Laila Hassan', null, null, null, null, 'Open', null, null, null, null, null]);
    ws.addRow(['X-501', 'Solutions Engineer (copy)', 'Germany', 'Sales', 'Laila', null, null, null, null, null, null, null, null, null, null]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    expect((await agents.nour.post('/api/import/upload').attach('file', buf, 'tracker.xlsx')).status).toBe(403);
    const r = await agents.admin.post('/api/import/upload').attach('file', buf, 'tracker.xlsx');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    batch = r.body;
    expect(batch.sheets.map((s: any) => s.name)).toEqual(['Tracker']);     // the sheet without a table is ignored
    const s = batch.sheets[0];
    expect(s.headerRow).toBe(3);
    expect(s.rowCount).toBe(6);
    const m = mappingOf(s);
    const col = (k: string) => s.columns[m[k]];
    expect(col('title')).toBe('Position');
    expect(col('greenhouseJobId')).toBe('GH Job ID');
    expect(col('hiringManager')).toBe('Hiring Manager');
    expect(col('targetHireDate')).toBe('Target Date');
    expect(col('progressUpdate')).toBe('Latest Update');
    expect(col('nextAction')).toBe('Next Step');
    expect(col('actionDeadline')).toBe('Deadline');
    expect(col('currentBlocker')).toBe('Blockers');
    expect(s.suggestedMapping.title.confidence).toBe('high');
  });
  it('previews rows with duplicates, missing information and unreadable values', async () => {
    const s = batch.sheets[0];
    const p = (await agents.admin.post(`/api/import/${batch.id}/preview`).send({ sheetName: s.name, mapping: mappingOf(s), options: { createMissingRefs: false } })).body;
    expect(p.summary).toMatchObject({ total: 6, ready: 2, duplicates: 3, errors: 1 });
    const [ok, warn, noTitle, ghDup, titleDup, fileDup] = p.rows;
    expect(ok.status).toBe('ready');
    expect(ok.values).toMatchObject({ openingDate: '2026-09-01', targetHireDate: '2026-12-15', actionDeadline: '2026-11-20', health: 'on_track' });
    expect(warn.issues.map((i: any) => i.field)).toEqual(expect.arrayContaining(['openingDate', 'country', 'recruiter', 'stage']));
    expect(noTitle.status).toBe('error');
    expect(ghDup.duplicate).toMatchObject({ type: 'greenhouse_id', allowNew: false });
    expect(titleDup.duplicate.type).toBe('title_location');
    expect(fileDup.duplicate.type).toBe('within_file');
    expect(p.rows.filter((r: any) => r.duplicate).every((r: any) => r.defaultDecision === 'skip')).toBe(true);
    const missingTitle = await agents.admin.post(`/api/import/${batch.id}/preview`).send({ sheetName: s.name, mapping: { ...mappingOf(s), title: null } });
    expect(missingTitle.status).toBe(400);
  });
  it('imports approved rows, never overwrites silently, and reports every row', async () => {
    const s = batch.sheets[0];
    const dach = (await agents.leader.get('/api/vacancies?q=DACH')).body[0];
    const fin = (await agents.leader.get('/api/vacancies?q=Finance Business')).body[0];
    const p = (await agents.admin.post(`/api/import/${batch.id}/preview`).send({ sheetName: s.name, mapping: mappingOf(s), options: { createMissingRefs: true } })).body;
    const rowOf = (i: number) => String(p.rows[i].rowNumber);
    const r = await agents.admin.post(`/api/import/${batch.id}/commit`).send({ sheetName: s.name, mapping: mappingOf(s), options: { createMissingRefs: true },
      decisions: { [rowOf(4)]: 'update' } });   // only the Finance row is explicitly updated; everything else keeps its default
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.totals).toMatchObject({ rows: 6, created: 2, updated: 1, skippedDuplicate: 2, skippedError: 1 });
    expect(r.body.createdReferenceValues.countries).toEqual(['Atlantis']);

    const after = (await agents.leader.get(`/api/vacancies/${dach.id}`)).body;
    expect(after.progressUpdate).toBe(dach.progressUpdate);               // duplicate was skipped, record untouched
    expect(after.hiringManager).toBe('Markus Steiner');
    const finAfter = (await agents.leader.get(`/api/vacancies/${fin.id}`)).body;
    expect(finAfter.history.some((h: any) => h.action === 'edited') || finAfter.updates.some((u: any) => u.source === 'import')).toBe(true);

    const se = (await agents.leader.get('/api/vacancies?q=Solutions Engineer')).body;
    expect(se).toHaveLength(1);
    const detail = (await agents.leader.get(`/api/vacancies/${se[0].id}`)).body;
    expect(detail).toMatchObject({ currentStage: 'Interviews', recruiter: 'Laila Hassan', country: 'Germany', nextAction: 'Book final panel', isDemo: false });
    expect(detail.updates[0]).toMatchObject({ source: 'import', summary: 'Two interviews done' });
    const am = (await agents.leader.get('/api/vacancies?q=Account Manager')).body[0];
    expect(am).toMatchObject({ currentStage: 'Reference checks', country: 'Atlantis', recruiter: null });
    expect(am.overall.key).toBe('on_hold');

    const rep = (await agents.admin.get(`/api/import/${batch.id}/report`)).body;
    expect(rep.status).toBe('imported');
    expect(rep.rows.map((x: any) => x.outcome)).toEqual(['created', 'created', 'skipped_error', 'skipped_duplicate', 'updated', 'skipped_duplicate']);
    const csv = await agents.admin.get(`/api/import/${batch.id}/report?format=csv`);
    expect(csv.text).toContain('Skipped — duplicate');
    expect((await agents.admin.post(`/api/import/${batch.id}/commit`).send({ sheetName: s.name, mapping: mappingOf(s), decisions: {} })).status).toBe(400); // cannot run twice
    const audit = (await agents.admin.get('/api/audit?entityType=import')).body;
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['uploaded', 'imported']));
  });
  it('reads CSV with semicolons and flags a re-upload of an imported file', async () => {
    const csv = 'Job title;Country;Recruiter;Status\nData Analyst;Egypt;Karim Mansour;Open\n';
    const r = await agents.admin.post('/api/import/upload').attach('file', Buffer.from(csv), 'extra.csv');
    expect(r.body.sheets[0].columns).toEqual(['Job title', 'Country', 'Recruiter', 'Status']);
    expect(r.body.sheets[0].rowCount).toBe(1);
    expect((await agents.admin.post('/api/import/upload').attach('file', Buffer.from('x'), 'old.xls')).status).toBe(400);
    expect(parseDate('03/04/2026')).toBe('2026-04-03');
    expect(parseDate('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(parseDate(46000)).toMatch(/^2025-/);
    expect(parseDate('soon')).toBeUndefined();
    expect(suggestMapping(['Role', 'TA Partner', 'Comments']).recruiter.column).toBe(1);
  });
});

describe('Greenhouse integration', () => {
  it('runs the simulated sync and shows mismatches, unlinked jobs and errors', async () => {
    const st = (await agents.admin.get('/api/integrations')).body;
    expect(st.greenhouse.mode).toBe('demo');
    expect(st.greenhouse.credentialsConfigured).toBe(false);
    const run = (await agents.admin.post('/api/integrations/greenhouse/sync')).body;
    expect(run.status).toBe('partial');
    expect(run.stats.vacanciesUpdated).toBeGreaterThan(5);
    expect(run.issues.some((i: any) => i.level === 'error' && i.message.includes('was not returned by Greenhouse'))).toBe(true);
    expect(run.unlinked).toHaveLength(2);
    const v = (await agents.leader.get('/api/vacancies?q=Arabic speaking')).body[0];
    expect(v.greenhouseSnapshot.mode).toBe('demo');
    expect(v.greenhouseSnapshot.mismatches[0].field).toBe('Job title');
    expect(v.title).toBe('Customer Success Manager — Arabic speaking');   // not overwritten unless auto-apply is on
    expect(v.greenhouseSnapshot.activeApplications).toBeGreaterThan(0);
    const linked = await agents.admin.post('/api/integrations/greenhouse/link').send({ runId: run.id, jobId: run.unlinked[0].id });
    expect(linked.status).toBe(201);
    expect((await agents.admin.get('/api/integrations/greenhouse/runs')).body[0].status).toBe('partial');
    expect((await agents.admin.put('/api/integrations/greenhouse').send({ mode: 'live', autoApply: false })).status).toBe(400); // no credentials
    expect((await agents.nour.post('/api/integrations/greenhouse/sync')).status).toBe(403);
  });
  it('speaks the Harvest v3 protocol: client-credentials token, Bearer auth, Link pagination and 429 retry', async () => {
    const seen: string[] = [];
    let throttled = false;
    const gh = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${String(req.headers.authorization).split(' ')[0]}`);
      const base = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
      const json = (o: unknown, headers: Record<string, string> = {}) => res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(o));
      if (req.url === '/token') {
        const basic = Buffer.from(String(req.headers.authorization).split(' ')[1], 'base64').toString();
        return basic === 'cid:secret' ? json({ access_token: 'tok-1', expires_in: 3600 }) : res.writeHead(401).end();
      }
      if (req.headers.authorization !== 'Bearer tok-1') return res.writeHead(401).end();
      if (req.url === '/v3/jobs') return json([{ id: 1, name: 'Job One', status: 'open', department_id: 7 }], { link: `<${base}/v3/jobs?cursor=abc>; rel="next"` });
      if (req.url === '/v3/jobs?cursor=abc') {
        if (!throttled) { throttled = true; return res.writeHead(429, { 'retry-after': '0' }).end(); }
        return json([{ id: 2, name: 'Job Two', status: 'open' }]);
      }
      if (req.url === '/v3/applications') return json([{ id: 10, job_id: 1, status: 'active', current_stage_id: 5 }, { id: 11, job_id: 1, status: 'rejected' }, { id: 12, job_id: 1, status: 'active', current_stage_id: 5 }]);
      if (req.url === '/v3/job_stages') return json([{ id: 5, name: 'Phone screen' }]);
      if (req.url === '/v3/departments') return json([{ id: 7, name: 'Sales' }]);
      return res.writeHead(403).end();
    }).listen(0);
    const base = `http://127.0.0.1:${(gh.address() as AddressInfo).port}`;
    const client = new HarvestV3Client({ clientId: 'cid', clientSecret: 'secret', tokenUrl: `${base}/token`, baseUrl: `${base}/v3`, jobUrlTemplate: '' });
    const issues: any[] = [];
    const jobs = await client.fetchJobs((i) => issues.push(i));
    gh.close();
    expect(jobs.map((j) => j.title)).toEqual(['Job One', 'Job Two']);
    expect(jobs[0]).toMatchObject({ department: 'Sales', activeApplications: 2, rejected: 1, byStage: [{ stage: 'Phone screen', count: 2 }] });
    expect(seen.filter((s) => s.startsWith('POST /token'))).toHaveLength(1);                 // token is cached
    expect(seen.filter((s) => s.includes('cursor=abc'))).toHaveLength(2);                    // retried after 429
    expect(issues.some((i) => i.message.includes('Offices could not be read'))).toBe(true);  // optional resources degrade to warnings
  });
});

describe('administration', () => {
  it('creates users with a one-time password that must be changed', async () => {
    const r = await agents.admin.post('/api/admin/users').send({ email: 'Salma.Adel@TalentRadar.example', name: 'Salma Adel', role: 'recruiter' });
    expect(r.status).toBe(201);
    const a = request.agent(app);
    expect((await a.post('/api/auth/login').send({ email: 'salma.adel@talentradar.example', password: r.body.temporaryPassword })).status).toBe(200);
    expect((await a.get('/api/auth/me')).body.user.mustChangePassword).toBe(true);
    expect((await a.get('/api/vacancies')).status).toBe(403);                                // nothing else works until the password is changed
    expect((await a.post('/api/auth/change-password').send({ current: r.body.temporaryPassword, next: 'short' })).status).toBe(400);
    expect((await a.post('/api/auth/change-password').send({ current: r.body.temporaryPassword, next: 'A-much-better-pass-2026' })).status).toBe(200);
    expect((await a.get('/api/auth/me')).body.user.mustChangePassword).toBe(false);
    expect((await agents.admin.post('/api/admin/users').send({ email: 'salma.adel@talentradar.example', name: 'Dup', role: 'viewer' })).status).toBe(409);
    await agents.admin.patch(`/api/admin/users/${r.body.id}`).send({ isActive: false });
    expect((await a.get('/api/auth/me')).status).toBe(401);                                  // deactivation ends sessions immediately
  });
  it('applies permission changes immediately and protects the last administrator', async () => {
    const p = (await agents.admin.get('/api/admin/permissions')).body;
    const viewer = [...p.matrix.viewer, 'assistant.use', 'admin.users'];
    expect((await agents.admin.put('/api/admin/permissions').send({ matrix: { viewer } })).status).toBe(200);
    expect((await agents.viewer.get('/api/assistant/weekly')).status).toBe(200);
    expect((await agents.viewer.get('/api/admin/users')).status).toBe(403);                  // admin permissions cannot be granted to other roles
    await agents.admin.put('/api/admin/permissions').send({ matrix: { viewer: p.matrix.viewer } });
    expect((await agents.viewer.get('/api/assistant/weekly')).status).toBe(403);
    const me = (await agents.admin.get('/api/auth/me')).body.user;
    expect((await agents.admin.patch(`/api/admin/users/${me.id}`).send({ role: 'viewer' })).status).toBe(400);
  });
  it('configures reference data, statuses and milestone templates', async () => {
    expect((await agents.admin.post('/api/admin/reference/countries').send({ name: 'Portugal', isoCode: 'pt' })).status).toBe(201);
    expect((await agents.admin.post('/api/admin/reference/statuses').send({ name: 'Pending approval', category: 'active' })).status).toBe(201);
    expect((await agents.admin.post('/api/admin/reference/statuses').send({ name: 'No category' })).status).toBe(400);
    const t = await agents.admin.post('/api/admin/templates').send({ name: 'Internship intake', items: [{ name: 'Intake', defaultOffsetDays: 0 }, { name: 'Campus sourcing', defaultOffsetDays: 7 }, { name: 'Offer', defaultOffsetDays: 30 }] });
    expect(t.status).toBe(201);
    const meta = (await agents.admin.get('/api/meta')).body;
    expect(meta.countries.find((c: any) => c.name === 'Portugal').isoCode).toBe('PT');
    expect(meta.statuses.some((s: any) => s.label === 'Pending approval')).toBe(true);
    const v = await agents.admin.post('/api/vacancies').send({ title: 'Marketing Intern', milestoneTemplateId: t.body.id, statusId: meta.statuses.find((s: any) => s.label === 'Pending approval').id });
    expect(v.body.milestones.map((m: any) => m.name)).toEqual(['Intake', 'Campus sourcing', 'Offer']);
    expect(v.body.status).toBe('Pending approval');
    const ref = (await agents.admin.get('/api/admin/reference')).body;
    const open = ref.statuses.find((s: any) => s.key === 'open');
    expect((await agents.admin.patch(`/api/admin/reference/statuses/${open.id}`).send({ category: 'filled' })).status).toBe(400); // in use
  });
  it('reassigns vacancies in bulk with an audit entry', async () => {
    const laila = (await agents.laila.get('/api/auth/me')).body.user;
    const v = (await agents.leader.get('/api/vacancies?q=Marketing Intern')).body[0];
    expect((await agents.leader.post('/api/admin/assign').send({ vacancyIds: [v.id], recruiterId: laila.id })).status).toBe(200);
    const d = (await agents.leader.get(`/api/vacancies/${v.id}`)).body;
    expect(d.recruiter).toBe('Laila Hassan');
    expect(d.history[0]).toMatchObject({ action: 'assigned', userName: 'Dina Abdelrahman' });
  });
  it('removes demonstration data without touching real records', async () => {
    const before = (await agents.admin.get('/api/vacancies')).body;
    const real = before.filter((v: any) => !v.isDemo).length;
    expect(real).toBeGreaterThan(0);
    const r = (await agents.admin.delete('/api/admin/demo-data')).body;
    expect(r.vacancies).toBe(11);                                                           // ten seeded + the job linked from the simulated sync
    const after = (await agents.admin.get('/api/vacancies')).body;
    expect(after).toHaveLength(real);
    expect(after.some((v: any) => v.isDemo && v.greenhouseJobId?.startsWith('DEMO-4012701'))).toBe(false);
    expect((await agents.admin.get('/api/auth/me')).status).toBe(200);                       // the acting admin is not locked out
    expect((await agents.leader.get('/api/auth/me')).status).toBe(401);                      // other demo accounts are deactivated
  });
});

describe('single sign-on (OpenID Connect against a mock identity provider)', () => {
  it('completes the authorisation-code + PKCE flow and maps the identity to an existing user', async () => {
    const { publicKey, privateKey } = await jose.generateKeyPair('RS256');
    const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    let issuer = '';
    let lastAuth: URLSearchParams | undefined;
    let who = { sub: 'entra-oid-123', email: 'karim.mansour@talentradar.example', name: 'Karim Mansour' };
    const idp = http.createServer(async (req, res) => {
      const url = new URL(req.url!, issuer);
      const json = (o: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      if (url.pathname === '/.well-known/openid-configuration') {
        return json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'] });
      }
      if (url.pathname === '/jwks') return json({ keys: [jwk] });
      if (url.pathname === '/token') {
        const idToken = await new jose.SignJWT({ nonce: lastAuth!.get('nonce')!, email: who.email, name: who.name })
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setIssuer(issuer).setAudience('tr-client').setSubject(who.sub).setIssuedAt().setExpirationTime('5m').sign(privateKey);
        return json({ access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: idToken });
      }
      res.writeHead(404).end();
    }).listen(0);
    issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}`;
    Object.assign(config.sso, { enabled: true, issuer, clientId: 'tr-client', clientSecret: 's3cret', autoProvision: false, allowedDomains: ['talentradar.example'] });
    await pool.query(`UPDATE users SET is_active = true WHERE email = 'karim.mansour@talentradar.example'`);
    try {
      const a = request.agent(app);
      const start = await a.get('/api/auth/sso/login');
      expect(start.status).toBe(302);
      lastAuth = new URL(start.headers.location).searchParams;
      expect(lastAuth.get('code_challenge_method')).toBe('S256');
      expect(lastAuth.get('redirect_uri')).toMatch(/\/api\/auth\/sso\/callback$/);
      const cb = await a.get(`/api/auth/sso/callback?code=abc&state=${lastAuth.get('state')}`);
      expect(cb.headers.location).toBe('/');
      const me = (await a.get('/api/auth/me')).body.user;
      expect(me).toMatchObject({ name: 'Karim Mansour', role: 'recruiter' });

      // A tampered state is rejected, and an unknown person is not let in when auto-provisioning is off.
      const b = request.agent(app);
      lastAuth = new URL((await b.get('/api/auth/sso/login')).headers.location).searchParams;
      expect((await b.get('/api/auth/sso/callback?code=abc&state=forged')).headers.location).toContain('/login?error=');
      who = { sub: 'entra-oid-999', email: 'stranger@talentradar.example', name: 'A Stranger' };
      const c = request.agent(app);
      lastAuth = new URL((await c.get('/api/auth/sso/login')).headers.location).searchParams;
      const denied = await c.get(`/api/auth/sso/callback?code=abc&state=${lastAuth.get('state')}`);
      expect(decodeURIComponent(denied.headers.location)).toContain('has not been added');
      expect((await c.get('/api/auth/me')).status).toBe(401);
    } finally {
      config.sso.enabled = false;
      idp.close();
    }
  });
});
