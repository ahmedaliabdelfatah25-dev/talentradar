import { useQuery } from '@tanstack/react-query';
import { Archive, ArrowDown, ArrowLeft, ArrowUp, Check, CircleDot, ExternalLink, FileText, Flag, LifeBuoy, Link2, Minus, PencilLine, Plus, Sparkles, Trash2, TriangleAlert, Trophy } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ActionDrawer, ActionList } from '../components/actions';
import { InsightSkeleton, InsightView } from '../components/Insight';
import { Deadline, QuickUpdate, VacancyForm } from '../components/vacancy';
import { Avatar, Button, Card, DemoTag, ErrorNote, Loading, Modal, PriorityTag, Row, SectionTitle, Segmented, StatusIcon, StatusPill, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useAct, useAuth } from '../lib/app';
import { cx, fmtDate, fmtDateTime, isPast, relDay } from '../lib/format';

const HEALTH: Record<string, string> = { on_track: 'On track', needs_attention: 'Needs attention', awaiting_feedback: 'Awaiting feedback', blocked: 'Blocked' };
const MS_STATUS: Record<string, string> = { pending: 'Not reached', in_progress: 'Current stage', completed: 'Completed', skipped: 'Skipped' };

function MilestoneTrack({ v }: { v: any }) {
  const open = ['active', 'on_hold'].includes(v.statusCategory);
  return (
    <ol className="flex gap-0 overflow-x-auto pb-1">
      {v.milestones.map((m: any, i: number) => {
        const late = open && m.status === 'pending' && isPast(m.plannedDate);
        const cur = m.status === 'in_progress';
        return (
          <li key={m.id} className="relative min-w-[104px] flex-1 pr-3">
            {i < v.milestones.length - 1 && <span className="absolute left-[22px] right-0 top-[10px] h-[2px] rounded-full" style={{ background: m.status === 'completed' ? 'var(--accent)' : 'var(--line-2)' }} />}
            <span className={cx('relative z-[1] flex h-[22px] w-[22px] items-center justify-center rounded-full border-2', m.status === 'completed' ? 'border-accent bg-accent text-on-accent' : cur ? 'border-accent bg-solid text-accent' : 'border-line-2 bg-solid text-ink-3')}
              style={cur ? { boxShadow: '0 0 0 4px var(--accent-soft)' } : undefined}>
              {m.status === 'completed' ? <Check size={12} strokeWidth={3.2} /> : cur ? <CircleDot size={12} strokeWidth={3} /> : m.status === 'skipped' ? <Minus size={12} strokeWidth={3} /> : null}
            </span>
            <div className={cx('mt-2 text-[12.5px] leading-snug', cur ? 'font-semibold' : m.status === 'pending' || m.status === 'skipped' ? 'text-ink-2' : 'font-medium', m.status === 'skipped' && 'line-through')}>{m.name}</div>
            <div className="mt-0.5 text-[11.5px] leading-snug text-ink-3">
              {m.status === 'skipped' ? 'Skipped' : m.startedDate ? <>Reached {fmtDate(m.startedDate)}</> : m.plannedDate ? <>Planned {fmtDate(m.plannedDate)}</> : 'No date planned'}
              {cur && v.daysInStage !== null && open && <span className="block font-medium text-ink-2">{v.daysInStage} {v.daysInStage === 1 ? 'day' : 'days'} in this stage</span>}
              {late && <span className="mt-0.5 flex items-center gap-1 font-medium text-crit"><TriangleAlert size={11} /> Past plan</span>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function MilestoneEditor({ v, onClose }: { v: any; onClose: () => void }) {
  const { run, busy } = useAct();
  const [ms, setMs] = useState<any[]>(() => v.milestones.map((m: any) => ({ id: m.id, name: m.name, status: m.status, plannedDate: m.plannedDate ?? '', startedDate: m.startedDate ?? '', completedDate: m.completedDate ?? '' })));
  const upd = (i: number, patch: Record<string, unknown>) => setMs((list) => list.map((m, j) => {
    if (j !== i) return patch.status === 'in_progress' && m.status === 'in_progress' ? { ...m, status: 'completed' } : m; // only one current stage
    return { ...m, ...patch };
  }));
  const move = (i: number, d: number) => setMs((list) => { const n = [...list]; const [x] = n.splice(i, 1); n.splice(i + d, 0, x); return n; });
  const save = async () => {
    const milestones = ms.map((m) => ({ ...(m.id ? { id: m.id } : {}), name: m.name.trim(), status: m.status, plannedDate: m.plannedDate || null, startedDate: m.startedDate || null, completedDate: m.completedDate || null }));
    if (await run(() => api(`/vacancies/${v.id}/milestones`, { method: 'PUT', body: { milestones } }), 'Milestones saved')) onClose();
  };
  return (
    <Modal title="Edit milestones" subtitle="Add, remove, reorder or skip milestones for this vacancy. Other vacancies are not affected." onClose={onClose} width={860}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={ms.some((m) => !m.name.trim()) || !ms.length} onClick={save}>Save milestones</Button></>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-[13px]">
          <thead><tr className="text-left text-[11px] uppercase tracking-[0.05em] text-ink-3"><th className="w-14 pb-2" /><th className="pb-2">Milestone</th><th className="w-40 pb-2">Status</th><th className="w-36 pb-2">Planned</th><th className="w-36 pb-2">Reached</th><th className="w-9 pb-2" /></tr></thead>
          <tbody>
            {ms.map((m, i) => (
              <tr key={m.id ?? `new-${i}`}>
                <td className="py-1 pr-2">
                  <span className="flex">
                    <button aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)} className="rounded p-1 text-ink-3 hover:bg-hover disabled:opacity-30"><ArrowUp size={14} /></button>
                    <button aria-label="Move down" disabled={i === ms.length - 1} onClick={() => move(i, 1)} className="rounded p-1 text-ink-3 hover:bg-hover disabled:opacity-30"><ArrowDown size={14} /></button>
                  </span>
                </td>
                <td className="py-1 pr-2"><input className="field" aria-label="Milestone name" value={m.name} onChange={(e) => upd(i, { name: e.target.value })} /></td>
                <td className="py-1 pr-2"><select className="field" aria-label="Status" value={m.status} onChange={(e) => upd(i, { status: e.target.value })}>{Object.entries(MS_STATUS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></td>
                <td className="py-1 pr-2"><input type="date" className="field" aria-label="Planned date" value={m.plannedDate} onChange={(e) => upd(i, { plannedDate: e.target.value })} /></td>
                <td className="py-1 pr-2"><input type="date" className="field" aria-label="Reached date" value={m.startedDate} disabled={!['in_progress', 'completed'].includes(m.status)} onChange={(e) => upd(i, { startedDate: e.target.value })} /></td>
                <td className="py-1"><button aria-label={`Remove ${m.name}`} onClick={() => setMs((l) => l.filter((_, j) => j !== i))} className="rounded p-1.5 text-ink-3 hover:bg-hover hover:text-crit"><Trash2 size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Button className="mt-3" size="sm" icon={Plus} onClick={() => setMs((l) => [...l, { name: '', status: 'pending', plannedDate: '', startedDate: '', completedDate: '' }])}>Add milestone</Button>
    </Modal>
  );
}

const show = (x: unknown) => (x === null || x === undefined || x === '' ? '—' : String(x));
function Changes({ changes }: { changes: any }) {
  if (!changes || typeof changes !== 'object') return null;
  const entries = Object.entries(changes).filter(([, c]: any) => c && typeof c === 'object' && 'to' in c);
  if (!entries.length) return null;
  return (
    <ul className="mt-1.5 space-y-0.5 text-[12.5px] text-ink-2">
      {entries.map(([k, c]: any) => (
        <li key={k} className="flex flex-wrap gap-x-1.5"><span className="text-ink-3">{c.label ?? k}:</span><span className="line-through decoration-ink-3/60">{show(c.from)}</span><span className="text-ink-3">→</span><span className="font-medium text-ink">{show(c.to)}</span></li>
      ))}
    </ul>
  );
}

export function VacancyPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { run } = useAct();
  const q = useQuery({ queryKey: ['vacancy', id], queryFn: () => api<any>(`/vacancies/${id}`) });
  const [modal, setModal] = useState<'update' | 'edit' | 'milestones' | 'summary' | null>(null);
  const [tab, setTab] = useState<'updates' | 'history'>('updates');
  const [action, setAction] = useState<any>(undefined);
  const summary = useQuery({ queryKey: ['assistant', 'vacancy', id], queryFn: () => api<any>(`/assistant/vacancy/${id}`), enabled: modal === 'summary' });
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const v = q.data;
  const open = ['active', 'on_hold'].includes(v.statusCategory);
  const latest = v.updates[0];
  const g = v.greenhouseSnapshot;
  const archive = async () => {
    if (!window.confirm(`Archive “${v.title}”? It disappears from the tracker and reports; its history is kept.`)) return;
    if (await run(() => api(`/vacancies/${v.id}`, { method: 'DELETE' }), 'Vacancy archived')) nav('/tracker');
  };

  return (
    <>
      <Link to="/tracker" className="no-print mb-3 inline-flex items-center gap-1.5 text-[13px] text-ink-2 hover:text-ink"><ArrowLeft size={15} /> Hiring tracker</Link>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">{v.title}</h1>
            {v.isDemo && <DemoTag />}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[13.5px] text-ink-2">
            <StatusPill k={v.overall.key} label={v.overall.label} />
            <PriorityTag p={v.priority} />
            <span>{[v.city, v.country].filter(Boolean).join(', ') || 'No location'}</span>
            {v.department && <span>· {v.department}</span>}
            <span>· Recruited by {v.taTeam ?? '—'}</span>
          </div>
        </div>
        <div className="no-print flex flex-wrap items-center gap-2">
          {can('assistant.use') && <Button icon={Sparkles} onClick={() => setModal('summary')}>Summary</Button>}
          {v.canEdit && <Button icon={FileText} onClick={() => setModal('edit')}>Edit record</Button>}
          {can('vacancies.archive') && <Button variant="ghost" icon={Archive} onClick={archive} aria-label="Archive vacancy" title="Archive vacancy" />}
          {v.canEdit && <Button variant="primary" icon={PencilLine} onClick={() => setModal('update')}>Update progress</Button>}
        </div>
      </div>

      <Card className="mb-5 p-5">
        <SectionTitle right={v.canEdit && <Button size="sm" icon={PencilLine} onClick={() => setModal('milestones')}>Edit milestones</Button>}>
          Recruitment milestones · {v.milestonesDone} of {v.milestonesTotal} complete
        </SectionTitle>
        <MilestoneTrack v={v} />
        <p className="mt-3 text-[11.5px] text-ink-3">Operational milestones are managed in Talent Radar. Candidate application stages stay in Greenhouse and are shown separately below.</p>
      </Card>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card className="p-5">
            <SectionTitle right={<span className="text-[12px] text-ink-3">{v.lastUpdateAt ? <>Last updated {fmtDate(v.lastUpdateAt)} ({relDay(v.lastUpdateAt)}){v.lastUpdateByName ? ` by ${v.lastUpdateByName}` : ''}</> : 'Never updated'}</span>}>Latest progress update</SectionTitle>
            <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{v.progressUpdate ?? <span className="text-ink-3">No progress update has been recorded yet.</span>}</p>
            {v.latestAchievement && <p className="mt-3 flex items-start gap-2 text-[13.5px] text-ink-2"><Trophy size={15} className="mt-0.5 shrink-0 text-good" /><span><span className="text-ink-3">Latest achievement: </span>{v.latestAchievement}</span></p>}
          </Card>

          <Card solid className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-4">
              <Segmented value={tab} onChange={setTab} options={[{ value: 'updates', label: 'Recruitment timeline', count: v.updates.length }, { value: 'history', label: 'Change history', count: v.history.length }]} />
              <span className="text-[12px] text-ink-3">{tab === 'updates' ? 'Progress updates with the status recorded at the time' : 'Every change, who made it and when'}</span>
            </div>
            {tab === 'updates' ? (
              <ol className="px-5 pb-5">
                {v.updates.map((u: any, i: number) => (
                  <li key={u.id} className="relative flex gap-3 pb-5 last:pb-0">
                    {i < v.updates.length - 1 && <span className="absolute bottom-0 left-[12px] top-7 w-px bg-line-2" />}
                    <Avatar name={u.userName} size={25} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3"><b className="font-medium text-ink-2">{u.userName ?? 'System'}</b><span>{fmtDateTime(u.createdAt)}</span>{u.source === 'import' && <Tag>Imported</Tag>}{i === 0 && latest && <Tag tone="accent">Latest</Tag>}</div>
                      <p className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed">{u.summary}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                        {u.stage && <Tag><Flag size={11} />{u.stage}</Tag>}
                        {u.statusCategory === 'active' && u.health && <span className="inline-flex items-center gap-1 text-ink-2"><StatusIcon k={u.health} size={13} />{HEALTH[u.health]}</span>}
                        {u.statusCategory && u.statusCategory !== 'active' && <Tag>{u.statusLabel}</Tag>}
                      </div>
                      {u.nextAction && <p className="mt-1 text-[12.5px] text-ink-2"><span className="text-ink-3">Next: </span>{u.nextAction}{u.actionOwner ? ` — ${u.actionOwner}` : ''}{u.actionDeadline ? `, by ${fmtDate(u.actionDeadline)}` : ''}</p>}
                      {u.blocker && <p className="mt-0.5 text-[12.5px] text-ink-2"><span className="text-ink-3">Blocker: </span>{u.blocker}</p>}
                      {u.achievement && <p className="mt-0.5 text-[12.5px] text-ink-2"><span className="text-ink-3">Achievement: </span>{u.achievement}</p>}
                    </div>
                  </li>
                ))}
                {!v.updates.length && <li className="py-6 text-center text-[13px] text-ink-3">No progress updates yet.</li>}
              </ol>
            ) : (
              <ul className="divide-y divide-line">
                {v.history.map((h: any) => (
                  <li key={h.id} className="px-5 py-3">
                    <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-ink-3"><b className="font-medium text-ink-2">{h.userName ?? 'System'}</b><span>{fmtDateTime(h.at)}</span><Tag>{String(h.action).replace(/_/g, ' ')}</Tag></div>
                    {h.summary && <p className="mt-0.5 text-[13.5px]">{h.summary}</p>}
                    <Changes changes={h.changes} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card className="p-5">
            <SectionTitle>Next action</SectionTitle>
            {v.nextAction ? <>
              <p className="text-[15px] font-medium leading-snug">{v.nextAction}</p>
              <dl className="mt-3"><Row label="Responsible">{v.actionOwner}</Row><Row label="Deadline"><Deadline date={v.actionDeadline} closed={!open} /></Row></dl>
            </> : <p className="flex items-center gap-2 text-[13.5px]">{open ? <><TriangleAlert size={16} style={{ color: 'var(--warn)' }} /> No next action has been agreed.</> : <span className="text-ink-3">Vacancy is closed.</span>}</p>}
          </Card>

          {(v.currentBlocker || v.supportRequired || v.overall.key === 'blocked') && (
            <Card className="p-5">
              <SectionTitle>Blockers and support</SectionTitle>
              <div className="space-y-3 text-[13.5px]">
                <div className="flex gap-2.5"><StatusIcon k="blocked" /><div><div className="text-[12px] font-medium text-ink-3">Current blocker</div><p className="whitespace-pre-wrap">{v.currentBlocker ?? <span className="text-ink-3">No description recorded.</span>}</p></div></div>
                {v.supportRequired && <div className="flex gap-2.5"><LifeBuoy size={16} className="mt-0.5 shrink-0 text-accent" /><div><div className="text-[12px] font-medium text-ink-3">Support required</div><p className="whitespace-pre-wrap">{v.supportRequired}</p></div></div>}
              </div>
            </Card>
          )}

          <Card className="p-5">
            <SectionTitle>Ownership</SectionTitle>
            <dl>
              <Row label="Responsible TA team">{v.taTeam}</Row>
              <Row label="Recruiter">{v.recruiter ?? <Tag tone="warn">Unassigned</Tag>}</Row>
              <Row label="Hiring manager">{v.hiringManager && <>{v.hiringManager}{v.hiringManagerEmail && <a className="block truncate text-[12px] text-accent hover:underline" href={`mailto:${v.hiringManagerEmail}`}>{v.hiringManagerEmail}</a>}</>}</Row>
              <Row label="Department owner">{v.departmentOwner}</Row>
              <Row label="Stakeholders">{v.stakeholders}</Row>
            </dl>
          </Card>

          <Card className="p-5">
            <SectionTitle>Vacancy information</SectionTitle>
            <dl>
              <Row label="Vacancy location">{[v.city, v.country].filter(Boolean).join(', ') || null}</Row>
              <Row label="Department">{v.department}</Row>
              <Row label="Job family">{v.jobFamily}</Row>
              <Row label="Vacancy type">{v.vacancyType}</Row>
              <Row label="Vacancy status">{v.status}{v.statusCategory === 'active' && <span className="text-ink-3"> · {HEALTH[v.health]}</span>}</Row>
              <Row label="Opening date">{v.openingDate && <span className="num">{fmtDate(v.openingDate, { year: true })}</span>}</Row>
              <Row label="Target hiring date">{v.targetHireDate && <><span className="num">{fmtDate(v.targetHireDate, { year: true })}</span>{open && <span className={cx('block text-[12px]', isPast(v.targetHireDate) ? 'font-medium text-crit' : 'text-ink-3')}>{isPast(v.targetHireDate) ? 'Passed · ' : ''}{relDay(v.targetHireDate)}</span>}</>}</Row>
              {v.closureDate && <Row label="Closure date"><span className="num">{fmtDate(v.closureDate, { year: true })}</span></Row>}
            </dl>
          </Card>

          <Card className="p-5">
            <SectionTitle right={v.greenhouseUrl && <a href={v.greenhouseUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] font-medium text-accent hover:underline">Open in Greenhouse <ExternalLink size={12} /></a>}>Greenhouse record</SectionTitle>
            {!v.greenhouseJobId ? <p className="flex items-start gap-2 text-[13px] text-ink-2"><Link2 size={15} className="mt-0.5 shrink-0 text-ink-3" /> No Greenhouse job is linked. Add the job ID in “Edit record” to link this vacancy.</p> : <>
              <dl><Row label="Job ID"><span className="num">{v.greenhouseJobId}</span></Row>
                {g && <><Row label="Job status in Greenhouse">{g.status}</Row><Row label="Last synchronised">{fmtDateTime(v.greenhouseSyncedAt)}{g.mode === 'demo' && <> <Tag tone="accent">Simulated</Tag></>}</Row></>}</dl>
              {!g && <p className="mt-1 text-[12.5px] text-ink-3">Not synchronised yet. Candidate counts appear here after a Greenhouse sync.</p>}
              {g && <>
                <div className="mt-3 text-[12px] font-medium text-ink-3">Candidate application stages (from Greenhouse) · {g.activeApplications} active</div>
                {g.byStage?.length ? (
                  <ul className="mt-1.5 space-y-1">
                    {g.byStage.map((s: any) => {
                      const max = Math.max(...g.byStage.map((x: any) => x.count));
                      return <li key={s.stage} className="flex items-center gap-2 text-[12.5px]"><span className="w-[46%] truncate text-ink-2">{s.stage}</span><span className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full bg-accent" style={{ width: `${(s.count / max) * 100}%` }} /></span><span className="num w-6 text-right">{s.count}</span></li>;
                    })}
                  </ul>
                ) : <p className="mt-1 text-[12.5px] text-ink-3">No active applications.</p>}
                {g.mismatches?.length > 0 && (
                  <div className="mt-3 rounded-xl border border-line bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] px-3 py-2 text-[12.5px]">
                    <div className="mb-1 flex items-center gap-1.5 font-medium"><TriangleAlert size={13} style={{ color: 'var(--warn)' }} /> Differs from Greenhouse</div>
                    {g.mismatches.map((m: any) => <div key={m.field} className="text-ink-2">{m.field}: tracker “{show(m.tracker)}” · Greenhouse “{show(m.greenhouse)}”</div>)}
                  </div>
                )}
              </>}
            </>}
          </Card>

          <Card solid className="overflow-hidden">
            <div className="px-5 pt-4"><SectionTitle right={can('actions.manage_own', 'actions.manage_all') && <Button size="sm" icon={Plus} onClick={() => setAction(null)}>Add action</Button>}>Actions</SectionTitle></div>
            <ActionList actions={v.actions.map((a: any) => ({ ...a, canManage: can('actions.manage_all') || v.canEdit }))} onOpen={setAction} empty="No actions are linked to this vacancy." />
          </Card>

          {'internalNotes' in v && (
            <Card className="p-5">
              <SectionTitle>Internal notes</SectionTitle>
              <p className="whitespace-pre-wrap text-[13.5px]">{v.internalNotes ?? <span className="text-ink-3">None. Add notes in “Edit record”.</span>}</p>
            </Card>
          )}
        </div>
      </div>

      {modal === 'update' && <QuickUpdate vacancy={v} onClose={() => setModal(null)} />}
      {modal === 'edit' && <VacancyForm vacancy={v} onClose={() => setModal(null)} />}
      {modal === 'milestones' && <MilestoneEditor v={v} onClose={() => setModal(null)} />}
      {modal === 'summary' && (
        <Modal title={`Progress summary`} subtitle={v.title} onClose={() => setModal(null)} width={760}>
          {summary.isLoading ? <InsightSkeleton /> : summary.error ? <ErrorNote error={summary.error} /> : <InsightView insight={summary.data} />}
        </Modal>
      )}
      {action !== undefined && <ActionDrawer action={action ?? undefined} defaults={{ vacancyId: v.id }} onClose={() => setAction(undefined)} />}
    </>
  );
}
