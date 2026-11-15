import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Ban, Briefcase, CalendarClock, CircleCheck, CirclePause, Download, LifeBuoy, ListChecks, Plus, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionDrawer } from '../components/actions';
import { applyFilters, FilterBar, NO_FILTERS, QuickUpdate, VacancyForm, VacancyTable, type Filters } from '../components/vacancy';
import { Button, Card, DemoTag, ErrorNote, Loading, PageHeader, SectionTitle, StatusPill } from '../components/ui';
import { api } from '../lib/api';
import { useAuth, useMeta } from '../lib/app';
import { cx, fmtDate, relDay } from '../lib/format';

function Tile({ label, value, sub, icon: Icon, color, active, onClick, to }: { label: string; value: number; sub?: string; icon: LucideIcon; color: string; active?: boolean; onClick?: () => void; to?: string }) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="num text-[30px] font-semibold leading-none tracking-[-0.02em]">{value}</span>
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${color} 15%, transparent)` }}><Icon size={15} strokeWidth={2.3} style={{ color }} /></span>
      </div>
      <div className="mt-2.5 text-[12.5px] font-medium leading-tight">{label}</div>
      <div className="mt-0.5 text-[11.5px] leading-tight text-ink-3">{sub}</div>
    </>
  );
  const cls = cx('glass block h-full w-full rounded-2xl p-4 text-left transition hover:-translate-y-px', active && 'ring-2 ring-accent');
  return to ? <Link to={to} className={cls}>{body}</Link> : <button className={cls} onClick={onClick} aria-pressed={active}>{body}</button>;
}

export function OverviewPage() {
  const { can } = useAuth();
  const meta = useMeta();
  const [teamId, setTeamId] = useState<string>('');
  const q = useQuery({ queryKey: ['overview', teamId], queryFn: () => api<any>(`/dashboard/overview${teamId ? `?teamId=${teamId}` : ''}`) });
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [update, setUpdate] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<any>(null);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  const k = d.kpis;
  const rows = applyFilters(d.vacancies, filters);
  const pick = (status: string) => () => setFilters((f) => ({ ...NO_FILTERS, status: f.status === status ? '' : status }));
  const exportUrl = `/api/vacancies/export.csv${d.teamId ? `?taTeamId=${d.teamId}` : ''}`;

  return (
    <>
      <PageHeader title={`${d.team} — recruitment overview`}
        subtitle={<>Every vacancy handled by the team, wherever it is located · week of {fmtDate(d.week.start)}–{fmtDate(d.week.end)}</>}
        actions={<>
          {(meta.data?.teams.filter((t: any) => t.isActive).length ?? 0) > 1 && (
            <select className="field !w-auto" aria-label="TA team" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">{meta.data?.primaryTeam?.name ?? 'Primary team'}</option>
              <option value="all">All TA teams</option>
            </select>
          )}
          <a href={exportUrl} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-2 bg-field px-3.5 text-[13.5px] font-medium hover:bg-hover"><Download size={16} /> Export CSV</a>
          {can('vacancies.create') && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New vacancy</Button>}
        </>} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 2xl:grid-cols-8">
        <Tile label="Active vacancies" value={k.active} sub={`${d.vacancies.length} in tracker`} icon={Briefcase} color="var(--accent)" active={filters.status === 'active'} onClick={pick('active')} />
        <Tile label="On track" value={k.onTrack} sub={k.active ? `${Math.round((k.onTrack / k.active) * 100)}% of active` : ''} icon={CircleCheck} color="var(--good)" active={filters.status === 'on_track'} onClick={pick('on_track')} />
        <Tile label="Needs attention" value={k.needsAttention + k.awaitingFeedback} sub={`${k.awaitingFeedback} awaiting feedback`} icon={TriangleAlert} color="var(--warn)" active={filters.status === 'attention'} onClick={pick('attention')} />
        <Tile label="Blocked" value={k.blocked} sub={k.blocked ? 'Needs intervention' : 'None'} icon={Ban} color="var(--crit)" active={filters.status === 'blocked'} onClick={pick('blocked')} />
        <Tile label="On hold" value={k.onHold} sub="Paused" icon={CirclePause} color="var(--idle)" active={filters.status === 'on_hold'} onClick={pick('on_hold')} />
        <Tile label="Completed hires" value={k.hired} sub="Vacancies filled" icon={BadgeCheck} color="var(--good)" active={filters.status === 'hired'} onClick={pick('hired')} />
        <Tile label="Upcoming deadlines" value={k.upcomingDeadlines} sub="Next 14 days" icon={CalendarClock} color="var(--accent)" onClick={() => document.getElementById('deadlines')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} />
        <Tile label="Overdue actions" value={k.overdueActions} sub={k.overdueActions ? 'Past their due date' : 'Nothing overdue'} icon={ListChecks} color={k.overdueActions ? 'var(--crit)' : 'var(--idle)'} to="/actions" />
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-3">
        <Card className="p-5">
          <SectionTitle right={d.intervention.length > 0 && <button className="text-[12px] font-medium text-accent hover:underline" onClick={pick('intervention')}>Show in table</button>}>Requires intervention</SectionTitle>
          {d.intervention.length === 0 ? <p className="text-[13.5px] text-ink-3">No vacancy is blocked, behind its timeline, overdue on its next action or asking for support.</p> : (
            <ul className="-mx-2 space-y-0.5">
              {d.intervention.map((v: any) => (
                <li key={v.id}>
                  <Link to={`/vacancies/${v.id}`} className="block rounded-xl px-2 py-2 hover:bg-hover">
                    <div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{v.title}</span><StatusPill k={v.overall.key} label={v.overall.label} /></div>
                    <div className="mt-0.5 text-[12px] text-ink-3">{[v.recruiter ?? 'Unassigned', v.country].filter(Boolean).join(' · ')} · updated {relDay(v.lastUpdateAt) || 'never'}</div>
                    <ul className="mt-1.5 space-y-1">
                      {v.reasons.slice(0, 3).map((r: any) => <li key={r.rule} className="flex gap-1.5 text-[12.5px] leading-snug text-ink-2"><span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: r.severity === 'high' ? 'var(--crit)' : 'var(--warn)' }} /><span className="line-clamp-2">{r.what}</span></li>)}
                    </ul>
                    {v.supportRequired && <div className="mt-1.5 flex items-start gap-1.5 text-[12.5px] font-medium"><LifeBuoy size={13} className="mt-0.5 shrink-0 text-accent" />Support needed</div>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5" id="deadlines">
          <SectionTitle>Upcoming deadlines · next 14 days</SectionTitle>
          {d.upcomingDeadlines.length === 0 ? <p className="text-[13.5px] text-ink-3">No deadlines in the coming two weeks.</p> : (
            <ul className="-mx-2 max-h-[330px] space-y-0.5 overflow-y-auto">
              {d.upcomingDeadlines.map((u: any, i: number) => (
                <li key={i}>
                  <Link to={u.vacancyId ? `/vacancies/${u.vacancyId}` : '/actions'} className="flex gap-3 rounded-xl px-2 py-1.5 hover:bg-hover">
                    <span className="num w-[50px] shrink-0 text-right text-[13px] font-semibold">{fmtDate(u.date)}</span>
                    <span className="min-w-0 flex-1"><span className="line-clamp-1 text-[13px]">{u.what}</span><span className="line-clamp-1 text-[11.5px] text-ink-3">{[relDay(u.date), u.kind, u.kind !== 'Target hiring date' ? u.title : null, u.owner].filter(Boolean).join(' · ')}</span></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <SectionTitle right={<Link to="/actions" className="text-[12px] font-medium text-accent hover:underline">Action centre</Link>}>Overdue actions</SectionTitle>
          {d.overdueActions.length === 0 ? <p className="text-[13.5px] text-ink-3">No action is past its due date.</p> : (
            <ul className="-mx-2 max-h-[330px] space-y-0.5 overflow-y-auto">
              {d.overdueActions.map((a: any) => (
                <li key={a.id}>
                  <button onClick={() => setAction(a)} className="flex w-full gap-3 rounded-xl px-2 py-1.5 text-left hover:bg-hover">
                    <span className="num w-[50px] shrink-0 text-right text-[13px] font-semibold text-crit">{fmtDate(a.dueDate)}</span>
                    <span className="min-w-0 flex-1"><span className="line-clamp-1 text-[13px]">{a.title}</span><span className="line-clamp-1 text-[11.5px] text-ink-3">{[relDay(a.dueDate), a.assignee ?? 'Unassigned', a.vacancyTitle, a.waitingOn ? `waiting for ${a.waitingOn}` : null].filter(Boolean).join(' · ')}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card solid className="mt-5">
        <div className="px-5 pb-3 pt-4">
          <SectionTitle right={<span className="text-[12px] text-ink-3">{rows.length} of {d.vacancies.length} vacancies{d.vacancies.some((v: any) => v.isDemo) && <> · <DemoTag /> = fictional</>}</span>}>Central recruitment tracker</SectionTitle>
          <FilterBar rows={d.vacancies} value={filters} onChange={setFilters} />
        </div>
        <VacancyTable rows={rows} onQuickUpdate={setUpdate} />
      </Card>

      {update && <QuickUpdate vacancy={update} onClose={() => setUpdate(null)} />}
      {creating && <VacancyForm onClose={() => setCreating(false)} />}
      {action && <ActionDrawer action={{ ...action, canManage: can('actions.manage_all') }} onClose={() => setAction(null)} />}
    </>
  );
}
