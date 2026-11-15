import { DEFAULT_ROLE_PERMISSIONS } from './auth.js';
import { one, pool, rows, type Db } from './db.js';

/** Transparent, rule-based risk checks. Each rule can be switched off or re-thresholded by an administrator. */
export const RISK_RULES = [
  { key: 'blocked', label: 'Vacancy is blocked', severity: 'high', params: {},
    description: 'The recruiter has marked the vacancy as blocked.' },
  { key: 'next_action_overdue', label: 'Next action overdue', severity: 'high', params: {},
    description: 'The deadline of the agreed next action has passed.' },
  { key: 'behind_timeline', label: 'Behind agreed timeline', severity: 'high', params: { warnDays: 14, gapPoints: 30 },
    description: 'The target hiring date has passed, or is close while milestone completion lags the time elapsed.' },
  { key: 'support_required', label: 'Support requested', severity: 'medium', params: {},
    description: 'The recruiter has recorded that support is required.' },
  { key: 'milestone_delayed', label: 'Milestone delayed', severity: 'medium', params: { graceDays: 0 },
    description: 'A milestone has passed its planned date without being completed.' },
  { key: 'decision_outstanding', label: 'Hiring manager decision outstanding', severity: 'medium', params: { days: 3 },
    description: 'The vacancy or one of its actions has been waiting for stakeholder feedback longer than the threshold.' },
  { key: 'stale_update', label: 'No recent update', severity: 'medium', params: { days: 7 },
    description: 'No progress update has been recorded within the configured period.' },
  { key: 'no_next_action', label: 'No agreed next action', severity: 'medium', params: {},
    description: 'An active vacancy has no next action recorded.' },
  { key: 'action_overdue', label: 'Action overdue', severity: 'medium', params: {},
    description: 'An Action Centre task linked to the vacancy is past its due date.' },
  { key: 'on_hold', label: 'Vacancy on hold', severity: 'low', params: { days: 0 },
    description: 'The vacancy has been on hold for longer than the threshold (0 = always list on-hold vacancies).' },
] as const;

export type RiskRuleKey = (typeof RISK_RULES)[number]['key'];
export type RiskRuleConfig = Record<string, { enabled: boolean } & Record<string, number | boolean>>;

const defaultRiskConfig = (): RiskRuleConfig =>
  Object.fromEntries(RISK_RULES.map((r) => [r.key, { enabled: true, ...r.params }]));

export const DEFAULT_SETTINGS = {
  general: { organisation: 'PlanRadar', primaryTeam: 'Egypt TA' },
  'risk.rules': defaultRiskConfig(),
  report: { weekStartsOn: 0, upcomingDays: 14, autoSnapshot: true },
  greenhouse: { mode: 'off' as 'off' | 'demo' | 'live', autoApply: false },
};
export type SettingKey = keyof typeof DEFAULT_SETTINGS;

export async function getSetting<K extends SettingKey>(key: K, db: Db = pool): Promise<(typeof DEFAULT_SETTINGS)[K]> {
  const row = await one<{ value: any }>(db, 'SELECT value FROM settings WHERE key = $1', [key]);
  const def = DEFAULT_SETTINGS[key] as any;
  if (!row) return structuredClone(def);
  if (key === 'risk.rules') {
    const merged: any = defaultRiskConfig();
    for (const k of Object.keys(merged)) merged[k] = { ...merged[k], ...(row.value?.[k] ?? {}) };
    return merged;
  }
  return { ...def, ...row.value };
}

export async function setSetting(key: SettingKey, value: unknown, userId: number | null, db: Db = pool): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, JSON.stringify(value), userId],
  );
}

const STANDARD = [
  ['Vacancy intake', 0], ['Job requirements approved', 4], ['Sourcing started', 7], ['Candidate pipeline developed', 18],
  ['Recruiter screening', 25], ['Hiring manager review', 32], ['Interviews', 46], ['Offer', 60], ['Hired', 75],
] as const;
const TEMPLATES: { name: string; description: string; isDefault?: boolean; items: readonly (readonly [string, number])[] }[] = [
  { name: 'Standard recruitment process', description: 'Default sequence for most professional roles.', isDefault: true, items: STANDARD },
  { name: 'Leadership / executive search', description: 'Longer search with market mapping, panel and references.',
    items: [['Vacancy intake', 0], ['Search strategy agreed', 7], ['Market mapping', 21], ['Longlist presented', 35],
      ['Shortlist interviews', 56], ['Panel and case study', 70], ['References', 80], ['Offer', 90], ['Hired', 120]] },
  { name: 'High-volume / junior hiring', description: 'Short sequence with a group assessment instead of staged interviews.',
    items: [['Vacancy intake', 0], ['Job requirements approved', 3], ['Sourcing started', 5], ['Assessment day', 21], ['Offer', 30], ['Hired', 45]] },
];

