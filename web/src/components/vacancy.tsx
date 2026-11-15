import { ArrowDown, ArrowUp, CalendarClock, ChevronRight, Columns3, PencilLine, Search, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAct, useAuth, useMeta } from '../lib/app';
import { cx, fmtDate, isPast, relDay } from '../lib/format';
import { Button, DemoTag, Drawer, Field, Meter, Modal, PriorityTag, StatusIcon, StatusPill, Tag } from './ui';

export const HEALTH_OPTIONS = [
  { value: 'on_track', label: 'On track' }, { value: 'needs_attention', label: 'Needs attention' },
  { value: 'awaiting_feedback', label: 'Awaiting feedback' }, { value: 'blocked', label: 'Blocked' },
];
const HEALTH_LABEL: Record<string, string> = Object.fromEntries(HEALTH_OPTIONS.map((h) => [h.value, h.label]));

// ───────────── Filters ─────────────
export interface Filters { q: string; recruiter: string; country: string; department: string; hiringManager: string; status: string }
export const NO_FILTERS: Filters = { q: '', recruiter: '', country: '', department: '', hiringManager: '', status: '' };

export function applyFilters(rows: any[], f: Filters): any[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((v) => {
    if (f.recruiter && (v.recruiter ?? 'Unassigned') !== f.recruiter) return false;
    if (f.country && v.country !== f.country) return false;
    if (f.department && v.department !== f.department) return false;
    if (f.hiringManager && v.hiringManager !== f.hiringManager) return false;
    if (f.status === 'active' && v.statusCategory !== 'active') return false;
    if (f.status === 'open' && !['active', 'on_hold'].includes(v.statusCategory)) return false;
    if (f.status === 'attention' && !(v.statusCategory === 'active' && ['needs_attention', 'awaiting_feedback'].includes(v.health))) return false;
    if (f.status === 'intervention' && !v.needsIntervention) return false;
    if (f.status === 'closed' && !['filled', 'cancelled'].includes(v.statusCategory)) return false;
    if (f.status && !['active', 'open', 'attention', 'intervention', 'closed'].includes(f.status) && v.overall.key !== f.status) return false;
    if (q && ![v.title, v.greenhouseJobId, v.hiringManager, v.recruiter, v.country, v.city, v.department, v.currentStage, v.nextAction]
      .some((x) => String(x ?? '').toLowerCase().includes(q))) return false;
    return true;
  });
}

const STATUS_FILTERS: [string, string][] = [['', 'All statuses'], ['active', 'Active'], ['on_track', 'On track'], ['attention', 'Needs attention / awaiting'],
  ['needs_attention', 'Needs attention'], ['awaiting_feedback', 'Awaiting feedback'], ['blocked', 'Blocked'], ['intervention', 'Requires intervention'],
  ['on_hold', 'On hold'], ['hired', 'Hired'], ['cancelled', 'Cancelled'], ['closed', 'Closed (hired or cancelled)']];

