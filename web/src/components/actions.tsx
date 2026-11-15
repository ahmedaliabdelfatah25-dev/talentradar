import { useQuery } from '@tanstack/react-query';
import { Check, Hourglass, MessageSquare, Send } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAct, useAuth, useMeta } from '../lib/app';
import { cx, fmtDateTime } from '../lib/format';
import { Deadline } from './vacancy';
import { Avatar, Button, Drawer, Field, Loading, PriorityTag, Tag } from './ui';

export const BUCKETS: { key: string; label: string; hint: string }[] = [
  { key: 'overdue', label: 'Overdue', hint: 'Past the due date and still open' },
  { key: 'today', label: 'Due today', hint: 'Due today' },
  { key: 'upcoming', label: 'Upcoming', hint: 'Due within the next 14 days' },
  { key: 'waiting', label: 'Waiting on others', hint: 'Waiting for feedback from another stakeholder' },
  { key: 'later', label: 'Later', hint: 'Due later, or no due date' },
  { key: 'done', label: 'Completed', hint: 'Completed or cancelled in the last 30 days' },
];
const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', waiting_feedback: 'Waiting for feedback', completed: 'Completed', cancelled: 'Cancelled' };

export function ActionList({ actions, onOpen, empty = 'Nothing here.', showAssignee = true }: { actions: any[]; onOpen: (a: any) => void; empty?: string; showAssignee?: boolean }) {
  const { run } = useAct();
  if (!actions.length) return <p className="px-4 py-6 text-center text-[13px] text-ink-3">{empty}</p>;
  return (
    <ul className="divide-y divide-line">
      {actions.map((a) => {
        const done = a.status === 'completed' || a.status === 'cancelled';
        return (
          <li key={a.id} className="flex cursor-pointer items-start gap-3 px-4 py-3 transition hover:bg-hover" onClick={() => onOpen(a)}>
            <button disabled={!a.canManage} title={done ? 'Reopen' : 'Mark as completed'} aria-label={done ? `Reopen ${a.title}` : `Mark ${a.title} as completed`}
              onClick={(e) => { e.stopPropagation(); void run(() => api(`/actions/${a.id}`, { method: 'PATCH', body: { status: done ? 'open' : 'completed' } }), done ? 'Action reopened' : 'Action completed'); }}
              className={cx('mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border transition disabled:opacity-40',
                done ? 'border-good bg-good text-white' : 'border-line-2 text-transparent hover:border-accent hover:text-accent')}>
              <Check size={12} strokeWidth={3} />
            </button>
            <div className="min-w-0 flex-1">
              <div className={cx('text-[13.5px] font-medium leading-snug', done && 'text-ink-3 line-through')}>{a.title}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[12px] text-ink-3">
                {a.vacancyTitle && <span className="truncate">{a.vacancyTitle}</span>}
                {showAssignee && a.assignee && <span>{a.assignee}</span>}
                {a.status === 'waiting_feedback' && <span className="inline-flex items-center gap-1 text-ink-2"><Hourglass size={12} style={{ color: 'var(--serious)' }} />Waiting{a.waitingOn ? ` for ${a.waitingOn}` : ' for feedback'}</span>}
                {a.status === 'in_progress' && <span>In progress</span>}
                {a.commentCount > 0 && <span className="inline-flex items-center gap-1"><MessageSquare size={12} />{a.commentCount}</span>}
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1 text-[12.5px]">
              <Deadline date={a.dueDate} closed={done} />
              {['high', 'critical'].includes(a.priority) && !done && <PriorityTag p={a.priority} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Create or edit an action. Existing actions also show their comment thread. */
export function ActionDrawer({ action, defaults, onClose }: { action?: any; defaults?: { vacancyId?: number; assigneeId?: number }; onClose: () => void }) {
  const meta = useMeta();
  const { user } = useAuth();
  const { run, busy } = useAct();
  const vacancies = useQuery({ queryKey: ['vacancies', 'all'], queryFn: () => api<any[]>('/vacancies') });
  const detail = useQuery({ queryKey: ['action', action?.id], queryFn: () => api<any>(`/actions/${action.id}`), enabled: !!action });
  const readOnly = !!action && !action.canManage;
  const blank = { title: '', description: '', vacancyId: defaults?.vacancyId ?? '', assigneeId: defaults?.assigneeId ?? user!.id, waitingOn: '', dueDate: '', priority: 'medium', status: 'open' };
  const [f, setF] = useState<Record<string, any>>(blank);
  const [comment, setComment] = useState('');
  useEffect(() => {
    if (action) setF({ title: action.title, description: action.description ?? '', vacancyId: action.vacancyId ?? '', assigneeId: action.assigneeId ?? '', waitingOn: action.waitingOn ?? '',
      dueDate: action.dueDate ?? '', priority: action.priority, status: action.status });
  }, [action]);
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function save() {
    const body = { title: f.title.trim(), description: f.description.trim() || null, vacancyId: f.vacancyId ? Number(f.vacancyId) : null, assigneeId: f.assigneeId ? Number(f.assigneeId) : null,
      waitingOn: f.waitingOn.trim() || null, dueDate: f.dueDate || null, priority: f.priority, status: f.status };
    if (await run(() => api(action ? `/actions/${action.id}` : '/actions', { method: action ? 'PATCH' : 'POST', body }), action ? 'Action saved' : 'Action created')) onClose();
  }
  async function addComment() {
    if (await run(() => api(`/actions/${action.id}/comments`, { body: { body: comment.trim() } }))) setComment('');
  }

  return (
    <Drawer title={action ? 'Action' : 'New action'} subtitle={action ? `Created ${fmtDateTime(action.createdAt)}${action.createdByName ? ` by ${action.createdByName}` : ''}` : 'Assign a task with an owner and a due date'} onClose={onClose}
      footer={readOnly ? <Button onClick={onClose}>Close</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" busy={busy} disabled={f.title.trim().length < 2} onClick={save}>{action ? 'Save changes' : 'Create action'}</Button></>}>
      <fieldset disabled={readOnly} className="space-y-3.5">
        <Field label="Action title" required><input className="field" autoFocus={!action} value={f.title} onChange={set('title')} placeholder="What needs to be done?" /></Field>
        <Field label="Description"><textarea className="field" rows={2} value={f.description} onChange={set('description')} /></Field>
        <Field label="Related vacancy">
          <select className="field" value={f.vacancyId} onChange={set('vacancyId')}>
            <option value="">Not linked to a vacancy</option>
            {vacancies.data?.map((v) => <option key={v.id} value={v.id}>{v.title}{v.country ? ` — ${v.country}` : ''}</option>)}
          </select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Assigned to">
            <select className="field" value={f.assigneeId} onChange={set('assigneeId')}>
              <option value="">Unassigned</option>
              {meta.data?.users.filter((u: any) => u.isActive || u.id === action?.assigneeId).map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </Field>
          <Field label="Due date"><input type="date" className="field" value={f.dueDate} onChange={set('dueDate')} /></Field>
          <Field label="Priority">
            <select className="field" value={f.priority} onChange={set('priority')}>{['low', 'medium', 'high', 'critical'].map((p) => <option key={p} value={p}>{p[0].toUpperCase() + p.slice(1)}</option>)}</select>
          </Field>
          <Field label="Status">
            <select className="field" value={f.status} onChange={set('status')}>{Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          </Field>
        </div>
        {(f.status === 'waiting_feedback' || f.waitingOn) && (
          <Field label="Waiting for" hint="The stakeholder whose feedback or decision is needed."><input className="field" value={f.waitingOn} onChange={set('waitingOn')} placeholder="e.g. hiring manager's name" /></Field>
        )}
      </fieldset>

      {action && (
        <div className="mt-7">
          <h3 className="mb-2.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">Comments</h3>
          {action.vacancyId && <p className="mb-3 text-[12.5px] text-ink-3">Vacancy: <Link className="text-accent hover:underline" to={`/vacancies/${action.vacancyId}`} onClick={onClose}>{action.vacancyTitle}</Link></p>}
          {detail.isLoading ? <Loading /> : (
            <ul className="space-y-3">
              {detail.data?.comments.map((c: any) => (
                <li key={c.id} className="flex gap-2.5">
                  <Avatar name={c.userName} size={24} />
                  <div className="min-w-0 flex-1 rounded-xl border border-line bg-field px-3 py-2">
                    <div className="text-[12px] text-ink-3"><b className="font-medium text-ink-2">{c.userName ?? 'Unknown'}</b> · {fmtDateTime(c.createdAt)}</div>
                    <div className="mt-0.5 whitespace-pre-wrap text-[13px]">{c.body}</div>
                  </div>
                </li>
              ))}
              {detail.data?.comments.length === 0 && <li className="text-[13px] text-ink-3">No comments yet.</li>}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <input className="field" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && comment.trim()) void addComment(); }} />
            <Button icon={Send} disabled={!comment.trim() || busy} onClick={addComment}>Post</Button>
          </div>
          {action.completedAt && <p className="mt-4 text-[12.5px] text-ink-3"><Tag tone="good">Completed</Tag> {fmtDateTime(action.completedAt)}</p>}
        </div>
      )}
    </Drawer>
  );
}
