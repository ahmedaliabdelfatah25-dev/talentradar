import { BadgeCheck, Ban, CircleCheck, CirclePause, CircleX, Hourglass, Loader2, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { cx, initials } from '../lib/format';

export function Card({ solid, className, children, ...p }: HTMLAttributes<HTMLDivElement> & { solid?: boolean }) {
  return <div className={cx(solid ? 'glass-solid' : 'glass', 'rounded-2xl', className)} {...p}>{children}</div>;
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; icon?: LucideIcon; busy?: boolean };
export function Button({ variant = 'secondary', size = 'md', icon: Icon, busy, className, children, disabled, ...p }: BtnProps) {
  const v = {
    primary: 'bg-accent text-on-accent shadow-sm hover:brightness-110 active:brightness-95',
    secondary: 'bg-field text-ink border border-line-2 hover:bg-hover',
    ghost: 'text-ink-2 hover:bg-hover hover:text-ink',
    danger: 'bg-crit text-white hover:brightness-110',
  }[variant];
  return (
    <button type="button" disabled={disabled || busy} className={cx('inline-flex shrink-0 items-center justify-center gap-1.5 rounded-[10px] font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
      size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13.5px]', v, className)} {...p}>
      {busy ? <Loader2 size={15} className="animate-spin" /> : Icon ? <Icon size={size === 'sm' ? 14 : 16} strokeWidth={2} /> : null}
      {children}
    </button>
  );
}

/** Status never relies on colour alone: every pill pairs the hue with an icon and a text label. */
const STATUS: Record<string, { icon: LucideIcon; color: string }> = {
  on_track: { icon: CircleCheck, color: 'var(--good)' },
  needs_attention: { icon: TriangleAlert, color: 'var(--warn)' },
  awaiting_feedback: { icon: Hourglass, color: 'var(--serious)' },
  blocked: { icon: Ban, color: 'var(--crit)' },
  on_hold: { icon: CirclePause, color: 'var(--idle)' },
  hired: { icon: BadgeCheck, color: 'var(--good)' },
  cancelled: { icon: CircleX, color: 'var(--idle)' },
};
export const statusColor = (k: string) => STATUS[k]?.color ?? 'var(--idle)';
export function StatusPill({ k, label, className }: { k: string; label: string; className?: string }) {
  const s = STATUS[k] ?? STATUS.on_hold;
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-[3px] pl-1.5 pr-2.5 text-[12px] font-medium text-ink', className)}
      style={{ background: `color-mix(in srgb, ${s.color} 15%, transparent)` }}>
      <s.icon size={14} strokeWidth={2.4} style={{ color: s.color }} aria-hidden />
      {label}
    </span>
  );
}
export function StatusIcon({ k, size = 16 }: { k: string; size?: number }) {
  const s = STATUS[k] ?? STATUS.on_hold;
  return <s.icon size={size} strokeWidth={2.3} className="shrink-0" style={{ color: s.color }} aria-hidden />;
}

export function Tag({ children, tone = 'neutral', className, title }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'crit' | 'warn' | 'good'; className?: string; title?: string }) {
  const c = { neutral: 'var(--idle)', accent: 'var(--accent)', crit: 'var(--crit)', warn: 'var(--warn)', good: 'var(--good)' }[tone];
  return <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-px text-[11px] font-medium text-ink-2', className)}
    style={{ background: `color-mix(in srgb, ${c} 14%, transparent)` }}>{children}</span>;
}
export const DemoTag = () => <Tag tone="accent" title="Fictional demonstration record">DEMO</Tag>;
const PRIO: Record<string, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };
export function PriorityTag({ p }: { p: string }) {
  return <Tag tone={p === 'critical' ? 'crit' : p === 'high' ? 'warn' : 'neutral'}>{PRIO[p] ?? p}</Tag>;
}

export function Avatar({ name, size = 26 }: { name?: string | null; size?: number }) {
  return <span aria-hidden className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent"
    style={{ width: size, height: size, fontSize: size * 0.4 }}>{initials(name)}</span>;
}

/** Milestone progress as a quiet meter with the count written out. */
export function Meter({ done, total, className }: { done: number; total: number; className?: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <span className={cx('inline-flex items-center gap-2', className)} title={`${done} of ${total} milestones complete`}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-line-2"><span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} /></span>
      <span className="num text-[11.5px] text-ink-3">{done}/{total}</span>
    </span>
  );
}

