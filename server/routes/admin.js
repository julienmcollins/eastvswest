import { API_SCHEMA, ERROR_CODES, TEAMS } from '../contracts.js';
import { HttpError, sendJson } from '../http/respond.js';
import { readJsonBody } from '../http/body.js';
import { revokeAllForAthlete } from '../security/sessionStore.js';
import { adminSetTeam, listAthletes, setAdmin } from '../db/athletes.js';
import { getActivity, setManualApproved } from '../db/activities.js';
import { isoFromEpoch } from '../lib/dates.js';

/**
 * Admin endpoints.
 *
 * NOTHING in this file calls requireAdmin. The guard is applied once, at the router level, to
 * the whole `/api/admin` prefix (see routes/index.js) -- which is the only version of that
 * check that cannot be forgotten when the next endpoint is added here. If you are reading
 * this file to work out whether a route is protected, the answer is "yes, by construction".
 *
 * These are also the only handlers in the tree permitted to read an athlete id from the
 * request. Everywhere else, identity is `ctx.session.athleteId`.
 */

/** Path parameters are strings from the URL; every one of them is validated here. */
function pathId(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `${what} must be a positive integer.`);
  }
  return n;
}

export function registerAdminRoutes(router, { db }) {
  router.add('GET', '/api/admin/athletes', async (req, res) => {
    const rows = await listAthletes(db);
    sendJson(res, 200, {
      schema: API_SCHEMA,
      athletes: rows.map((row) => ({
        athlete_id: Number(row.athlete_id),
        display_name: row.display_name,
        team: row.team ?? null,
        is_admin: Number(row.is_admin) === 1,
        // The raw csv, not the 'read_all'/'read' summary: an admin diagnosing "why are this
        // rider's private rides missing" needs to see exactly what Strava returned.
        granted_scope: row.granted_scope ?? '',
        revoked: row.strava_revoked_at !== null && row.strava_revoked_at !== undefined,
        disconnected: row.disconnected_at !== null && row.disconnected_at !== undefined,
        last_synced_at: isoFromEpoch(row.last_sync_finished ?? null),
        /** Manual rides awaiting approval -- the anti-cheat queue this page exists for. */
        pending_manual: Number(row.pending_manual ?? 0),
      })),
    });
  });

  /**
   * Move a rider between teams, bypassing the one-time rule.
   *
   * The session drop is not optional: the moved rider's live session would otherwise keep
   * reporting the old team from whatever the client cached at login, and they would see
   * themselves in one column while their miles score in the other.
   */
  router.add('POST', '/api/admin/athletes/:athleteId/team', async (req, res, ctx) => {
    const athleteId = pathId(ctx.params.athleteId, 'athleteId');
    const body = await readJsonBody(req);

    if (!TEAMS.includes(body.team)) {
      throw new HttpError(400, ERROR_CODES.INVALID_TEAM, `Team must be one of ${TEAMS.join(', ')}.`, {
        allowed: [...TEAMS],
      });
    }

    if (!(await adminSetTeam(db, athleteId, body.team))) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'No such rider.');
    }
    await revokeAllForAthlete(db, athleteId);

    sendJson(res, 200, { ok: true, athlete_id: athleteId, team: body.team });
  });

  /**
   * Grant or revoke admin.
   *
   * Sessions are dropped on BOTH directions, not just on revocation. requireAdmin already
   * re-reads the row on every request so a stale session cannot retain the flag, but dropping
   * on grant too means the newly promoted admin's client re-fetches /api/me and actually
   * renders the admin UI instead of waiting for a reload nobody told them to do.
   */
  router.add('POST', '/api/admin/athletes/:athleteId/admin', async (req, res, ctx) => {
    const athleteId = pathId(ctx.params.athleteId, 'athleteId');
    const body = await readJsonBody(req);

    if (typeof body.is_admin !== 'boolean') {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'is_admin must be true or false.');
    }

    if (!(await setAdmin(db, athleteId, body.is_admin))) {
      throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'No such rider.');
    }
    await revokeAllForAthlete(db, athleteId);

    sendJson(res, 200, { ok: true, athlete_id: athleteId, is_admin: body.is_admin });
  });

  /**
   * Approve (or un-approve) a manual ride.
   *
   * Manual rides are excluded by default because a manual distance is free text with no
   * device and no upper bound -- counting them automatically means the first person to notice
   * wins. This flag is the only way one ever scores.
   */
  router.add('POST', '/api/admin/activities/:activityId/approve', async (req, res, ctx) => {
    const activityId = pathId(ctx.params.activityId, 'activityId');
    const body = await readJsonBody(req);

    if (typeof body.approved !== 'boolean') {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'approved must be true or false.');
    }

    // Looked up first so a 404 is a 404: setManualApproved's `changes === 0` would also be
    // reported for an activity that already had the requested value in some SQLite builds.
    const activity = await getActivity(db, activityId);
    if (!activity) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'No such activity.');

    await setManualApproved(db, activityId, body.approved);

    sendJson(res, 200, {
      ok: true,
      activity_id: activityId,
      approved: body.approved,
      /** Echoed so the admin UI can warn when someone approves a non-manual ride by mistake. */
      is_manual: Number(activity.is_manual) === 1,
    });
  });
}
