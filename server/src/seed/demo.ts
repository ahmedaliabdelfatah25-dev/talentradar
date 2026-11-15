import { hashPassword } from '../auth.js';
import { one, pool, rows, tx, type Db } from '../db.js';
import { ensureDefaults, loadRefs, setSetting } from '../settings.js';
import { recomputeStage } from '../services/vacancies.js';
import { computeKpis } from '../services/report.js';
import { addDays, dateOf, overallStatus, today, weekRange } from '../util.js';

/**
 * Fictional demonstration data. Every person, vacancy and identifier below is invented.
 * All rows are flagged is_demo so the UI can label them and an administrator can remove them in one step.
 * Dates are relative to the day the data is loaded, so the demo always looks current.
 */
export const DEMO_PASSWORD = 'TalentRadar-Demo-2026';
const DOMAIN = 'talentradar.example';

const USERS = [
  { key: 'dina', name: 'Dina Abdelrahman', role: 'leadership', title: 'Head of Talent Acquisition, Egypt' },
  { key: 'youssef', name: 'Youssef Tarek', role: 'admin', title: 'TA Operations Lead' },
  { key: 'nour', name: 'Nour El-Sayed', role: 'recruiter', title: 'Senior Talent Acquisition Partner' },
  { key: 'omar', name: 'Omar Farouk', role: 'recruiter', title: 'Talent Acquisition Partner' },
  { key: 'laila', name: 'Laila Hassan', role: 'recruiter', title: 'Talent Acquisition Partner' },
  { key: 'karim', name: 'Karim Mansour', role: 'recruiter', title: 'Talent Acquisition Specialist' },
  { key: 'stefan', name: 'Stefan Huber', role: 'viewer', title: 'People Business Partner' },
] as const;
type U = (typeof USERS)[number]['key'];

interface DemoVacancy {
  gh: string; title: string; country: string; city: string; dept: string; family: string; type: string; recruiter: U;
  hm: string; owner: string; stakeholders?: string; opened: number; target: number | null; priority: string; template?: string;
  stage: string; status: 'open' | 'on_hold' | 'filled'; health: string; closed?: number; lastUpdate: number;
  achievement?: string; next?: [string, string, number]; blocker?: string; support?: string; notes?: string;
  updates: [number, U, string, string, string][];           // days ago, author, summary, stage then, health then
  trail: [number, string, string][];                        // weeks ago → stage, overall status (for saved weekly reports)
}