/** Inserts reference data the application needs to be usable. Only fills what is missing — never overwrites edits. */
export async function ensureDefaults(db: Db = pool): Promise<void> {
  const empty = async (t: string) => (await one<{ n: number }>(db, `SELECT count(*) AS n FROM ${t}`))!.n === 0;

  if (await empty('ta_teams')) await db.query(`INSERT INTO ta_teams (name, sort_order) VALUES ('Egypt TA', 1)`);
  if (await empty('vacancy_statuses')) {
    await db.query(`INSERT INTO vacancy_statuses (key, label, category, sort_order) VALUES
      ('open','Open','active',1), ('on_hold','On hold','on_hold',2), ('filled','Filled','filled',3), ('cancelled','Cancelled','cancelled',4)`);
  }
  if (await empty('countries')) {
    const list = [['Egypt', 'EG'], ['Austria', 'AT'], ['Germany', 'DE'], ['United Kingdom', 'GB'], ['United Arab Emirates', 'AE'],
      ['Saudi Arabia', 'SA'], ['Poland', 'PL'], ['Spain', 'ES'], ['France', 'FR'], ['Italy', 'IT'], ['Netherlands', 'NL'],
      ['Sweden', 'SE'], ['Croatia', 'HR'], ['United States', 'US'], ['Singapore', 'SG'], ['Australia', 'AU']];
    for (const [n, c] of list) await db.query('INSERT INTO countries (name, iso_code) VALUES ($1,$2)', [n, c]);
  }
  if (await empty('departments')) {
    for (const n of ['Sales', 'Customer Success', 'Customer Support', 'Marketing', 'Product', 'Engineering', 'Finance',
      'People & Culture', 'Operations', 'Business Development']) await db.query('INSERT INTO departments (name) VALUES ($1)', [n]);
  }
  if (await empty('lookup_values')) {
    const fam = ['Sales', 'Customer Success', 'Support', 'Marketing', 'Product', 'Engineering', 'Finance', 'People', 'Operations'];
    const typ = ['New headcount', 'Replacement', 'Fixed-term', 'Internship'];
    let i = 0;
    for (const l of fam) await db.query(`INSERT INTO lookup_values (type, label, sort_order) VALUES ('job_family',$1,$2)`, [l, ++i]);
    for (const l of typ) await db.query(`INSERT INTO lookup_values (type, label, sort_order) VALUES ('vacancy_type',$1,$2)`, [l, ++i]);
  }
  if (await empty('milestone_templates')) {
    for (const t of TEMPLATES) {
      const { id } = (await one<{ id: number }>(db,
        'INSERT INTO milestone_templates (name, description, is_default) VALUES ($1,$2,$3) RETURNING id', [t.name, t.description, !!t.isDefault]))!;
      let pos = 0;
      for (const [name, offset] of t.items) {
        await db.query('INSERT INTO milestone_template_items (template_id, name, position, default_offset_days) VALUES ($1,$2,$3,$4)',
          [id, name, ++pos, offset]);
      }
    }
  }
  if (await empty('role_permissions')) {
    for (const [role, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      for (const p of perms) await db.query('INSERT INTO role_permissions (role, permission) VALUES ($1,$2) ON CONFLICT DO NOTHING', [role, p]);
    }
  }
}

/** Reference lookups used for label resolution, validation and import matching. */
export async function loadRefs(db: Db = pool) {
  // Sequential on purpose: this is often called inside a transaction, and a single connection runs one query at a time.
  const teams = await rows<any>(db, 'SELECT * FROM ta_teams ORDER BY sort_order, name');
  const countries = await rows<any>(db, 'SELECT * FROM countries ORDER BY name');
  const departments = await rows<any>(db, 'SELECT * FROM departments ORDER BY name');
  const statuses = await rows<any>(db, 'SELECT * FROM vacancy_statuses ORDER BY sort_order, label');
  const users = await rows<any>(db, `SELECT id, name, email, role, job_title, ta_team_id, is_active, is_demo FROM users ORDER BY name`);
  const lookups = await rows<any>(db, 'SELECT * FROM lookup_values ORDER BY sort_order, label');
  const templates = await rows<any>(db, 'SELECT * FROM milestone_templates ORDER BY is_default DESC, name');
  const items = await rows<any>(db, 'SELECT * FROM milestone_template_items ORDER BY template_id, position');
  for (const t of templates) t.items = items.filter((i) => i.templateId === t.id);
  const byId = <T extends { id: number }>(list: T[]) => new Map(list.map((x) => [x.id, x]));
  return {
    teams, countries, departments, statuses, users, lookups, templates,
    teamById: byId(teams), countryById: byId(countries), departmentById: byId(departments),
    statusById: byId(statuses), userById: byId(users),
  };
}
export type Refs = Awaited<ReturnType<typeof loadRefs>>;
