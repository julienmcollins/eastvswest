import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Apply any migrations the database has not seen yet, tracked in `PRAGMA user_version`.
 *
 * user_version rather than a migrations table: it needs no bootstrap migration of its
 * own, and it is a single integer that both node:sqlite and D1 can read.
 *
 * Each migration file runs inside one transaction. Migration files therefore must not
 * contain PRAGMAs -- verified that a PRAGMA inside a transaction is silently ignored.
 *
 * @returns {Promise<{from:number,to:number,applied:string[]}>}
 */
export async function migrate(db) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // 001_, 002_, ... lexicographic sort is the intended order

  const from = Number(db.raw.prepare('PRAGMA user_version').get().user_version);
  const applied = [];

  for (const [index, file] of files.entries()) {
    const version = index + 1;
    if (version <= from) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    if (/^\s*PRAGMA/im.test(sql)) {
      throw new Error(
        `${file} contains a PRAGMA. Migrations run in a transaction where pragmas are ` +
          `silently ignored -- move it to openDatabase().`,
      );
    }

    db.raw.exec('BEGIN IMMEDIATE');
    try {
      db.raw.exec(sql);
      // user_version does not accept a bound parameter, and `version` is a loop index we
      // computed ourselves -- never request data.
      db.raw.exec(`PRAGMA user_version = ${version}`);
      db.raw.exec('COMMIT');
    } catch (err) {
      try {
        db.raw.exec('ROLLBACK');
      } catch {
        // Preserve the original failure.
      }
      throw new Error(`Migration ${file} failed: ${err.message}`, { cause: err });
    }
    applied.push(file);
  }

  const to = Number(db.raw.prepare('PRAGMA user_version').get().user_version);
  return { from, to, applied };
}

/** Current schema version on disk. */
export function schemaVersion(db) {
  return Number(db.raw.prepare('PRAGMA user_version').get().user_version);
}