export function FilterBar({ rows, value, onChange, right }: { rows: any[]; value: Filters; onChange: (f: Filters) => void; right?: ReactNode }) {
  const opts = (key: string) => [...new Set(rows.map((r) => r[key] ?? (key === 'recruiter' ? 'Unassigned' : null)).filter(Boolean))].sort() as string[];
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => onChange({ ...value, [k]: e.target.value });
  const active = Object.values(value).some(Boolean);
  const sel = (k: keyof Filters, all: string, items: string[]) => (
    <select className="field !w-auto min-w-[130px] flex-1 sm:flex-none" aria-label={all} value={value[k]} onChange={set(k)}>
      <option value="">{all}</option>
      {items.map((o) => <option key={o}>{o}</option>)}
    </select>
  );
  return (
    <div className="no-print flex flex-wrap items-center gap-2">
      <div className="relative min-w-[180px] flex-1 sm:max-w-[240px]">
        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
        <input className="field !pl-8" placeholder="Filter this table…" aria-label="Filter this table" value={value.q} onChange={set('q')} />
      </div>
      {sel('recruiter', 'All recruiters', opts('recruiter'))}
      {sel('country', 'All countries', opts('country'))}
      {sel('department', 'All departments', opts('department'))}
      {sel('hiringManager', 'All hiring managers', opts('hiringManager'))}
      <select className="field !w-auto min-w-[130px] flex-1 sm:flex-none" aria-label="Status" value={value.status} onChange={set('status')}>
        {STATUS_FILTERS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {active && <Button variant="ghost" size="sm" icon={X} onClick={() => onChange(NO_FILTERS)}>Clear</Button>}
      {right && <div className="ml-auto flex items-center gap-2">{right}</div>}
    </div>
  );
}

// ───────────── Tracker table ─────────────
interface Col { key: string; label: string; sort?: (v: any) => string | number; render: (v: any) => ReactNode; min?: number }
const text = (s: unknown, clamp = 2) => (s ? <span className={clamp === 2 ? 'line-clamp-2' : 'line-clamp-3'} title={String(s)}>{String(s)}</span> : <span className="text-ink-3">—</span>);
const dash = (s: unknown) => (s ? String(s) : <span className="text-ink-3">—</span>);

export function Deadline({ date, closed }: { date?: string | null; closed?: boolean }) {
  if (!date) return <span className="text-ink-3">—</span>;
  const late = !closed && isPast(date);
  return (
    <span className="whitespace-nowrap">
      <span className={cx('num', late && 'font-semibold')}>{fmtDate(date)}</span>
      <span className={cx('block text-[11.5px]', late ? 'font-medium text-crit' : 'text-ink-3')}>{late ? `Overdue · ${relDay(date)}` : relDay(date)}</span>
    </span>
  );
}

export const COLUMNS: Col[] = [
  { key: 'title', label: 'Vacancy', min: 190, sort: (v) => v.title.toLowerCase(), render: (v) => (
    <div>
      <div className="font-semibold leading-snug">{v.title}</div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-ink-3">
        {v.greenhouseJobId && <span className="num">GH {v.greenhouseJobId}</span>}
        {v.isDemo && <DemoTag />}
        {v.priority && ['high', 'critical'].includes(v.priority) && ['active', 'on_hold'].includes(v.statusCategory) && <PriorityTag p={v.priority} />}
      </div>
    </div>) },
  { key: 'location', label: 'Location', min: 100, sort: (v) => `${v.country ?? ''} ${v.city ?? ''}`, render: (v) => (v.country ? <div>{v.country}{v.city && <div className="text-[11.5px] text-ink-3">{v.city}</div>}</div> : dash(null)) },
  { key: 'department', label: 'Department', sort: (v) => v.department ?? '', render: (v) => dash(v.department) },
  { key: 'recruiter', label: 'Recruiter', min: 96, sort: (v) => v.recruiter ?? '', render: (v) => v.recruiter ?? <Tag tone="warn">Unassigned</Tag> },
  { key: 'hiringManager', label: 'Hiring manager', min: 96, sort: (v) => v.hiringManager ?? '', render: (v) => dash(v.hiringManager) },
  { key: 'stage', label: 'Current stage', min: 138, sort: (v) => v.milestonesTotal ? v.milestonesDone / v.milestonesTotal : 0, render: (v) => (
    <div><div>{dash(v.currentStage)}</div>
      <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap"><Meter done={v.milestonesDone} total={v.milestonesTotal} />
        {v.statusCategory === 'active' && v.daysInStage !== null && v.daysInStage !== undefined && <span className="num text-[11.5px] text-ink-3" title={`${v.daysInStage} days in this stage`}>· {v.daysInStage}d</span>}</div>
    </div>) },
  { key: 'status', label: 'Overall status', sort: (v) => ['blocked', 'needs_attention', 'awaiting_feedback', 'on_track', 'on_hold', 'hired', 'cancelled'].indexOf(v.overall.key), render: (v) => <StatusPill k={v.overall.key} label={v.overall.label} /> },
  { key: 'lastUpdate', label: 'Last update', min: 84, sort: (v) => v.lastUpdateAt ?? '', render: (v) => (v.lastUpdateAt
    ? <span className="whitespace-nowrap" title={v.lastUpdateByName ? `Updated by ${v.lastUpdateByName}` : undefined}><span className="num">{fmtDate(v.lastUpdateAt)}</span><span className="block text-[11.5px] text-ink-3">{relDay(v.lastUpdateAt)}</span></span>
    : <Tag tone="warn">Never</Tag>) },
  { key: 'nextAction', label: 'Next action', min: 170, render: (v) => (v.nextAction ? text(v.nextAction) : ['active'].includes(v.statusCategory) ? <Tag tone="warn">No next action</Tag> : dash(null)) },
  { key: 'actionOwner', label: 'Action owner', min: 96, sort: (v) => v.actionOwner ?? '', render: (v) => dash(v.actionOwner) },
  { key: 'deadline', label: 'Deadline', min: 96, sort: (v) => v.actionDeadline ?? '9999', render: (v) => <Deadline date={v.actionDeadline} closed={!['active', 'on_hold'].includes(v.statusCategory)} /> },
  // Additional tracker fields (available through the column chooser)
  { key: 'greenhouseJobId', label: 'Greenhouse job ID', sort: (v) => v.greenhouseJobId ?? '', render: (v) => <span className="num">{dash(v.greenhouseJobId)}</span> },
  { key: 'taTeam', label: 'Responsible TA team', sort: (v) => v.taTeam ?? '', render: (v) => dash(v.taTeam) },
  { key: 'jobFamily', label: 'Job family', sort: (v) => v.jobFamily ?? '', render: (v) => dash(v.jobFamily) },
  { key: 'vacancyType', label: 'Vacancy type', sort: (v) => v.vacancyType ?? '', render: (v) => dash(v.vacancyType) },
  { key: 'departmentOwner', label: 'Department owner', sort: (v) => v.departmentOwner ?? '', render: (v) => dash(v.departmentOwner) },
  { key: 'stakeholders', label: 'Stakeholders', min: 160, render: (v) => text(v.stakeholders) },
  { key: 'priority', label: 'Priority', sort: (v) => ['critical', 'high', 'medium', 'low'].indexOf(v.priority), render: (v) => <PriorityTag p={v.priority} /> },
  { key: 'openingDate', label: 'Opening date', sort: (v) => v.openingDate ?? '', render: (v) => <span className="num whitespace-nowrap">{fmtDate(v.openingDate, { year: true })}</span> },
  { key: 'targetHireDate', label: 'Target hiring date', sort: (v) => v.targetHireDate ?? '9999', render: (v) => <span className="num whitespace-nowrap">{fmtDate(v.targetHireDate, { year: true })}</span> },
  { key: 'vacancyStatus', label: 'Vacancy status', sort: (v) => v.status, render: (v) => v.status },
  { key: 'health', label: 'Vacancy health', sort: (v) => v.health, render: (v) => (v.statusCategory === 'active' ? <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><StatusIcon k={v.health} size={14} />{HEALTH_LABEL[v.health]}</span> : dash(null)) },
  { key: 'progressUpdate', label: 'Progress update', min: 260, render: (v) => text(v.progressUpdate, 3) },
  { key: 'latestAchievement', label: 'Latest achievement', min: 220, render: (v) => text(v.latestAchievement) },
  { key: 'currentBlocker', label: 'Current blocker', min: 220, render: (v) => text(v.currentBlocker) },
  { key: 'supportRequired', label: 'Support required', min: 220, render: (v) => text(v.supportRequired) },
  { key: 'closureDate', label: 'Closure date', sort: (v) => v.closureDate ?? '', render: (v) => <span className="num whitespace-nowrap">{fmtDate(v.closureDate, { year: true })}</span> },
];
export const DEFAULT_COLUMNS = ['title', 'location', 'department', 'recruiter', 'hiringManager', 'stage', 'status', 'lastUpdate', 'nextAction', 'actionOwner', 'deadline'];

export function ColumnChooser({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button size="md" icon={Columns3} onClick={() => setOpen((o) => !o)}>Columns</Button>
      {open && <>
        <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
        <div className="glass-solid pop anim-rise absolute right-0 top-full z-40 mt-2 max-h-[420px] w-64 overflow-y-auto rounded-xl p-2">
          {COLUMNS.map((c) => (
            <label key={c.key} className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] hover:bg-hover">
              <input type="checkbox" className="accent-[var(--accent)]" checked={value.includes(c.key)} disabled={c.key === 'title'}
                onChange={(e) => onChange(e.target.checked ? COLUMNS.map((x) => x.key).filter((k) => k === c.key || value.includes(k)) : value.filter((k) => k !== c.key))} />
              {c.label}
            </label>
          ))}
          <div className="mt-1 border-t border-line pt-1"><Button variant="ghost" size="sm" onClick={() => onChange(DEFAULT_COLUMNS)}>Reset to default</Button></div>
        </div>
      </>}
    </div>
  );
}

