/**
 * Parameter binding rules shared by EVERY database adapter, and nothing else.
 *
 * This file exists so `server/db/d1.js` can enforce the same rules as `server/db/db.js`
 * without importing it. That matters more than it sounds: `db.js` imports `node:sqlite`,
 * which does not exist on Cloudflare Workers at all, so anything that reaches it -- even for
 * a pure helper like `placeholders()` -- makes the whole route tree unloadable in a Worker.
 * `activities.js` and `leaderboard.js` import `placeholders` from here for exactly that
 * reason.
 *
 * Nothing in this file may import a Node builtin. That is the entire constraint.
 */

/**
 * Coerce a JS value into something SQLite will accept, or throw loudly.
 *
 * This is the single most important guard in the database layer. Verified on Node v26.3.0:
 * binding a JS boolean or `undefined` throws "Provided value cannot be bound to SQLite
 * parameter N". D1 rejects both the same way. Strava's JSON is full of booleans (`trainer`,
 * `manual`, `private`) and missing fields, so without this every activity insert fails -- and
 * pure mapper unit tests never catch it, because the failure only happens at bind time.
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

export function bindables(params) {
  return params.map((p, i) => toBindable(p, i));
}

/**
 * Reject SQL shapes that fail SILENTLY rather than loudly.
 *
 * Both checks are about drivers quietly doing the wrong thing instead of erroring:
 * a stray second statement never runs on some drivers, and node:sqlite treats an ARRAY of
 * params as NAMED parameters (verified: passing `[1]` throws `Unknown named parameter '0'`),
 * so a named placeholder silently fails to bind.
 */
export function assertStatement(sql) {
  if (sql.replace(/;\s*$/, '').includes(';')) {
    throw new Error(`db: one statement per call. Use batch() for multiple:\n${sql}`);
  }
  if (/[:@$][A-Za-z_]/.test(sql)) {
    throw new Error(`db: positional ? placeholders only, found a named parameter:\n${sql}`);
  }
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
