import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, FlaskConical, ShieldCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Logo } from '../components/Shell';
import { Avatar, Button, Card, Field } from '../components/ui';
import { api } from '../lib/api';

const ROLE: Record<string, string> = { leadership: 'Leadership view', recruiter: 'Recruiter workspace', admin: 'Administrator', viewer: 'Read-only viewer' };

export function LoginPage() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const cfg = useQuery({ queryKey: ['auth-config'], queryFn: () => api<any>('/auth/config') });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(params.get('error') ?? '');
  const [busy, setBusy] = useState(false);

  async function signIn(e: string, p: string) {
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', { body: { email: e, password: p } });
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const submit = (ev: FormEvent) => { ev.preventDefault(); void signIn(email, password); };
  const c = cfg.data;

  return (
    <div className="flex min-h-full items-center justify-center p-4 py-10">
      <div className="grid w-full max-w-[940px] items-stretch gap-5 lg:grid-cols-[1fr_1fr]">
        <Card className="flex flex-col p-8 sm:p-10">
          <div className="flex items-center gap-3">
            <Logo size={40} />
            <div className="leading-tight"><div className="text-[20px] font-semibold tracking-tight">Talent Radar</div><div className="text-[12.5px] text-ink-3">Egypt TA Control Tower</div></div>
          </div>
          <h1 className="mt-9 text-[28px] font-semibold leading-[1.15] tracking-[-0.02em]">Where every vacancy stands, who owns it, and what happens next.</h1>
          <p className="mt-3 text-[14px] text-ink-2">One shared place for recruitment progress, ownership and next actions — replacing the Excel tracker.</p>

          <form onSubmit={submit} className="mt-8 space-y-3.5">
            {c?.sso.enabled && (
              <a href="/api/auth/sso/login" className="flex h-10 items-center justify-center gap-2 rounded-[10px] bg-accent text-[14px] font-medium text-on-accent hover:brightness-110">
                <ShieldCheck size={17} /> {c.sso.label}
              </a>
            )}
            {c?.sso.enabled && c?.localLogin && <div className="flex items-center gap-3 text-[12px] text-ink-3"><span className="h-px flex-1 bg-line-2" />or use a password<span className="h-px flex-1 bg-line-2" /></div>}
            {c?.localLogin !== false && <>
              <Field label="Work email"><input className="field" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
              <Field label="Password"><input className="field" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              <Button type="submit" variant={c?.sso.enabled ? 'secondary' : 'primary'} busy={busy} className="w-full">Sign in</Button>
            </>}
            {error && <p role="alert" className="rounded-lg bg-[color-mix(in_srgb,var(--crit)_12%,transparent)] px-3 py-2 text-[13px]">{error}</p>}
          </form>
          <p className="mt-auto pt-8 text-[11.5px] text-ink-3">Access is limited to authorised colleagues. Activity is recorded in the audit log.</p>
        </Card>

        {c?.demo ? (
          <Card className="p-8 sm:p-10">
            <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.07em] text-accent"><FlaskConical size={15} /> Demonstration mode</div>
            <h2 className="mt-3 text-[19px] font-semibold tracking-tight">Explore with fictional data</h2>
            <p className="mt-1.5 text-[13.5px] text-ink-2">Every person and vacancy in this prototype is invented. Choose a role to see the application from that seat.</p>
            <div className="mt-5 space-y-1.5">
              {c.demo.users.map((u: any) => (
                <button key={u.email} disabled={busy} onClick={() => signIn(u.email, c.demo.password)}
                  className="group flex w-full items-center gap-3 rounded-xl border border-line bg-field px-3 py-2.5 text-left transition hover:border-line-2 hover:bg-hover disabled:opacity-60">
                  <Avatar name={u.name} size={32} />
                  <span className="min-w-0 flex-1"><span className="block text-[13.5px] font-medium">{u.name}</span><span className="block truncate text-[12px] text-ink-3">{u.jobTitle}</span></span>
                  <span className="hidden text-[12px] text-ink-2 sm:block">{ROLE[u.role]}</span>
                  <ArrowRight size={15} className="text-ink-3 transition group-hover:translate-x-0.5 group-hover:text-ink" />
                </button>
              ))}
            </div>
            <p className="mt-4 text-[12px] text-ink-3">Demo sign-in is only offered while the server runs with DEMO_DATA enabled. It is switched off in production.</p>
          </Card>
        ) : (
          <Card className="hidden flex-col justify-center p-10 lg:flex">
            <ul className="space-y-5 text-[14px]">
              {[['What are we hiring for?', 'Every vacancy handled by the team, wherever it is located.'], ['Where does each one stand?', 'Stage, status, last update and next action on one line.'],
                ['Is anything delayed?', 'Rule-based alerts explain what happened and who should act.']].map(([t, d]) => (
                <li key={t}><div className="font-semibold">{t}</div><div className="text-ink-2">{d}</div></li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
