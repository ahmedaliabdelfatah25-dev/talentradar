export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);

/** Business timezone for calendar-day logic (deadlines, "today", week boundaries). */
export const TZ = process.env.APP_TIMEZONE ?? 'Africa/Cairo';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** 'YYYY-MM-DD' for an instant, in the business timezone. */
export const dateOf = (d: Date | string | number): string => dayFmt.format(new Date(d));
export const today = (): string => dateOf(Date.now());

const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
export const addDays = (s: string, n: number): string => {
  const d = utc(s);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Whole days from a to b (positive when b is later). */
export const diffDays = (a: string, b: string): number => Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000);
export const daysSince = (instant: Date | string | null | undefined): number | null =>
  instant ? diffDays(dateOf(instant), today()) : null;

/** Week containing `day`, starting on weekStartsOn (0 = Sunday … 6 = Saturday). */
export function weekRange(day: string, weekStartsOn = 0): { start: string; end: string } {
  const dow = utc(day).getUTCDay();
  const start = addDays(day, -((dow - weekStartsOn + 7) % 7));
  return { start, end: addDays(start, 6) };
}

export const fmtDate = (s?: string | null): string => {
  if (!s) return '—';
  const d = utc(typeof s === 'string' ? s : dateOf(s));
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export const clean = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

/** User-entered text without trailing full stops, so it can be embedded in a sentence. */
export const bare = (s: string | null | undefined): string => (s ?? '').trim().replace(/[.\s]+$/, '');

export const plural = (n: number, word: string, pluralWord?: string) => `${n} ${n === 1 ? word : pluralWord ?? `${word}s`}`;

export function csvEscape(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection when the file is opened in Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(headers: string[], data: unknown[][]): string {
  return '﻿' + [headers, ...data].map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n';
}

export const HEALTH = {
  on_track: 'On track',
  needs_attention: 'Needs attention',
  awaiting_feedback: 'Awaiting feedback',
  blocked: 'Blocked',
} as const;
export type Health = keyof typeof HEALTH;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const ACTION_STATUS = {
  open: 'Open',
  in_progress: 'In progress',
  waiting_feedback: 'Waiting for feedback',
  completed: 'Completed',
  cancelled: 'Cancelled',
} as const;
export const OPEN_ACTION_STATUSES = ['open', 'in_progress', 'waiting_feedback'];

/** One display status per vacancy: closed/on-hold outcomes win, otherwise the recruiter-set health. */
export function overallStatus(statusCategory: string, health: string): { key: string; label: string } {
  if (statusCategory === 'filled') return { key: 'hired', label: 'Hired' };
  if (statusCategory === 'cancelled') return { key: 'cancelled', label: 'Cancelled' };
  if (statusCategory === 'on_hold') return { key: 'on_hold', label: 'On hold' };
  return { key: health, label: HEALTH[health as Health] ?? health };
}
