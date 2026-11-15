import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CircleAlert, CircleCheck, PlugZap, Plus, RefreshCw, Star, Trash2, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorNote, Field, Loading, Modal, Row, SectionTitle, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useAct, useMeta } from '../lib/app';
import { cx, fmtDateTime } from '../lib/format';

// ───────────── Reference data ─────────────
const CATEGORY: Record<string, string> = { active: 'Active (recruitment in progress)', on_hold: 'On hold', filled: 'Filled', cancelled: 'Cancelled' };
const REF_TYPES: { key: string; title: string; hint: string; status?: boolean; iso?: boolean }[] = [
  { key: 'statuses', title: 'Vacancy statuses', hint: 'Labels are yours; the category drives KPIs and risk rules.', status: true },
  { key: 'departments', title: 'Departments', hint: 'Used for filtering and reporting.' },
  { key: 'countries', title: 'Countries', hint: 'Where a vacancy is located — independent of the TA team that recruits for it.', iso: true },
  { key: 'teams', title: 'TA teams', hint: 'The team responsible for recruitment.' },
  { key: 'jobFamilies', title: 'Job families', hint: 'Suggestions offered in the vacancy form.' },
  { key: 'vacancyTypes', title: 'Vacancy types', hint: 'Suggestions offered in the vacancy form.' },
];