const V: DemoVacancy[] = [
  { gh: 'DEMO-4012701', title: 'Senior Account Executive — DACH', country: 'Austria', city: 'Vienna', dept: 'Sales', family: 'Sales', type: 'New headcount', recruiter: 'nour',
    hm: 'Markus Steiner', owner: 'Claudia Reiter', stakeholders: 'Petra Lang (Sales Enablement)', opened: 38, target: -32, priority: 'high',
    stage: 'Interviews', status: 'open', health: 'on_track', lastUpdate: 1,
    achievement: 'Two finalists confirmed after first-round interviews.', next: ['Run second-round interviews with both finalists', 'Markus Steiner', -3],
    updates: [[34, 'nour', 'Intake completed with Markus; target profile and interview panel agreed.', 'Vacancy intake', 'on_track'],
      [27, 'nour', 'Requirements approved; outreach started on LinkedIn Recruiter.', 'Sourcing started', 'on_track'],
      [16, 'nour', 'Pipeline of 14 qualified profiles built; screening calls scheduled.', 'Recruiter screening', 'on_track'],
      [8, 'nour', 'Shortlist of five shared; hiring manager selected four for interview.', 'Interviews', 'on_track'],
      [1, 'nour', 'First-round interviews done. Two finalists move to second round next week.', 'Interviews', 'on_track']],
    trail: [[6, 'Vacancy intake', 'on_track'], [4, 'Sourcing started', 'on_track'], [3, 'Recruiter screening', 'on_track'], [1, 'Interviews', 'on_track']] },

  { gh: 'DEMO-4012702', title: 'Customer Success Manager — Arabic speaking', country: 'United Arab Emirates', city: 'Dubai', dept: 'Customer Success', family: 'Customer Success', type: 'Replacement', recruiter: 'omar',
    hm: 'Rania Khoury', owner: 'Rania Khoury', opened: 44, target: -20, priority: 'high',
    stage: 'Hiring manager review', status: 'open', health: 'awaiting_feedback', lastUpdate: 6,
    achievement: 'Shortlist of five screened candidates submitted.', next: ['Review shortlist of five profiles and confirm who to interview', 'Rania Khoury', 4],
    updates: [[40, 'omar', 'Intake held; replacement approved with unchanged scope.', 'Vacancy intake', 'on_track'],
      [30, 'omar', 'Sourcing started; strong response from the UAE and Egypt markets.', 'Sourcing started', 'on_track'],
      [19, 'omar', 'Screening under way, nine calls completed.', 'Recruiter screening', 'on_track'],
      [11, 'omar', 'Shortlist of five profiles sent to the hiring manager for review.', 'Hiring manager review', 'on_track'],
      [6, 'omar', 'Still waiting for shortlist feedback; reminder sent to Rania.', 'Hiring manager review', 'awaiting_feedback']],
    trail: [[6, 'Vacancy intake', 'on_track'], [5, 'Sourcing started', 'on_track'], [3, 'Recruiter screening', 'on_track'], [2, 'Hiring manager review', 'on_track'], [1, 'Hiring manager review', 'awaiting_feedback']] },

  { gh: 'DEMO-4012703', title: 'Backend Engineer (Ruby)', country: 'Egypt', city: 'Cairo', dept: 'Engineering', family: 'Engineering', type: 'New headcount', recruiter: 'laila',
    hm: 'Tamer Shawky', owner: 'Ingrid Solberg', opened: 30, target: -35, priority: 'medium',
    stage: 'Sourcing started', status: 'open', health: 'needs_attention', lastUpdate: 2,
    next: ['Agree with hiring manager to widen the search to remote EMEA profiles', 'Laila Hassan', -2],
    blocker: 'Candidate pipeline is thin: only three qualified profiles after three weeks of sourcing.',
    updates: [[27, 'laila', 'Intake completed; seniority and tech stack confirmed.', 'Vacancy intake', 'on_track'],
      [21, 'laila', 'Job requirements approved, sourcing started.', 'Sourcing started', 'on_track'],
      [9, 'laila', 'Response rate is low; only three qualified profiles so far.', 'Sourcing started', 'needs_attention'],
      [2, 'laila', 'Pipeline still thin. Proposing to open the search to remote EMEA candidates.', 'Sourcing started', 'needs_attention']],
    trail: [[4, 'Vacancy intake', 'on_track'], [3, 'Sourcing started', 'on_track'], [1, 'Sourcing started', 'needs_attention']] },

  { gh: 'DEMO-4012704', title: 'Regional Sales Manager — KSA', country: 'Saudi Arabia', city: 'Riyadh', dept: 'Sales', family: 'Sales', type: 'New headcount', recruiter: 'nour',
    hm: 'Faisal Al-Harbi', owner: 'Claudia Reiter', stakeholders: 'Helena Brandt (Finance)', opened: 71, target: -6, priority: 'critical',
    stage: 'Offer', status: 'open', health: 'blocked', lastUpdate: 1,
    achievement: 'Preferred candidate selected after final panel.', next: ['Confirm budget exception so the offer can be released', 'Helena Brandt', 2],
    blocker: 'Offer approval pending: the agreed compensation is above the approved budget band and Finance sign-off is outstanding.',
    support: 'Leadership decision needed on a 12% budget exception before the candidate’s other offer expires.',
    notes: 'Candidate has a competing offer with a decision deadline next week.',
    updates: [[66, 'nour', 'Intake completed; market briefing shared with the hiring manager.', 'Vacancy intake', 'on_track'],
      [50, 'nour', 'Pipeline developed, six candidates in screening.', 'Recruiter screening', 'on_track'],
      [33, 'nour', 'Hiring manager reviewed shortlist; three candidates invited to interview.', 'Interviews', 'on_track'],
      [12, 'nour', 'Final panel completed; preferred candidate identified.', 'Offer', 'on_track'],
      [7, 'nour', 'Offer drafted. Compensation is above the budget band; approval requested from Finance.', 'Offer', 'needs_attention'],
      [1, 'nour', 'Blocked: Finance sign-off still outstanding and the candidate has a competing offer.', 'Offer', 'blocked']],
    trail: [[6, 'Recruiter screening', 'on_track'], [4, 'Interviews', 'on_track'], [2, 'Offer', 'on_track'], [1, 'Offer', 'needs_attention']] },

  { gh: 'DEMO-4012705', title: 'Marketing Operations Specialist', country: 'Germany', city: 'Munich', dept: 'Marketing', family: 'Marketing', type: 'Replacement', recruiter: 'karim',
    hm: 'Julia Weber', owner: 'Julia Weber', opened: 63, target: 2, priority: 'medium',
    stage: 'Hired', status: 'filled', health: 'on_track', closed: 5, lastUpdate: 5,
    achievement: 'Offer accepted; start date confirmed.',
    updates: [[58, 'karim', 'Intake completed.', 'Vacancy intake', 'on_track'],
      [40, 'karim', 'Screening completed; four candidates presented.', 'Hiring manager review', 'on_track'],
      [22, 'karim', 'Interviews completed; one finalist.', 'Interviews', 'on_track'],
      [12, 'karim', 'Verbal offer made.', 'Offer', 'on_track'],
      [5, 'karim', 'Offer accepted and contract signed. Vacancy filled.', 'Hired', 'on_track']],
    trail: [[6, 'Hiring manager review', 'on_track'], [4, 'Interviews', 'on_track'], [2, 'Offer', 'on_track']] },

  { gh: 'DEMO-4012706', title: 'Product Designer', country: 'United Kingdom', city: 'London', dept: 'Product', family: 'Product', type: 'New headcount', recruiter: 'omar',
    hm: 'Oliver Grant', owner: 'Ingrid Solberg', opened: 52, target: null, priority: 'low',
    stage: 'Recruiter screening', status: 'on_hold', health: 'on_track', lastUpdate: 16,
    next: ['Confirm with hiring manager whether the vacancy resumes', 'Omar Farouk', -12],
    blocker: 'Headcount is under review after the product reorganisation; a decision is expected next month.',
    updates: [[47, 'omar', 'Intake completed.', 'Vacancy intake', 'on_track'],
      [30, 'omar', 'Screening started with seven candidates.', 'Recruiter screening', 'on_track'],
      [16, 'omar', 'Placed on hold at the hiring manager’s request; candidates informed.', 'Recruiter screening', 'on_track']],
    trail: [[6, 'Sourcing started', 'on_track'], [4, 'Recruiter screening', 'on_track'], [2, 'Recruiter screening', 'on_hold']] },

  { gh: 'DEMO-4012707', title: 'Customer Support Specialist — Polish', country: 'Poland', city: 'Warsaw', dept: 'Customer Support', family: 'Support', type: 'New headcount', recruiter: 'karim',
    hm: 'Agnieszka Nowak', owner: 'Rania Khoury', opened: 21, target: -40, priority: 'medium',
    stage: 'Recruiter screening', status: 'open', health: 'on_track', lastUpdate: 0,
    achievement: 'Eleven qualified applicants in the pipeline.', next: ['Complete screening calls with the remaining six candidates', 'Karim Mansour', -1],
    updates: [[19, 'karim', 'Intake completed; language assessment agreed as part of screening.', 'Vacancy intake', 'on_track'],
      [12, 'karim', 'Sourcing started; job published.', 'Sourcing started', 'on_track'],
      [5, 'karim', 'Pipeline of eleven qualified applicants.', 'Candidate pipeline developed', 'on_track'],
      [0, 'karim', 'Five screening calls done, six scheduled for this week.', 'Recruiter screening', 'on_track']],
    trail: [[3, 'Vacancy intake', 'on_track'], [2, 'Sourcing started', 'on_track'], [1, 'Candidate pipeline developed', 'on_track']] },

  { gh: 'DEMO-4012708', title: 'Finance Business Partner', country: 'Austria', city: 'Vienna', dept: 'Finance', family: 'Finance', type: 'Replacement', recruiter: 'laila',
    hm: 'Helena Brandt', owner: 'Helena Brandt', opened: 40, target: -25, priority: 'medium',
    stage: 'Candidate pipeline developed', status: 'open', health: 'on_track', lastUpdate: 12,
    updates: [[36, 'laila', 'Intake completed.', 'Vacancy intake', 'on_track'],
      [26, 'laila', 'Sourcing started.', 'Sourcing started', 'on_track'],
      [12, 'laila', 'Eight profiles identified; outreach in progress.', 'Candidate pipeline developed', 'on_track']],
    trail: [[5, 'Vacancy intake', 'on_track'], [4, 'Sourcing started', 'on_track'], [2, 'Candidate pipeline developed', 'on_track']] },

  { gh: 'DEMO-4012709', title: 'Sales Development Representative — Spain', country: 'Spain', city: 'Madrid', dept: 'Sales', family: 'Sales', type: 'New headcount', recruiter: 'nour',
    hm: 'Carlos Mendez', owner: 'Claudia Reiter', opened: 4, target: -56, priority: 'medium', template: 'High-volume / junior hiring',
    stage: 'Job requirements approved', status: 'open', health: 'on_track', lastUpdate: 2,
    next: ['Publish the job and start outreach', 'Nour El-Sayed', 0],
    updates: [[4, 'nour', 'Vacancy received; intake meeting booked.', 'Vacancy intake', 'on_track'],
      [2, 'nour', 'Intake held with Carlos. Waiting for the final job description sign-off.', 'Job requirements approved', 'on_track']],
    trail: [] },

  { gh: 'DEMO-4012710', title: 'Head of Customer Success — MENA', country: 'Egypt', city: 'Cairo', dept: 'Customer Success', family: 'Customer Success', type: 'New headcount', recruiter: 'omar',
    hm: 'Rania Khoury', owner: 'Claudia Reiter', stakeholders: 'Dina Abdelrahman, Claudia Reiter', opened: 96, target: 5, priority: 'high', template: 'Leadership / executive search',
    stage: 'Shortlist interviews', status: 'open', health: 'needs_attention', lastUpdate: 3,
    next: ['Re-engage the longlist and present three new profiles', 'Omar Farouk', -6],
    blocker: 'Two finalists withdrew after receiving counter-offers from their current employers.',
    updates: [[90, 'omar', 'Search strategy agreed with the hiring manager.', 'Search strategy agreed', 'on_track'],
      [70, 'omar', 'Market mapping completed across UAE, KSA and Egypt.', 'Market mapping', 'on_track'],
      [52, 'omar', 'Longlist of twelve presented.', 'Longlist presented', 'on_track'],
      [24, 'omar', 'Shortlist interviews running; two strong finalists.', 'Shortlist interviews', 'on_track'],
      [10, 'omar', 'One finalist withdrew after a counter-offer.', 'Shortlist interviews', 'needs_attention'],
      [3, 'omar', 'Second finalist also withdrew. Going back to the longlist; target date will be missed.', 'Shortlist interviews', 'needs_attention']],
    trail: [[6, 'Longlist presented', 'on_track'], [4, 'Shortlist interviews', 'on_track'], [1, 'Shortlist interviews', 'needs_attention']] },
];

