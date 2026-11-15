// Starts the application for end-to-end tests on a freshly emptied test database with fictional demo data.
import pg from 'pg';

const url = process.env.DATABASE_URL ?? '';
if (!/_test\b/.test(url)) throw new Error('Refusing to wipe a database whose name does not end in _test');
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await client.end();
await import('../server/src/index.ts');