export function VacancyTable({ rows, columns = DEFAULT_COLUMNS, onQuickUpdate, empty = 'No vacancies match these filters.', maxHeight }: { rows: any[]; columns?: string[]; onQuickUpdate?: (v: any) => void; empty?: string; maxHeight?: string }) {
  const nav = useNavigate();
  const { user, can } = useAuth();
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const cols = useMemo(() => columns.map((k) => COLUMNS.find((c) => c.key === k)!).filter(Boolean), [columns]);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const c = COLUMNS.find((x) => x.key === sort.key);
    if (!c?.sort) return rows;
    return [...rows].sort((a, b) => { const x = c.sort!(a), y = c.sort!(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }, [rows, sort]);
  const editable = (v: any) => can('vacancies.edit_all') || (can('vacancies.edit_own') && v.recruiterId === user?.id);

  return (
    <div className="overflow-auto rounded-b-2xl" style={{ maxHeight }}>
      <table className="data">
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={{ minWidth: c.min }} className={c.key === 'title' ? 'sticky-col' : undefined} aria-sort={sort?.key === c.key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}>
                {c.sort ? (
                  <button className="inline-flex items-center gap-1 uppercase tracking-[0.04em] hover:text-ink" onClick={() => setSort((s) => (s?.key === c.key ? (s.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 }))}>
                    {c.label}{sort?.key === c.key && (sort.dir === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                  </button>
                ) : c.label}
              </th>
            ))}
            <th className="w-10" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {sorted.map((v) => (
            <tr key={v.id} className="clickable" tabIndex={0} onClick={() => nav(`/vacancies/${v.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/vacancies/${v.id}`); }}>
              {cols.map((c) => <td key={c.key} className={c.key === 'title' ? 'sticky-col' : undefined}>{c.render(v)}</td>)}
              <td className="!pl-0 !pr-2 text-right">
                {onQuickUpdate && editable(v)
                  ? <button title="Update progress" aria-label={`Update progress for ${v.title}`} className="rounded-lg p-1.5 text-ink-3 hover:bg-accent-soft hover:text-accent" onClick={(e) => { e.stopPropagation(); onQuickUpdate(v); }}><PencilLine size={16} /></button>
                  : <ChevronRight size={16} className="ml-auto text-ink-3" />}
              </td>
            </tr>
          ))}
          {!sorted.length && <tr><td colSpan={cols.length + 1} className="!py-10 text-center text-ink-3">{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ───────────── Quick progress update ─────────────
export function QuickUpdate({ vacancy, onClose }: { vacancy: any; onClose: () => void }) {
  const meta = useMeta();
  const { run, busy } = useAct();
  const detail = vacancy.milestones ? vacancy : null;
  const [ms, setMs] = useState<any[] | null>(detail?.milestones ?? null);
  useEffect(() => {
    if (detail) return;
    let live = true;
    api(`/vacancies/${vacancy.id}`).then((d) => { if (live) setMs(d.milestones); }).catch(() => { if (live) setMs([]); });
    return () => { live = false; };
  }, [vacancy.id, detail]);
  const current = ms?.find((m) => m.status === 'in_progress')?.id ?? '';
  const init = { summary: '', health: vacancy.health, statusId: vacancy.statusId, stage: '', nextAction: vacancy.nextAction ?? '', actionOwner: vacancy.actionOwner ?? '',
    actionDeadline: vacancy.actionDeadline ?? '', blocker: vacancy.currentBlocker ?? '', supportRequired: vacancy.supportRequired ?? '', achievement: '', createAction: false };
  const [f, setF] = useState(init);
  const set = (k: keyof typeof init) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const stage = f.stage || String(current);
  const closed = meta.data?.statuses.find((s: any) => s.id === Number(f.statusId))?.category !== 'active';
  const nextChanged = f.nextAction.trim() !== (vacancy.nextAction ?? '') && f.nextAction.trim() !== '';

  async function save() {
    // Only what actually changed is sent; everything else stays as recorded.
    const body: Record<string, unknown> = { summary: f.summary };
    if (f.health !== vacancy.health) body.health = f.health;
    if (Number(f.statusId) !== vacancy.statusId) body.statusId = Number(f.statusId);
    if (stage && Number(stage) !== current) body.stageMilestoneId = Number(stage);
    const map = { nextAction: 'nextAction', actionOwner: 'actionOwner', actionDeadline: 'actionDeadline', blocker: 'currentBlocker', supportRequired: 'supportRequired' } as const;
    for (const [k, orig] of Object.entries(map)) if ((f as any)[k].trim() !== (vacancy[orig] ?? '')) body[k] = (f as any)[k].trim() || null;
    if (f.achievement.trim()) body.achievement = f.achievement.trim();
    if (f.createAction && f.nextAction.trim()) body.createAction = true;
    if (await run(() => api(`/vacancies/${vacancy.id}/updates`, { body }), 'Progress update saved')) onClose();
  }

  return (
    <Modal title="Update progress" subtitle={vacancy.title} onClose={onClose} width={660}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={f.summary.trim().length < 3} onClick={save}>Save update</Button></>}>
      <div className="space-y-4">
        <Field label="What changed?" required hint="One or two sentences are enough. The date and your name are recorded automatically.">
          <textarea className="field" autoFocus rows={2} value={f.summary} onChange={set('summary')} placeholder="e.g. Second interviews completed; hiring manager prefers candidate B." />
        </Field>
        <div>
          <span className="mb-1 block text-[12px] font-medium text-ink-2">Vacancy health</span>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {HEALTH_OPTIONS.map((h) => (
              <button key={h.value} type="button" disabled={closed} onClick={() => setF((x) => ({ ...x, health: h.value }))} aria-pressed={f.health === h.value}
                className={cx('flex items-center gap-1.5 rounded-[10px] border px-2.5 py-2 text-[13px] font-medium transition disabled:opacity-50', f.health === h.value ? 'border-accent bg-accent-soft' : 'border-line-2 bg-field hover:bg-hover')}>
                <StatusIcon k={h.value} size={15} />{h.label}
              </button>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current recruitment stage">
            <select className="field" value={stage} onChange={set('stage')} disabled={!ms}>
              {!ms && <option>Loading…</option>}
              {ms?.filter((m) => m.status !== 'skipped' || String(m.id) === stage).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </Field>
          <Field label="Vacancy status">
            <select className="field" value={f.statusId} onChange={set('statusId')}>
              {meta.data?.statuses.filter((s: any) => s.isActive || s.id === vacancy.statusId).map((s: any) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Next action"><input className="field" value={f.nextAction} onChange={set('nextAction')} placeholder="What happens next?" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Responsible person">
            <input className="field" list="owners" value={f.actionOwner} onChange={set('actionOwner')} placeholder="Who does it?" />
            <datalist id="owners">{[vacancy.hiringManager, ...(meta.data?.users ?? []).filter((u: any) => u.isActive).map((u: any) => u.name)].filter(Boolean).map((n: string) => <option key={n} value={n} />)}</datalist>
          </Field>
          <Field label="Deadline"><input type="date" className="field" value={f.actionDeadline} onChange={set('actionDeadline')} /></Field>
        </div>
        {nextChanged && (
          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" className="accent-[var(--accent)]" checked={f.createAction} onChange={(e) => setF((x) => ({ ...x, createAction: e.target.checked }))} />
            <CalendarClock size={15} /> Also add this next action to the Action Centre
          </label>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current blocker" hint="Leave empty if nothing is blocking."><textarea className="field" rows={2} value={f.blocker} onChange={set('blocker')} /></Field>
          <Field label="Support required" hint="What do you need from leadership?"><textarea className="field" rows={2} value={f.supportRequired} onChange={set('supportRequired')} /></Field>
        </div>
        <Field label="Latest achievement (optional)"><input className="field" value={f.achievement} onChange={set('achievement')} placeholder={vacancy.latestAchievement ?? 'e.g. Shortlist approved'} /></Field>
      </div>
    </Modal>
  );
}

// ───────────── Create / edit a vacancy record ─────────────
const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <fieldset className="mb-6"><legend className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">{title}</legend><div className="grid gap-3 sm:grid-cols-2">{children}</div></fieldset>
);

export function VacancyForm({ vacancy, onClose, onSaved }: { vacancy?: any; onClose: () => void; onSaved?: (v: any) => void }) {
  const meta = useMeta();
  const { user, can } = useAuth();
  const { run, busy } = useAct();
  const m = meta.data;
  const keys = ['greenhouseJobId', 'title', 'countryId', 'city', 'departmentId', 'jobFamily', 'vacancyType', 'taTeamId', 'recruiterId', 'hiringManager', 'hiringManagerEmail',
    'departmentOwner', 'stakeholders', 'openingDate', 'targetHireDate', 'priority', 'statusId', 'health', 'progressUpdate', 'latestAchievement', 'nextAction', 'actionOwner',
    'actionDeadline', 'currentBlocker', 'supportRequired', 'internalNotes', 'closureDate'];
  const [f, setF] = useState<Record<string, any>>(() => {
    const base: Record<string, any> = Object.fromEntries(keys.map((k) => [k, vacancy?.[k] ?? '']));
    if (!vacancy) Object.assign(base, { priority: 'medium', health: 'on_track', taTeamId: m?.primaryTeam?.id ?? '', recruiterId: user?.role === 'recruiter' ? user.id : '',
      statusId: m?.statuses.find((s: any) => s.category === 'active')?.id ?? '', milestoneTemplateId: m?.templates.find((t: any) => t.isDefault)?.id ?? '' });
    return base;
  });
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const ids = ['countryId', 'departmentId', 'taTeamId', 'recruiterId', 'statusId', 'milestoneTemplateId'];
  const input = (k: string, label: string, props: Record<string, unknown> = {}, cls?: string) => <Field label={label} className={cls} required={k === 'title'}><input className="field" value={f[k] ?? ''} onChange={set(k)} {...props} /></Field>;
  const area = (k: string, label: string, hint?: string) => <Field label={label} hint={hint} className="sm:col-span-2"><textarea className="field" rows={2} value={f[k] ?? ''} onChange={set(k)} /></Field>;
  const select = (k: string, label: string, options: { id: any; label: string }[], blank?: string, disabled?: boolean) => (
    <Field label={label}><select className="field" value={f[k] ?? ''} onChange={set(k)} disabled={disabled}>
      {blank !== undefined && <option value="">{blank}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select></Field>
  );
  const listInput = (k: string, label: string, list: string[]) => (
    <Field label={label}><input className="field" list={`dl-${k}`} value={f[k] ?? ''} onChange={set(k)} /><datalist id={`dl-${k}`}>{list.map((o) => <option key={o} value={o} />)}</datalist></Field>
  );

  async function save() {
    const body: Record<string, unknown> = {};
    for (const k of Object.keys(f)) {
      const v = ids.includes(k) ? (f[k] === '' ? null : Number(f[k])) : typeof f[k] === 'string' ? f[k].trim() : f[k];
      if (!vacancy) { if (v !== '' && v !== null) body[k] = v; } else if ((v === '' ? null : v) !== (vacancy[k] ?? null) && k !== 'milestoneTemplateId') body[k] = v === '' ? null : v;
    }
    const out = await run(() => api(vacancy ? `/vacancies/${vacancy.id}` : '/vacancies', { method: vacancy ? 'PATCH' : 'POST', body }), vacancy ? 'Vacancy saved' : 'Vacancy created');
    if (out) { onSaved?.(out); onClose(); }
  }
  if (!m) return null;
  const recruiters = m.users.filter((u: any) => u.isActive && u.role !== 'viewer' || u.id === vacancy?.recruiterId).map((u: any) => ({ id: u.id, label: u.name }));
  const active = (list: any[], cur: any) => list.filter((x) => x.isActive || x.id === cur).map((x) => ({ id: x.id, label: x.name ?? x.label }));

  return (
    <Drawer title={vacancy ? 'Edit vacancy record' : 'New vacancy'} subtitle={vacancy?.title ?? 'Add a vacancy handled by the team'} onClose={onClose} width={680}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!String(f.title).trim()} onClick={save}>{vacancy ? 'Save changes' : 'Create vacancy'}</Button></>}>
      <Group title="Identification">
        {input('title', 'Job title', { autoFocus: !vacancy }, 'sm:col-span-2')}
        {input('greenhouseJobId', 'Greenhouse job ID', { placeholder: 'Links this record to Greenhouse' })}
        {select('departmentId', 'Department', active(m.departments, vacancy?.departmentId), '—')}
        {select('countryId', 'Country (vacancy location)', active(m.countries, vacancy?.countryId), '—')}
        {input('city', 'City')}
        {listInput('jobFamily', 'Job family', m.jobFamilies)}
        {listInput('vacancyType', 'Vacancy type', m.vacancyTypes)}
      </Group>
      <Group title="Ownership">
        {select('taTeamId', 'Responsible TA team', active(m.teams, vacancy?.taTeamId))}
        {select('recruiterId', 'Recruiter', recruiters, 'Unassigned', !can('vacancies.assign'))}
        {listInput('hiringManager', 'Hiring manager', m.hiringManagers)}
        {input('hiringManagerEmail', 'Hiring manager email', { type: 'email' })}
        {input('departmentOwner', 'Department owner')}
        {input('stakeholders', 'Additional stakeholders')}
      </Group>
      <Group title="Recruitment information">
        {input('openingDate', 'Opening date', { type: 'date' })}
        {input('targetHireDate', 'Target hiring date', { type: 'date' })}
        {select('priority', 'Priority', [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'critical', label: 'Critical' }])}
        {select('statusId', 'Vacancy status', active(m.statuses, vacancy?.statusId))}
        {select('health', 'Vacancy health', HEALTH_OPTIONS.map((h) => ({ id: h.value, label: h.label })))}
        {!vacancy && select('milestoneTemplateId', 'Milestone template', m.templates.map((t: any) => ({ id: t.id, label: `${t.name} (${t.items.length} milestones)` })))}
        {vacancy && input('closureDate', 'Closure date', { type: 'date' })}
      </Group>
      <Group title="Operational tracking">
        {area('progressUpdate', 'Progress update')}
        {area('latestAchievement', 'Latest achievement')}
        {input('nextAction', 'Next action', {}, 'sm:col-span-2')}
        {input('actionOwner', 'Action owner')}
        {input('actionDeadline', 'Action deadline', { type: 'date' })}
        {area('currentBlocker', 'Current blocker')}
        {area('supportRequired', 'Support required')}
        {can('notes.view') && area('internalNotes', 'Internal notes', 'Visible to the TA team and leadership only.')}
      </Group>
    </Drawer>
  );
}