// [title, vacancy index | null, assignee, due (days ago; negative = future), priority, status, waiting on, description, completed days ago, comment]
const ACTIONS: [string, number | null, U, number | null, string, string, string | null, string | null, number | null, string | null][] = [
  ['Send interview feedback forms to the panel', 0, 'nour', -2, 'medium', 'open', null, null, null, null],
  ['Schedule second-round interviews with both finalists', 0, 'nour', 0, 'high', 'in_progress', null, 'Coordinate calendars with Markus and Petra.', null, 'Markus is available Tuesday and Thursday afternoon.'],
  ['Chase shortlist feedback from hiring manager', 1, 'omar', 3, 'high', 'waiting_feedback', 'Rania Khoury', 'Five profiles were sent; no response yet.', null, 'Reminder sent by email and Teams.'],
  ['Prepare remote-EMEA sourcing proposal', 2, 'laila', -2, 'medium', 'open', null, null, null, null],
  ['Refresh job advert wording for the Ruby role', 2, 'laila', 5, 'low', 'open', null, null, null, null],
  ['Obtain Finance sign-off for the budget exception', 3, 'nour', 2, 'critical', 'waiting_feedback', 'Helena Brandt', 'Offer cannot be released without it.', null, 'Escalated to Dina on Monday.'],
  ['Keep preferred candidate warm — weekly call', 3, 'nour', -1, 'high', 'open', null, null, null, null],
  ['Complete remaining screening calls', 6, 'karim', -1, 'medium', 'in_progress', null, null, null, null],
  ['Agree next action for Finance Business Partner search', 7, 'laila', 1, 'medium', 'open', null, null, null, null],
  ['Publish Madrid SDR job and brief sourcing', 8, 'nour', 0, 'medium', 'open', null, null, null, null],
  ['Present three new profiles from the longlist', 9, 'omar', -6, 'high', 'open', null, null, null, null],
  ['Confirm whether Product Designer vacancy resumes', 5, 'omar', -12, 'low', 'waiting_feedback', 'Oliver Grant', null, null, null],
  ['Send onboarding handover to People Operations', 4, 'karim', 4, 'medium', 'completed', null, null, 4, 'Handover sent and acknowledged.'],
  ['Close Marketing Operations job in Greenhouse', 4, 'karim', 4, 'low', 'completed', null, null, 3, null],
  ['Prepare monthly TA capacity overview', null, 'dina', -7, 'low', 'open', null, null, null, null],
  ['Share market briefing for KSA sales roles', 3, 'nour', 20, 'medium', 'completed', null, null, 18, null],
];

