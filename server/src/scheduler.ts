import { SYSTEM, audit } from './audit.js';
import { one, pool } from './db.js';
import { getSetting } from './settings.js';
import { runGreenhouseSync } from './services/greenhouse.js';
import { buildWeeklyReport, saveSnapshot } from './services/report.js';
import { addDays, today, weekRange } from './util.js';

/**
 * Background housekeeping, checked once an hour:
 *  - closes each reporting week with an automatic snapshot (so history exists even if nobody clicks "save");
 *  - removes expired sessions;
 *  - optionally refreshes Greenhouse data (GREENHOUSE_SYNC_HOURS).
 */
export async function runScheduledTasks(): Promise<void> {
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  const cfg = await getSetting('report');
  if (cfg.autoSnapshot) {
    const lastWeek = addDays(weekRange(today(), cfg.weekStartsOn).start, -7);
    const has = await one(pool, 'SELECT 1 AS x FROM report_snapshots WHERE week_start = $1', [lastWeek]);
    const any = await one(pool, 'SELECT 1 AS x FROM vacancies WHERE archived_at IS NULL LIMIT 1');
    if (!has && any) {
      const { id } = await saveSnapshot(pool, null, 'auto', await buildWeeklyReport(pool, { weekStart: lastWeek }));
      await audit(pool, SYSTEM, { entityType: 'report', entityId: id, action: 'snapshot_saved', summary: `Automatic weekly report saved for the week starting ${lastWeek}` });
    }
  }
  const hours = Number(process.env.GREENHOUSE_SYNC_HOURS ?? 0);
  if (hours > 0 && (await getSetting('greenhouse')).mode !== 'off') {
    const recent = await one(pool, `SELECT 1 AS x FROM sync_runs WHERE integration = 'greenhouse' AND started_at > now() - make_interval(hours => $1)`, [hours]);
    if (!recent) await runGreenhouseSync(null);
  }
}

export function startScheduler(): NodeJS.Timeout {
  const tick = () => runScheduledTasks().catch((e) => console.error(JSON.stringify({ level: 'error', message: `scheduler: ${e.message}` })));
  setTimeout(tick, 15_000).unref();
  const t = setInterval(tick, 60 * 60 * 1000);
  t.unref();
  return t;
}
