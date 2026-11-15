import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()));
const here = path.dirname(fileURLToPath(import.meta.url));
const isProd = env.NODE_ENV === 'production';

/**
 * All configuration comes from environment variables (12-factor).
 * Secrets are never stored in the database or returned by the API.
 */
export const config = {
  env: env.NODE_ENV ?? 'development',
  isProd,
  port: Number(env.PORT ?? 8080),
  appUrl: (env.APP_URL ?? '').replace(/\/$/, ''),
  databaseUrl: env.DATABASE_URL ?? 'postgres://talentradar:talentradar_dev@127.0.0.1:5432/talentradar',
  databaseSsl: bool(env.DATABASE_SSL, false),
  trustProxy: env.TRUST_PROXY ?? (isProd ? '1' : ''),
  cookieSecure: bool(env.COOKIE_SECURE, isProd),
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
  demoData: bool(env.DEMO_DATA, false),
  localLogin: bool(env.LOCAL_LOGIN_ENABLED, true),
  bootstrapAdmin: {
    email: env.BOOTSTRAP_ADMIN_EMAIL ?? '',
    password: env.BOOTSTRAP_ADMIN_PASSWORD ?? '',
    name: env.BOOTSTRAP_ADMIN_NAME ?? 'Administrator',
  },
  sso: {
    enabled: bool(env.SSO_ENABLED, false),
    label: env.SSO_LABEL ?? 'Sign in with Microsoft',
    issuer: env.SSO_ISSUER ?? '', // e.g. https://login.microsoftonline.com/<tenant-id>/v2.0
    clientId: env.SSO_CLIENT_ID ?? '',
    clientSecret: env.SSO_CLIENT_SECRET ?? '',
    allowedDomains: (env.SSO_ALLOWED_DOMAINS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    autoProvision: bool(env.SSO_AUTO_PROVISION, false),
    defaultRole: env.SSO_DEFAULT_ROLE ?? 'viewer',
  },
  greenhouse: {
    clientId: env.GREENHOUSE_CLIENT_ID ?? '',
    clientSecret: env.GREENHOUSE_CLIENT_SECRET ?? '',
    tokenUrl: env.GREENHOUSE_TOKEN_URL ?? 'https://auth.greenhouse.io/token',
    baseUrl: (env.GREENHOUSE_BASE_URL ?? 'https://harvest.greenhouse.io/v3').replace(/\/$/, ''),
    jobUrlTemplate: env.GREENHOUSE_JOB_URL_TEMPLATE ?? 'https://app.greenhouse.io/sdash/{id}',
  },
  ai: {
    provider: (env.AI_PROVIDER ?? 'none') as 'none' | 'openai_compatible',
    baseUrl: (env.AI_BASE_URL ?? '').replace(/\/$/, ''),
    apiKey: env.AI_API_KEY ?? '',
    apiKeyHeader: env.AI_API_KEY_HEADER ?? 'Authorization', // Azure OpenAI classic deployments use "api-key"
    model: env.AI_MODEL ?? '',
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 30000),
  },
  teams: { webhookUrl: env.TEAMS_WEBHOOK_URL ?? '' },
  webDist: env.WEB_DIST ?? path.resolve(here, '../../web/dist'),
  migrationsDir: path.resolve(here, '../migrations'),
};
