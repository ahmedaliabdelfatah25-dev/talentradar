import { useQuery } from '@tanstack/react-query';
import { Copy, FlaskConical, KeyRound, Plus, Search, UserPlus } from 'lucide-react';
import { useEffect, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button, Card, DemoTag, ErrorNote, Field, Loading, Modal, PageHeader, SectionTitle, StatusPill, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useAct, useAuth, useMeta, useToast } from '../lib/app';
import { cx, fmtDateTime } from '../lib/format';
import { IntegrationsTab, ReferenceTab, RulesTab, TemplatesTab } from './AdminConfig';

const ROLES: Record<string, string> = { admin: 'Administrator', leadership: 'Leadership', recruiter: 'Recruiter', viewer: 'Viewer' };

// ───────────── Users ─────────────
function UsersTab() {
  const meta = useMeta();
  const toast = useToast();
  const { run, busy } = useAct();
  const q = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<any[]>('/admin/users') });
  const [edit, setEdit] = useState<any>(undefined);
  const [f, setF] = useState<Record<string, any>>({});
  const [temp, setTemp] = useState<{ name: string; password: string } | null>(null);
  useEffect(() => { if (edit !== undefined) setF(edit ? { email: edit.email, name: edit.name, role: edit.role, jobTitle: edit.jobTitle ?? '', taTeamId: edit.taTeamId ?? '', isActive: edit.isActive } : { email: '', name: '', role: 'recruiter', jobTitle: '', taTeamId: meta.data?.primaryTeam?.id ?? '', isActive: true }); }, [edit]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    const body = { email: f.email, name: f.name, role: f.role, jobTitle: f.jobTitle || null, taTeamId: f.taTeamId ? Number(f.taTeamId) : null, isActive: f.isActive };
    const r = await run(() => api<any>(edit ? `/admin/users/${edit.id}` : '/admin/users', { method: edit ? 'PATCH' : 'POST', body }), edit ? 'User saved' : 'User created');
    if (!r) return;
    if (!edit && r.temporaryPassword) setTemp({ name: f.name, password: r.temporaryPassword });
    setEdit(undefined);
  }
  async function resetPw(u: any) {
    if (!window.confirm(`Reset the password for ${u.name}? They will be signed out and must choose a new password.`)) return;
    const r = await run(() => api<any>(`/admin/users/${u.id}/reset-password`, { method: 'POST' }));
    if (r) setTemp({ name: u.name, password: r.temporaryPassword });
  }
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  return (
    <>
      <Card solid className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4"><p className="text-[13px] text-ink-2">{q.data!.filter((u) => u.isActive).length} active users. Roles decide what each person can see and change.</p><Button variant="primary" icon={UserPlus} onClick={() => setEdit(null)}>Add user</Button></div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Name</th><th>Role</th><th>Open vacancies</th><th>Sign-in</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
            <tbody>
              {q.data!.map((u) => (
                <tr key={u.id} className={u.isActive ? '' : 'opacity-55'}>
                  <td><div className="font-medium">{u.name} {u.isDemo && <DemoTag />}</div><div className="text-[12px] text-ink-3">{u.email}{u.jobTitle ? ` · ${u.jobTitle}` : ''}</div></td>
                  <td>{ROLES[u.role]}</td><td className="num">{u.openVacancies}</td>
                  <td className="text-[12.5px] text-ink-2">{[u.hasPassword && 'Password', u.ssoLinked && 'SSO'].filter(Boolean).join(' + ') || 'SSO at first sign-in'}</td>
                  <td className="whitespace-nowrap text-[12.5px]">{u.lastLoginAt ? fmtDateTime(u.lastLoginAt) : <span className="text-ink-3">Never</span>}</td>
                  <td>{u.isActive ? <Tag tone="good">Active</Tag> : <Tag>Deactivated</Tag>}</td>
                  <td className="whitespace-nowrap text-right"><Button size="sm" onClick={() => setEdit(u)}>Edit</Button> <Button size="sm" variant="ghost" icon={KeyRound} onClick={() => resetPw(u)} title="Reset password" aria-label={`Reset password for ${u.name}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {edit !== undefined && (
        <Modal title={edit ? 'Edit user' : 'Add user'} onClose={() => setEdit(undefined)} width={520}
          footer={<><Button variant="ghost" onClick={() => setEdit(undefined)}>Cancel</Button><Button variant="primary" busy={busy} disabled={!f.name?.trim() || !f.email?.trim()} onClick={save}>{edit ? 'Save' : 'Create user'}</Button></>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Full name" required className="sm:col-span-2"><input className="field" autoFocus value={f.name ?? ''} onChange={set('name')} /></Field>
            <Field label="Work email" required className="sm:col-span-2"><input className="field" type="email" value={f.email ?? ''} onChange={set('email')} /></Field>
            <Field label="Role"><select className="field" value={f.role ?? 'recruiter'} onChange={set('role')}>{Object.entries(ROLES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></Field>
            <Field label="TA team"><select className="field" value={f.taTeamId ?? ''} onChange={set('taTeamId')}><option value="">None</option>{meta.data?.teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
            <Field label="Job title" className="sm:col-span-2"><input className="field" value={f.jobTitle ?? ''} onChange={set('jobTitle')} /></Field>
            {edit && <label className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2"><input type="checkbox" className="accent-[var(--accent)]" checked={!!f.isActive} onChange={(e) => setF((x) => ({ ...x, isActive: e.target.checked }))} />Account is active (deactivating signs the person out immediately)</label>}
          </div>
        </Modal>
      )}
      {temp && (
        <Modal title="Temporary password" subtitle={`Give this to ${temp.name} through a private channel. It is shown only once and must be changed at first sign-in.`} onClose={() => setTemp(null)} width={460} footer={<Button variant="primary" onClick={() => setTemp(null)}>Done</Button>}>
          <div className="flex items-center gap-2"><code className="num flex-1 rounded-xl border border-line bg-field px-3 py-2.5 text-[15px]">{temp.password}</code>
            <Button icon={Copy} onClick={() => navigator.clipboard.writeText(temp.password).then(() => toast('ok', 'Copied'), () => toast('error', 'Copy failed — select it manually'))}>Copy</Button></div>
        </Modal>
      )}
    </>
  );
}

// ───────────── Vacancy assignment ─────────────
function AssignTab() {
  const meta = useMeta();
  const { run, busy } = useAct();
  const q = useQuery({ queryKey: ['vacancies', 'all'], queryFn: () => api<any[]>('/vacancies') });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  if (q.isLoading) return <Loading />;
  const open = q.data!.filter((v) => ['active', 'on_hold'].includes(v.statusCategory) && (!from || (v.recruiter ?? 'Unassigned') === from));
  const recruiters = [...new Set(q.data!.map((v) => v.recruiter ?? 'Unassigned'))].sort();
  const toggle = (id: number) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const assign = async () => { if (await run(() => api('/admin/assign', { body: { vacancyIds: [...sel], recruiterId: to === 'none' ? null : Number(to) } }), `${sel.size} ${sel.size === 1 ? 'vacancy' : 'vacancies'} reassigned`)) setSel(new Set()); };
  return (
    <Card solid className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        <select className="field !w-auto" aria-label="Current recruiter" value={from} onChange={(e) => { setFrom(e.target.value); setSel(new Set()); }}><option value="">All recruiters</option>{recruiters.map((r) => <option key={r}>{r}</option>)}</select>
        <span className="text-[13px] text-ink-3">{sel.size} selected</span>
        <span className="ml-auto flex flex-wrap items-center gap-2 text-[13px]">Assign to
          <select className="field !w-auto" aria-label="New recruiter" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option><option value="none">Unassigned</option>
            {meta.data?.users.filter((u: any) => u.isActive && u.role !== 'viewer').map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
          <Button variant="primary" busy={busy} disabled={!sel.size || !to} onClick={assign}>Assign</Button>
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="data">
          <thead><tr><th className="w-10"><input type="checkbox" aria-label="Select all" className="accent-[var(--accent)]" checked={open.length > 0 && sel.size === open.length} onChange={(e) => setSel(e.target.checked ? new Set(open.map((v) => v.id)) : new Set())} /></th><th>Vacancy</th><th>Location</th><th>Current recruiter</th><th>Stage</th><th>Status</th></tr></thead>
          <tbody>
            {open.map((v) => (
              <tr key={v.id} className="clickable" onClick={() => toggle(v.id)}>
                <td><input type="checkbox" aria-label={`Select ${v.title}`} className="accent-[var(--accent)]" checked={sel.has(v.id)} onChange={() => toggle(v.id)} onClick={(e) => e.stopPropagation()} /></td>
                <td className="font-medium">{v.title}</td><td>{[v.city, v.country].filter(Boolean).join(', ') || '—'}</td>
                <td>{v.recruiter ?? <Tag tone="warn">Unassigned</Tag>}</td><td>{v.currentStage ?? '—'}</td><td><StatusPill k={v.overall.key} label={v.overall.label} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ───────────── Permissions ─────────────
function PermissionsTab() {
  const { run, busy } = useAct();
  const q = useQuery({ queryKey: ['admin', 'permissions'], queryFn: () => api<any>('/admin/permissions') });
  const [m, setM] = useState<Record<string, string[]> | null>(null);
  useEffect(() => { if (q.data) setM(q.data.matrix); }, [q.data]);
  if (q.isLoading || !m) return <Loading />;
  const toggle = (role: string, perm: string) => setM((x) => ({ ...x!, [role]: x![role].includes(perm) ? x![role].filter((p) => p !== perm) : [...x![role], perm] }));
  const dirty = JSON.stringify(m) !== JSON.stringify(q.data.matrix);
  return (
    <Card solid className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"><p className="max-w-2xl text-[13px] text-ink-2">Tick what each role may do. Administrators always have every permission, and administration permissions cannot be given to other roles.</p>
        <Button variant="primary" busy={busy} disabled={!dirty} onClick={() => run(() => api('/admin/permissions', { method: 'PUT', body: { matrix: m } }), 'Permissions updated')}>Save permissions</Button></div>
      <div className="overflow-x-auto">
        <table className="data">
          <thead><tr><th>Permission</th>{q.data.roles.map((r: string) => <th key={r} className="!text-center">{ROLES[r]}</th>)}</tr></thead>
          <tbody>
            {q.data.permissions.map((p: any) => (
              <tr key={p.key}>
                <td><div>{p.label}</div><div className="num text-[11.5px] text-ink-3">{p.key}</div></td>
                {q.data.roles.map((r: string) => {
                  const locked = r === 'admin' || p.key.startsWith('admin.');
                  return <td key={r} className="text-center"><input type="checkbox" aria-label={`${ROLES[r]}: ${p.label}`} className="accent-[var(--accent)]" disabled={locked} checked={m[r].includes(p.key)} onChange={() => toggle(r, p.key)} /></td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ───────────── Audit log ─────────────
function AuditTab() {
  const [type, setType] = useState('');
  const [text, setText] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = async (reset: boolean) => {
    setLoading(true);
    const before = reset ? '' : `&before=${rows[rows.length - 1]?.id ?? ''}`;
    const page = await api<any[]>(`/audit?entityType=${type}&q=${encodeURIComponent(text)}${before}`).catch(() => []);
    setRows((r) => (reset ? page : [...r, ...page]));
    setDone(page.length < 100);
    setLoading(false);
  };
  useEffect(() => { const t = setTimeout(() => void load(true), 250); return () => clearTimeout(t); }, [type, text]); // eslint-disable-line react-hooks/exhaustive-deps
  const chg = (c: any) => Object.entries(c ?? {}).filter(([, v]: any) => v && typeof v === 'object' && 'to' in v).map(([k, v]: any) => `${v.label ?? k}: ${v.from ?? '—'} → ${v.to ?? '—'}`);
  return (
    <Card solid className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 px-5 py-4">
        <div className="relative min-w-[200px] flex-1 sm:max-w-[300px]"><Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" /><input className="field !pl-8" placeholder="Search summary or person…" value={text} onChange={(e) => setText(e.target.value)} /></div>
        <select className="field !w-auto" aria-label="Record type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All record types</option>
          {['vacancy', 'action', 'user', 'auth', 'import', 'report', 'reference', 'template', 'permissions', 'settings', 'integration'].map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
        </select>
        <span className="ml-auto text-[12.5px] text-ink-3">Append-only. Entries cannot be edited or deleted from the application.</span>
      </div>
      <div className="max-h-[calc(100vh-330px)] overflow-auto">
        <table className="data">
          <thead><tr><th>When</th><th>Who</th><th>Record</th><th>What happened</th></tr></thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="whitespace-nowrap text-[12.5px]">{fmtDateTime(a.at)}</td><td className="whitespace-nowrap">{a.userName ?? 'System'}</td>
                <td className="whitespace-nowrap"><Tag>{a.entityType}</Tag> <span className="text-[12px] text-ink-3">{String(a.action).replace(/_/g, ' ')}</span></td>
                <td className="min-w-[320px]">{a.vacancyId && a.vacancyTitle ? <Link className="font-medium hover:underline" to={`/vacancies/${a.vacancyId}`}>{a.vacancyTitle}: </Link> : null}{a.summary}
                  {chg(a.changes).length > 0 && <ul className="mt-0.5 text-[12px] text-ink-3">{chg(a.changes).slice(0, 6).map((c, i) => <li key={i}>{c}</li>)}</ul>}</td>
              </tr>
            ))}
            {!rows.length && !loading && <tr><td colSpan={4} className="!py-10 text-center text-ink-3">No audit entries match.</td></tr>}
          </tbody>
        </table>
      </div>
      {!done && <div className="border-t border-line px-5 py-3 text-center"><Button size="sm" busy={loading} onClick={() => load(false)}>Load older entries</Button></div>}
    </Card>
  );
}

// ───────────── Data: demo records and reporting settings ─────────────
function DataTab() {
  const meta = useMeta();
  const { run, busy } = useAct();
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api<any>('/admin/settings') });
  const [rep, setRep] = useState<any>(null);
  const [gen, setGen] = useState<any>(null);
  useEffect(() => { if (q.data) { setRep(q.data.report); setGen(q.data.general); } }, [q.data]);
  if (q.isLoading || !rep) return <Loading />;
  const removeDemo = async () => {
    if (!window.confirm('Remove all demonstration vacancies, actions and saved demo reports? Demo user accounts are deactivated (your own stays active). This cannot be undone.')) return;
    await run(() => api('/admin/demo-data', { method: 'DELETE' }), 'Demonstration data removed');
  };
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card className="p-5">
        <SectionTitle>Demonstration data</SectionTitle>
        <p className="flex items-start gap-2 text-[13.5px] text-ink-2"><FlaskConical size={16} className="mt-0.5 shrink-0 text-accent" />{meta.data?.hasDemoData
          ? 'Fictional demonstration records are loaded and tagged DEMO everywhere. Remove them before going live; real records are not affected.'
          : 'No demonstration records are loaded. You can load the fictional dataset to explore or train colleagues.'}</p>
        <div className="mt-4">{meta.data?.hasDemoData ? <Button variant="danger" busy={busy} onClick={removeDemo}>Remove demonstration data</Button>
          : <Button icon={Plus} busy={busy} onClick={() => run(() => api('/admin/demo-data', { method: 'POST' }), 'Demonstration data loaded')}>Load demonstration data</Button>}</div>
      </Card>
      <Card className="p-5">
        <SectionTitle>Weekly reporting</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Reporting week starts on"><select className="field" value={rep.weekStartsOn} onChange={(e) => setRep({ ...rep, weekStartsOn: Number(e.target.value) })}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></Field>
          <Field label="“Upcoming deadlines” look ahead (days)"><input type="number" min={1} max={90} className="field" value={rep.upcomingDays} onChange={(e) => setRep({ ...rep, upcomingDays: Number(e.target.value) })} /></Field>
          <label className="flex cursor-pointer items-center gap-2 text-[13px] sm:col-span-2"><input type="checkbox" className="accent-[var(--accent)]" checked={rep.autoSnapshot} onChange={(e) => setRep({ ...rep, autoSnapshot: e.target.checked })} />Save each week’s report automatically when the week ends</label>
        </div>
        <Button className="mt-4" variant="primary" busy={busy} onClick={() => run(() => api('/admin/settings/report', { method: 'PUT', body: rep }), 'Reporting settings saved')}>Save reporting settings</Button>
      </Card>
      <Card className="p-5">
        <SectionTitle>General</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Organisation"><input className="field" value={gen.organisation} onChange={(e) => setGen({ ...gen, organisation: e.target.value })} /></Field>
          <Field label="Primary TA team" hint="Default scope of the overview and the weekly report."><select className="field" value={gen.primaryTeam} onChange={(e) => setGen({ ...gen, primaryTeam: e.target.value })}>{meta.data?.teams.map((t: any) => <option key={t.id}>{t.name}</option>)}</select></Field>
        </div>
        <Button className="mt-4" variant="primary" busy={busy} onClick={() => run(() => api('/admin/settings/general', { method: 'PUT', body: gen }), 'General settings saved')}>Save general settings</Button>
      </Card>
      <Card className="p-5">
        <SectionTitle>Backup and recovery</SectionTitle>
        <p className="text-[13.5px] text-ink-2">All application data lives in one PostgreSQL database. Backups are taken by the hosting platform (or the supplied backup script), not from this screen. The schedule, retention and the restore procedure are described in the IT handover document delivered with the source code.</p>
      </Card>
    </div>
  );
}

const TABS: { key: string; label: string; perm: string[]; el: () => ReactElement }[] = [
  { key: 'users', label: 'Users', perm: ['admin.users'], el: () => <UsersTab /> },
  { key: 'assignment', label: 'Assign vacancies', perm: ['vacancies.assign'], el: () => <AssignTab /> },
  { key: 'reference', label: 'Departments, countries, statuses', perm: ['admin.config'], el: () => <ReferenceTab /> },
  { key: 'milestones', label: 'Milestone templates', perm: ['admin.config'], el: () => <TemplatesTab /> },
  { key: 'rules', label: 'Risk rules', perm: ['admin.config'], el: () => <RulesTab /> },
  { key: 'permissions', label: 'Permissions', perm: ['admin.permissions'], el: () => <PermissionsTab /> },
  { key: 'integrations', label: 'Integrations', perm: ['admin.integrations'], el: () => <IntegrationsTab /> },
  { key: 'audit', label: 'Audit log', perm: ['audit.view'], el: () => <AuditTab /> },
  { key: 'data', label: 'Data and settings', perm: ['admin.config'], el: () => <DataTab /> },
];

export function AdminPage() {
  const { tab } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const tabs = TABS.filter((t) => can(...t.perm));
  const cur = tabs.find((t) => t.key === tab) ?? tabs[0];
  if (!cur) return <Card className="p-6 text-[14px]">You do not have access to administration.</Card>;
  return (
    <>
      <PageHeader title="Administration" subtitle="Users, ownership, configuration and integrations. Every change here is written to the audit log." />
      <div className="no-print mb-5 flex gap-1 overflow-x-auto border-b border-line" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={cur.key === t.key} onClick={() => nav(`/admin/${t.key}`)}
            className={cx('-mb-px whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-[13.5px] font-medium transition', cur.key === t.key ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink')}>{t.label}</button>
        ))}
      </div>
      {cur.el()}
    </>
  );
}
