import { pool, rows, type Db } from '../db.js';
import { getSetting, RISK_RULES, type RiskRuleConfig } from '../settings.js';
import { addDays, bare, daysSince, diffDays, fmtDate, plural, today } from '../util.js';
import { listVacancies, type VacancyFilters } from './vacancies.js';

export interface Alert {
  id: string;
  rule: string;
  ruleLabel: string;
  severity: 'high' | 'medium' | 'low';
  vacancyId: number | null;
  vacancyTitle: string | null;
  country: string | null;
  recruiter: string | null;
  responsible: string;       // who is expected to act
  what: string;              // what happened, with the recorded facts
  lastUpdateAt: string | null;
  daysSinceUpdate: number | null;
  recommended: string;
  actionId?: number;
}

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * Rule-based risk monitor. Every alert is a direct restatement of recorded data
 * (dates, statuses, missing fields) against a configurable threshold — there is
 * no scoring model and nothing is predicted.
 */
export async function computeAlerts(filters: VacancyFilters = {}, db: Db = pool, rules?: RiskRuleConfig): Promise<Alert[]> {
  const cfg = rules ?? (await getSetting('risk.rules', db));
  const on = (k: string) => cfg[k]?.enabled !== false;
  const num = (k: string, p: string, d: number) => (typeof cfg[k]?.[p] === 'number' ? (cfg[k][p] as number) : d);
  const t = today();
  const vacancies = await listVacancies({ ...filters, overall: 'open_all' }, undefined, db);
  if (!vacancies.length && !on('action_overdue')) return [];
  const ids = vacancies.map((v) => v.id);
  const [milestones, actions] = await Promise.all([
    ids.length ? rows<any>(db, `SELECT * FROM vacancy_milestones WHERE vacancy_id = ANY($1) ORDER BY vacancy_id, position`, [ids]) : [],
    rows<any>(db, `SELECT a.*, u.name AS assignee, v.title AS vacancy_title FROM actions a
                     LEFT JOIN users u ON u.id = a.assignee_id LEFT JOIN vacancies v ON v.id = a.vacancy_id
                    WHERE a.status IN ('open','in_progress','waiting_feedback') AND (v.id IS NULL OR v.archived_at IS NULL)`),
  ]);
  const meta = new Map(RISK_RULES.map((r) => [r.key as string, r]));
  const out: Alert[] = [];
  const push = (rule: string, v: any | null, a: Partial<Alert> & Pick<Alert, 'responsible' | 'what' | 'recommended'>, sub = '') => {
    const m = meta.get(rule)!;
    out.push({
      id: `${rule}:${v?.id ?? 'none'}${sub}`, rule, ruleLabel: m.label, severity: m.severity,
      vacancyId: v?.id ?? null, vacancyTitle: v?.title ?? null, country: v?.country ?? null, recruiter: v?.recruiter ?? null,
      lastUpdateAt: v?.lastUpdateAt ?? null, daysSinceUpdate: v ? daysSince(v.lastUpdateAt) : null, ...a,
    });
  };

  for (const v of vacancies) {
    const active = v.statusCategory === 'active';
    const recruiter = v.recruiter ?? 'Unassigned (no recruiter)';
    const hm = v.hiringManager ?? 'the hiring manager';
    const since = daysSince(v.lastUpdateAt);

    if (active && on('blocked') && v.health === 'blocked') {
      push('blocked', v, {
        responsible: recruiter,
        what: `Marked as blocked${v.currentBlocker ? `: ${bare(v.currentBlocker)}` : ' — no blocker description has been recorded'}.`,
        recommended: v.supportRequired
          ? `Leadership to act on the recorded support request (“${bare(v.supportRequired)}”) and agree an unblock owner and date with ${recruiter}.`
          : `Review the blocker with ${recruiter} and ${hm}; record who will unblock it and by when.`,
      });
    }
    if (active && on('next_action_overdue') && v.actionDeadline && v.actionDeadline < t) {
      const n = diffDays(v.actionDeadline, t);
      push('next_action_overdue', v, {
        responsible: v.actionOwner ?? recruiter,
        what: `Next action “${bare(v.nextAction) || 'not described'}” was due on ${fmtDate(v.actionDeadline)} (${plural(n, 'day')} ago).`,
        recommended: `${v.actionOwner ?? recruiter} to complete the action, or agree a new deadline and record it in a progress update.`,
      });
    }
    if (active && on('behind_timeline') && v.targetHireDate) {
      const warn = num('behind_timeline', 'warnDays', 14);
      const gap = num('behind_timeline', 'gapPoints', 30);
      if (v.targetHireDate < t) {
        push('behind_timeline', v, {
          responsible: recruiter,
          what: `Target hiring date ${fmtDate(v.targetHireDate)} passed ${plural(diffDays(v.targetHireDate, t), 'day')} ago; the vacancy is at “${v.currentStage ?? 'no stage'}”.`,
          recommended: `Agree a revised target date with ${hm} and record it, or escalate if the delay is not acceptable.`,
        });
      } else if (v.openingDate && diffDays(t, v.targetHireDate) <= warn && v.milestonesTotal > 0) {
        const total = Math.max(1, diffDays(v.openingDate, v.targetHireDate));
        const elapsed = Math.min(100, Math.round((diffDays(v.openingDate, t) / total) * 100));
        const done = Math.round((v.milestonesDone / v.milestonesTotal) * 100);
        if (elapsed - done >= gap) {
          push('behind_timeline', v, {
            responsible: recruiter,
            what: `${elapsed}% of the planned time has elapsed but ${v.milestonesDone} of ${v.milestonesTotal} milestones (${done}%) are complete; the target hiring date is ${fmtDate(v.targetHireDate)} (in ${plural(diffDays(t, v.targetHireDate), 'day')}).`,
            recommended: `Check with ${recruiter} whether the target date is still realistic and record the outcome.`,
          });
        }
      }
    }
    if (on('support_required') && v.supportRequired) {
      push('support_required', v, {
        responsible: v.departmentOwner ?? 'TA leadership',
        what: `Support requested: ${bare(v.supportRequired)}.`,
        recommended: `TA leadership to respond to ${recruiter} and record the decision in the vacancy.`,
      });
    }
    if (active && on('milestone_delayed')) {
      const grace = num('milestone_delayed', 'graceDays', 0);
      // Only milestones that have not been reached yet can be late; the current stage has, by definition, been reached.
      const late = milestones.filter((m) => m.vacancyId === v.id && m.status === 'pending' && m.plannedDate && addDays(m.plannedDate, grace) < t);
      if (late.length) {
        const m = late[0];
        push('milestone_delayed', v, {
          responsible: recruiter,
          what: `Milestone “${m.name}” was planned for ${fmtDate(m.plannedDate)} (${plural(diffDays(m.plannedDate, t), 'day')} ago) and has not been reached; the vacancy is still at “${v.currentStage ?? 'no stage'}”${late.length > 1 ? `. ${plural(late.length - 1, 'later milestone is', 'later milestones are')} also past plan` : ''}.`,
          recommended: `Record what is needed to reach “${m.name}”, or re-plan the remaining milestone dates with ${hm}.`,
        });
      }
    }
    if (active && on('decision_outstanding') && v.health === 'awaiting_feedback') {
      const d = num('decision_outstanding', 'days', 3);
      if (since === null || since >= d) {
        push('decision_outstanding', v, {
          responsible: v.actionOwner ?? hm,
          what: `Awaiting feedback${since !== null ? ` for ${plural(since, 'day')} since the last update` : ''}${v.nextAction ? `. Outstanding: “${bare(v.nextAction)}”${v.actionOwner ? ` (owner: ${v.actionOwner})` : ''}` : ''}.`,
          recommended: `Send a reminder to ${v.actionOwner ?? hm}; escalate to ${v.departmentOwner ?? 'the department owner'} if the decision is still open after the next follow-up.`,
        });
      }
    }
    if (active && on('stale_update')) {
      const d = num('stale_update', 'days', 7);
      if (since === null || since >= d) {
        push('stale_update', v, {
          responsible: recruiter,
          what: since === null ? 'No progress update has ever been recorded.'
            : `No progress update for ${plural(since, 'day')} (last update ${fmtDate(v.lastUpdateAt)}); the threshold is ${plural(d, 'day')}.`,
          recommended: `${recruiter} to record a short progress update, even if nothing has changed.`,
        });
      }
    }
    if (active && on('no_next_action') && !v.nextAction) {
      push('no_next_action', v, {
        responsible: recruiter,
        what: 'No next action is recorded for this active vacancy.',
        recommended: 'Agree the next action, its owner and a deadline, and record them.',
      });
    }
    if (v.statusCategory === 'on_hold' && on('on_hold')) {
      const d = num('on_hold', 'days', 0);
      if (since === null || since >= d) {
        push('on_hold', v, {
          responsible: recruiter,
          what: `On hold${since !== null ? `; last updated ${plural(since, 'day')} ago` : ''}${v.currentBlocker ? `. Reason recorded: ${bare(v.currentBlocker)}` : ''}.`,
          recommended: `Confirm with ${hm} whether the vacancy should resume, stay on hold or be cancelled.`,
        });
      }
    }
  }

  const visible = new Set(ids);
  const scoped = Object.keys(filters).some((k) => (filters as any)[k]);
  for (const a of actions) {
    if (a.vacancyId ? !visible.has(a.vacancyId) : scoped) continue;
    const v = vacancies.find((x) => x.id === a.vacancyId) ?? null;
    if (on('action_overdue') && a.dueDate && a.dueDate < t) {
      push('action_overdue', v, {
        actionId: a.id,
        responsible: a.assignee ?? 'Unassigned',
        what: `Action “${bare(a.title)}” was due on ${fmtDate(a.dueDate)} (${plural(diffDays(a.dueDate, t), 'day')} ago)${a.status === 'waiting_feedback' && a.waitingOn ? `; waiting for ${a.waitingOn}` : ''}.`,
        recommended: `${a.assignee ?? 'The assignee'} to complete or re-plan the action${a.waitingOn ? `, and chase ${a.waitingOn}` : ''}.`,
      }, `:a${a.id}`);
    } else if (on('decision_outstanding') && a.status === 'waiting_feedback') {
      const waited = daysSince(a.updatedAt) ?? 0;
      if (waited >= num('decision_outstanding', 'days', 3)) {
        push('decision_outstanding', v, {
          actionId: a.id,
          responsible: a.waitingOn ?? a.assignee ?? 'Unassigned',
          what: `Action “${bare(a.title)}” has been waiting for feedback${a.waitingOn ? ` from ${a.waitingOn}` : ''} for ${plural(waited, 'day')}.`,
          recommended: `${a.assignee ?? 'The assignee'} to send a reminder${a.waitingOn ? ` to ${a.waitingOn}` : ''} and record the response.`,
        }, `:a${a.id}`);
      }
    }
  }

  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || (b.daysSinceUpdate ?? 0) - (a.daysSinceUpdate ?? 0) || (a.vacancyTitle ?? '').localeCompare(b.vacancyTitle ?? ''));
}

/** Vacancy ids that leadership should look at: blocked, behind timeline, overdue next action or support requested. */
export function interventionIds(alerts: Alert[]): Set<number> {
  const keys = new Set(['blocked', 'behind_timeline', 'next_action_overdue', 'support_required']);
  return new Set(alerts.filter((a) => keys.has(a.rule) && a.vacancyId).map((a) => a.vacancyId!));
}
