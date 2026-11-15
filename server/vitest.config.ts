import { defineConfig } from 'vitest/config';

// Integration tests run against a dedicated PostgreSQL database that is wiped at the start of every run.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://talentradar:talentradar_dev@127.0.0.1:5432/talentradar_test',
      DEMO_DATA: 'true',
      LOGIN_RATE_LIMIT: '10000',
      AI_PROVIDER: 'none',
    },
  },
});
