import crypto from 'node:crypto';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import * as oidc from 'openid-client';
import { z } from 'zod';
import { audit } from '../audit.js';
import { assertPasswordPolicy, createSession, destroySession, hashPassword, publicUser, requireAuth, verifyPassword } from '../auth.js';
import { config } from '../config.js';
import { one, pool, rows } from '../db.js';
import { DEMO_PASSWORD } from '../seed/demo.js';
import { HttpError } from '../util.js';

export const authRouter = Router();
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: Number(process.env.LOGIN_RATE_LIMIT ?? 30), standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a few minutes and try again.' } });

authRouter.get('/config', async (_req, res) => {
  const demoUsers = config.demoData
    ? await rows<any>(pool, `SELECT name, email, role, job_title FROM users WHERE is_demo AND is_active ORDER BY CASE role WHEN 'leadership' THEN 0 WHEN 'recruiter' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, name`)
    : [];
  res.json({ localLogin: config.localLogin, sso: { enabled: config.sso.enabled, label: config.sso.label },
    demo: config.demoData ? { password: DEMO_PASSWORD, users: demoUsers } : null });
});

authRouter.post('/login', loginLimiter, async (req, res) => {
  if (!config.localLogin) throw new HttpError(403, 'Password sign-in is disabled. Use single sign-on.');
  const { email, password } = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) }).parse(req.body);
  const u = await one<any>(pool, 'SELECT * FROM users WHERE lower(email) = lower($1)', [email]);
  const fail = new HttpError(401, 'Email or password is incorrect');
  if (!u || !u.isActive) { await verifyPassword(password, 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'); throw fail; }
  if (u.lockedUntil && new Date(u.lockedUntil) > new Date()) throw new HttpError(423, 'This account is temporarily locked after repeated failed sign-ins. Try again in 15 minutes.');
  if (!(await verifyPassword(password, u.passwordHash))) {
    await pool.query(`UPDATE users SET failed_logins = failed_logins + 1,
        locked_until = CASE WHEN failed_logins + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id]);
    await audit(pool, { id: u.id, name: u.name }, { entityType: 'auth', entityId: u.id, action: 'login_failed', summary: `Failed sign-in for ${u.email}` });
    throw fail;
  }
  await createSession(res, req, u.id);
  await audit(pool, { id: u.id, name: u.name }, { entityType: 'auth', entityId: u.id, action: 'login', summary: 'Signed in with password' });
  res.json({ ok: true });
});

authRouter.post('/logout', async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user!) });
});

authRouter.post('/change-password', requireAuth, async (req, res) => {
  const { current, next } = z.object({ current: z.string().max(200), next: z.string().max(200) }).parse(req.body);
  const u = await one<any>(pool, 'SELECT password_hash FROM users WHERE id = $1', [req.user!.id]);
  if (!(await verifyPassword(current, u.passwordHash))) throw new HttpError(400, 'Your current password is incorrect');
  assertPasswordPolicy(next);
  await pool.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [req.user!.id, await hashPassword(next)]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [req.user!.id, req.user!.sessionId]);
  await audit(pool, { id: req.user!.id, name: req.user!.name }, { entityType: 'auth', entityId: req.user!.id, action: 'password_changed', summary: 'Password changed' });
  res.json({ ok: true });
});

// ───────────── Single sign-on: OpenID Connect authorisation-code flow with PKCE (e.g. Microsoft Entra ID) ─────────────
let oidcConfig: Promise<oidc.Configuration> | undefined;
const discover = () => {
  if (!config.sso.enabled || !config.sso.issuer || !config.sso.clientId) throw new HttpError(404, 'Single sign-on is not configured');
  const opts = config.sso.issuer.startsWith('http://') ? { execute: [oidc.allowInsecureRequests] } : undefined; // http only for local test providers
  oidcConfig ??= oidc.discovery(new URL(config.sso.issuer), config.sso.clientId, config.sso.clientSecret || undefined, undefined, opts)
    .catch((e) => { oidcConfig = undefined; throw new HttpError(502, `Could not reach the identity provider: ${e.message}`); });
  return oidcConfig;
};
const SSO_COOKIE = 'tr_sso';
const baseUrl = (req: any) => config.appUrl || `${req.protocol}://${req.get('host')}`;

authRouter.get('/sso/login', async (req, res) => {
  const cfg = await discover();
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: `${baseUrl(req)}/api/auth/sso/callback`, scope: 'openid profile email', response_type: 'code',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
  });
  res.cookie(SSO_COOKIE, JSON.stringify({ verifier, state, nonce }), { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/api/auth/sso', maxAge: 10 * 60 * 1000 });
  res.redirect(url.href);
});

authRouter.get('/sso/callback', async (req, res) => {
  const fail = (msg: string) => res.redirect(`/login?error=${encodeURIComponent(msg)}`);
  let saved: { verifier: string; state: string; nonce: string };
  try { saved = JSON.parse(req.cookies?.[SSO_COOKIE] ?? ''); } catch { return fail('Your sign-in session expired. Please try again.'); }
  res.clearCookie(SSO_COOKIE, { path: '/api/auth/sso' });
  let claims: Record<string, any> | undefined;
  try {
    const cfg = await discover();
    const tokens = await oidc.authorizationCodeGrant(cfg, new URL(`${baseUrl(req)}${req.originalUrl}`),
      { pkceCodeVerifier: saved.verifier, expectedState: saved.state, expectedNonce: saved.nonce, idTokenExpected: true });
    claims = tokens.claims();
  } catch (e) {
    return fail(`Single sign-on failed: ${(e as Error).message}`);
  }
  const email = String(claims?.email ?? claims?.preferred_username ?? claims?.upn ?? '').toLowerCase();
  if (!claims?.sub || !email.includes('@')) return fail('The identity provider did not return an email address.');
  if (config.sso.allowedDomains.length && !config.sso.allowedDomains.includes(email.split('@')[1])) return fail('Your email domain is not allowed to use this application.');
  let u = await one<any>(pool, 'SELECT * FROM users WHERE sso_subject = $1 OR lower(email) = $2 ORDER BY (sso_subject = $1) DESC LIMIT 1', [claims.sub, email]);
  if (!u && config.sso.autoProvision) {
    u = await one<any>(pool, `INSERT INTO users (email, name, role, sso_subject) VALUES ($1,$2,$3,$4) RETURNING *`,
      [email, String(claims.name ?? email.split('@')[0]), ['viewer', 'recruiter', 'leadership'].includes(config.sso.defaultRole) ? config.sso.defaultRole : 'viewer', claims.sub]);
    await audit(pool, { id: u.id, name: u.name }, { entityType: 'user', entityId: u.id, action: 'created', summary: `User provisioned at first single sign-on as ${u.role}` });
  }
  if (!u) return fail('Your account has not been added to Talent Radar yet. Ask an administrator to invite you.');
  if (!u.isActive) return fail('Your account is deactivated.');
  if (!u.ssoSubject) await pool.query('UPDATE users SET sso_subject = $2 WHERE id = $1', [u.id, claims.sub]);
  await createSession(res, req, u.id);
  await audit(pool, { id: u.id, name: u.name }, { entityType: 'auth', entityId: u.id, action: 'login', summary: 'Signed in with single sign-on' });
  res.redirect('/');
});

export const randomPassword = () => `${crypto.randomBytes(9).toString('base64url')}7a`;
