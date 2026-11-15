import { useQuery } from '@tanstack/react-query';
import { Clipboard, Cpu, Mail, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { InsightSkeleton, InsightView } from '../components/Insight';
import { Button, Card, ErrorNote, PageHeader, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useToast } from '../lib/app';
import { cx } from '../lib/format';

const VIEWS = [
  { key: 'brief', label: 'Leadership brief', hint: 'Status in plain business language' },
  { key: 'weekly', label: 'Weekly status summary', hint: 'What happened this week' },
  { key: 'vacancy', label: 'Vacancy progress summary', hint: 'One vacancy, start to now' },
  { key: 'suggestions', label: 'Suggested next actions', hint: 'Based on recorded progress' },
  { key: 'outdated', label: 'Outdated records', hint: 'Stale or incomplete entries' },
  { key: 'reminders', label: 'Reminder drafts', hint: 'For overdue actions' },
  { key: 'bottlenecks', label: 'Recurring bottlenecks', hint: 'Where time is lost' },
];

export function AssistantPage() {
  const toast = useToast();
  const [view, setView] = useState('brief');
  const [vacancyId, setVacancyId] = useState('');
  const [polish, setPolish] = useState(false);
  const status = useQuery({ queryKey: ['assistant', 'status'], queryFn: () => api<any>('/assistant/status') });
  const vacancies = useQuery({ queryKey: ['vacancies', 'all'], queryFn: () => api<any[]>('/vacancies'), enabled: view === 'vacancy' });
  const vid = vacancyId || (vacancies.data?.[0] ? String(vacancies.data[0].id) : '');
  const usePolish = polish && status.data?.configured && view !== 'reminders';
  const path = view === 'vacancy' ? (vid ? `/assistant/vacancy/${vid}` : null) : `/assistant/${view}`;
  const q = useQuery({ queryKey: ['assistant', view, vid, usePolish], queryFn: () => api<any>(`${path}${usePolish ? '?polish=1' : ''}`), enabled: !!path });
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); toast('ok', 'Copied to clipboard'); } catch { toast('error', 'Could not copy — select the text and copy it manually'); } };
  const plain = (i: any) => i.sections.map((s: any) => `${s.heading}\n${s.statements.length ? s.statements.map((x: any) => `- ${x.text}`).join('\n') : `- ${s.empty ?? 'Nothing recorded.'}`}`).join('\n\n');

  return (
    <>
      <PageHeader title="Recruitment assistant" subtitle="Summaries, reminders and suggestions assembled from what is recorded in the tracker. Every statement shows the records it is based on."
        actions={<span className="inline-flex items-center gap-2 rounded-full border border-line bg-field px-3 py-1.5 text-[12.5px] text-ink-2"><Cpu size={14} /> {status.data?.description ?? 'Built-in engine'}</span>} />
      <div className="grid gap-5 lg:grid-cols-[250px_minmax(0,1fr)]">
        <Card className="self-start p-2">
          <nav aria-label="Assistant views" className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
            {VIEWS.map((v) => (
              <button key={v.key} onClick={() => setView(v.key)} aria-current={view === v.key}
                className={cx('shrink-0 rounded-xl px-3 py-2 text-left transition', view === v.key ? 'bg-accent-soft ring-1 ring-inset ring-line' : 'hover:bg-hover')}>
                <span className="block whitespace-nowrap text-[13.5px] font-medium">{v.label}</span>
                <span className="hidden text-[12px] text-ink-3 lg:block">{v.hint}</span>
              </button>
            ))}
          </nav>
        </Card>

        <Card solid className="p-5 sm:p-7">
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <h2 className="min-w-0 flex-1 text-[19px] font-semibold tracking-tight">{q.data?.title ?? VIEWS.find((v) => v.key === view)!.label}</h2>
            {view === 'vacancy' && (
              <select className="field !w-auto max-w-[300px]" aria-label="Vacancy" value={vid} onChange={(e) => setVacancyId(e.target.value)}>
                {vacancies.data?.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}
              </select>
            )}
            {status.data?.configured && view !== 'reminders' && (
              <label className="flex cursor-pointer items-center gap-2 rounded-full border border-line bg-field px-3 py-1.5 text-[12.5px]">
                <input type="checkbox" className="accent-[var(--accent)]" checked={polish} onChange={(e) => setPolish(e.target.checked)} /><Sparkles size={13} className="text-accent" /> Re-word with {status.data.model}
              </label>
            )}
            <Button size="sm" icon={RefreshCw} onClick={() => q.refetch()} busy={q.isFetching}>Refresh</Button>
            {q.data && view !== 'reminders' && <Button size="sm" icon={Clipboard} onClick={() => copy(q.data.narrative ?? plain(q.data))}>Copy text</Button>}
          </div>

          {q.isLoading ? <InsightSkeleton /> : q.error ? <ErrorNote error={q.error} /> : !q.data ? <p className="text-ink-3">Choose a vacancy.</p> : view === 'reminders' ? (
            <div>
              <p className="mb-4 text-[13px] text-ink-3">Drafts only — nothing is sent by the application. Copy a draft or open it in your mail client, then edit before sending. Based on: {q.data.basis}</p>
              {q.data.drafts.length === 0 && <p className="text-[14px] text-ink-2">Nothing is overdue, so there is nothing to chase.</p>}
              <ul className="space-y-3">
                {q.data.drafts.map((d: any, i: number) => (
                  <li key={i} className="rounded-xl border border-line bg-field p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13.5px] font-semibold">To: {d.to}</span>
                      {d.toEmail ? <span className="text-[12px] text-ink-3">{d.toEmail}</span> : <Tag tone="warn">No email on record</Tag>}
                      <span className="ml-auto flex gap-1.5">
                        <Button size="sm" icon={Clipboard} onClick={() => copy(`Subject: ${d.subject}\n\n${d.body}`)}>Copy</Button>
                        <a className="inline-flex h-7 items-center gap-1.5 rounded-[10px] border border-line-2 bg-field px-2.5 text-[12.5px] font-medium hover:bg-hover"
                          href={`mailto:${d.toEmail ?? ''}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`}><Mail size={14} /> Open in mail</a>
                      </span>
                    </div>
                    <div className="mt-2 text-[13px] font-medium">{d.subject}</div>
                    <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[13px] leading-relaxed text-ink-2">{d.body}</pre>
                    <div className="mt-2 text-[11.5px] text-ink-3">Based on: {d.sources.map((s: any) => s.label).join('; ')}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : <InsightView insight={q.data} />}
        </Card>
      </div>
    </>
  );
}
