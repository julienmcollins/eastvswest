import { TEAMS } from '../contracts.js';
import { isoUtcNow } from '../lib/dates.js';

/**
 * The athletes table: identity, team, admin flag, and grant state.
 *
 * Identity is always Strava's own `athlete.id`. Matching on it (never on a name or an
 * email) is what makes a re-login reattach the rider's team and history instead of
 * creating a second row and re-showing the one-time team picker.
 */

/**
 * Normalize a Strava avatar to an absolute https: URL or NULL.
 *
 * Strava returns the bare relative string `avatar/athlete/large.png` for photo-less
 * athletes. Stored as-is it renders as a broken image against our own origin, and
 * `new URL('avatar/athlete/large.png')` throws in the client's `safeAvatar`, which -- inside
 * `riders.map(...)` -- blanks the entire roster over one rider with no profile photo.
 * NULL is the value the client knows how to fall back from.
 */
export function normalizeAvatarUrl(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return v.startsWith('https://') ? v : null;
}

/**
 * "Julien C." from firstname + last initial.
 *
 * Spread into an array before taking [0]: `lastname[0]` on a name starting with an astral
 * character (emoji, some CJK extensions) slices a surrogate pair in half and produces a
 * lone-surrogate string, which JSON.stringify happily emits as an unpaired \ud800.
 */
export function displayNameFrom({ firstname = '', lastname = '', username = null, id = null } = {}) {
  const first = String(firstname ?? '').trim();
  const last = String(lastname ?? '').trim();
  if (first && last) return `${first} ${[...last][0]}.`;
  if (first) return first;
  if (last) return last;
  const user = username === null || username === undefined ? '' : String(username).trim();
  if (user) return user;
  return id === null || id === undefined ? 'Athlete' : `Athlete ${id}`;
}

function assertTeam(team) {
  if (!TEAMS.includes(team)) {
    throw new TypeError(`Invalid team "${team}". Expected one of ${TEAMS.join(', ')}.`);
  }
}

/**
 * Insert or refresh an athlete from a Strava `/athlete` (or callback) payload.
 *
 * Three columns are conspicuously absent from the UPDATE set, each for a reason:
 *
 *  - `team` / `team_locked_at`: overwriting these on a re-login would reset the one-time
 *    pick and reopen the mandatory picker for an established rider.
 *  - `strava_revoked_at` / `disconnected_at`: cleared explicitly by the caller
 *    (`clearRevoked`) on a successful reconnect. This function is also called from the sync
 *    path, and having it silently clear the reconnect badge would hide grant state changes.
 *  - `is_admin`: bootstrap admin grants are grant-only and applied by the route.
 *
 * `granted_scope` is only overwritten when the caller actually has a fresh grant. Sync's
 * athlete refresh does not know the scope, and writing '' there would wipe `activity:read_all`
 * and permanently badge the rider as "private rides not counted".
 */
export async function upsertAthleteFromStrava(db, raw, { grantedScope = null, displayName = null, nowIso = isoUtcNow() } = {}) {
  const id = Number(raw?.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError(`upsertAthleteFromStrava: bad athlete id ${JSON.stringify(raw?.id)}`);
  }

  const firstname = String(raw?.firstname ?? '');
  const lastname = String(raw?.lastname ?? '');
  const username = raw?.username === null || raw?.username === undefined ? null : String(raw.username);
  const avatar = normalizeAvatarUrl(raw?.profile ?? raw?.profile_medium ?? null);
  const name = displayName ?? displayNameFrom({ firstname, lastname, username, id });

  await db.run(
    `INSERT INTO athletes (strava_athlete_id, username, firstname, lastname, display_name,
       avatar_url, granted_scope, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(strava_athlete_id) DO UPDATE SET
       username     = excluded.username,
       firstname    = excluded.firstname,
       lastname     = excluded.lastname,
       display_name = excluded.display_name,
       avatar_url   = excluded.avatar_url,
       granted_scope = COALESCE(NULLIF(excluded.granted_scope, ''), athletes.granted_scope),
       updated_at   = excluded.updated_at`,
    [id, username, firstname, lastname, name, avatar, grantedScope ?? '', nowIso, nowIso],
  );

  return getAthlete(db, id);
}

/** @returns {Promise<object|undefined>} */
export async function getAthlete(db, athleteId) {
  return db.get(
    `SELECT strava_athlete_id, username, firstname, lastname, display_name, avatar_url, team,
            is_admin, granted_scope, team_locked_at, strava_revoked_at, disconnected_at,
            created_at, updated_at
       FROM athletes
      WHERE strava_athlete_id = ?`,
    [athleteId],
  );
}

