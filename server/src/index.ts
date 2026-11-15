import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { pool } from './db.js';
import { startScheduler } from './scheduler.js';

async function main() {
  await bootstrap();
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(JSON.stringify({ level: 'info', message: `Talent Radar listening on port ${config.port}`, env: config.env, demoData: config.demoData }));
  });
  startScheduler();
  const stop = (signal: string) => {
    console.log(JSON.stringify({ level: 'info', message: `${signal} received, shutting down` }));
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => {
  console.error(JSON.stringify({ level: 'fatal', message: err.message, stack: err.stack }));
  process.exit(1);
});
