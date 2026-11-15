import { useQuery } from '@tanstack/react-query';
import { ListChecks, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ActionDrawer, ActionList, BUCKETS } from '../components/actions';
import { Button, Card, ErrorNote, Loading, PageHeader, Segmented } from '../components/ui';
import { api } from '../lib/api';
import { useAuth, useMeta } from '../lib/app';

export function ActionsPage() {
  const { user, can } = useAuth();
  const meta = useMeta();
  const q = useQuery({ queryKey: ['actions'], queryFn: () => api<any[]>('/actions') });
  const [bucket, setBucket] = useState('overdue');
  const [who, setWho] = useState<string>(user!.role === 'recruiter' ? String(user!.id) : '');
  const [vacancy, setVacancy] = useState('');
  const [open, setOpen] = useState<any>(undefined);
  const scoped = useMemo(() => (q.data ?? []).filter((a) => (!who || String(a.assigneeId) === who) && (!vacancy || String(a.vacancyId) === vacancy)), [q.data, who, vacancy]);
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const counts = Object.fromEntries(BUCKETS.map((b) => [b.key, scoped.filter((a) => a.bucket === b.key).length]));
  const active = counts[bucket] === 0 && bucket === 'overdue' ? (BUCKETS.find((b) => counts[b.key] > 0)?.key ?? 'overdue') : bucket;
  const list = scoped.filter((a) => a.bucket === active);
  const vacancies = [...new Map((q.data ?? []).filter((a) => a.vacancyId).map((a) => [a.vacancyId, a.vacancyTitle])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const info = BUCKETS.find((b) => b.key === active)!;

  return (
    <>
      <PageHeader title="Recruitment action centre" subtitle="Shared tasks for the team. Buckets are worked out from each action's status and due date."
        actions={can('actions.manage_own', 'actions.manage_all') && <Button variant="primary" icon={Plus} onClick={() => setOpen(null)}>New action</Button>} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented value={active} onChange={setBucket} options={BUCKETS.map((b) => ({ value: b.key, label: b.label, count: counts[b.key], alert: b.key === 'overdue' }))} />
        <div className="ml-auto flex flex-wrap gap-2">
          <select className="field !w-auto" aria-label="Assigned to" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {meta.data?.users.filter((u: any) => u.isActive).map((u: any) => <option key={u.id} value={u.id}>{u.id === user!.id ? `${u.name} (me)` : u.name}</option>)}
          </select>
          <select className="field !w-auto max-w-[260px]" aria-label="Related vacancy" value={vacancy} onChange={(e) => setVacancy(e.target.value)}>
            <option value="">All vacancies</option>
            {vacancies.map(([id, title]) => <option key={id} value={id}>{title}</option>)}
          </select>
        </div>
      </div>
      <Card solid className="overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3"><ListChecks size={14} /> {info.hint} · {list.length} {list.length === 1 ? 'action' : 'actions'}</div>
        <ActionList actions={list} onOpen={setOpen} empty={active === 'overdue' ? 'Nothing is overdue.' : 'No actions in this group.'} />
      </Card>
      {open !== undefined && <ActionDrawer action={open ?? undefined} onClose={() => setOpen(undefined)} />}
    </>
  );
}
