import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, CircleCheck, Download, FileSpreadsheet, Info, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, ErrorNote, Loading, Modal, PageHeader, SectionTitle, Tag } from '../components/ui';
import { api } from '../lib/api';
import { useAct, useToast } from '../lib/app';
import { cx, fmtDateTime } from '../lib/format';

const STEPS = ['Upload', 'Map columns', 'Preview and decide', 'Validation report'];
const OUTCOME: Record<string, { label: string; tone: 'good' | 'warn' | 'crit' | 'neutral' | 'accent' }> = {
  created: { label: 'Created', tone: 'good' }, updated: { label: 'Updated existing', tone: 'accent' }, skipped_duplicate: { label: 'Skipped — duplicate', tone: 'warn' },
  skipped_error: { label: 'Skipped — error', tone: 'crit' }, skipped_by_user: { label: 'Skipped by user', tone: 'neutral' },
};
const LEVEL: Record<string, string> = { error: 'var(--crit)', warning: 'var(--warn)', info: 'var(--idle)' };

function Issues({ issues }: { issues: any[] }) {
  if (!issues?.length) return <span className="text-ink-3">—</span>;
  return <ul className="space-y-1">{issues.map((m, i) => <li key={i} className="flex gap-1.5 text-[12.5px] leading-snug"><span className="mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LEVEL[m.level] }} />{m.message}</li>)}</ul>;
}

function ReportModal({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery({ queryKey: ['import', 'report', id], queryFn: () => api<any>(`/import/${id}/report`) });
  const r = q.data;
  return (
    <Modal title="Import validation report" subtitle={r ? `${r.filename} · imported ${fmtDateTime(r.importedAt)} by ${r.importedBy ?? 'unknown'}` : undefined} onClose={onClose} width={980}
      footer={<a href={`/api/import/${id}/report?format=csv`} className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-2 bg-field px-3.5 text-[13.5px] font-medium hover:bg-hover"><Download size={16} /> Download as CSV</a>}>
      {q.isLoading ? <Loading /> : q.error ? <ErrorNote error={q.error} /> : (
        <>
          <Totals t={r.report?.totals} />
          <div className="mt-4 max-h-[52vh] overflow-auto rounded-xl border border-line">
            <table className="data">
              <thead><tr><th>Row</th><th>Outcome</th><th>Job title</th><th>Tracker record</th><th>Messages</th></tr></thead>
              <tbody>
                {r.rows.map((x: any) => (
                  <tr key={x.rowNumber}>
                    <td className="num">{x.rowNumber}</td><td><Tag tone={OUTCOME[x.outcome]?.tone}>{OUTCOME[x.outcome]?.label ?? x.outcome}</Tag></td>
                    <td>{x.raw?.title ?? <span className="text-ink-3">—</span>}</td>
                    <td>{x.vacancyId && x.vacancyTitle ? <Link className="text-accent hover:underline" to={`/vacancies/${x.vacancyId}`}>{x.vacancyTitle}</Link> : <span className="text-ink-3">—</span>}</td>
                    <td className="min-w-[320px]"><Issues issues={x.messages} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

function Totals({ t }: { t: any }) {
  if (!t) return null;
  const items: [string, number, string][] = [['Rows read', t.rows, 'var(--idle)'], ['Created', t.created, 'var(--good)'], ['Updated', t.updated, 'var(--accent)'],
    ['Duplicates skipped', t.skippedDuplicate, 'var(--warn)'], ['Errors skipped', t.skippedError, 'var(--crit)'], ['Skipped by user', t.skippedByUser, 'var(--idle)']];
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
      {items.map(([l, n, c]) => <div key={l} className="rounded-xl border border-line bg-field px-3 py-2.5"><div className="num text-[22px] font-semibold leading-none">{n}</div><div className="mt-1.5 flex items-center gap-1.5 text-[11.5px] text-ink-3"><span className="h-1.5 w-1.5 rounded-full" style={{ background: c }} />{l}</div></div>)}
    </div>
  );
}

export function ImportPage() {
  const toast = useToast();
  const { run, busy } = useAct();
  const fileRef = useRef<HTMLInputElement>(null);
  const batches = useQuery({ queryKey: ['import', 'batches'], queryFn: () => api<any[]>('/import/batches') });
  const [step, setStep] = useState(0);
  const [batch, setBatch] = useState<any>(null);
  const [sheetName, setSheetName] = useState('');
  const [mapping, setMapping] = useState<Record<string, number | null>>({});
  const [options, setOptions] = useState({ createMissingRefs: true, dateOrder: 'dmy' });
  const [preview, setPreview] = useState<any>(null);
  const [decisions, setDecisions] = useState<Record<string, string>>({});
  const [result, setResult] = useState<any>(null);
  const [report, setReport] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const [uploading, setUploading] = useState(false);
  const sheet = batch?.sheets.find((s: any) => s.name === sheetName);

  const pickSheet = (b: any, name: string) => {
    const s = b.sheets.find((x: any) => x.name === name);
    setSheetName(name);
    setMapping(Object.fromEntries(Object.entries(s.suggestedMapping).map(([k, v]: any) => [k, v.column])));
  };
  async function upload(file?: File | null) {
    if (!file) return;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const b = await api<any>('/import/upload', { form });
      setBatch(b);
      pickSheet(b, [...b.sheets].sort((x: any, y: any) => y.rowCount - x.rowCount)[0].name);
      setStep(1);
      void batches.refetch();
    } catch (e: any) {
      toast('error', e.message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }
  async function toPreview() {
    const p = await run(() => api<any>(`/import/${batch.id}/preview`, { body: { sheetName, mapping, options } }));
    if (!p) return;
    setPreview(p);
    setDecisions(Object.fromEntries(p.rows.map((r: any) => [r.rowNumber, r.defaultDecision])));
    setStep(2);
  }
  async function commit() {
    const n = Object.values(decisions).filter((d) => d !== 'skip').length;
    const upd = Object.values(decisions).filter((d) => d === 'update').length;
    if (!window.confirm(`Import ${n} row${n === 1 ? '' : 's'} into the tracker?${upd ? ` ${upd} existing record${upd === 1 ? '' : 's'} will be updated with the imported values.` : ' No existing record will be changed.'}`)) return;
    const r = await run(() => api<any>(`/import/${batch.id}/commit`, { body: { sheetName, mapping, options, decisions } }), 'Import completed');
    if (r) { setResult(r); setStep(3); }
  }
  const reset = async (discard: boolean) => {
    if (discard && batch && step < 3) await api(`/import/${batch.id}/discard`, { method: 'POST' }).catch(() => undefined);
    setBatch(null); setPreview(null); setResult(null); setStep(0); void batches.refetch();
  };
  const used = new Set(Object.values(mapping).filter((v) => v !== null));
  const toImport = Object.values(decisions).filter((d) => d !== 'skip').length;

  return (
    <>
      <PageHeader title="Import from Excel" subtitle="Bring the existing tracker in once, check it, and retire the spreadsheet. Nothing is written until you approve the preview." />
      <ol className="mb-5 flex flex-wrap gap-x-2 gap-y-2" aria-label="Import steps">
        {STEPS.map((s, i) => (
          <li key={s} className={cx('flex items-center gap-2 rounded-full border px-3 py-1.5 text-[13px] font-medium', i === step ? 'border-accent bg-accent-soft' : i < step ? 'border-line text-ink-2' : 'border-line text-ink-3')} aria-current={i === step ? 'step' : undefined}>
            <span className={cx('num flex h-5 w-5 items-center justify-center rounded-full text-[11px]', i < step ? 'bg-good text-white' : i === step ? 'bg-accent text-on-accent' : 'bg-hover')}>{i < step ? <CircleCheck size={13} /> : i + 1}</span>{s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
          <Card className="p-6">
            <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={(e) => { e.preventDefault(); setDrag(false); void upload(e.dataTransfer.files[0]); }}
              className={cx('flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition', drag ? 'border-accent bg-accent-soft' : 'border-line-2')}>
              <FileSpreadsheet size={34} strokeWidth={1.5} className="text-ink-3" />
              <p className="mt-3 text-[16px] font-semibold">Drop the Excel tracker here</p>
              <p className="mt-1 text-[13px] text-ink-2">.xlsx or .csv, up to 10 MB. Every sheet is read; you choose which one to import.</p>
              <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
              <Button variant="primary" icon={Upload} className="mt-5" busy={uploading} onClick={() => fileRef.current?.click()}>Choose file</Button>
            </div>
            <ul className="mt-5 space-y-2 text-[13px] text-ink-2">
              {[[ShieldCheck, 'Existing records are never overwritten silently. Duplicates are skipped unless you choose “update” row by row.'],
                [Info, 'Column names are matched automatically and you can correct every mapping before anything is imported.'],
                [CircleCheck, 'Each import produces a row-by-row validation report and is recorded in the audit log.']].map(([I, t]: any, i) => (
                <li key={i} className="flex gap-2.5"><I size={16} className="mt-0.5 shrink-0 text-accent" />{t}</li>
              ))}
            </ul>
          </Card>
          <Card solid className="self-start overflow-hidden">
            <div className="px-5 pt-4"><SectionTitle>Migration audit trail</SectionTitle></div>
            {batches.isLoading ? <Loading /> : !batches.data?.length ? <p className="px-5 pb-5 text-[13.5px] text-ink-3">No files have been uploaded yet.</p> : (
              <ul className="divide-y divide-line">
                {batches.data.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13.5px] font-medium">{b.filename}</div>
                      <div className="text-[12px] text-ink-3">{fmtDateTime(b.uploadedAt)} · {b.uploadedBy ?? 'unknown'}{b.totals ? ` · ${b.totals.created} created, ${b.totals.updated} updated, ${b.totals.skippedDuplicate + b.totals.skippedError + b.totals.skippedByUser} skipped` : ''}</div>
                    </div>
                    <Tag tone={b.status === 'imported' ? 'good' : b.status === 'discarded' ? 'neutral' : 'warn'}>{b.status === 'uploaded' ? 'Not imported' : b.status[0].toUpperCase() + b.status.slice(1)}</Tag>
                    {b.status === 'imported' && <Button size="sm" onClick={() => setReport(b.id)}>Report</Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      {step === 1 && batch && sheet && (
        <Card solid className="overflow-hidden">
          <div className="flex flex-wrap items-end gap-4 px-5 pb-4 pt-5">
            <div className="min-w-0 flex-1">
              <h2 className="text-[16px] font-semibold tracking-tight">{batch.filename}</h2>
              <p className="mt-0.5 text-[13px] text-ink-2">Header found on row {sheet.headerRow} · {sheet.rowCount} data rows · {sheet.columns.length} columns{sheet.truncated && ' · only the first 5,000 rows are read'}</p>
              {batch.previouslyImportedAt && <p className="mt-1.5 flex items-center gap-1.5 text-[13px] font-medium"><TriangleAlert size={14} style={{ color: 'var(--warn)' }} />This exact file was already imported on {fmtDateTime(batch.previouslyImportedAt)}. Rows already in the tracker will show as duplicates.</p>}
            </div>
            {batch.sheets.length > 1 && (
              <label className="text-[12px] font-medium text-ink-2">Sheet
                <select className="field mt-1 !w-auto" value={sheetName} onChange={(e) => pickSheet(batch, e.target.value)}>{batch.sheets.map((s: any) => <option key={s.name} value={s.name}>{s.name} ({s.rowCount} rows)</option>)}</select>
              </label>
            )}
          </div>
          <div className="overflow-x-auto border-t border-line">
            <table className="data">
              <thead><tr><th>Tracker field</th><th>Column in your file</th><th>Match</th><th>First value in the file</th></tr></thead>
              <tbody>
                {batch.fields.map((f: any) => {
                  const col = mapping[f.key];
                  const sug = sheet.suggestedMapping[f.key];
                  const sample = col !== null && col !== undefined ? sheet.sample.map((r: any[]) => r[col]).find((x: any) => x !== null && x !== undefined) : null;
                  return (
                    <tr key={f.key}>
                      <td className="whitespace-nowrap font-medium">{f.label} {f.required && <Tag tone="crit">Required</Tag>}{f.recommended && <Tag>Recommended</Tag>}</td>
                      <td className="min-w-[230px]">
                        <select className="field" aria-label={`Column for ${f.label}`} value={col ?? ''} onChange={(e) => setMapping((m) => ({ ...m, [f.key]: e.target.value === '' ? null : Number(e.target.value) }))}>
                          <option value="">— not imported —</option>
                          {sheet.columns.map((c: string, i: number) => <option key={i} value={i} disabled={used.has(i) && col !== i}>{c}{used.has(i) && col !== i ? ' (already used)' : ''}</option>)}
                        </select>
                      </td>
                      <td>{col === null || col === undefined ? <span className="text-ink-3">—</span> : sug?.column === col ? <Tag tone={sug.confidence === 'high' ? 'good' : 'warn'}>{sug.confidence === 'high' ? 'Matched by name' : 'Likely match — check'}</Tag> : <Tag tone="accent">Set by you</Tag>}</td>
                      <td className="max-w-[320px] truncate text-ink-2">{sample !== null && sample !== undefined ? String(sample) : <span className="text-ink-3">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line px-5 py-4">
            <label className="flex cursor-pointer items-center gap-2 text-[13px]"><input type="checkbox" className="accent-[var(--accent)]" checked={options.createMissingRefs} onChange={(e) => setOptions((o) => ({ ...o, createMissingRefs: e.target.checked }))} />Create countries, departments and TA teams that do not exist yet</label>
            <label className="flex items-center gap-2 text-[13px]">Ambiguous dates such as 03/04/2026 are
              <select className="field !w-auto" value={options.dateOrder} onChange={(e) => setOptions((o) => ({ ...o, dateOrder: e.target.value }))}><option value="dmy">day / month / year</option><option value="mdy">month / day / year</option></select>
            </label>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" icon={ArrowLeft} onClick={() => reset(true)}>Discard upload</Button>
              <Button variant="primary" busy={busy} disabled={mapping.title === null || mapping.title === undefined} onClick={toPreview}>Preview import <ArrowRight size={15} /></Button>
            </div>
          </div>
          {sheet.columns.some((_: string, i: number) => !used.has(i)) && (
            <p className="border-t border-line px-5 py-3 text-[12.5px] text-ink-3">Columns in the file that will not be imported: {sheet.columns.filter((_: string, i: number) => !used.has(i)).join(', ')}</p>
          )}
        </Card>
      )}

      {step === 2 && preview && (
        <Card solid className="overflow-hidden">
          <div className="px-5 pb-4 pt-5">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone="good">{preview.summary.ready} ready</Tag><Tag tone="warn">{preview.summary.duplicates} duplicates</Tag><Tag tone="crit">{preview.summary.errors} missing required information</Tag>
              <Tag>{preview.summary.withWarnings} with warnings</Tag>
              <span className="ml-auto flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setDecisions((d) => Object.fromEntries(preview.rows.map((r: any) => [r.rowNumber, r.duplicate ? 'skip' : d[r.rowNumber]])))}>Skip all duplicates</Button>
                <Button size="sm" onClick={() => setDecisions((d) => Object.fromEntries(preview.rows.map((r: any) => [r.rowNumber, r.duplicate?.allowUpdate ? 'update' : d[r.rowNumber]])))}>Update all matching records</Button>
              </span>
            </div>
            {(preview.newReferenceValues.countries.length + preview.newReferenceValues.departments.length + preview.newReferenceValues.teams.length) > 0 && (
              <p className="mt-3 flex items-start gap-2 text-[13px]"><Info size={15} className="mt-0.5 shrink-0 text-accent" />New reference values will be created:
                {[['Countries', preview.newReferenceValues.countries], ['Departments', preview.newReferenceValues.departments], ['TA teams', preview.newReferenceValues.teams]].filter(([, l]: any) => l.length).map(([l, list]: any) => ` ${l}: ${list.join(', ')}.`)}</p>
            )}
          </div>
          <div className="max-h-[calc(100vh-380px)] min-h-[240px] overflow-auto border-t border-line">
            <table className="data">
              <thead><tr><th>Row</th><th>Decision</th><th>Job title</th><th>Country</th><th>Recruiter</th><th>Stage</th><th>Status</th><th>Checks</th></tr></thead>
              <tbody>
                {preview.rows.map((r: any) => (
                  <tr key={r.rowNumber} className={decisions[r.rowNumber] === 'skip' ? 'opacity-60' : ''}>
                    <td className="num">{r.rowNumber}</td>
                    <td className="min-w-[190px]">
                      {r.status === 'error' ? <Tag tone="crit">Cannot import</Tag> : (
                        <select className="field" aria-label={`Decision for row ${r.rowNumber}`} value={decisions[r.rowNumber]} onChange={(e) => setDecisions((d) => ({ ...d, [r.rowNumber]: e.target.value }))}>
                          {(!r.duplicate || r.duplicate.allowNew) && <option value="import">{r.duplicate ? 'Import as a new record' : 'Import'}</option>}
                          {r.duplicate?.allowUpdate && <option value="update">Update the existing record</option>}
                          <option value="skip">Skip{r.duplicate ? ' (keep existing)' : ''}</option>
                        </select>
                      )}
                    </td>
                    <td className="min-w-[200px] font-medium">{r.display.title ?? <span className="font-normal text-ink-3">(empty)</span>}{r.display.greenhouseJobId && <div className="num text-[11.5px] font-normal text-ink-3">GH {r.display.greenhouseJobId}</div>}</td>
                    <td>{r.display.country ?? '—'}</td><td>{r.display.recruiter ?? '—'}</td><td>{r.display.stage ?? '—'}</td>
                    <td>{[r.display.status, r.display.health].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="min-w-[340px]">
                      {r.duplicate && <p className="mb-1 flex gap-1.5 text-[12.5px] font-medium leading-snug"><TriangleAlert size={13} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />{r.duplicate.label}</p>}
                      <Issues issues={r.issues} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-4">
            <span className="text-[13px] text-ink-2">{toImport} of {preview.rows.length} rows will be written · {Object.values(decisions).filter((d) => d === 'update').length} update existing records</span>
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" icon={ArrowLeft} onClick={() => setStep(1)}>Back to mapping</Button>
              <Button variant="primary" busy={busy} disabled={toImport === 0} onClick={commit}>Import {toImport} {toImport === 1 ? 'row' : 'rows'}</Button>
            </div>
          </div>
        </Card>
      )}

      {step === 3 && result && (
        <Card className="p-6">
          <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--good)_15%,transparent)]"><CircleCheck size={21} className="text-good" /></span>
            <div><h2 className="text-[18px] font-semibold tracking-tight">Import completed</h2><p className="text-[13px] text-ink-2">{batch.filename} · sheet “{result.sheet}”</p></div></div>
          <div className="mt-5"><Totals t={result.totals} /></div>
          {Object.values(result.createdReferenceValues).some((l: any) => l.length) && <p className="mt-4 text-[13px] text-ink-2">Reference values created: {Object.entries(result.createdReferenceValues).filter(([, l]: any) => l.length).map(([k, l]: any) => `${k}: ${l.join(', ')}`).join(' · ')}</p>}
          {result.unmappedColumns?.length > 0 && <p className="mt-1.5 text-[13px] text-ink-3">Columns not imported: {result.unmappedColumns.join(', ')}</p>}
          <div className="mt-6 flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => setReport(result.id)}>Open validation report</Button>
            <Link to="/tracker" className="inline-flex h-9 items-center rounded-[10px] border border-line-2 bg-field px-3.5 text-[13.5px] font-medium hover:bg-hover">Go to the hiring tracker</Link>
            <Button variant="ghost" onClick={() => reset(false)}>Import another file</Button>
          </div>
        </Card>
      )}
      {report && <ReportModal id={report} onClose={() => setReport(null)} />}
    </>
  );
}
