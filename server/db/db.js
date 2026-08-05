import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

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
 * Coerce a JS value into something SQLite will accept, or throw loudly.
 *
 * This is the single most important guard in the file. Verified on Node v26.3.0:
 * binding a JS boolean or `undefined` throws "Provided value cannot be bound to SQLite
 * parameter N". Strava's JSON is full of booleans (`trainer`, `manual`, `private`) and
 * missing fields, so without this every activity insert fails -- and pure mapper unit
 * tests never catch it, because the failure only happens at bind time.
 */
export function toBindable(value, index = 0) {
  if (value === null || value === undefined) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new TypeError(`Parameter ${index} is ${String(value)}; refusing to store a non-finite number.`);
      }
      return value;
    case 'bigint':
    case 'string':
      return value;
    default:
      throw new TypeError(
        `Parameter ${index} has unsupported type ${typeof value}. ` +
          `Only null, boolean, number, bigint, and string can be bound.`,
      );
  }
}

function bindables(params) {
  return params.map((p, i) => toBindable(p, i));
}

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
  const assertSingle = (sql) => {
    // A stray semicolon means a second statement silently never runs on some drivers.
    if (sql.replace(/;\s*$/, '').includes(';')) {
      throw new Error(`db: one statement per call. Use batch() for multiple:\n${sql}`);
    }
    // node:sqlite treats an array of params as NAMED parameters, so a named placeholder
    // here silently fails to bind rather than erroring usefully.
    if (/[:@$][A-Za-z_]/.test(sql)) {
      throw new Error(`db: positional ? placeholders only, found a named parameter:\n${sql}`);
    }
  };

  return {
    path,
    /** The underlying handle. Only migrate.js and tests should reach for this. */
    raw,

    /** @returns {Promise<object[]>} all matching rows as plain objects */
    async all(sql, params = []) {
      assertSingle(sql);
      return raw.prepare(sql).all(...bindables(params));
    },

    /** @returns {Promise<object|undefined>} the first row, or undefined */
    async get(sql, params = []) {
      assertSingle(sql);
      return raw.prepare(sql).get(...bindables(params));
    },

    /** @returns {Promise<{changes:number,lastInsertRowid:number}>} */
    async run(sql, params = []) {
      assertSingle(sql);
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
      for (const [sql] of statements) assertSingle(sql);

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

/**
 * Build `?,?,?` for an IN clause from the actual array length.
 *
 * Always use this instead of a hardcoded `IN (?,?,?,?)`: ALLOWED_SPORT_TYPES is
 * configurable, so a hardcoded arity breaks silently the moment someone sets three or
 * five sport types -- the query still runs, it just stops matching.
 */
export function placeholders(n) {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`placeholders(${n}): need at least one.`);
  return new Array(n).fill('?').join(',');
}