/** An instant `daysAgo` days back (one minute earlier, so "today" entries are always in the past). */
const at = (daysAgo: number) => new Date(Date.now() - daysAgo * 86400000 - 60000);
const day = (daysAgo: number) => addDays(today(), -daysAgo);

export async function seedDemoData(): Promise<void> {
  await ensureDefaults();
  const hash = await hashPassword(DEMO_PASSWORD);
  await tx(async (db: Db) => {
    const refs = await loadRefs(db);
    const team = refs.teams[0];
    const uid: Record<string, number> = {};
    for (const u of USERS) {
      const email = `${u.name.toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN}`;
      const row = await one<{ id: number }>(db, `INSERT INTO users (email, name, role, job_title, ta_team_id, password_hash, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,true)
         ON CONFLICT (lower(email)) DO UPDATE SET is_active = true, password_hash = EXCLUDED.password_hash, is_demo = true RETURNING id`,
        [email, u.name, u.role, u.title, u.role === 'viewer' ? null : team.id, hash]);
      uid[u.key] = row!.id;
    }
    const nameOf = (k: U) => USERS.find((u) => u.key === k)!.name;
    const status = (k: string) => refs.statuses.find((s: any) => s.key === k)!;
    const vid: number[] = [];

    for (const v of V) {
      const st = status(v.status);
      const row = await one<{ id: number }>(db,
        `INSERT INTO vacancies (greenhouse_job_id, title, country_id, city, department_id, job_family, vacancy_type, ta_team_id, recruiter_id, hiring_manager,
            hiring_manager_email, department_owner, stakeholders, opening_date, target_hire_date, priority, status_id, health, progress_update, latest_achievement,
            next_action, action_owner, action_deadline, current_blocker, support_required, internal_notes, closure_date, is_demo, created_by, created_at,
            last_update_at, last_update_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,true,$28,$29,$30,$31) RETURNING id`,
        [v.gh, v.title, refs.countries.find((c: any) => c.name === v.country)?.id, v.city, refs.departments.find((d: any) => d.name === v.dept)?.id, v.family, v.type,
          team.id, uid[v.recruiter], v.hm, `${v.hm.toLowerCase().replace(/[^a-z]+/g, '.')}@${DOMAIN}`, v.owner, v.stakeholders ?? null, day(v.opened),
          v.target === null ? null : day(v.target), v.priority, st.id, v.health, v.updates[v.updates.length - 1][2], v.achievement ?? null,
          v.next?.[0] ?? null, v.next?.[1] ?? null, v.next ? day(v.next[2]) : null, v.blocker ?? null, v.support ?? null, v.notes ?? null,
          v.closed !== undefined ? day(v.closed) : null, uid[v.recruiter], at(v.opened), at(v.lastUpdate), uid[v.recruiter]]);
      const id = row!.id;
      vid.push(id);

      const tpl = refs.templates.find((t: any) => t.name === v.template) ?? refs.templates.find((t: any) => t.isDefault);
      const cur = tpl.items.findIndex((i: any) => i.name === v.stage);
      const opened = day(v.opened);
      const planned: string[] = tpl.items.map((i: any) => addDays(opened, i.defaultOffsetDays ?? 0));
      // "Reached" dates come from the first update that mentions the stage, otherwise the plan — kept in order and never in the future.
      const reached: (string | null)[] = tpl.items.map((item: any, i: number) => (i > cur ? null : (() => { const u = v.updates.find((x) => x[3] === item.name); return u ? day(u[0]) : null; })()));
      let nextKnown = v.closed !== undefined ? day(v.closed) : today();
      for (let i = cur; i >= 0; i--) {
        const r: string = reached[i] ?? (planned[i] < nextKnown ? planned[i] : nextKnown);
        reached[i] = r > nextKnown ? nextKnown : r;
        nextKnown = reached[i]!;
      }
      for (const [i, item] of tpl.items.entries()) {
        const filledLast = v.status === 'filled' && i === cur;
        const st2 = i < cur || filledLast ? 'completed' : i === cur ? 'in_progress' : 'pending';
        await db.query(`INSERT INTO vacancy_milestones (vacancy_id, name, position, status, planned_date, started_date, completed_date) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, item.name, item.position, st2, planned[i], reached[i], i < cur ? reached[i + 1] : filledLast ? reached[i] : null]);
      }
      await recomputeStage(db, id);

      for (const [i, [ago, who, summary, stage, health]] of v.updates.entries()) {
        const last = i === v.updates.length - 1;
        const cat = last ? st.category : v.status === 'on_hold' && ago <= 16 ? 'on_hold' : 'active';
        await db.query(
          `INSERT INTO vacancy_updates (vacancy_id, user_id, created_at, summary, achievement, stage, status_label, status_category, health, next_action, action_owner, action_deadline, blocker, support_required)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [id, uid[who], at(ago), summary, last ? v.achievement ?? null : null, stage, cat === 'active' ? 'Open' : last ? st.label : 'On hold', cat, health,
            last ? v.next?.[0] ?? null : null, last ? v.next?.[1] ?? null : null, last && v.next ? day(v.next[2]) : null,
            last || health !== 'on_track' ? v.blocker ?? null : null, last ? v.support ?? null : null]);
        await db.query(`INSERT INTO audit_log (at, user_id, user_name, entity_type, entity_id, vacancy_id, action, summary) VALUES ($1,$2,$3,'vacancy',$4,$4,'progress_update',$5)`,
          [at(ago), uid[who], nameOf(who), id, summary]);
      }
      await db.query(`INSERT INTO audit_log (at, user_id, user_name, entity_type, entity_id, vacancy_id, action, summary) VALUES ($1,$2,$3,'vacancy',$4,$4,'created',$5)`,
        [at(v.opened), uid[v.recruiter], nameOf(v.recruiter), id, `Vacancy created (demonstration data): ${v.title}`]);
    }

    for (const [title, vi, who, due, priority, st, waitingOn, desc, completedAgo, comment] of ACTIONS) {
      const a = await one<{ id: number }>(db,
        `INSERT INTO actions (title, description, vacancy_id, assignee_id, waiting_on, due_date, priority, status, is_demo, created_by, created_at, updated_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12) RETURNING id`,
        [title, desc, vi === null ? null : vid[vi], uid[who], waitingOn, due === null ? null : day(due), priority, st, uid[who],
          at((due ?? 0) + 9), at(completedAgo ?? (st === 'waiting_feedback' ? Math.max(4, (due ?? 0) + 2) : 1)), completedAgo === null ? null : at(completedAgo)]);
      if (comment) await db.query('INSERT INTO action_comments (action_id, user_id, body, created_at) VALUES ($1,$2,$3,$4)', [a!.id, uid[who], comment, at(1)]);
    }

    // Saved weekly reports for the previous six weeks, so the historical view has something to show.
    const cfgWeek = weekRange(today(), 0);
    let prev: any[] | null = null;
    for (let w = 6; w >= 1; w--) {
      const start = addDays(cfgWeek.start, -7 * w);
      const end = addDays(start, 6);
      const list = V.map((v, i) => {
        if (v.opened < w * 7 - 3) return null;                       // not opened yet in that week
        const t = [...v.trail].sort((a, b) => b[0] - a[0]).filter((x) => x[0] >= w).pop();
        if (!t) return null;
        const cat = t[2] === 'on_hold' ? 'on_hold' : 'active';
        const health = t[2] === 'on_hold' ? 'on_track' : t[2];
        return { id: vid[i], title: v.title, country: v.country, city: v.city, department: v.dept, recruiter: nameOf(v.recruiter), hiringManager: v.hm,
          stage: t[1], status: cat === 'on_hold' ? 'On hold' : 'Open', statusCategory: cat, health, overall: overallStatus(cat, health), priority: v.priority,
          lastUpdateAt: at(w * 7).toISOString(), progressUpdate: null, nextAction: null, actionOwner: null, actionDeadline: null,
          blocker: null, supportRequired: null, openingDate: day(v.opened), targetHireDate: v.target === null ? null : day(v.target), closureDate: null,
          milestonesDone: 0, milestonesTotal: 0, isDemo: true, greenhouseJobId: v.gh };
      }).filter(Boolean) as any[];
      const changes: any[] = [];
      for (const x of list) {
        const b = prev?.find((p) => p.id === x.id);
        if (!b) { if (prev) changes.push({ vacancyId: x.id, title: x.title, type: 'New vacancy', from: null, to: x.stage }); continue; }
        if (b.overall.key !== x.overall.key) changes.push({ vacancyId: x.id, title: x.title, type: 'Status', from: b.overall.label, to: x.overall.label });
        if (b.stage !== x.stage) changes.push({ vacancyId: x.id, title: x.title, type: 'Stage', from: b.stage, to: x.stage });
      }
      const ups = V.flatMap((v, i) => v.updates.filter((u) => day(u[0]) >= start && day(u[0]) <= end)
        .map((u) => ({ id: 0, vacancyId: vid[i], title: v.title, at: at(u[0]).toISOString(), user: nameOf(u[1]), summary: u[2], stage: u[3] })));
      const recs = [...new Set(list.map((x) => x.recruiter))].sort();
      const data = {
        meta: { team: team.name, teamId: team.id, weekStart: start, weekEnd: end, generatedAt: at(w * 7 - 6).toISOString(), previousWeekStart: prev ? addDays(start, -7) : null, containsDemoData: true },
        kpis: computeKpis(list, { overdueActions: Math.max(0, 4 - w), upcomingDeadlines: 3 + (w % 3), stale: w % 2 }),
        vacancies: list, changes, unchangedCount: list.length - new Set(changes.map((c) => c.vacancyId)).size,
        workload: recs.map((r) => { const mine = list.filter((x) => x.recruiter === r); const act = mine.filter((x) => x.statusCategory === 'active');
          return { recruiter: r, active: act.length, onTrack: act.filter((x) => x.health === 'on_track').length,
            needsAttention: act.filter((x) => ['needs_attention', 'awaiting_feedback'].includes(x.health)).length, blocked: act.filter((x) => x.health === 'blocked').length,
            onHold: mine.length - act.length, hired: 0, openActions: 0, overdueActions: 0, updatesThisWeek: ups.filter((u) => mine.some((m) => m.id === u.vacancyId)).length }; }),
        activity: { updates: ups, actionsCompleted: [], milestonesCompleted: [] },
        outstandingActions: [], overdueMilestones: [], blockers: [], supportRequired: [], upcomingDeadlines: [], alertCounts: [],
      };
      await db.query(`INSERT INTO report_snapshots (week_start, week_end, generated_at, generated_by, kind, data) VALUES ($1,$2,$3,$4,'demo',$5)
                      ON CONFLICT (week_start) DO NOTHING`, [start, end, at(w * 7 - 6), uid.dina, JSON.stringify(data)]);
      prev = list;
    }
    await setSetting('greenhouse', { mode: 'demo', autoApply: false }, uid.youssef, db);
  });
}

/** Removes all demonstration records. Demo user accounts are deactivated (the caller's own account is kept so they are not locked out). */
export async function clearDemoData(currentUserId: number) {
  return tx(async (db: Db) => {
    const v = await db.query('DELETE FROM vacancies WHERE is_demo');
    const a = await db.query('DELETE FROM actions WHERE is_demo');
    const s = await db.query(`DELETE FROM report_snapshots WHERE kind = 'demo'`);
    const u = await db.query('UPDATE users SET is_active = false WHERE is_demo AND id <> $1 AND is_active', [currentUserId]);
    await db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE is_demo AND id <> $1)', [currentUserId]);
    const self = await rows<any>(db, 'SELECT is_demo FROM users WHERE id = $1', [currentUserId]);
    return { vacancies: v.rowCount, actions: a.rowCount, reports: s.rowCount, usersDeactivated: u.rowCount, currentUserIsDemo: !!self[0]?.isDemo };
  });
}

export const demoDate = dateOf;
export const hasUsers = async () => (await one<{ n: number }>(pool, 'SELECT count(*) AS n FROM users'))!.n > 0;
