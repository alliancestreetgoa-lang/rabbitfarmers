#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Applies every db/migrations/*.sql not yet recorded, in filename order, each
 * in its own transaction. Re-running is a no-op.
 *
 *   node src/migrate.js            apply pending migrations, then seed
 *   node src/migrate.js --status   list what is applied and what is pending
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import pg from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', '..', 'db', 'migrations');
const seedFile = join(here, '..', '..', '..', 'db', 'seed.sql');

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function main() {
  const url = process.env.ADMIN_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error('Set DATABASE_URL (and ADMIN_DATABASE_URL for the owner role).');
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename    text PRIMARY KEY,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )`);

  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const { rows } = await client.query('SELECT filename, checksum FROM schema_migration');
  const applied = new Map(rows.map((r) => [r.filename, r.checksum]));

  if (process.argv.includes('--status')) {
    for (const f of files) {
      const sql = await readFile(join(migrationsDir, f), 'utf8');
      const was = applied.get(f);
      if (!was) console.log(`pending  ${f}`);
      else if (was !== sha(sql)) console.log(`CHANGED  ${f}  <-- already applied but edited`);
      else console.log(`applied  ${f}`);
    }
    await client.end();
    return;
  }

  let count = 0;
  for (const f of files) {
    const sql = await readFile(join(migrationsDir, f), 'utf8');
    const checksum = sha(sql);
    const was = applied.get(f);

    if (was) {
      // Editing an applied migration is how two environments silently diverge.
      // Fail loudly rather than pretending everything matches.
      if (was !== checksum) {
        console.error(
          `\n${f} has changed since it was applied.\n` +
          `Migrations are immutable once applied — add a new one instead.\n`);
        process.exitCode = 1;
        await client.end();
        return;
      }
      continue;
    }

    process.stdout.write(`applying ${f} ... `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)', [f, checksum]);
      await client.query('COMMIT');
      console.log('ok');
      count++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.log('FAILED');
      console.error(`\n${err.message}\n`);
      process.exitCode = 1;
      await client.end();
      return;
    }
  }

  const seed = await readFile(seedFile, 'utf8');
  await client.query(seed);

  console.log(count === 0 ? 'up to date; seed refreshed' : `${count} migration(s) applied, seeded`);
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