export function Field({ label, hint, required, className, children }: { label: string; hint?: string; required?: boolean; className?: string; children: ReactNode }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-[12px] font-medium text-ink-2">{label}{required && <span className="text-crit"> *</span>}</span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-ink-3">{hint}</span>}
    </label>
  );
}

function useEscape(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const on = (e: KeyboardEvent) => { if (e.key === 'Escape') ref.current(); };
    document.addEventListener('keydown', on);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', on); document.body.style.overflow = prev; };
  }, []);
}

export function Modal({ title, subtitle, onClose, children, footer, width = 620 }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(onClose);
  return (
    <div className="no-print fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-12" role="dialog" aria-modal="true" aria-label={title}>
      <div className="anim-fade fixed inset-0 bg-black/30 backdrop-blur-[3px]" onClick={onClose} />
      <div className="glass-solid pop anim-rise relative w-full rounded-2xl" style={{ maxWidth: width }}>
        <div className="flex items-start gap-4 px-6 pb-3 pt-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p>}
          </div>
          <button aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-hover hover:text-ink"><X size={18} /></button>
        </div>
        <div className="px-6 pb-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ title, subtitle, onClose, children, footer, width = 560 }: { title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(onClose);
  return (
    <div className="no-print fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={title}>
      <div className="anim-fade absolute inset-0 bg-black/30 backdrop-blur-[3px]" onClick={onClose} />
      <div className="glass-solid pop anim-slide absolute inset-y-0 right-0 flex w-full flex-col sm:inset-y-3 sm:right-3 sm:rounded-2xl" style={{ maxWidth: width }}>
        <div className="flex items-start gap-4 border-b border-line px-6 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-ink-2">{subtitle}</p>}
          </div>
          <button aria-label="Close" onClick={onClose} className="rounded-lg p-1.5 text-ink-3 hover:bg-hover hover:text-ink"><X size={18} /></button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; count?: number; alert?: boolean }[]; className?: string }) {
  return (
    <div className={cx('inline-flex max-w-full gap-0.5 overflow-x-auto rounded-xl border border-line bg-field p-0.5', className)} role="tablist">
      {options.map((o) => (
        <button key={o.value} role="tab" aria-selected={value === o.value} onClick={() => onChange(o.value)}
          className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-[9px] px-3 py-1.5 text-[13px] font-medium transition',
            value === o.value ? 'bg-solid text-ink shadow-sm ring-1 ring-line-2' : 'text-ink-2 hover:text-ink')}>
          {o.label}
          {o.count !== undefined && <span className={cx('num rounded-full px-1.5 text-[11px]', o.alert && o.count > 0 ? 'bg-crit text-white' : 'bg-hover text-ink-2')}>{o.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {subtitle && <p className="mt-1 text-[13.5px] text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="no-print flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-3 flex items-center justify-between gap-3', className)}>
      <h2 className="text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-3">{children}</h2>
      {right}
    </div>
  );
}

export function Empty({ icon: Icon, title, children }: { icon?: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      {Icon && <Icon size={26} strokeWidth={1.6} className="mb-3 text-ink-3" />}
      <p className="font-medium">{title}</p>
      {children && <p className="mt-1 max-w-md text-[13px] text-ink-2">{children}</p>}
    </div>
  );
}

export const Loading = ({ label = 'Loading…' }: { label?: string }) => (
  <div className="flex items-center justify-center gap-2 py-16 text-ink-3"><Loader2 size={18} className="animate-spin" /> {label}</div>
);

export function ErrorNote({ error }: { error: unknown }) {
  return (
    <Card className="flex items-start gap-3 p-4 text-[13.5px]">
      <TriangleAlert size={18} className="mt-0.5 shrink-0 text-crit" />
      <div><p className="font-medium">This could not be loaded</p><p className="text-ink-2">{(error as Error)?.message ?? 'Unknown error'}</p></div>
    </Card>
  );
}

/** Key–value row used in the detail side panels. */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5 text-[13px]">
      <dt className="w-[42%] shrink-0 text-ink-3">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{children ?? <span className="text-ink-3">—</span>}</dd>
    </div>
  );
}
