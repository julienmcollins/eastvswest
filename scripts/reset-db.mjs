#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/db.js';
import { migrate, schemaVersion } from '../server/db/migrate.js';

/**
 * Drop the development database and re-migrate it from scratch.
 *
 *   npm run reset-db -- --yes
 *
 * `--yes` is REQUIRED and is not ceremony: this is a destructive command whose name reads like
 * a harmless one, and it is one shell-history arrow-key away from a command someone runs all
 * day. It also refuses outright when NODE_ENV=production, because no argument makes deleting a
 * live competition's results correct.
 */

const args = process.argv.slice(2).filter((a) => a !== '--');

if (!args.includes('--yes')) {
  process.stderr.write(
    'Refusing to reset without confirmation.\n\n' +
      'Usage: npm run reset-db -- --yes\n\n' +
      'This DELETES every athlete, activity, token, and session in DATABASE_PATH.\n',
  );
  process.exit(1);
}

const config = loadConfig(process.env, { loadEnvFile: true });

if (config.isProduction) {
  process.stderr.write('NODE_ENV=production: refusing to reset the database.\n');
  process.exit(1);
}

const path = config.databasePath;
const isMemory = path === ':memory:' || path.startsWith('file::memory:');

if (isMemory) {
  // Nothing on disk to remove, and a fresh handle IS a fresh database. Reported rather than
  // silently succeeding, so nobody concludes their file database was wiped when it was not.
  process.stdout.write(`DATABASE_PATH is ${path}; an in-memory database is empty on every start. Nothing to drop.\n`);
} else {
  // The files are removed rather than the tables dropped. DROP TABLE with foreign keys ON has
  // to happen in dependency order, and every future migration adds another table to keep that
  // list correct -- a list that is silently wrong the first time someone forgets. Deleting the
  // file cannot drift.
  //
  // `-wal` and `-shm` go too: leaving a WAL behind next to a deleted main database means the
  // next open either fails or resurrects pages from the database that was just "reset".
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`;
    if (existsSync(file)) {
      rmSync(file);
      process.stdout.write(`removed ${file}\n`);
    }
  }
}

// openDatabase recreates the directory and the file, applies the pragmas, and asserts
// journal_mode came back as WAL.
const db = openDatabase(path);
try {
  const result = await migrate(db);
  process.stdout.write(
    `migrated ${path} to schema version ${schemaVersion(db)} ` +
      `(${result.applied.length} file(s): ${result.applied.join(', ') || 'none'}).\n`,
  );
} finally {
  await db.close();
}
