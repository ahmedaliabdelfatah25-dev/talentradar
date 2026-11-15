import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Settings2, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, Empty, ErrorNote, Loading, PageHeader, SectionTitle, Segmented, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/app';
import { fmtDate, relDay } from '../lib/format';

const SEV: Record<string, { label: string; color: string }> = { high: { label: 'High', color: 'var(--crit)' }, medium: { label: 'Medium', color: 'var(--warn)' }, low: { label: 'For information', color: 'var(--idle)' } };

export function RisksPage() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['risks'], queryFn: () => api<any>('/risks') });
  const [sev, setSev] = useState('all');
  const [rule, setRule] = useState('');
  const [who, setWho] = useState('');
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { alerts, rules } = q.data;
  const shown = alerts.filter((a: any) => (sev === 'all' || a.severity === sev) && (!rule || a.rule === rule) && (!who || (a.recruiter ?? 'Unassigned') === who));
  const count = (s: string) => alerts.filter((a: any) => a.severity === s).length;
  const recruiters = [...new Set(alerts.map((a: any) => a.recruiter ?? 'Unassigned'))].sort() as string[];
  const param = (r: any) => Object.entries(r.config ?? {}).filter(([k]) => k !== 'enabled').map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${v}`).join(' · ');

  return (
    <>
      <PageHeader title="Recruitment risk monitor" subtitle="Rule-based alerts. Each one restates recorded facts against a configurable threshold — nothing is predicted or scored." />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Segmented value={sev} onChange={setSev} options={[{ value: 'all', label: 'All', count: alerts.length }, { value: 'high', label: 'High', count: count('high'), alert: true }, { value: 'medium', label: 'Medium', count: count('medium') }, { value: 'low', label: 'For information', count: count('low') }]} />
            <div className="ml-auto flex flex-wrap gap-2">
              <select className="field !w-auto" aria-label="Rule" value={rule} onChange={(e) => setRule(e.target.value)}>
                <option value="">All rules</option>
                {rules.map((r: any) => <option key={r.key} value={r.key}>{r.label}</option>)}
              </select>
              <select className="field !w-auto" aria-label="Recruiter" value={who} onChange={(e) => setWho(e.target.value)}>
                <option value="">All recruiters</option>
                {recruiters.map((r) => <option key={r}>{r}</option>)}
              </select>
            </div>
          </div>
          {shown.length === 0 ? <Card><Empty icon={ShieldCheck} title="No alerts match">Nothing recorded in the tracker currently breaks the selected rules.</Empty></Card> : (
            <ul className="space-y-3">
              {shown.map((a: any) => (
                <li key={a.id}>
                  <Card className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.05em]" style={{ color: 'var(--ink-2)' }}>
                        <span className="h-2 w-2 rounded-full" style={{ background: SEV[a.severity].color }} />{a.ruleLabel}
                      </span>
                      <Tag>{SEV[a.severity].label}</Tag>
                      {a.vacancyId && <Link to={`/vacancies/${a.vacancyId}`} className="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">Open vacancy <ArrowRight size={13} /></Link>}
                    </div>
                    <div className="mt-2 text-[15px] font-semibold leading-snug">{a.vacancyTitle ?? 'Not linked to a vacancy'}{a.country && <span className="font-normal text-ink-3"> · {a.country}</span>}</div>
                    <dl className="mt-3 grid gap-x-6 gap-y-2.5 text-[13.5px] sm:grid-cols-[1.5fr_1fr]">
                      <div><dt className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-ink-3">What happened</dt><dd className="mt-0.5">{a.what}</dd></div>
                      <div className="grid grid-cols-2 gap-x-4 sm:block sm:space-y-2.5">
                        <div><dt className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-ink-3">Responsible</dt><dd className="mt-0.5">{a.responsible}</dd></div>
                        <div><dt className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-ink-3">Last update</dt><dd className="mt-0.5">{a.lastUpdateAt ? <>{fmtDate(a.lastUpdateAt)} <span className="text-ink-3">({relDay(a.lastUpdateAt)})</span></> : <span className="text-ink-3">{a.vacancyId ? 'Never' : '—'}</span>}</dd></div>
                      </div>
                      <div className="sm:col-span-2"><dt className="text-[11.5px] font-semibold uppercase tracking-[0.05em] text-ink-3">Recommended action</dt><dd className="mt-0.5">{a.recommended}</dd></div>
                    </dl>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>

        <Card className="self-start p-5">
          <SectionTitle right={can('admin.config') && <Link to="/admin/rules" className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline"><Settings2 size={13} /> Configure</Link>}>Rules in force</SectionTitle>
          <ul className="space-y-3">
            {rules.map((r: any) => {
              const on = r.config?.enabled !== false;
              const n = alerts.filter((a: any) => a.rule === r.key).length;
              return (
                <li key={r.key} className={on ? '' : 'opacity-50'}>
                  <button className="flex w-full items-center gap-2 text-left text-[13.5px] font-medium hover:text-accent" onClick={() => { setRule(rule === r.key ? '' : r.key); setSev('all'); }}>
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: SEV[r.severity].color }} />
                    <span className="flex-1">{r.label}</span>
                    {on ? <span className="num rounded-full bg-hover px-1.5 text-[11.5px] text-ink-2">{n}</span> : <Tag>Off</Tag>}
                  </button>
                  <p className="ml-4 mt-0.5 text-[12px] leading-snug text-ink-3">{r.description}{param(r) && <span className="block text-ink-2">Threshold — {param(r)}</span>}</p>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
