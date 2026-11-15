import { assertPasswordPolicy, hashPassword } from './auth.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { clearDemoData, seedDemoData } from './seed/demo.js';
import { ensureDefaults } from './settings.js';

/** Operational commands for IT: `node dist/cli.js <command>`. */
const [cmd, ...args] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  migrate: async () => { const done = await migrate(); await ensureDefaults(); console.log(done.length ? `Applied: ${done.join(', ')}` : 'Database is up to date.'); },
  'seed-demo': async () => { await migrate(); await seedDemoData(); console.log('Demonstration data loaded.'); },
  'clear-demo': async () => { console.log(await clearDemoData(0)); },
  'create-admin': async () => {
    const [email, name, password] = args;
    if (!email || !name || !password) throw new Error('Usage: create-admin <email> "<full name>" <temporary-password>');
    assertPasswordPolicy(password);
    await pool.query(`INSERT INTO users (email, name, role, password_hash, must_change_password) VALUES ($1,$2,'admin',$3,true)
      ON CONFLICT (lower(email)) DO UPDATE SET role = 'admin', is_active = true, password_hash = EXCLUDED.password_hash, must_change_password = true, failed_logins = 0, locked_until = NULL`,
      [email.toLowerCase(), name, await hashPassword(password)]);
    console.log(`Administrator ready: ${email}`);
  },
};
const run = commands[cmd ?? ''];
if (!run) {
  console.error(`Unknown command. Available: ${Object.keys(commands).join(', ')}`);
  process.exit(2);
}
run().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
