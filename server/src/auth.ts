import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { one, pool, rows } from './db.js';
import { forbidden, HttpError } from './util.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const ROLES = ['admin', 'leadership', 'recruiter', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS: Record<string, string> = {
  'vacancies.view': 'View vacancies and the hiring tracker',
  'vacancies.create': 'Create vacancies',
  'vacancies.edit_own': 'Update vacancies assigned to them',
  'vacancies.edit_all': 'Update any vacancy',
  'vacancies.assign': 'Assign or reassign recruiters',
  'vacancies.archive': 'Archive vacancies',
  'notes.view': 'See internal notes',
  'actions.manage_own': 'Create actions and manage their own',
  'actions.manage_all': 'Manage any action',
  'risks.view': 'View the risk monitor',
  'reports.view': 'View and export leadership reports',
  'reports.generate': 'Save weekly report snapshots',
  'assistant.use': 'Use the recruitment assistant',
  'import.run': 'Import Excel / CSV data',
  'audit.view': 'View the audit log',
  'admin.users': 'Manage users',
  'admin.config': 'Configure reference data, statuses, milestones and risk rules',
  'admin.permissions': 'Configure role permissions',
  'admin.integrations': 'Manage integration settings',
};

const all = Object.keys(PERMISSIONS);
export const DEFAULT_ROLE_PERMISSIONS: Record<Role, string[]> = {
  admin: all,
  leadership: ['vacancies.view', 'vacancies.create', 'vacancies.edit_all', 'vacancies.assign', 'notes.view', 'actions.manage_own',
    'actions.manage_all', 'risks.view', 'reports.view', 'reports.generate', 'assistant.use', 'audit.view'],
  recruiter: ['vacancies.view', 'vacancies.create', 'vacancies.edit_own', 'notes.view', 'actions.manage_own', 'risks.view',
    'reports.view', 'assistant.use'],
  viewer: ['vacancies.view', 'risks.view', 'reports.view'],
};

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: Role;
  jobTitle: string | null;
  taTeamId: number | null;
  mustChangePassword: boolean;
  permissions: Set<string>;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// ───────────── Passwords (scrypt, per-user salt) ─────────────
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
export function assertPasswordPolicy(password: string): void {
  if (password.length < 10) throw new HttpError(400, 'Password must be at least 10 characters long');
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) throw new HttpError(400, 'Password must contain letters and numbers');
}

// ───────────── Sessions (opaque token in an httpOnly cookie; only its hash is stored) ─────────────
export const SESSION_COOKIE = 'tr_session';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(res: Response, req: Request, userId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttlMs = config.sessionTtlHours * 3600 * 1000;
  await pool.query(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1,$2,$3,$4,$5)`,
    [sha(token), userId, new Date(Date.now() + ttlMs), req.ip ?? null, String(req.headers['user-agent'] ?? '').slice(0, 300)],
  );
  await pool.query('UPDATE users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [userId]);
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/', maxAge: ttlMs });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE id = $1', [sha(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

// ───────────── Role permissions (cached briefly; invalidated when an admin edits them) ─────────────
let permCache: { at: number; map: Map<string, Set<string>> } | undefined;
export function invalidatePermissionCache(): void {
  permCache = undefined;
}
export async function rolePermissions(): Promise<Map<string, Set<string>>> {
  if (permCache && Date.now() - permCache.at < 30_000) return permCache.map;
  const map = new Map<string, Set<string>>();
  for (const r of await rows<{ role: string; permission: string }>(pool, 'SELECT role, permission FROM role_permissions')) {
    if (!map.has(r.role)) map.set(r.role, new Set());
    map.get(r.role)!.add(r.permission);
  }
  map.set('admin', new Set(all)); // administrators can never be locked out
  permCache = { at: Date.now(), map };
  return map;
}

/** Attaches req.user when a valid session cookie is present. Never rejects on its own. */
export async function loadUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return next();
  const u = await one<any>(
    pool,
    `SELECT u.id, u.email, u.name, u.role, u.job_title, u.ta_team_id, u.must_change_password, s.id AS session_id
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now() AND u.is_active`,
    [sha(token)],
  );
  if (u) {
    const perms = (await rolePermissions()).get(u.role) ?? new Set<string>();
    req.user = { ...u, permissions: perms };
    pool.query(`UPDATE sessions SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'`, [u.sessionId])
      .catch(() => undefined);
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  next();
}

/** Route guard: the signed-in user needs at least one of the listed permissions. */
export const requirePerm = (...perms: string[]) => (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  if (!perms.some((p) => req.user!.permissions.has(p))) throw forbidden();
  next();
};

export const can = (user: AuthUser, perm: string) => user.permissions.has(perm);
export const actor = (req: Request) => ({ id: req.user!.id, name: req.user!.name });

export function publicUser(u: AuthUser) {
  return { id: u.id, email: u.email, name: u.name, role: u.role, jobTitle: u.jobTitle, taTeamId: u.taTeamId,
    mustChangePassword: u.mustChangePassword, permissions: [...u.permissions].sort() };
}
