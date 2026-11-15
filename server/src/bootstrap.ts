import { hashPassword } from './auth.js';
import { config } from './config.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { hasUsers, seedDemoData } from './seed/demo.js';
import { ensureDefaults } from './settings.js';

const log = (message: string) => console.log(JSON.stringify({ level: 'info', message }));

/** Brings an empty or outdated database to a usable state. Idempotent — runs on every start. */
export async function bootstrap(): Promise<void> {
  await migrate(log);
  await ensureDefaults();
  if (await hasUsers()) return;
  if (config.demoData) {
    await seedDemoData();
    log('Demonstration data loaded (DEMO_DATA=true). All records are fictional.');
    return;
  }
  const b = config.bootstrapAdmin;
  if (b.email && b.password) {
    await pool.query(`INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES ($1,$2,'admin',$3,true)`,
      [b.email.toLowerCase(), b.name, await hashPassword(b.password)]);
    log(`First administrator created for ${b.email}. They must change the password at first sign-in.`);
  } else {
    log('No users exist. Set BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD (or DEMO_DATA=true) and restart.');
  }
}
