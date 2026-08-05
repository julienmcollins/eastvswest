import { OAUTH_STATE_MAX_ROWS } from '../contracts.js';

/**
 * Pending OAuth `state` rows.
 *
 * `GET /api/auth/strava/login` must be a top-level navigation, so it is an unauthenticated
 * GET that writes a row. Three things bound that: a short TTL, a purge on every write, and
 * a hard row cap (`enforceStateCap`). Without them this table is a free unauthenticated
 * growth vector.
 *
 * `nonce_hash` is what binds a state to the browser that started the flow. Signing plus
 * single-use is NOT enough on its own: an attacker can complete Strava consent themselves
 * and mail the victim the resulting genuine `code`+`state`, and the victim's browser would
 * get a session bound to the attacker's athlete id.
 */

/**
 * Insert a pending state, purging already-expired rows in the same transaction.
 *
 * The purge rides along here rather than living on a timer because this is the only place
 * rows are created: pairing them guarantees the table is swept on exactly the traffic that
 * grows it, including on serverless where no long-lived timer exists.
 */
export async function insertState(db, { stateHash, nonceHash, expiresAt, returnTo, nowEpoch }) {
  await db.batch([
    [`DELETE FROM oauth_states WHERE expires_at <= ?`, [nowEpoch]],
    [
      `INSERT INTO oauth_states (state_hash, nonce_hash, created_at, expires_at, return_to)
       VALUES (?,?,?,?,?)`,
      // return_to is NOT NULL DEFAULT '/', and the adapter binds `undefined` as NULL rather
      // than as "absent", so the default is defaulted here instead.
      [stateHash, nonceHash, nowEpoch, expiresAt, returnTo ?? '/'],
    ],
  ]);
  return { stateHash, expiresAt };
}

/**
 * Atomically consume a state: one statement that both reads and destroys the row.
 *
 * `DELETE ... RETURNING` is what makes replay impossible. A `SELECT` followed by a
 * `DELETE` leaves a window in which two concurrent callbacks both read the same row and
 * both mint a session, which is precisely the replay the single-use rule exists to stop.
 *
 * `expires_at` is returned rather than filtered on, so the caller can tell "expired" from
 * "never existed / already used" and redirect with an accurate fragment code.
 *
 * @returns {Promise<{nonce_hash:string,return_to:string,expires_at:number}|undefined>}
 */
export async function consumeState(db, stateHash) {
  return db.get(
    `DELETE FROM oauth_states WHERE state_hash = ? RETURNING nonce_hash, return_to, expires_at`,
    [stateHash],
  );
}

/** @returns {Promise<number>} rows deleted */
export async function purgeExpiredStates(db, nowEpoch) {
  const res = await db.run(`DELETE FROM oauth_states WHERE expires_at <= ?`, [nowEpoch]);
  return res.changes;
}

/**
 * Keep only the newest `maxRows` pending states, deleting the oldest beyond the cap.
 *
 * The TTL alone does not bound the table: an attacker can hammer /login thousands of times
 * per second and every row is legitimately unexpired for the next 600 seconds. The cap is
 * the actual ceiling. Newest-wins because a flood should never be able to evict the state
 * a real rider created a moment ago... which it still can, at volume -- but the cap is
 * chosen high enough (5000) that real concurrency never approaches it.
 *
 * `LIMIT -1 OFFSET ?` is SQLite's "everything after the first N rows".
 *
 * @returns {Promise<number>} rows deleted
 */
export async function enforceStateCap(db, maxRows = OAUTH_STATE_MAX_ROWS) {
  if (!Number.isInteger(maxRows) || maxRows < 1) {
    throw new RangeError(`enforceStateCap: maxRows must be a positive integer, got ${maxRows}`);
  }
  const res = await db.run(
    `DELETE FROM oauth_states WHERE state_hash IN (
       SELECT state_hash FROM oauth_states
        ORDER BY created_at DESC, state_hash ASC
        LIMIT -1 OFFSET ?
     )`,
    [maxRows],
  );
  return res.changes;
}

/** Row count, for tests and the admin health view. */
export async function countStates(db) {
  const row = await db.get(`SELECT COUNT(*) AS n FROM oauth_states`);
  return Number(row.n);
}
