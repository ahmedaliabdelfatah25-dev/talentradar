import { useQuery } from '@tanstack/react-query';
import { FileBarChart, FlaskConical, KeyRound, LayoutDashboard, ListChecks, LogOut, Menu, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, ShieldAlert, Sparkles, Sun, Table2, Upload, UserRound, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { useAct, useAuth, useMeta, useTheme } from '../lib/app';
import { cx } from '../lib/format';
import { Avatar, Button, Field, Modal, StatusIcon } from './ui';

const ROLE_LABEL: Record<string, string> = { admin: 'Administrator', leadership: 'Leadership', recruiter: 'Recruiter', viewer: 'Viewer' };

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <circle cx="16" cy="16" r="9" fill="none" stroke="var(--on-accent)" strokeWidth="2" opacity=".45" />
      <circle cx="16" cy="16" r="4.5" fill="none" stroke="var(--on-accent)" strokeWidth="2" opacity=".75" />
      <path d="M16 16 L23.5 9.5" stroke="var(--on-accent)" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="16" cy="16" r="1.8" fill="var(--on-accent)" />
    </svg>
  );
}

function ChangePassword({ onClose, forced }: { onClose: () => void; forced?: boolean }) {
  const { run, busy } = useAct();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const mismatch = f.again !== '' && f.next !== f.again;
  return (
    <Modal title={forced ? 'Choose a new password' : 'Change password'} onClose={forced ? () => undefined : onClose} width={440}
      subtitle={forced ? 'You signed in with a temporary password. Set your own before continuing.' : undefined}
      footer={<>
        {!forced && <Button variant="ghost" onClick={onClose}>Cancel</Button>}
        <Button variant="primary" busy={busy} disabled={!f.current || f.next.length < 10 || f.next !== f.again}
          onClick={async () => { if (await run(() => api('/auth/change-password', { body: { current: f.current, next: f.next } }), 'Password changed')) onClose(); }}>Save password</Button>
      </>}>
      <div className="space-y-3">
        <Field label={forced ? 'Temporary password' : 'Current password'}><input type="password" autoFocus className="field" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
        <Field label="New password" hint="At least 10 characters, with letters and numbers."><input type="password" className="field" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="Repeat new password" hint={mismatch ? 'The two passwords do not match.' : undefined}><input type="password" className="field" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

/** Jump to any vacancy by title, Greenhouse ID, hiring manager, recruiter or location. */
function QuickFind() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const res = useQuery({ queryKey: ['find', q], queryFn: () => api<any[]>(`/vacancies?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2 });
  useEffect(() => {
    const on = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, []);
  return (
    <div ref={box} className="relative w-full max-w-[340px]">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
      <input className="field !rounded-full !pl-9" placeholder="Find a vacancy…" aria-label="Find a vacancy" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} />
      {open && q.trim().length >= 2 && (
        <div className="glass-solid pop anim-rise absolute left-0 right-0 top-full z-40 mt-2 max-h-[360px] overflow-y-auto rounded-xl p-1.5">
          {res.isLoading && <p className="px-3 py-2 text-[13px] text-ink-3">Searching…</p>}
          {res.data?.length === 0 && <p className="px-3 py-2 text-[13px] text-ink-3">No vacancy matches “{q}”.</p>}
          {res.data?.slice(0, 8).map((v) => (
            <button key={v.id} className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-hover"
              onClick={() => { setOpen(false); setQ(''); nav(`/vacancies/${v.id}`); }}>
              <StatusIcon k={v.overall.key} />
              <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{v.title}</span>
                <span className="block truncate text-[12px] text-ink-3">{[v.country, v.recruiter, v.currentStage].filter(Boolean).join(' · ')}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { user, can, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const meta = useMeta();
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [pw, setPw] = useState(false);
  // On laptop-sized screens the sidebar starts as an icon rail so the tracker table has room; the choice is remembered.
  const [rail, setRailState] = useState(() => { try { const s = localStorage.getItem('tr-rail'); return s ? s === '1' : window.innerWidth < 1600; } catch { return false; } });
  const setRail = (v: boolean) => { setRailState(v); try { localStorage.setItem('tr-rail', v ? '1' : '0'); } catch { /* private mode */ } };
  const hide = rail ? 'lg:hidden' : '';
  useEffect(() => { setNavOpen(false); setMenu(false); }, [loc.pathname]);

  const items = [
    { to: '/overview', label: 'Overview', icon: LayoutDashboard, show: can('vacancies.view') },
    { to: '/workspace', label: 'My workspace', icon: UserRound, show: can('vacancies.edit_own', 'actions.manage_own') },
    { to: '/tracker', label: 'Hiring tracker', icon: Table2, show: can('vacancies.view') },
    { to: '/actions', label: 'Action centre', icon: ListChecks, show: can('vacancies.view') },
    { to: '/risks', label: 'Risk monitor', icon: ShieldAlert, show: can('risks.view') },
    { to: '/reports', label: 'Leadership report', icon: FileBarChart, show: can('reports.view') },
    { to: '/assistant', label: 'Assistant', icon: Sparkles, show: can('assistant.use') },
  ].filter((i) => i.show);
  const manage = [
    { to: '/import', label: 'Import from Excel', icon: Upload, show: can('import.run') },
    { to: '/admin', label: 'Administration', icon: Settings, show: can('admin.users', 'admin.config', 'admin.permissions', 'admin.integrations', 'audit.view', 'vacancies.assign') },
  ].filter((i) => i.show);
  const link = (i: (typeof items)[number]) => (
    <NavLink key={i.to} to={i.to} title={rail ? i.label : undefined} className={({ isActive }) => cx('flex items-center gap-3 rounded-xl px-3 py-2 text-[13.5px] font-medium transition', rail && 'lg:justify-center lg:px-0',
      isActive ? 'bg-accent-soft text-ink ring-1 ring-inset ring-line' : 'text-ink-2 hover:bg-hover hover:text-ink')}>
      {({ isActive }) => <><i.icon size={17} strokeWidth={isActive ? 2.2 : 1.9} className={cx('shrink-0', isActive && 'text-accent')} /><span className={hide}>{i.label}</span></>}
    </NavLink>
  );
  const nextTheme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  const ThemeIcon = theme === 'system' ? Monitor : theme === 'light' ? Sun : Moon;

  return (
    <div className="flex min-h-full">
      {navOpen && <div className="no-print fixed inset-0 z-30 bg-black/30 backdrop-blur-[2px] lg:hidden" onClick={() => setNavOpen(false)} />}
      <aside className={cx('no-print glass fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col !rounded-none !border-y-0 !border-l-0 px-3 py-4 transition-[transform,width] lg:inset-y-3 lg:left-3 lg:!rounded-2xl lg:!border',
        rail && 'lg:w-[68px]', navOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0')}>
        <div className={cx('mb-5 flex items-center gap-2.5 px-2', rail && 'lg:justify-center lg:px-0')}>
          <Logo />
          <div className={cx('min-w-0 leading-tight', hide)}>
            <div className="text-[15px] font-semibold tracking-tight">Talent Radar</div>
            <div className="truncate text-[11.5px] text-ink-3">{meta.data?.primaryTeam?.name ?? 'Egypt TA'} Control Tower</div>
          </div>
          <button className="ml-auto rounded-lg p-1.5 text-ink-3 hover:bg-hover lg:hidden" aria-label="Close menu" onClick={() => setNavOpen(false)}><X size={18} /></button>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto" aria-label="Main">
          {items.map(link)}
          {manage.length > 0 && <div className={cx('mb-1 mt-4 px-3 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-3', rail && 'lg:invisible lg:mb-0 lg:h-px lg:overflow-hidden lg:border-t lg:border-line lg:!visible')}>Manage</div>}
          {manage.map(link)}
        </nav>
        {meta.data?.hasDemoData && (
          <div title="Demonstration data — records tagged DEMO are fictional" className={cx('mt-3 flex items-start gap-2 rounded-xl border border-line bg-accent-soft px-3 py-2.5 text-[12px] leading-snug text-ink-2', rail && 'lg:justify-center lg:px-0')}>
            <FlaskConical size={15} className="mt-px shrink-0 text-accent" />
            <span className={hide}><b className="font-semibold text-ink">Demonstration data.</b> Records tagged DEMO are fictional.</span>
          </div>
        )}
        <button onClick={() => setRail(!rail)} title={rail ? 'Expand menu' : 'Collapse menu'} aria-label={rail ? 'Expand menu' : 'Collapse menu'}
          className={cx('mt-2 hidden items-center gap-3 rounded-xl px-3 py-2 text-[12.5px] text-ink-3 hover:bg-hover hover:text-ink lg:flex', rail && 'lg:justify-center lg:px-0')}>
          {rail ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}<span className={hide}>Collapse menu</span>
        </button>
      </aside>

      <div className={cx('print-full flex min-w-0 flex-1 flex-col', rail ? 'lg:pl-[92px]' : 'lg:pl-[272px]')}>
        <header className="no-print sticky top-0 z-20 flex items-center gap-3 px-4 py-3 sm:px-6 lg:px-8">
          <button className="glass rounded-xl p-2 lg:hidden" aria-label="Open menu" onClick={() => setNavOpen(true)}><Menu size={18} /></button>
          <QuickFind />
          <div className="ml-auto flex items-center gap-1.5">
            <button className="glass rounded-full p-2 text-ink-2 hover:text-ink" title={`Theme: ${theme}. Click for ${nextTheme}.`} aria-label={`Switch theme (now ${theme})`} onClick={() => setTheme(nextTheme)}>
              <ThemeIcon size={16} />
            </button>
            <div className="relative">
              <button className="glass flex items-center gap-2 rounded-full py-1 pl-1 pr-3 text-[13px] font-medium" onClick={() => setMenu((m) => !m)} aria-haspopup="menu" aria-expanded={menu}>
                <Avatar name={user!.name} /> <span className="hidden sm:inline">{user!.name}</span>
              </button>
              {menu && (
                <div className="glass-solid pop anim-rise absolute right-0 top-full z-40 mt-2 w-64 rounded-xl p-1.5" role="menu">
                  <div className="px-3 py-2">
                    <div className="text-[13.5px] font-semibold">{user!.name}</div>
                    <div className="truncate text-[12px] text-ink-3">{user!.jobTitle ?? user!.email}</div>
                    <div className="mt-1 text-[11.5px] text-ink-3">Role: {ROLE_LABEL[user!.role]}</div>
                  </div>
                  <div className="my-1 border-t border-line" />
                  <button role="menuitem" className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] hover:bg-hover" onClick={() => { setMenu(false); setPw(true); }}><KeyRound size={15} /> Change password</button>
                  <button role="menuitem" className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13.5px] hover:bg-hover" onClick={() => signOut()}><LogOut size={15} /> Sign out</button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main className="print-full mx-auto w-full max-w-[1640px] flex-1 px-4 pb-12 sm:px-6 lg:px-8">{children}</main>
      </div>
      {(pw || user!.mustChangePassword) && <ChangePassword forced={user!.mustChangePassword} onClose={() => setPw(false)} />}
    </div>
  );
}
