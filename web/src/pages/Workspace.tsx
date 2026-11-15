import { useQuery } from '@tanstack/react-query';
import { CircleCheck, PencilLine, Plus, Target } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ActionDrawer, ActionList, BUCKETS } from '../components/actions';
import { Deadline, QuickUpdate, VacancyForm } from '../components/vacancy';
import { Button, Card, DemoTag, Empty, ErrorNote, Loading, Meter, PageHeader, SectionTitle, StatusPill, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useAct, useAuth } from '../lib/app';
import { fmtDate, relDay } from '../lib/format';

export function WorkspacePage() {
  const { user, can } = useAuth();
  const q = useQuery({ queryKey: ['my'], queryFn: () => api<any>('/dashboard/my') });
  const { run, busy } = useAct();
  const [update, setUpdate] = useState<any>(null);
  const [action, setAction] = useState<any>(undefined);
  const [creating, setCreating] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const d = q.data;
  const hour = new Date().getHours();
  const overdue = d.actions.filter((a: any) => a.bucket === 'overdue').length;
  const attention = d.vacancies.filter((v: any) => v.alerts.length > 0).length;
  const np = d.nextPriority;

  return (
    <>
      <PageHeader title={`${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${user!.name.split(' ')[0]}`}
        subtitle={<>{d.vacancies.length} open {d.vacancies.length === 1 ? 'vacancy' : 'vacancies'} · {d.needsUpdate.length} to update · {overdue} overdue {overdue === 1 ? 'action' : 'actions'} · {attention} with open alerts</>}
        actions={<>
          {can('actions.manage_own') && <Button icon={Plus} onClick={() => setAction(null)}>New action</Button>}
          {can('vacancies.create') && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New vacancy</Button>}
        </>} />

      {np && (
        <Card className="mb-5 flex flex-wrap items-center gap-4 p-4 sm:p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent-soft"><Target size={19} className="text-accent" /></span>
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3">Next priority {np.bucket === 'overdue' ? '· overdue' : np.bucket === 'today' ? '· due today' : ''}</div>
            <div className="mt-0.5 text-[15.5px] font-semibold leading-snug">{np.title}</div>
            <div className="text-[12.5px] text-ink-3">{[np.vacancyTitle, np.dueDate ? `due ${fmtDate(np.dueDate)} (${relDay(np.dueDate)})` : 'no due date', np.waitingOn ? `waiting for ${np.waitingOn}` : null].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setAction(np)}>Open</Button>
            <Button variant="primary" icon={CircleCheck} busy={busy} onClick={() => run(() => api(`/actions/${np.id}`, { method: 'PATCH', body: { status: 'completed' } }), 'Action completed')}>Mark done</Button>
          </div>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          {d.needsUpdate.length > 0 && (
            <Card className="p-5">
              <SectionTitle>What I must update</SectionTitle>
              <ul className="space-y-2">
                {d.needsUpdate.map((n: any) => {
                  const v = d.vacancies.find((x: any) => x.id === n.id);
                  return (
                    <li key={n.id} className="flex items-start gap-3 rounded-xl border border-line bg-field px-3.5 py-2.5">
                      <div className="min-w-0 flex-1">
                        <Link to={`/vacancies/${n.id}`} className="text-[13.5px] font-semibold hover:underline">{n.title}</Link>
                        <ul className="mt-0.5 space-y-0.5 text-[12.5px] text-ink-2">{n.reasons.map((r: string, i: number) => <li key={i}>{r}</li>)}</ul>
                      </div>
                      <Button size="sm" variant="primary" icon={PencilLine} onClick={() => setUpdate(v)}>Update</Button>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}

          <div>
            <SectionTitle right={d.closedCount > 0 && <Link to="/tracker" className="text-[12px] text-ink-3 hover:text-ink">{d.closedCount} closed in tracker</Link>} className="px-1">My vacancies</SectionTitle>
            {d.vacancies.length === 0 ? <Card><Empty title="No open vacancies are assigned to you">Vacancies appear here when you create one or an administrator assigns one to you.</Empty></Card> : (
              <div className="grid gap-3 md:grid-cols-2">
                {d.vacancies.map((v: any) => (
                  <Card key={v.id} className="flex flex-col p-4">
                    <div className="flex items-start gap-2">
                      <Link to={`/vacancies/${v.id}`} className="min-w-0 flex-1">
                        <div className="text-[14.5px] font-semibold leading-snug hover:underline">{v.title}</div>
                        <div className="mt-0.5 text-[12px] text-ink-3">{v.isDemo && <><DemoTag />{' '}</>}{[v.city, v.country].filter(Boolean).join(', ')}{v.hiringManager ? ` · HM ${v.hiringManager}` : ''}</div>
                      </Link>
                      <StatusPill k={v.overall.key} label={v.overall.label} />
                    </div>
                    <div className="mt-3 flex items-center justify-between gap-3 text-[12.5px]">
                      <span className="min-w-0 truncate"><span className="text-ink-3">Stage </span><b className="font-medium">{v.currentStage ?? '—'}</b>{v.daysInStage !== null && v.statusCategory === 'active' && <span className="text-ink-3"> · {v.daysInStage}d</span>}</span>
                      <Meter done={v.milestonesDone} total={v.milestonesTotal} />
                    </div>
                    <div className="mt-2.5 rounded-xl border border-line bg-field px-3 py-2">
                      <div className="text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">Next action</div>
                      {v.nextAction ? (
                        <div className="mt-0.5 flex items-start gap-3">
                          <div className="min-w-0 flex-1"><div className="line-clamp-2 text-[13px]">{v.nextAction}</div><div className="text-[11.5px] text-ink-3">{v.actionOwner ?? 'No owner'}</div></div>
                          <div className="shrink-0 text-right text-[12.5px]"><Deadline date={v.actionDeadline} /></div>
                        </div>
                      ) : <div className="mt-0.5"><Tag tone="warn">No next action recorded</Tag></div>}
                    </div>
                    {v.alerts.length > 0 && (
                      <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {[...new Map(v.alerts.map((a: any) => [a.rule, a])).values()].slice(0, 4).map((a: any) => <Tag key={a.rule} tone={a.severity === 'high' ? 'crit' : a.severity === 'medium' ? 'warn' : 'neutral'} title={a.what}>{a.ruleLabel}</Tag>)}
                      </div>
                    )}
                    <div className="mt-auto flex items-center justify-between gap-2 pt-3 text-[12px] text-ink-3">
                      <span>Updated {relDay(v.lastUpdateAt) || 'never'}</span>
                      <Button size="sm" icon={PencilLine} onClick={() => setUpdate(v)}>Update progress</Button>
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>

        <Card solid className="self-start overflow-hidden">
          <div className="px-5 pt-4"><SectionTitle right={<Link to="/actions" className="text-[12px] font-medium text-accent hover:underline">Action centre</Link>}>My outstanding actions</SectionTitle></div>
          {d.actions.length === 0 ? <Empty icon={CircleCheck} title="You have no open actions" /> : BUCKETS.filter((b) => b.key !== 'done').map((b) => {
            const list = d.actions.filter((a: any) => a.bucket === b.key);
            if (!list.length) return null;
            return (
              <div key={b.key} className="border-t border-line">
                <div className="flex items-center gap-2 px-4 pb-1 pt-3 text-[11.5px] font-semibold uppercase tracking-[0.06em]" style={{ color: b.key === 'overdue' ? 'var(--crit)' : 'var(--ink-3)' }}>{b.label}<span className="num rounded-full bg-hover px-1.5 text-ink-2">{list.length}</span></div>
                <ActionList actions={list} onOpen={setAction} showAssignee={false} />
              </div>
            );
          })}
        </Card>
      </div>

      {update && <QuickUpdate vacancy={update} onClose={() => setUpdate(null)} />}
      {creating && <VacancyForm onClose={() => setCreating(false)} />}
      {action !== undefined && <ActionDrawer action={action ?? undefined} onClose={() => setAction(undefined)} />}
    </>
  );
}
