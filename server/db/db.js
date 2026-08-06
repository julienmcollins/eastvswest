import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

import { assertStatement, bindables, placeholders, toBindable } from './bind.js';

/**
 * THE database adapter. Every other module talks to SQLite exclusively through this
 * interface, and never imports node:sqlite directly.
 *
 * Two shape decisions look gratuitous today and are the whole reason the Cloudflare
 * Worker port stays small:
 *
 *  1. Every method is `async`, even though node:sqlite is fully synchronous. D1 is
 *     async-only; retrofitting `await` through guards, routes, sessions, and sync later
 *     is the bulk of a port, and it is free to pay for now.
 *
 *  2. `batch()` replaces interactive transactions. D1 has no BEGIN/COMMIT, so there is
 *     deliberately no `withTransaction(fn)` taking a callback anywhere in the tree.
 *
 * Also enforced here: positional `?` placeholders only, one statement per call.
 * node:sqlite treats an ARRAY of params as NAMED parameters (verified: passing `[1]`
 * throws `Unknown named parameter '0'`), so params are always spread internally and no
 * call site can get that wrong.
 */

/**
 * Re-exported so `openDatabase`'s callers keep one import site. The definitions live in
 * ./bind.js because server/db/d1.js needs them too and must not touch node:sqlite.
 */
export { toBindable, placeholders };

/**
 * Open the database and apply connection-level pragmas.
 *
 * Pragmas live ONLY here, outside any transaction, and the journal_mode result is
 * asserted -- verified that a PRAGMA inside a transaction is a silent no-op, so a pragma
 * placed in a migration file would appear to work while doing nothing at all.
 */
export function openDatabase(path, { readOnly = false } = {}) {
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');
  if (!isMemory && !readOnly) mkdirSync(dirname(path), { recursive: true });

  const raw = new DatabaseSync(path, { readOnly });

  raw.exec('PRAGMA foreign_keys = ON');
  if (!readOnly) {
    raw.exec('PRAGMA busy_timeout = 5000');
    if (!isMemory) {
      // WAL is unavailable for :memory:, where it is also pointless.
      const mode = raw.prepare('PRAGMA journal_mode = WAL').get()?.journal_mode;
      if (mode !== 'wal') {
        throw new Error(`Expected journal_mode=wal, got "${mode}". A pragma was probably run inside a transaction.`);
      }
      raw.exec('PRAGMA synchronous = NORMAL');
    }
  }

  const fk = raw.prepare('PRAGMA foreign_keys').get()?.foreign_keys;
  if (fk !== 1) throw new Error(`Failed to enable foreign_keys (got ${fk}).`);

  return wrap(raw, path);
}

function wrap(raw, path) {
  return {
    path,
    /** The underlying handle. Only migrate.js and tests should reach for this. */
    raw,

    /** @returns {Promise<object[]>} all matching rows as plain objects */
    async all(sql, params = []) {
      assertStatement(sql);
      return raw.prepare(sql).all(...bindables(params));
    },

    /** @returns {Promise<object|undefined>} the first row, or undefined */
    async get(sql, params = []) {
      assertStatement(sql);
      return raw.prepare(sql).get(...bindables(params));
    },

    /** @returns {Promise<{changes:number,lastInsertRowid:number}>} */
    async run(sql, params = []) {
      assertStatement(sql);
      const r = raw.prepare(sql).run(...bindables(params));
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },

    /**
     * Run every statement in one transaction, all-or-nothing.
     *
     * BEGIN IMMEDIATE (not the default deferred) takes the write lock up front, so two
     * concurrent syncs fail fast instead of one dying at COMMIT after all its work.
     *
     * @param {Array<[string, unknown[]]>} statements
     * @returns {Promise<Array<{changes:number,lastInsertRowid:number}>>}
     */
    async batch(statements) {
      if (!Array.isArray(statements)) throw new TypeError('batch() expects an array of [sql, params].');
      if (statements.length === 0) return [];
      for (const [sql] of statements) assertStatement(sql);

      raw.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(([sql, params = []]) => {
          const r = raw.prepare(sql).run(...bindables(params));
          return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
        });
        raw.exec('COMMIT');
        return results;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // A failed rollback must not mask the original error.
        }
        throw err;
      }
    },

    /** Multi-statement DDL. Migrations only -- never user input. */
    async exec(sql) {
      raw.exec(sql);
    },

    async close() {
      raw.close();
    },
  };
}