function RefList({ type, items }: { type: (typeof REF_TYPES)[number]; items: any[] }) {
  const { run, busy } = useAct();
  const [name, setName] = useState('');
  const [category, setCategory] = useState('active');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const label = (x: any) => x.name ?? x.label;
  const add = async () => { if (await run(() => api(`/admin/reference/${type.key}`, { body: { name: name.trim(), ...(type.status ? { category } : {}) } }), `${name.trim()} added`)) setName(''); };
  const patch = (id: number, body: Record<string, unknown>, ok: string) => run(() => api(`/admin/reference/${type.key}/${id}`, { method: 'PATCH', body }), ok);
  return (
    <Card className="flex flex-col p-5">
      <SectionTitle right={<span className="text-[12px] text-ink-3">{items.filter((i) => i.isActive).length} active</span>}>{type.title}</SectionTitle>
      <p className="-mt-1.5 mb-3 text-[12.5px] text-ink-3">{type.hint}</p>
      <ul className="-mx-2 max-h-[300px] flex-1 overflow-y-auto">
        {items.map((x) => (
          <li key={x.id} className={cx('group flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13.5px] hover:bg-hover', !x.isActive && 'opacity-50')}>
            {editing?.id === x.id ? (
              <input className="field !py-1" autoFocus value={editing!.name} onChange={(e) => setEditing({ id: x.id, name: e.target.value })}
                onKeyDown={async (e) => {
                  const next = e.currentTarget.value.trim();
                  if (e.key === 'Enter' && next) { await patch(x.id, { name: next }, 'Renamed'); setEditing(null); }
                  if (e.key === 'Escape') setEditing(null);
                }} onBlur={() => setEditing(null)} />
            ) : (
              <button className="min-w-0 flex-1 truncate text-left" title="Click to rename" onClick={() => setEditing({ id: x.id, name: label(x) })}>
                {label(x)}{type.iso && x.isoCode && <span className="num ml-2 text-[11.5px] text-ink-3">{x.isoCode}</span>}
              </button>
            )}
            {type.status && <Tag>{CATEGORY[x.category].split(' ')[0]}{x.category === 'on_hold' ? ' hold' : ''}</Tag>}
            {x.inUse > 0 && <span className="num text-[11.5px] text-ink-3" title="Vacancies using this value">{x.inUse} in use</span>}
            <button className="rounded-md px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-hover hover:text-ink" onClick={() => patch(x.id, { isActive: !x.isActive }, x.isActive ? 'Deactivated — no longer offered for new records' : 'Reactivated')}>{x.isActive ? 'Deactivate' : 'Activate'}</button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2 border-t border-line pt-3">
        <input className="field" placeholder={`Add ${type.title.toLowerCase().replace(/s$/, '').replace(/ie$/, 'y')}…`} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void add(); }} />
        {type.status && <select className="field !w-auto" aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>{Object.entries(CATEGORY).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>}
        <Button icon={Plus} busy={busy} disabled={!name.trim()} onClick={add}>Add</Button>
      </div>
    </Card>
  );
}

export function ReferenceTab() {
  const q = useQuery({ queryKey: ['admin', 'reference'], queryFn: () => api<any>('/admin/reference') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  return <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">{REF_TYPES.map((t) => <RefList key={t.key} type={t} items={q.data[t.key]} />)}</div>;
}

// ───────────── Milestone templates ─────────────
function TemplateEditor({ tpl, onClose }: { tpl: any | null; onClose: () => void }) {
  const { run, busy } = useAct();
  const [f, setF] = useState(() => ({ name: tpl?.name ?? '', description: tpl?.description ?? '', isDefault: tpl?.isDefault ?? false, isActive: tpl?.isActive ?? true,
    items: (tpl?.items ?? [{ name: 'Vacancy intake', defaultOffsetDays: 0 }]).map((i: any) => ({ name: i.name, defaultOffsetDays: i.defaultOffsetDays ?? '' })) as { name: string; defaultOffsetDays: number | '' }[] }));
  const upd = (i: number, patch: Record<string, unknown>) => setF((x) => ({ ...x, items: x.items.map((it, j) => (j === i ? { ...it, ...patch } : it)) }));
  const move = (i: number, d: number) => setF((x) => { const n = [...x.items]; const [it] = n.splice(i, 1); n.splice(i + d, 0, it); return { ...x, items: n }; });
  const save = async () => {
    const body = { name: f.name.trim(), description: f.description.trim() || null, isDefault: f.isDefault, isActive: f.isActive,
      items: f.items.map((i) => ({ name: i.name.trim(), defaultOffsetDays: i.defaultOffsetDays === '' ? null : Number(i.defaultOffsetDays) })) };
    if (await run(() => api(tpl ? `/admin/templates/${tpl.id}` : '/admin/templates', { method: tpl ? 'PUT' : 'POST', body }), 'Template saved')) onClose();
  };
  return (
    <Modal title={tpl ? 'Edit milestone template' : 'New milestone template'} subtitle="Applies to vacancies created from now on. Existing vacancies keep their own milestones." onClose={onClose} width={640}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name.trim() || f.items.some((i) => !i.name.trim()) || !f.items.length} onClick={save}>Save template</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Template name" required><input className="field" autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="When to use it"><input className="field" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
      <div className="mt-4 text-[12px] font-medium text-ink-2">Milestones in order <span className="font-normal text-ink-3">· “planned day” is the number of days after the opening date by which the milestone should be reached</span></div>
      <ul className="mt-2 space-y-1.5">
        {f.items.map((it, i) => (
          <li key={i} className="flex items-center gap-2">
            <span className="num w-5 text-right text-[12px] text-ink-3">{i + 1}</span>
            <button aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-ink-3 hover:bg-hover disabled:opacity-30"><ArrowUp size={14} /></button>
            <button aria-label="Move down" disabled={i === f.items.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-ink-3 hover:bg-hover disabled:opacity-30"><ArrowDown size={14} /></button>
            <input className="field" aria-label="Milestone name" value={it.name} onChange={(e) => upd(i, { name: e.target.value })} />
            <input className="field !w-24" type="number" min={0} aria-label="Planned day" placeholder="Day" value={it.defaultOffsetDays} onChange={(e) => upd(i, { defaultOffsetDays: e.target.value === '' ? '' : Number(e.target.value) })} />
            <button aria-label="Remove" onClick={() => setF((x) => ({ ...x, items: x.items.filter((_, j) => j !== i) }))} className="rounded p-1.5 text-ink-3 hover:bg-hover hover:text-crit"><Trash2 size={15} /></button>
          </li>
        ))}
      </ul>
      <Button className="mt-2.5" size="sm" icon={Plus} onClick={() => setF((x) => ({ ...x, items: [...x.items, { name: '', defaultOffsetDays: '' }] }))}>Add milestone</Button>
      <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
        <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" className="accent-[var(--accent)]" checked={f.isDefault} onChange={(e) => setF({ ...f, isDefault: e.target.checked })} />Default for new vacancies</label>
        {tpl && <label className="flex cursor-pointer items-center gap-2"><input type="checkbox" className="accent-[var(--accent)]" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />Available for selection</label>}
      </div>
    </Modal>
  );
}

export function TemplatesTab() {
  const q = useQuery({ queryKey: ['admin', 'reference'], queryFn: () => api<any>('/admin/reference') });
  const [edit, setEdit] = useState<any>(undefined);
  if (q.isLoading) return <Loading />;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-3xl text-[13px] text-ink-2">Templates define the operational milestones a new vacancy starts with. Recruiters can still add, skip, rename or reorder milestones on any single vacancy, because not every role follows the same sequence. These are not Greenhouse application stages.</p>
        <Button variant="primary" icon={Plus} onClick={() => setEdit(null)}>New template</Button>
      </div>
      <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
        {q.data.templates.map((t: any) => (
          <Card key={t.id} className={cx('p-5', !t.isActive && 'opacity-60')}>
            <div className="flex items-start gap-2"><h3 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug">{t.name}</h3>{t.isDefault && <Tag tone="accent"><Star size={11} /> Default</Tag>}{!t.isActive && <Tag>Hidden</Tag>}</div>
            {t.description && <p className="mt-1 text-[12.5px] text-ink-3">{t.description}</p>}
            <ol className="mt-3 space-y-1">
              {t.items.map((i: any, n: number) => <li key={i.id} className="flex items-center gap-2.5 text-[13px]"><span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-hover text-[11px] text-ink-2">{n + 1}</span><span className="flex-1">{i.name}</span>{i.defaultOffsetDays !== null && <span className="num text-[11.5px] text-ink-3">day {i.defaultOffsetDays}</span>}</li>)}
            </ol>
            <Button className="mt-4" size="sm" onClick={() => setEdit(t)}>Edit template</Button>
          </Card>
        ))}
      </div>
      {edit !== undefined && <TemplateEditor tpl={edit} onClose={() => setEdit(undefined)} />}
    </>
  );
}

// ───────────── Risk rules ─────────────
const PARAM_LABEL: Record<string, string> = { days: 'Threshold (days)', graceDays: 'Grace period (days)', warnDays: 'Warn when target date is within (days)', gapPoints: 'Gap between time elapsed and milestones done (percentage points)' };
export function RulesTab() {
  const { run, busy } = useAct();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api<any>('/admin/settings') });
  const [cfg, setCfg] = useState<Record<string, any> | null>(null);
  useEffect(() => { if (q.data) setCfg(q.data.riskRules); }, [q.data]);
  if (q.isLoading || !cfg) return <Loading />;
  const set = (k: string, patch: Record<string, unknown>) => setCfg((c) => ({ ...c!, [k]: { ...c![k], ...patch } }));
  const dirty = JSON.stringify(cfg) !== JSON.stringify(q.data.riskRules);
  return (
    <Card solid className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="max-w-3xl text-[13px] text-ink-2">Each rule compares recorded dates and fields with a threshold you control. There is no scoring model: an alert always says exactly which fact triggered it. <Link to="/risks" className="text-accent hover:underline">Open the risk monitor</Link></p>
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => run(() => api('/admin/settings/risk.rules', { method: 'PUT', body: cfg }), 'Risk rules saved')}>Save rules</Button>
      </div>
      <ul className="divide-y divide-line border-t border-line">
        {q.data.riskRuleDefinitions.map((r: any) => (
          <li key={r.key} className="flex flex-wrap items-start gap-x-6 gap-y-3 px-5 py-4">
            <label className="flex min-w-[280px] flex-1 cursor-pointer items-start gap-3">
              <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={cfg[r.key]?.enabled !== false} onChange={(e) => set(r.key, { enabled: e.target.checked })} />
              <span><span className="flex items-center gap-2 text-[14px] font-medium">{r.label}<Tag tone={r.severity === 'high' ? 'crit' : r.severity === 'medium' ? 'warn' : 'neutral'}>{r.severity === 'low' ? 'For information' : r.severity[0].toUpperCase() + r.severity.slice(1)}</Tag></span>
                <span className="mt-0.5 block text-[12.5px] text-ink-3">{r.description}</span></span>
            </label>
            <div className="flex flex-wrap gap-3">
              {Object.keys(r.params).map((p) => (
                <label key={p} className="w-[230px] text-[12px] text-ink-2">{PARAM_LABEL[p] ?? p}
                  <input type="number" min={0} max={365} className="field mt-1" disabled={cfg[r.key]?.enabled === false} value={cfg[r.key]?.[p] ?? r.params[p]} onChange={(e) => set(r.key, { [p]: Number(e.target.value) })} />
                </label>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ───────────── Integrations ─────────────
const RUN_TONE: Record<string, 'good' | 'warn' | 'crit' | 'neutral'> = { success: 'good', partial: 'warn', failed: 'crit', running: 'neutral' };
const RUN_LABEL: Record<string, string> = { success: 'Completed', partial: 'Completed with issues', failed: 'Failed', running: 'Running' };

export function IntegrationsTab() {
  const meta = useMeta();
  const { run, busy } = useAct();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => api<any>('/integrations') });
  const runs = useQuery({ queryKey: ['integrations', 'runs'], queryFn: () => api<any[]>('/integrations/greenhouse/runs') });
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [assignee, setAssignee] = useState<Record<string, string>>({});
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const g = q.data.greenhouse;
  const last = runs.data?.[0];
  const setMode = (mode: string, autoApply = g.autoApply) => run(() => api('/integrations/greenhouse', { method: 'PUT', body: { mode, autoApply } }), 'Greenhouse settings saved');
  const State = ({ ok, children }: { ok: boolean; children: ReactNode }) => <span className="inline-flex items-start gap-1.5">{ok ? <CircleCheck size={15} className="mt-0.5 shrink-0 text-good" /> : <CircleAlert size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--idle)' }} />}<span>{children}</span></span>;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <Card solid className="self-start overflow-hidden">
        <div className="p-5">
          <SectionTitle right={<Tag tone={g.mode === 'live' ? 'good' : g.mode === 'demo' ? 'accent' : 'neutral'}>{g.mode === 'live' ? 'Live' : g.mode === 'demo' ? 'Simulated data' : 'Off — manual operation'}</Tag>}>Greenhouse (system of record)</SectionTitle>
          <p className="text-[13px] text-ink-2">Greenhouse stays authoritative for jobs, candidates and applications. Talent Radar links records by Greenhouse job ID and stores only a read-only summary per vacancy — job title and status, hiring team names and application counts by stage. No candidate profile is copied.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            {[['off', 'Off', 'Manual operation. Nothing is called.'], ['demo', 'Simulated', 'Fictional data, to demonstrate the workflow before IT approval.'], ['live', 'Live', 'Harvest API v3. Requires credentials configured by IT.']].map(([k, l, d]) => (
              <button key={k} disabled={busy} onClick={() => setMode(k)} aria-pressed={g.mode === k} className={cx('rounded-xl border px-3.5 py-3 text-left transition', g.mode === k ? 'border-accent bg-accent-soft' : 'border-line-2 bg-field hover:bg-hover')}>
                <span className="block text-[13.5px] font-semibold">{l}</span><span className="mt-0.5 block text-[12px] leading-snug text-ink-3">{d}</span>
              </button>
            ))}
          </div>
          <label className="mt-3 flex cursor-pointer items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={g.autoApply} disabled={busy || g.mode === 'off'} onChange={(e) => setMode(g.mode, e.target.checked)} />
            <span>Apply Greenhouse’s job title and hiring manager to the tracker automatically <span className="text-ink-3">(off: differences are shown on the vacancy and nothing is changed; every applied value is written to the audit log)</span></span></label>
          <dl className="mt-4 border-t border-line pt-3">
            <Row label="API credentials"><State ok={g.credentialsConfigured}>{g.credentialsConfigured ? 'Configured in the hosting environment' : 'Not configured — IT must set GREENHOUSE_CLIENT_ID and GREENHOUSE_CLIENT_SECRET'}</State></Row>
            <Row label="Token endpoint"><span className="num break-all text-[12.5px]">{g.tokenUrl}</span></Row>
            <Row label="API base URL"><span className="num break-all text-[12.5px]">{g.baseUrl}</span></Row>
            <Row label="Linked vacancies">{g.linkedVacancies} with a Greenhouse job ID · {g.syncedVacancies} synchronised at least once</Row>
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="primary" icon={RefreshCw} busy={busy} disabled={g.mode === 'off'} onClick={async () => { await run(() => api('/integrations/greenhouse/sync', { method: 'POST' }), 'Synchronisation finished'); void runs.refetch(); }}>Synchronise now</Button>
            <Button icon={PlugZap} disabled={!g.credentialsConfigured} onClick={async () => setTest(await api('/integrations/greenhouse/test', { method: 'POST' }).catch((e) => ({ ok: false, message: e.message })))}>Test live connection</Button>
            {test && <span className="inline-flex items-center gap-1.5 text-[13px]">{test.ok ? <CircleCheck size={15} className="text-good" /> : <TriangleAlert size={15} className="text-crit" />}{test.message}</span>}
          </div>
        </div>

        {last && (
          <div className="border-t border-line p-5">
            <div className="flex flex-wrap items-center gap-2"><h3 className="text-[14px] font-semibold">Last synchronisation</h3><Tag tone={RUN_TONE[last.status]}>{RUN_LABEL[last.status]}</Tag>
              <span className="text-[12.5px] text-ink-3">{fmtDateTime(last.startedAt)} · {last.mode === 'demo' ? 'simulated data' : last.mode} · {last.triggeredByName ?? 'scheduled'}</span></div>
            {last.stats && <p className="mt-2 text-[13px] text-ink-2">{last.stats.jobsRead} jobs read · {last.stats.vacanciesUpdated} of {last.stats.vacanciesLinked} linked vacancies refreshed · {last.stats.mismatches} differences found · {last.stats.valuesApplied} values applied · {last.stats.unlinkedJobs} open jobs not in the tracker</p>}
            {last.errors?.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {last.errors.map((e: any, i: number) => (
                  <li key={i} className="flex items-start gap-2 text-[13px]">{e.level === 'error' ? <CircleAlert size={15} className="mt-0.5 shrink-0 text-crit" /> : <TriangleAlert size={15} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />}
                    <span>{e.message}{e.vacancyId && <> <Link to={`/vacancies/${e.vacancyId}`} className="text-accent hover:underline">Open vacancy</Link></>}</span></li>
                ))}
              </ul>
            )}
            {last.unlinked?.length > 0 && (
              <div className="mt-4">
                <h4 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-3">Open in Greenhouse but not in the tracker</h4>
                <ul className="mt-2 space-y-2">
                  {last.unlinked.map((j: any) => (
                    <li key={j.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-field px-3 py-2">
                      <span className="min-w-[200px] flex-1"><span className="block text-[13.5px] font-medium">{j.title}</span><span className="num block text-[12px] text-ink-3">GH {j.id} · {[j.department, j.office].filter(Boolean).join(' · ')} · {j.activeApplications} active applications</span></span>
                      <select className="field !w-auto" aria-label="Recruiter" value={assignee[j.id] ?? ''} onChange={(e) => setAssignee((a) => ({ ...a, [j.id]: e.target.value }))}><option value="">Unassigned</option>{meta.data?.users.filter((u: any) => u.isActive && u.role !== 'viewer').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
                      <Button size="sm" icon={Plus} busy={busy} onClick={async () => { await run(() => api('/integrations/greenhouse/link', { body: { runId: last.id, jobId: j.id, recruiterId: assignee[j.id] ? Number(assignee[j.id]) : null } }), 'Added to the tracker'); }}>Add to tracker</Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {runs.data && runs.data.length > 1 && (
          <div className="border-t border-line px-5 py-4">
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-3">Earlier runs</h3>
            <ul className="space-y-1 text-[12.5px] text-ink-2">{runs.data.slice(1, 8).map((r) => <li key={r.id} className="flex gap-3"><span className="num w-32 shrink-0">{fmtDateTime(r.startedAt)}</span><Tag tone={RUN_TONE[r.status]}>{RUN_LABEL[r.status]}</Tag><span className="text-ink-3">{r.errors?.length ?? 0} issue(s)</span></li>)}</ul>
          </div>
        )}
      </Card>

      <div className="space-y-5">
        <Card className="p-5">
          <SectionTitle>Sign-in</SectionTitle>
          <dl>
            <Row label="Single sign-on"><State ok={q.data.sso.enabled}>{q.data.sso.enabled ? 'Enabled' : 'Not configured'}</State></Row>
            {q.data.sso.issuer && <Row label="Identity provider"><span className="break-all text-[12.5px]">{q.data.sso.issuer}</span></Row>}
            <Row label="Redirect URI to register"><span className="num break-all text-[12.5px]">{q.data.sso.redirectUri}</span></Row>
            <Row label="Password sign-in">{q.data.sso.localLogin ? 'Allowed' : 'Disabled (SSO only)'}</Row>
            <Row label="New SSO users">{q.data.sso.autoProvision ? 'Created automatically at first sign-in' : 'Must be added by an administrator first'}</Row>
          </dl>
        </Card>
        <Card className="p-5">
          <SectionTitle>AI wording (optional)</SectionTitle>
          <p className="text-[13px] text-ink-2"><State ok={q.data.ai.configured}>{q.data.ai.description}</State></p>
          <p className="mt-2 text-[12.5px] text-ink-3">All tracking, alerts, reports and assistant summaries work without any AI service. If IT connects a company-approved model endpoint, it may only re-word recorded facts, and its text is discarded unless every figure can be traced back to them.</p>
        </Card>
        <Card className="p-5">
          <SectionTitle>Microsoft Teams</SectionTitle>
          <p className="text-[13px] text-ink-2"><State ok={q.data.teams.configured}>{q.data.teams.configured ? 'Channel webhook configured' : 'Not configured — IT sets TEAMS_WEBHOOK_URL'}</State></p>
          <Button className="mt-3" size="sm" disabled={!q.data.teams.configured} busy={busy} onClick={() => run(() => api('/integrations/teams/post-weekly', { method: 'POST' }), 'Weekly headline posted to Teams')}>Post this week’s headline to the channel</Button>
        </Card>
        <Card className="p-5">
          <SectionTitle>Not integrated by design</SectionTitle>
          <p className="text-[13px] text-ink-2">LinkedIn Recruiter and BrightHire remain separate tools. Sourcing and interview intelligence stay there; Talent Radar only tracks operational progress and ownership.</p>
        </Card>
      </div>
    </div>
  );
}
