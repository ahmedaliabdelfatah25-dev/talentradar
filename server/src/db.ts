import pg from 'pg';
import { config } from './config.js';

// Calendar dates stay as 'YYYY-MM-DD' strings (no timezone drift); counts become numbers.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
  max: Number(process.env.DATABASE_POOL_MAX ?? 10),
});

export type Db = { query: (text: string, params?: unknown[]) => Promise<pg.QueryResult<any>> };

const camelKey = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** Shallow snake_case → camelCase for a database row (jsonb payloads are left untouched). */
export function camel<T = any>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[camelKey(k)] = row[k];
  return out as T;
}

export async function rows<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db.query(text, params);
  return r.rows.map((x) => camel<T>(x));
}
export async function one<T = any>(db: Db, text: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(db, text, params))[0];
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
