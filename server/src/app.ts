import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import { ZodError } from 'zod';
import { loadUser, requireAuth } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import { admin } from './routes/admin.js';
import { authRouter } from './routes/auth.js';
import { core } from './routes/core.js';
import { HttpError } from './util.js';

/** CSRF defence in depth: besides SameSite cookies, state-changing requests must come from our own origin. */
function sameOrigin(req: Request, _res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* malformed origin is rejected below */ }
    const allowed = [req.headers.host, req.get('x-forwarded-host'), config.appUrl ? new URL(config.appUrl).host : undefined].filter(Boolean);
    if (!allowed.includes(host)) throw new HttpError(403, 'Cross-site request blocked');
  } else if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Cross-site request blocked');
  }
  next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', /^\d+$/.test(config.trustProxy) ? Number(config.trustProxy) : config.trustProxy);

  // FRAME_ANCESTORS lets IT allow embedding (e.g. as a Microsoft Teams tab); the production default forbids framing.
  const frameAncestors = (process.env.FRAME_ANCESTORS ?? (config.isProd ? "'none'" : '*')).split(/\s+/).filter(Boolean);
  app.use(helmet({
    contentSecurityPolicy: { directives: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors, upgradeInsecureRequests: null,
    } },
    xFrameOptions: frameAncestors.includes("'none'") ? { action: 'deny' } : false,
    strictTransportSecurity: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
  }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', time: new Date().toISOString() });
    } catch {
      res.status(503).json({ status: 'database_unavailable' });
    }
  });

  app.use('/api', sameOrigin, loadUser, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api/auth', authRouter);
  // A temporary password only allows choosing a new one — enforced here, not just in the browser.
  app.use('/api', requireAuth, (req, _res, next) => {
    if (req.user!.mustChangePassword) throw new HttpError(403, 'Choose a new password before continuing');
    next();
  }, core, admin);
  app.use('/api', (_req, _res) => { throw new HttpError(404, 'Not found'); });

  // Single-page application: hashed assets are cached for a year, index.html is never cached.
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1y', immutable: true }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(config.webDist, 'index.html'));
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return void res.status(400).json({ error: first ? `${first.path.join('.') ? `${first.path.join('.')}: ` : ''}${first.message}` : 'Invalid input', issues: err.issues });
    }
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message, details: err.details });
    if (err?.code === 'LIMIT_FILE_SIZE') return void res.status(413).json({ error: 'The file is larger than the 10 MB upload limit' });
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request is too large' });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Request body is not valid JSON' });
    if (err?.code === '23505') return void res.status(409).json({ error: 'A record with the same unique value already exists' });
    if (err?.code === '23503') return void res.status(409).json({ error: 'This record is still referenced by other records' });
    const ref = Math.random().toString(36).slice(2, 10);
    console.error(JSON.stringify({ level: 'error', ref, method: req.method, path: req.path, user: req.user?.id ?? null, message: err?.message, stack: err?.stack }));
    res.status(500).json({ error: `Something went wrong on the server. Reference: ${ref}` });
  });
  return app;
}
