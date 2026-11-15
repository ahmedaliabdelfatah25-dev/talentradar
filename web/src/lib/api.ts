export class ApiError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

/** Thin fetch wrapper: JSON in and out, session cookie included, errors raised with the server's message. */
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('tr:signed-out'));
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (data as any)?.error ?? `Request failed (${res.status})`, (data as any)?.details);
  return data as T;
}

export const qs = (params: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};
