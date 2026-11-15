const TZ = 'Africa/Cairo';
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's calendar date in the team's business timezone, as YYYY-MM-DD. */
export const today = () => dayFmt.format(new Date());
export const dateOf = (v: string | Date) => dayFmt.format(new Date(v));
const utc = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
export const diffDays = (a: string, b: string) => Math.round((utc(b).getTime() - utc(a).getTime()) / 86400000);

/** "14 Nov 2026" (or "14 Nov" when the year is the current one). Accepts a date or a timestamp. */
export function fmtDate(v?: string | null, opts: { year?: boolean } = {}): string {
  if (!v) return '—';
  const d = utc(v.length > 10 ? dateOf(v) : v);
  const sameYear = d.getUTCFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: opts.year || !sameYear ? 'numeric' : undefined, timeZone: 'UTC' });
}
export function fmtDateTime(v?: string | null): string {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: TZ });
}
/** Relative wording for a calendar date: "today", "in 3 days", "4 days ago". */
export function relDay(v?: string | null): string {
  if (!v) return '';
  const n = diffDays(today(), v.length > 10 ? dateOf(v) : v);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
export const isPast = (v?: string | null) => !!v && v < today();
export const initials = (name?: string | null) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
