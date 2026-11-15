import { defineConfig } from 'playwright/test';

const PORT = 8099;
// Browser tests of the primary workflows. Needs `npm run build -w web` first and a local PostgreSQL test database.
export default defineConfig({
  testDir: '.',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 }, trace: 'off' },
  webServer: {
    command: 'npx tsx e2e/start.mts',
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT), DEMO_DATA: 'true', NODE_ENV: 'development', LOGIN_RATE_LIMIT: '10000',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://talentradar:talentradar_dev@127.0.0.1:5432/talentradar_test',
    },
  },
});
