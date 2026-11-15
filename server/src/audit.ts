import type { Db } from './db.js';

export interface Actor { id: number | null; name: string }
export type Changes = Record<string, { from: unknown; to: unknown }>;

const norm = (v: unknown) => (v === undefined || v === '' ? null : v instanceof Date ? v.toISOString() : v);

/** Field-level before/after for the audit trail. Only fields that actually changed are returned. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>, fields: string[]): Changes {
  const out: Changes = {};
  for (const f of fields) {
    if (!(f in after)) continue;
    const a = norm(before[f]);
    const b = norm(after[f]);
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { from: a, to: b };
  }
  return out;
}

export async function audit(
  db: Db,
  actor: Actor,
  e: { entityType: string; entityId?: number | null; vacancyId?: number | null; action: string; summary?: string; changes?: unknown },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, user_name, entity_type, entity_id, vacancy_id, action, summary, changes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor.id, actor.name, e.entityType, e.entityId ?? null, e.vacancyId ?? null, e.action, e.summary ?? null,
      e.changes ? JSON.stringify(e.changes) : null],
  );
}

export const SYSTEM: Actor = { id: null, name: 'System' };
