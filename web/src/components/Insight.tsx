import { Cpu, FileSearch, Sparkles, TriangleAlert } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router-dom';
import { cx, fmtDateTime } from '../lib/format';

const TONE: Record<string, string> = { positive: 'var(--good)', warning: 'var(--warn)', critical: 'var(--crit)' };

function Sources({ sources }: { sources: any[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? sources : sources.slice(0, 2);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-3">
      <FileSearch size={12} className="shrink-0" aria-label="Based on" />
      {shown.map((s, i) => {
        const to = s.vacancyId ? `/vacancies/${s.vacancyId}` : s.type === 'action' ? '/actions' : s.type === 'report' ? '/reports' : s.type === 'rule' ? '/risks' : null;
        const body = <span className="line-clamp-1 max-w-[420px]">{s.label}</span>;
        return to
          ? <Link key={i} to={to} className="rounded-md border border-line px-1.5 py-px hover:border-line-2 hover:text-ink">{body}</Link>
          : <span key={i} className="rounded-md border border-line px-1.5 py-px">{body}</span>;
      })}
      {sources.length > 2 && <button className="rounded-md px-1 text-accent hover:underline" onClick={() => setAll((a) => !a)}>{all ? 'Show fewer' : `+${sources.length - 2} more`}</button>}
    </div>
  );
}

/**
 * Renders an assistant result. Every statement is numbered and shows the records it was
 * built from; when an LLM has re-worded the text, its [n] citations point at these numbers.
 */
export function InsightView({ insight }: { insight: any }) {
  let n = 0;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span className="inline-flex items-center gap-1.5"><Cpu size={13} /> Built-in engine · generated {fmtDateTime(insight.generatedAt)}</span>
        <span>Based on: {insight.basis}</span>
      </div>
      {insight.llm?.note && (
        <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-line bg-[color-mix(in_srgb,var(--warn)_12%,transparent)] px-3.5 py-2.5 text-[13px]">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} /> <span>{insight.llm.note}</span>
        </div>
      )}
      {insight.narrative && (
        <div className="mb-5 rounded-xl border border-line bg-accent-soft px-4 py-3.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-accent"><Sparkles size={13} /> Wording by {insight.llm?.model}</div>
          <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{insight.narrative}</p>
          <p className="mt-2 text-[12px] text-ink-3">Bracketed numbers refer to the recorded facts listed below. The wording was accepted only because every figure in it appears in those facts.</p>
        </div>
      )}
      <div className="space-y-6">
        {insight.sections.map((sec: any) => (
          <section key={sec.heading}>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">{sec.heading}</h3>
            {sec.statements.length === 0 ? <p className="text-[13.5px] text-ink-3">{sec.empty ?? 'Nothing recorded.'}</p> : (
              <ol className="space-y-2.5">
                {sec.statements.map((st: any, i: number) => {
                  n += 1;
                  return (
                    <li key={i} className="flex gap-3">
                      <span className="num mt-px w-6 shrink-0 text-right text-[12px] text-ink-3">{n}</span>
                      <span className={cx('mt-1.5 h-[calc(100%-12px)] min-h-[14px] w-[3px] shrink-0 rounded-full')} style={{ background: TONE[st.tone] ?? 'var(--line-2)' }} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] leading-relaxed">{st.text}</p>
                        <Sources sources={st.sources} />
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

export const InsightSkeleton = () => <Fragment><div className="mb-3 h-3 w-64 animate-pulse rounded bg-line-2" />{[0, 1, 2, 3].map((i) => <div key={i} className="mb-2.5 h-4 animate-pulse rounded bg-line" style={{ width: `${88 - i * 12}%` }} />)}</Fragment>;
