/**
 * Session rows. The raw session token never appears here: callers hash it first
 * (`security/hash.js#sha256b64u`) and pass only the digest, so a leaked database file
 * yields no usable credential.
 *
 * Every function is async because `server/db/db.js` is async -- see the note there.
 */

/** A user-agent header is attacker-controlled and unbounded; one row is written per login. */
const MAX_USER_AGENT = 256;

/**
 * Insert a new session.
 *
 * `lastSeenAt` and `userAgent` are defaulted explicitly rather than left to the column
 * DEFAULT, because the adapter maps `undefined` to NULL (not to "absent"), and both
 * columns are NOT NULL -- so an omitted field would fail the insert instead of taking the
 * default.
 */
export async function insertSession(db, { sessionIdHash, athleteId, createdAt, expiresAt, lastSeenAt, userAgent }) {
  const created = createdAt;
  await db.run(
    `INSERT INTO sessions (session_id_hash, athlete_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?,?,?,?,?,?)`,
    [
      sessionIdHash,
      athleteId,
      created,
      expiresAt,
      lastSeenAt ?? created,
      String(userAgent ?? '').slice(0, MAX_USER_AGENT),
    ],
  );
  return { sessionIdHash, athleteId, created_at: created, expires_at: expiresAt };
}

/**
 * Look a session up by the SHA-256 of its raw token.
 *
 * `last_seen_at` is in the SELECT list ON PURPOSE and must stay there. The caller decides
 * whether to refresh the column with `now - row.last_seen_at > 300`; if the column is
 * missing from the projection that expression is `NaN > 300`, which is `false`, so the
 * column is never updated and activity tracking silently freezes forever with no error.
 *
 * Expiry is deliberately NOT filtered here -- this function takes no clock, and inventing
 * one would let a stale `now` resurrect an expired session. The caller compares
 * `expires_at` (which is why it is selected) against its own single source of time.
 */
export async function findSessionByHash(db, sessionIdHash) {
  return db.get(
    `SELECT session_id_hash, athlete_id, created_at, expires_at, last_seen_at, user_agent
       FROM sessions
      WHERE session_id_hash = ?`,
    [sessionIdHash],
  );
}

/** Bump `last_seen_at`. Returns true if a row was actually touched. */
export async function touchSession(db, sessionIdHash, nowEpoch) {
  const res = await db.run(`UPDATE sessions SET last_seen_at = ? WHERE session_id_hash = ?`, [
    nowEpoch,
    sessionIdHash,
  ]);
  return res.changes > 0;
}

/** Delete one session (logout). Idempotent: false simply means it was already gone. */
export async function deleteSession(db, sessionIdHash) {
  const res = await db.run(`DELETE FROM sessions WHERE session_id_hash = ?`, [sessionIdHash]);
  return res.changes > 0;
}

/**
 * Drop every session for an athlete.
 *
 * Called on any privilege change (admin grant/revoke, admin team reassignment) so an
 * already-issued session cannot keep acting with its old privileges.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function deleteSessionsForAthlete(db, athleteId) {
  const res = await db.run(`DELETE FROM sessions WHERE athlete_id = ?`, [athleteId]);
  return res.changes;
}

/**
 * Startup / periodic sweep of expired sessions.
 *
 * This is housekeeping only, never the security boundary: expiry is enforced on every
 * lookup by comparing `expires_at`. If this were the enforcement point, a process that
 * never restarted would honour expired sessions indefinitely.
 *
 * @returns {Promise<number>} rows deleted
 */
export async function purgeExpiredSessions(db, nowEpoch) {
  const res = await db.run(`DELETE FROM sessions WHERE expires_at <= ?`, [nowEpoch]);
  return res.changes;
}

/** Convenience for scripts/tests that want a human-readable audit of a session row. */
export async function listSessionsForAthlete(db, athleteId) {
  return db.all(
    `SELECT session_id_hash, athlete_id, created_at, expires_at, last_seen_at, user_agent
       FROM sessions WHERE athlete_id = ? ORDER BY created_at DESC`,
    [athleteId],
  );
}
