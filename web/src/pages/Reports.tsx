import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Download, FileDown, Printer, Save, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Deadline } from '../components/vacancy';
import { Button, Card, DemoTag, ErrorNote, Loading, PageHeader, Segmented, StatusPill, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useAct, useAuth } from '../lib/app';
import { cx, fmtDate, fmtDateTime, relDay } from '../lib/format';

function Section({ n, title, note, children }: { n: number; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <Card solid className="overflow-hidden break-inside-avoid">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 pb-3 pt-4">
        <h2 className="text-[15px] font-semibold tracking-tight"><span className="num mr-2 text-ink-3">{n}</span>{title}</h2>
        {note && <span className="text-[12.5px] text-ink-3">{note}</span>}
      </div>
      {children}
    </Card>
  );
}
const None = ({ children }: { children: ReactNode }) => <p className="px-5 pb-5 text-[13.5px] text-ink-3">{children}</p>;
const VLink = ({ id, children }: { id?: number | null; children: ReactNode }) => (id ? <Link to={`/vacancies/${id}`} className="font-medium hover:underline">{children}</Link> : <span className="text-ink-3">{children ?? '—'}</span>);

function ReportBody({ r }: { r: any }) {
  const k = r.kpis;
  const tiles: [string, number][] = [['Active', k.active], ['On track', k.onTrack], ['Needs attention', k.needsAttention], ['Awaiting feedback', k.awaitingFeedback], ['Blocked', k.blocked],
    ['On hold', k.onHold], ['Hired', k.hired], ['Overdue actions', k.overdueActions], ['Deadlines ahead', k.upcomingDeadlines]];
  return (
    <div className="space-y-4">
      <Card className="grid grid-cols-3 gap-px overflow-hidden !p-0 sm:grid-cols-5 lg:grid-cols-9">
        {tiles.map(([label, value]) => (
          <div key={label} className="px-4 py-3.5"><div className="num text-[24px] font-semibold leading-none tracking-[-0.02em]">{value}</div><div className="mt-1.5 text-[11.5px] text-ink-3">{label}</div></div>
        ))}
      </Card>

      <Section n={1} title={`Vacancies managed by ${r.meta.team}`} note={`${r.vacancies.length} in total`}>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Vacancy</th><th>Location</th><th>Recruiter</th><th>Current stage</th><th>Status</th><th>Last update</th><th>Next action</th><th>Deadline</th></tr></thead>
            <tbody>
              {r.vacancies.map((v: any) => (
                <tr key={v.id}>
                  <td className="min-w-[200px]"><VLink id={v.id}>{v.title}</VLink>{v.isDemo && <> <DemoTag /></>}<div className="text-[11.5px] text-ink-3">{v.hiringManager ? `HM ${v.hiringManager}` : ''}</div></td>
                  <td>{[v.city, v.country].filter(Boolean).join(', ') || '—'}</td>
                  <td>{v.recruiter ?? '—'}</td>
                  <td>{v.stage ?? '—'}{v.milestonesTotal > 0 && <div className="num text-[11.5px] text-ink-3">{v.milestonesDone}/{v.milestonesTotal} milestones</div>}</td>
                  <td><StatusPill k={v.overall.key} label={v.overall.label} /></td>
                  <td className="whitespace-nowrap">{v.lastUpdateAt ? <><span className="num">{fmtDate(v.lastUpdateAt)}</span><div className="text-[11.5px] text-ink-3">{relDay(v.lastUpdateAt)}</div></> : '—'}</td>
                  <td className="min-w-[200px]">{v.nextAction ?? <span className="text-ink-3">—</span>}{v.actionOwner && <div className="text-[11.5px] text-ink-3">{v.actionOwner}</div>}</td>
                  <td><Deadline date={v.actionDeadline} closed={!['active', 'on_hold'].includes(v.statusCategory)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section n={2} title="Changes since the previous report" note={r.meta.previousWeekStart ? `Compared with the week of ${fmtDate(r.meta.previousWeekStart)} · ${r.unchangedCount} open vacancies unchanged` : undefined}>
        {!r.meta.previousWeekStart ? <None>No earlier saved report exists to compare against.</None> : r.changes.length === 0 ? <None>No stage or status changes.</None> : (
          <ul className="divide-y divide-line">
            {r.changes.map((c: any, i: number) => (
              <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-[13.5px]">
                <span className="min-w-[220px] flex-1"><VLink id={c.vacancyId}>{c.title}</VLink></span>
                <Tag tone={c.type === 'New vacancy' ? 'accent' : 'neutral'}>{c.type}</Tag>
                <span className="flex min-w-[260px] flex-1 items-center gap-2 text-ink-2">{c.from ?? '—'} <ArrowRight size={13} className="shrink-0 text-ink-3" /> <b className="font-medium text-ink">{c.to ?? '—'}</b></span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section n={3} title="Recruiter workload">
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Recruiter</th><th>Active</th><th>On track</th><th>Attention / awaiting</th><th>Blocked</th><th>On hold</th><th>Hired</th><th>Open actions</th><th>Overdue actions</th><th>Updates this week</th></tr></thead>
            <tbody>
              {r.workload.map((w: any) => (
                <tr key={w.recruiter}>
                  <td className="font-medium">{w.recruiter}</td>
                  {[w.active, w.onTrack, w.needsAttention, w.blocked, w.onHold, w.hired, w.openActions].map((x, i) => <td key={i} className="num">{x}</td>)}
                  <td className={cx('num', w.overdueActions > 0 && 'font-semibold text-crit')}>{w.overdueActions}</td>
                  <td className="num">{w.updatesThisWeek}{w.active > 0 && w.updatesThisWeek === 0 && <span className="ml-2 inline-flex items-center gap-1 text-[11.5px] font-normal text-ink-3"><TriangleAlert size={11} style={{ color: 'var(--warn)' }} />none recorded</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section n={4} title="Activities completed this week" note={`${r.activity.updates.length} progress updates · ${r.activity.actionsCompleted.length} actions · ${r.activity.milestonesCompleted.length} milestones`}>
        {r.activity.updates.length + r.activity.actionsCompleted.length + r.activity.milestonesCompleted.length === 0 ? <None>Nothing was recorded this week.</None> : (
          <ul className="divide-y divide-line">
            {r.activity.updates.map((u: any, i: number) => (
              <li key={`u${i}`} className="grid gap-x-4 gap-y-0.5 px-5 py-2.5 text-[13.5px] sm:grid-cols-[92px_minmax(0,1fr)]">
                <span className="num text-ink-3">{fmtDate(u.at)}</span>
                <span><VLink id={u.vacancyId}>{u.title}</VLink> — {u.summary} <span className="text-ink-3">({u.user})</span></span>
              </li>
            ))}
            {r.activity.milestonesCompleted.map((m: any) => (
              <li key={`m${m.id}`} className="grid gap-x-4 px-5 py-2.5 text-[13.5px] sm:grid-cols-[92px_minmax(0,1fr)]">
                <span className="num text-ink-3">{fmtDate(m.completedDate)}</span><span><Tag tone="good">Milestone</Tag> {m.name} — <VLink id={m.vacancyId}>{m.title}</VLink></span>
              </li>
            ))}
            {r.activity.actionsCompleted.map((a: any) => (
              <li key={`a${a.id}`} className="grid gap-x-4 px-5 py-2.5 text-[13.5px] sm:grid-cols-[92px_minmax(0,1fr)]">
                <span className="num text-ink-3">{fmtDate(a.completedAt)}</span><span><Tag tone="good">Action done</Tag> {a.title}{a.vacancyTitle && <> — <VLink id={a.vacancyId}>{a.vacancyTitle}</VLink></>} <span className="text-ink-3">({a.assignee ?? 'unassigned'})</span></span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section n={5} title="Outstanding actions" note={`${r.outstandingActions.length} open · ${r.outstandingActions.filter((a: any) => a.overdue).length} overdue`}>
        {r.outstandingActions.length === 0 ? <None>No open actions.</None> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Due</th><th>Action</th><th>Vacancy</th><th>Assigned to</th><th>Waiting on</th></tr></thead>
              <tbody>
                {r.outstandingActions.map((a: any) => (
                  <tr key={a.id}>
                    <td><Deadline date={a.dueDate} /></td>
                    <td className="min-w-[240px]">{a.title}</td>
                    <td><VLink id={a.vacancyId}>{a.vacancyTitle ?? 'General'}</VLink></td>
                    <td>{a.assignee ?? '—'}</td>
                    <td>{a.waitingOn ?? <span className="text-ink-3">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section n={6} title="Overdue milestones" note="Milestones not reached by their planned date">
        {r.overdueMilestones.length === 0 ? <None>No milestone is past its planned date.</None> : (
          <div className="overflow-x-auto">
            <table className="data">
              <thead><tr><th>Planned</th><th>Milestone</th><th>Vacancy</th><th>Days late</th><th>Recruiter</th></tr></thead>
              <tbody>
                {r.overdueMilestones.map((m: any) => (
                  <tr key={m.id}><td className="num whitespace-nowrap">{fmtDate(m.plannedDate)}</td><td>{m.name}</td><td><VLink id={m.vacancyId}>{m.title}</VLink></td><td className="num font-semibold">{m.daysLate}</td><td>{m.recruiter ?? '—'}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section n={7} title="Recruitment blockers">
          {r.blockers.length === 0 ? <None>No blockers recorded.</None> : (
            <ul className="divide-y divide-line">
              {r.blockers.map((b: any) => (
                <li key={b.vacancyId} className="px-5 py-3 text-[13.5px]">
                  <div className="flex items-center gap-2"><span className="min-w-0 flex-1"><VLink id={b.vacancyId}>{b.title}</VLink></span><StatusPill k={b.overall.key} label={b.overall.label} /></div>
                  <p className="mt-1 text-ink-2">{b.blocker ?? 'Marked blocked — no description recorded.'}</p>
                  <p className="mt-0.5 text-[12px] text-ink-3">{b.recruiter ?? 'Unassigned'}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section n={8} title="Support required">
          {r.supportRequired.length === 0 ? <None>No support requests recorded.</None> : (
            <ul className="divide-y divide-line">
              {r.supportRequired.map((s: any) => (
                <li key={s.vacancyId} className="px-5 py-3 text-[13.5px]">
                  <VLink id={s.vacancyId}>{s.title}</VLink>
                  <p className="mt-1 text-ink-2">{s.supportRequired}</p>
                  <p className="mt-0.5 text-[12px] text-ink-3">Requested by {s.recruiter ?? 'unassigned'}{s.hiringManager ? ` · hiring manager ${s.hiringManager}` : ''}</p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <Section n={9} title="Important upcoming deadlines">
        {r.upcomingDeadlines.length === 0 ? <None>No deadlines in the coming period.</None> : (
          <ul className="divide-y divide-line">
            {r.upcomingDeadlines.map((u: any, i: number) => (
              <li key={i} className="grid gap-x-4 px-5 py-2.5 text-[13.5px] sm:grid-cols-[92px_130px_minmax(0,1fr)_160px]">
                <span className="num font-medium">{fmtDate(u.date)}</span><span className="text-ink-3">{u.kind}</span>
                <span>{u.what}{u.title && u.kind !== 'Target hiring date' && <> — <VLink id={u.vacancyId}>{u.title}</VLink></>}</span><span className="text-ink-2">{u.owner ?? '—'}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function History() {
  const q = useQuery({ queryKey: ['reports', 'history'], queryFn: () => api<any>('/reports/history') });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const { series, stagnation } = q.data;
  const cols: [string, (s: any) => number][] = [['Active', (s) => s.kpis.active], ['On track', (s) => s.kpis.onTrack], ['Needs attention', (s) => s.kpis.needsAttention + (s.kpis.awaitingFeedback ?? 0)],
    ['Blocked', (s) => s.kpis.blocked], ['On hold', (s) => s.kpis.onHold], ['Hired', (s) => s.kpis.hired], ['Overdue actions', (s) => s.kpis.overdueActions],
    ['Progress updates', (s) => s.updates], ['Stage moves', (s) => s.stageChanges]];
  return (
    <div className="space-y-4">
      <Card solid className="overflow-hidden">
        <div className="px-5 pb-3 pt-4"><h2 className="text-[15px] font-semibold tracking-tight">Week by week</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">Each row is a saved weekly report; the last row is the current week, computed live. “Stage moves” counts vacancies whose stage changed against the week before.</p></div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Week starting</th>{cols.map(([l]) => <th key={l} className="!text-right">{l}</th>)}</tr></thead>
            <tbody>
              {series.map((s: any, i: number) => (
                <tr key={s.weekStart} className={s.kind === 'live' ? 'bg-accent-soft' : ''}>
                  <td className="whitespace-nowrap font-medium"><span className="num">{fmtDate(s.weekStart, { year: true })}</span>{s.kind === 'live' && <> <Tag tone="accent">This week · live</Tag></>}{s.kind === 'demo' && <> <DemoTag /></>}</td>
                  {cols.map(([l, get]) => {
                    const cur = get(s);
                    const prev = i > 0 ? get(series[i - 1]) : null;
                    const d = prev === null ? 0 : cur - prev;
                    return <td key={l} className="num text-right">{cur}{d !== 0 && <span className="ml-1.5 inline-block w-7 text-left text-[11px] text-ink-3">{d > 0 ? `+${d}` : d}</span>}{d === 0 && <span className="ml-1.5 inline-block w-7" />}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card solid className="overflow-hidden">
        <div className="px-5 pb-3 pt-4"><h2 className="text-[15px] font-semibold tracking-tight">Progressing or stagnating?</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-3">The stage recorded for each open vacancy in every weekly report. A stage name marks the week it changed; a dot means no movement that week.</p></div>
        <div className="overflow-x-auto">
          <table className="data">
            <thead><tr><th>Vacancy</th>{series.map((s: any) => <th key={s.weekStart} className="whitespace-nowrap">{s.kind === 'live' ? 'Now' : fmtDate(s.weekStart)}</th>)}<th>In current stage</th><th>Last update</th></tr></thead>
            <tbody>
              {stagnation.map((v: any) => (
                <tr key={v.vacancyId}>
                  <td className="min-w-[210px]"><VLink id={v.vacancyId}>{v.title}</VLink><div className="text-[11.5px] text-ink-3">{v.recruiter ?? 'Unassigned'}</div></td>
                  {v.trail.map((st: string | null, i: number) => {
                    const prev = i > 0 ? v.trail[i - 1] : undefined;
                    const changed = st !== null && st !== prev;
                    return <td key={i} className="min-w-[92px] align-middle text-[12px]">{st === null ? <span className="text-ink-3">–</span> : changed ? <span className="font-medium leading-tight">{st}</span> : <span className="block h-1.5 w-1.5 rounded-full bg-line-2" title={st} />}</td>;
                  })}
                  <td className="whitespace-nowrap">
                    <span className="num font-medium">{v.weeksInStage} {v.weeksInStage === 1 ? 'week' : 'weeks'}</span>
                    {v.weeksInStage >= 3 && v.overall.key !== 'on_hold' && <span className="ml-2 inline-flex items-center gap-1 text-[11.5px]"><TriangleAlert size={12} style={{ color: 'var(--warn)' }} />No movement</span>}
                    <div className="mt-0.5"><StatusPill k={v.overall.key} label={v.overall.label} /></div>
                  </td>
                  <td className="num whitespace-nowrap">{v.daysSinceUpdate === null ? '—' : v.daysSinceUpdate === 0 ? 'today' : `${v.daysSinceUpdate}d ago`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

export function ReportsPage() {
  const { can } = useAuth();
  const { run, busy } = useAct();
  const [tab, setTab] = useState<'report' | 'history'>('report');
  const [snap, setSnap] = useState('');
  const snaps = useQuery({ queryKey: ['reports', 'snapshots'], queryFn: () => api<any[]>('/reports/snapshots') });
  const q = useQuery({ queryKey: ['reports', 'weekly', snap], queryFn: () => api<any>(snap ? `/reports/snapshots/${snap}` : '/reports/weekly') });
  const r = q.data;
  const exp = (format: string) => `/api/reports/export?format=${format}${snap ? `&snapshotId=${snap}` : ''}`;
  const link = 'inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-2 bg-field px-3.5 text-[13.5px] font-medium hover:bg-hover';

  return (
    <>
      <PageHeader title="Weekly leadership report"
        subtitle={r ? <>{r.meta.team} · week of {fmtDate(r.meta.weekStart, { year: true })} – {fmtDate(r.meta.weekEnd, { year: true })} · {snap ? `saved ${fmtDateTime(r.meta.generatedAt)}` : 'live from the tracker'}{r.meta.containsDemoData && <> · <DemoTag /> contains fictional data</>}</> : 'Loading…'}
        actions={<>
          <select className="field !w-auto" aria-label="Report week" value={snap} onChange={(e) => { setSnap(e.target.value); setTab('report'); }}>
            <option value="">This week (live)</option>
            {snaps.data?.map((s) => <option key={s.id} value={s.id}>Week of {fmtDate(s.weekStart, { year: true })} — saved{s.kind === 'auto' ? ' automatically' : s.kind === 'demo' ? ' (demo)' : ''}</option>)}
          </select>
          <a className={link} href={exp('pdf')}><FileDown size={16} /> PDF</a>
          <a className={link} href={exp('csv')}><Download size={16} /> CSV</a>
          <Button icon={Printer} onClick={() => window.print()}>Print</Button>
          {can('reports.generate') && !snap && <Button variant="primary" icon={Save} busy={busy} onClick={() => run(() => api('/reports/snapshots', { method: 'POST' }), 'This week’s report has been saved to history')}>Save to history</Button>}
        </>} />
      <div className="no-print mb-4">
        <Segmented value={tab} onChange={setTab} options={[{ value: 'report', label: 'Report' }, { value: 'history', label: 'History and trends', count: snaps.data?.length }]} />
      </div>
      {tab === 'history' ? <History /> : q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : <ReportBody r={r} />}
    </>
  );
}
