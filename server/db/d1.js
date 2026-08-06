import { assertStatement, bindables } from './bind.js';

/**
 * THE Cloudflare D1 adapter. The other half of `server/db/db.js`, exposing a byte-identical
 * interface over a completely different driver, so that nothing above this file knows which
 * one it is talking to.
 *
 * The two shape decisions `db.js` made up front are what keep this file short:
 *
 *  1. Every method there is already `async`, even though node:sqlite is synchronous. D1 is
 *     async-only, so there is no `await` to retrofit through guards, routes, sessions or sync.
 *  2. `batch()` already replaced interactive transactions. D1 has no BEGIN/COMMIT -- a batch
 *     IS the transaction -- so there was never a `withTransaction(fn)` to unpick.
 *
 * WHAT IS DELIBERATELY MISSING, versus db.js:
 *
 *  - No pragmas. D1 does not accept `PRAGMA foreign_keys`, `journal_mode`, or `busy_timeout`;
 *    it enforces foreign keys itself and manages its own storage. `openDatabase` asserts those
 *    pragmas took effect precisely because a silently-ignored pragma is dangerous; here there
 *    is nothing to assert, so nothing pretends to.
 *  - No `close()` that closes anything. The binding outlives the request and is owned by the
 *    runtime. It is kept as a no-op so shared shutdown code does not need a branch.
 */

/**
 * Normalize a D1 result envelope, turning a driver-level failure into a throw.
 *
 * D1 reports some failures as `{success: false}` rather than by rejecting, and a caller that
 * only awaits the promise would read that as an empty result set -- a sync that silently
 * stores nothing, which is the exact failure mode this project keeps trying to avoid.
 */
function assertOk(result, sql) {
  if (result && result.success === false) {
    const detail = typeof result.error === 'string' ? `: ${result.error}` : '';
    throw new Error(`D1 reported failure for statement${detail}\n${sql}`);
  }
  return result;
}

/**
 * D1 cannot bind a BigInt, so narrow it here.
 *
 * `toBindable` (shared with the SQLite path) allows bigint because node:sqlite accepts it.
 * Every id in this schema is a Strava id or a rowid, all far inside Number.MAX_SAFE_INTEGER,
 * so narrowing is lossless in practice -- and throwing on the one case where it would NOT be
 * is better than storing a rounded id.
 */
function d1Bindables(params) {
  return bindables(params).map((value, i) => {
    if (typeof value !== 'bigint') return value;
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
      throw new TypeError(`Parameter ${i} is a BigInt too large to store in D1 without losing precision.`);
    }
    return Number(value);
  });
}

/** `{changes, lastInsertRowid}` from a D1 meta block, with the field renames D1 uses. */
function writeResult(result) {
  const meta = result?.meta ?? {};
  return {
    changes: Number(meta.changes ?? 0),
    // D1 calls it last_row_id; node:sqlite calls it lastInsertRowid. Call sites use the
    // latter, so the rename happens here rather than in every repository.
    lastInsertRowid: Number(meta.last_row_id ?? 0),
  };
}

/**
 * Wrap a D1 binding in the same interface `openDatabase` returns.
 *
 * @param {D1Database} binding the `env.DB` binding declared in wrangler.toml
 * @param {{name?: string}} opts `name` only appears in `.path`, for log lines
 * @returns {object} the same shape server/db/* already expects
 */
export function openD1(binding, { name = 'DB' } = {}) {
  if (!binding || typeof binding.prepare !== 'function') {
    throw new TypeError(
      'openD1 requires a D1Database binding. Check that wrangler.toml declares '
      + '[[d1_databases]] with binding = "DB" and that the id is filled in.',
    );
  }

  /** Prepare + bind. `.bind()` is skipped entirely for a no-parameter statement, because D1
   *  treats `bind()` with zero arguments as an arity mismatch on some versions. */
  const stmt = (sql, params) => {
    assertStatement(sql);
    const prepared = binding.prepare(sql);
    return params.length === 0 ? prepared : prepared.bind(...d1Bindables(params));
  };

  return {
    path: `d1:${name}`,
    /** The underlying binding. Only tests and one-off scripts should reach for this. */
    raw: binding,

    /** @returns {Promise<object[]>} all matching rows as plain objects */
    async all(sql, params = []) {
      const result = assertOk(await stmt(sql, params).all(), sql);
      return result?.results ?? [];
    },

    /**
     * @returns {Promise<object|undefined>} the first row, or undefined
     *
     * D1's `.first()` resolves to `null` for no row; node:sqlite gives `undefined`. Normalized
     * to `undefined` so a call site testing `=== undefined` behaves the same on both.
     */
    async get(sql, params = []) {
      const row = await stmt(sql, params).first();
      return row === null ? undefined : row;
    },

    /** @returns {Promise<{changes:number,lastInsertRowid:number}>} */
    async run(sql, params = []) {
      return writeResult(assertOk(await stmt(sql, params).run(), sql));
    },

    /**
     * Run every statement in one transaction, all-or-nothing.
     *
     * `D1.batch()` is implicitly a transaction, which is why this codebase never grew a
     * `withTransaction(callback)` anywhere: there would be nothing to map it onto.
     *
     * @param {Array<[string, unknown[]]>} statements
     * @returns {Promise<Array<{changes:number,lastInsertRowid:number}>>}
     */
    async batch(statements) {
      if (!Array.isArray(statements)) throw new TypeError('batch() expects an array of [sql, params].');
      if (statements.length === 0) return [];

      const prepared = statements.map(([sql, params = []]) => stmt(sql, params));
      const results = await binding.batch(prepared);
      return results.map((result, i) => writeResult(assertOk(result, statements[i][0])));
    },

    /**
     * Multi-statement DDL. Migrations only.
     *
     * Unused at runtime: migrations are applied out of band with
     * `wrangler d1 migrations apply`, which is why server/db/migrate.js (and its node:fs
     * reads of server/migrations/) is never imported by the Worker.
     */
    async exec(sql) {
      await binding.exec(sql);
    },

    /** A no-op. The runtime owns the binding's lifetime; see the file header. */
    async close() {},
  };
}
