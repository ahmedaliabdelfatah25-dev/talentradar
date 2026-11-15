import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';

export interface User { id: number; email: string; name: string; role: 'admin' | 'leadership' | 'recruiter' | 'viewer'; jobTitle: string | null; mustChangePassword: boolean; permissions: string[] }

const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: (n, e: any) => n < 2 && !(e?.status >= 400 && e?.status < 500) } } });

// ───────────── Toasts ─────────────
interface Toast { id: number; kind: 'ok' | 'error'; text: string }
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

// ───────────── Theme ─────────────
type Theme = 'light' | 'dark' | 'system';
const ThemeCtx = createContext<{ theme: Theme; dark: boolean; setTheme: (t: Theme) => void }>({ theme: 'system', dark: false, setTheme: () => undefined });
export const useTheme = () => useContext(ThemeCtx);
const stored = (): Theme => { try { return (localStorage.getItem('tr-theme') as Theme) || 'system'; } catch { return 'system'; } };

// ───────────── Auth ─────────────
const AuthCtx = createContext<{ user: User | null; loading: boolean; can: (...p: string[]) => boolean; signOut: () => Promise<void> }>({ user: null, loading: true, can: () => false, signOut: async () => undefined });
export const useAuth = () => useContext(AuthCtx);

function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: () => api<{ user: User }>('/auth/me').then((r) => r.user).catch((e) => { if (e.status === 401) return null; throw e; }), staleTime: 60_000 });
  useEffect(() => {
    const out = () => qc.setQueryData(['me'], null);
    window.addEventListener('tr:signed-out', out);
    return () => window.removeEventListener('tr:signed-out', out);
  }, [qc]);
  const value = useMemo(() => {
    const user = me.data ?? null;
    return {
      user, loading: me.isLoading,
      can: (...p: string[]) => !!user && p.some((x) => user.permissions.includes(x)),
      signOut: async () => { await api('/auth/logout', { method: 'POST' }).catch(() => undefined); qc.clear(); qc.setQueryData(['me'], null); },
    };
  }, [me.data, me.isLoading, qc]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const [theme, setThemeState] = useState<Theme>(stored);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const dark = theme === 'dark' || (theme === 'system' && systemDark);
  useEffect(() => { document.documentElement.classList.toggle('dark', dark); }, [dark]);
  const setTheme = useCallback((t: Theme) => { setThemeState(t); try { localStorage.setItem('tr-theme', t); } catch { /* private mode */ } }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeCtx.Provider value={{ theme, dark, setTheme }}>
        <ToastCtx.Provider value={push}>
          <AuthProvider>{children}</AuthProvider>
          <div className="no-print fixed bottom-4 right-4 z-[80] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2" role="status" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className="glass-solid pop anim-rise flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-[13px]">
                {t.kind === 'ok' ? <CircleCheck size={17} className="mt-px shrink-0 text-good" /> : <CircleAlert size={17} className="mt-px shrink-0 text-crit" />}
                <span className="flex-1">{t.text}</span>
                <button aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="text-ink-3 hover:text-ink"><X size={15} /></button>
              </div>
            ))}
          </div>
        </ToastCtx.Provider>
      </ThemeCtx.Provider>
    </QueryClientProvider>
  );
}

/** Reference data for forms and filters (teams, countries, users, statuses, templates…). */
export const useMeta = () => useQuery({ queryKey: ['meta'], queryFn: () => api<any>('/meta'), staleTime: 60_000 });

/**
 * Runs a write, then refreshes everything on screen. The dataset is small, so a full
 * refresh is cheap and guarantees leaders and recruiters never look at stale numbers.
 */
export function useAct() {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const out = await fn();
      await qc.invalidateQueries();
      if (ok) toast('ok', ok);
      return out;
    } catch (e: any) {
      toast('error', e?.message ?? 'Something went wrong');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [qc, toast]);
  return { run, busy };
}