/**
 * The one-time team claim.
 *
 * A single conditional UPDATE with RETURNING, never a read followed by a write. Two
 * concurrent POSTs (an impatient double-click is enough) would both pass a "team IS NULL?"
 * read and both write, and the second write would win silently -- so the rider would see a
 * 200 for EAST and end up on WEST.
 *
 * @returns {Promise<'EAST'|'WEST'|undefined>} the claimed team, or undefined if it was
 *   already set (=> the route answers 409) or the athlete does not exist.
 */
export async function claimTeam(db, athleteId, team, nowIso = isoUtcNow()) {
  assertTeam(team);
  const row = await db.get(
    `UPDATE athletes SET team = ?, team_locked_at = ?, updated_at = ?
      WHERE strava_athlete_id = ? AND team IS NULL
     RETURNING team`,
    [team, nowIso, nowIso, athleteId],
  );
  return row?.team;
}

/**
 * Admin override of a team, bypassing the one-time rule.
 *
 * The caller must also `deleteSessionsForAthlete` -- a moved rider's live session otherwise
 * keeps reporting the old team from cached state.
 *
 * @returns {Promise<boolean>} false => no such athlete (=> 404)
 */
export async function adminSetTeam(db, athleteId, team, nowIso = isoUtcNow()) {
  assertTeam(team);
  const res = await db.run(
    `UPDATE athletes SET team = ?, team_locked_at = ?, updated_at = ? WHERE strava_athlete_id = ?`,
    [team, nowIso, nowIso, athleteId],
  );
  return res.changes > 0;
}

/** @returns {Promise<boolean>} false => no such athlete (=> 404) */
export async function setAdmin(db, athleteId, isAdmin, nowIso = isoUtcNow()) {
  const res = await db.run(
    `UPDATE athletes SET is_admin = ?, updated_at = ? WHERE strava_athlete_id = ?`,
    // Explicit 0/1 rather than relying on the adapter's boolean coercion, because the column
    // has a CHECK (is_admin IN (0,1)) that a stray string would trip at runtime.
    [isAdmin ? 1 : 0, nowIso, athleteId],
  );
  return res.changes > 0;
}

/**
 * Every athlete, with the two joined facts the admin view needs.
 *
 * `pending_manual` is a correlated subquery rather than another LEFT JOIN: joining
 * `activities` here would multiply the athlete rows and make any future aggregate on this
 * query silently wrong.
 */
export async function listAthletes(db) {
  return db.all(
    `SELECT ath.strava_athlete_id AS athlete_id,
            ath.display_name, ath.team, ath.is_admin, ath.granted_scope,
            ath.strava_revoked_at, ath.disconnected_at, ath.created_at,
            ss.last_sync_finished,
            (SELECT COUNT(*) FROM activities ac
              WHERE ac.athlete_id = ath.strava_athlete_id
                AND ac.deleted_at IS NULL
                AND ac.is_manual = 1
                AND ac.manual_approved = 0) AS pending_manual
       FROM athletes ath
       LEFT JOIN sync_state ss ON ss.athlete_id = ath.strava_athlete_id
      ORDER BY ath.display_name ASC, ath.strava_athlete_id ASC`,
  );
}

/**
 * Flag the grant as revoked at Strava.
 *
 * Only this column changes: the athlete row, their team, and every activity survive, so the
 * rider stays on the leaderboard with a frozen total and a reconnect badge rather than
 * vanishing mid-competition and taking their team's miles with them.
 */
export async function markRevoked(db, athleteId, nowEpoch, nowIso = isoUtcNow()) {
  const res = await db.run(
    `UPDATE athletes SET strava_revoked_at = ?, updated_at = ? WHERE strava_athlete_id = ?`,
    [nowEpoch, nowIso, athleteId],
  );
  return res.changes > 0;
}

/** Clear the revoked/disconnected badges after a successful reconnect. */
export async function clearRevoked(db, athleteId, nowIso = isoUtcNow()) {
  const res = await db.run(
    `UPDATE athletes SET strava_revoked_at = NULL, disconnected_at = NULL, updated_at = ?
      WHERE strava_athlete_id = ?`,
    [nowIso, athleteId],
  );
  return res.changes > 0;
}

/** Record a voluntary disconnect. Tokens are deleted separately; the row itself stays. */
export async function markDisconnected(db, athleteId, nowEpoch, nowIso = isoUtcNow()) {
  const res = await db.run(
    `UPDATE athletes SET disconnected_at = ?, updated_at = ? WHERE strava_athlete_id = ?`,
    [nowEpoch, nowIso, athleteId],
  );
  return res.changes > 0;
}

/**
 * Delete the athlete outright (DELETE /api/me).
 *
 * Tokens, sessions, sync state, and activities all go with it via ON DELETE CASCADE, which
 * only works because `PRAGMA foreign_keys` is asserted ON in openDatabase().
 */
export async function deleteAthlete(db, athleteId) {
  const res = await db.run(`DELETE FROM athletes WHERE strava_athlete_id = ?`, [athleteId]);
  return res.changes > 0;
}
