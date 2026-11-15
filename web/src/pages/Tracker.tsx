import { useQuery } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { useState } from 'react';
import { applyFilters, ColumnChooser, DEFAULT_COLUMNS, FilterBar, NO_FILTERS, QuickUpdate, VacancyForm, VacancyTable, type Filters } from '../components/vacancy';
import { Button, Card, ErrorNote, Loading, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { useAuth, useMeta } from '../lib/app';

const loadCols = (): string[] => { try { return JSON.parse(localStorage.getItem('tr-columns') ?? 'null') ?? DEFAULT_COLUMNS; } catch { return DEFAULT_COLUMNS; } };

/** The Excel replacement: one structured record per vacancy, every field available as a column. */
export function TrackerPage() {
  const { can } = useAuth();
  const meta = useMeta();
  const q = useQuery({ queryKey: ['vacancies', 'all'], queryFn: () => api<any[]>('/vacancies') });
  const [filters, setFilters] = useState<Filters>({ ...NO_FILTERS });
  const [team, setTeam] = useState('');
  const [cols, setColsState] = useState<string[]>(loadCols);
  const [update, setUpdate] = useState<any>(null);
  const [creating, setCreating] = useState(false);
  const setCols = (c: string[]) => { setColsState(c); try { localStorage.setItem('tr-columns', JSON.stringify(c)); } catch { /* private mode */ } };
  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} />;
  const all = q.data!.filter((v) => !team || String(v.taTeamId) === team);
  const rows = applyFilters(all, filters);
  const teams = meta.data?.teams.filter((t: any) => t.isActive) ?? [];

  return (
    <>
      <PageHeader title="Central hiring tracker" subtitle="One record per vacancy — identification, ownership, progress, next action and outcome. Click a row to open its workspace."
        actions={<>
          <a href="/api/vacancies/export.csv" className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-line-2 bg-field px-3.5 text-[13.5px] font-medium hover:bg-hover"><Download size={16} /> Export CSV</a>
          {can('vacancies.create') && <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>New vacancy</Button>}
        </>} />
      <Card solid>
        <div className="px-5 py-4">
          <FilterBar rows={all} value={filters} onChange={setFilters} right={<>
            {teams.length > 1 && (
              <select className="field !w-auto" aria-label="Responsible TA team" value={team} onChange={(e) => setTeam(e.target.value)}>
                <option value="">All TA teams</option>
                {teams.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}
            <ColumnChooser value={cols} onChange={setCols} />
          </>} />
          <p className="mt-2.5 text-[12px] text-ink-3">{rows.length} of {all.length} vacancies · {all.filter((v) => ['active', 'on_hold'].includes(v.statusCategory)).length} open · {all.filter((v) => v.statusCategory === 'filled').length} filled</p>
        </div>
        <VacancyTable rows={rows} columns={cols} onQuickUpdate={setUpdate} maxHeight="calc(100vh - 270px)" />
      </Card>
      {update && <QuickUpdate vacancy={update} onClose={() => setUpdate(null)} />}
      {creating && <VacancyForm onClose={() => setCreating(false)} />}
    </>
  );
}
