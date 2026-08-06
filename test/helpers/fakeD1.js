import { openDatabase } from '../../server/db/db.js';

/**
 * A D1Database double, backed by the real node:sqlite driver.
 *
 * The point is to exercise `server/db/d1.js` against actual SQL and a real schema rather than
 * against assertions about what D1 returns. Everything D1-shaped is faithfully reproduced,
 * because every one of these details is a way the adapter could be silently wrong:
 *
 *   - `.first()` resolves to `null` for no row, where node:sqlite gives `undefined`
 *   - write metadata is `meta.changes` / `meta.last_row_id`, not `changes` / `lastInsertRowid`
 *   - `.all()` wraps rows in `{success, results, meta}`
 *   - a failure can arrive as `{success: false}` rather than as a rejection
 *   - `batch()` is implicitly one transaction, and D1 has no BEGIN to call
 *   - BigInt parameters are rejected outright
 */
export function createFakeD1(sqliteDb) {
  const raw = sqliteDb.raw;
  /** Every statement the fake has executed, for arity and ordering assertions. */
  const calls = [];
  /**
   * Substrings that force `{success:false}`, to test the assertOk path.
   *
   * Matched against the SQL *and* the bound parameters: every real statement in this codebase
   * is parameterized, so a value like 'Four' never appears in the SQL text at all.
   */
  const failOn = new Set();

  function prepare(sql) {
    return statement(sql, null);
  }

  function statement(sql, bound) {
    const params = () => {
      if (bound === null) return [];
      for (const [i, p] of bound.entries()) {
        if (typeof p === 'bigint') throw new TypeError(`D1_TYPE_ERROR: cannot bind BigInt at ${i}`);
        if (typeof p === 'boolean' || p === undefined) {
          throw new TypeError(`D1_TYPE_ERROR: cannot bind ${typeof p} at ${i}`);
        }
      }
      return bound;
    };

    const record = (kind) => calls.push({ kind, sql, params: bound === null ? [] : [...bound] });
    const forced = () => {
      const haystack = `${sql} ${JSON.stringify(bound ?? [])}`;
      return [...failOn].some((needle) => haystack.includes(needle));
    };

    return {
      bind(...args) {
        // D1 returns a NEW bound statement; rebinding the same prepared statement is an error
        // there, so the fake models it the same way.
        if (bound !== null) throw new Error('D1_ERROR: statement is already bound');
        return statement(sql, args);
      },

      async all() {
        record('all');
        if (forced()) return { success: false, error: 'forced failure', results: [], meta: {} };
        // Spread into ORDINARY objects: node:sqlite hands back null-prototype rows, D1 does
        // not, and a test asserting deepEqual against a literal would otherwise fail against
        // the fake while passing in production.
        const results = raw.prepare(sql).all(...params()).map((row) => ({ ...row }));
        return { success: true, results, meta: { changes: 0, last_row_id: 0, duration: 0.1 } };
      },

      async first(column) {
        record('first');
        const row = raw.prepare(sql).get(...params());
        if (row === undefined) return null; // D1 gives null, not undefined.
        const plain = { ...row };
        return column === undefined ? plain : (plain[column] ?? null);
      },

      async run() {
        record('run');
        if (forced()) return { success: false, error: 'forced failure', meta: {} };
        const r = raw.prepare(sql).run(...params());
        return {
          success: true,
          results: [],
          meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), duration: 0.1 },
        };
      },
    };
  }

  return {
    calls,
    failOn,
    prepare,

    /** D1's batch is implicitly a transaction, so the fake wraps it in a real one. */
    async batch(statements) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = [];
        for (const stmt of statements) out.push(await stmt.run());
        // A forced failure inside a batch must roll the whole thing back, like D1.
        if (out.some((r) => r.success === false)) throw new Error('forced batch failure');
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* a failed rollback must not mask the original error */
        }
        throw err;
      }
    },

    async exec(sql) {
      calls.push({ kind: 'exec', sql, params: [] });
      raw.exec(sql);
      return { count: sql.split(';').filter((s) => s.trim()).length, duration: 0.1 };
    },
  };
}

/** A migrated in-memory database plus a D1 double sitting on top of the same file. */
export async function freshD1() {
  const { migrate } = await import('../../server/db/migrate.js');
  const sqlite = openDatabase(':memory:');
  await migrate(sqlite);
  const { openD1 } = await import('../../server/db/d1.js');
  const fake = createFakeD1(sqlite);
  return { sqlite, fake, db: openD1(fake, { name: 'TEST' }) };
}
