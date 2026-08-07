import { API_SCHEMA, ERROR_CODES, SYNC_MODES, TEAMS } from '../contracts.js';
import { HttpError, sendJson } from '../http/respond.js';
import { readJsonBody } from '../http/body.js';
import { revokeAllForAthlete } from '../security/sessionStore.js';
import { adminSetTeam, getAthlete, listAthletes, setAdmin } from '../db/athletes.js';
import { activityMonthlyTotals, getActivity, selectableMonthBounds, setManualApproved } from '../db/activities.js';
import { syncAthlete } from '../strava/sync.js';
import { isoFromEpoch } from '../lib/dates.js';
import { requireMonthParam } from './leaderboard.js';
import { toHttpError } from './me.js';

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

export function registerAdminRoutes(router, { config, db, strava, now }) {
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

  /**
   * Force a full re-sync of ONE rider, back to a named month. The backfill, server-side.
   *
   * WHY THIS ROUTE HAS TO EXIST. `scripts/backfill.mjs` opens `config.databasePath` with
   * node:sqlite, and production runs on Cloudflare D1 (server/worker.js is the only caller of
   * `openD1`). So the script could never touch the deployed data at all: it migrated an empty
   * local file, found no athletes, printed "nothing to back-fill", and exited 0. Meanwhile the
   * only thing that ever wrote to D1 was a rider pressing Refresh, which auto-mode serves with a
   * cheap incremental for 24 hours after each full sync. A month that had been missed therefore
   * stayed missed no matter how many times the backfill was run.
   *
   * `since_month` is the whole point, and it is admin-only for a reason spelled out in
   * `computeSyncWindow`: the fetch window is also the reconcile window, so naming it is the power
   * to soft-delete. `POST /api/me/sync` deliberately does not forward the rider's month.
   *
   *   { }                                -> mode 'full', since_month = COMPETITION_START's month
   *   { "since_month": "2026-01" }       -> that month, whatever config says
   *   { "since_month": null }            -> no override; the ordinary three-source union floor
   *
   * DEFAULTED SERVER-SIDE, never by the caller. The floor a backfill should reach is a fact about
   * the deployed config, and a script that computed it from its own `.env` would compute it from
   * the wrong config -- which is the class of bug that produced the September floor in the first
   * place.
   *
   * ONE RIDER PER REQUEST. The roster loop lives in the script, not here: a Worker invocation has
   * a CPU and subrequest budget, and the per-instance rate-limit state in strava/client.js is
   * what makes a sequential roster safe (see the single-client note in scripts/backfill.mjs).
   * Fanning out server-side would spend the whole 15-minute quota in one request.
   */
  router.add('POST', '/api/admin/athletes/:athleteId/sync', async (req, res, ctx) => {
    const athleteId = pathId(ctx.params.athleteId, 'athleteId');
    const nowMs = ctx.nowMs ?? now();
    const body = await readJsonBody(req);

    // Defaults to 'full', not to auto. Auto would pick 'incremental' for exactly the riders this
    // route exists for -- anyone whose `last_full_sync_at` is under a day old -- and fetch only
    // from their watermark, which sits in the current month.
    let mode = 'full';
    if (body.mode !== undefined && body.mode !== null) {
      if (!SYNC_MODES.includes(body.mode)) {
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `mode must be one of ${SYNC_MODES.join(', ')}.`);
      }
      mode = body.mode;
    }

    // `requireMonthParam` is the same strict validator the read routes use, so `2026-13` is a 400
    // here exactly as it is on `?month=`. It maps absent AND '' to null, hence the explicit
    // `undefined` test: absent means "use the configured start", a literal null means "no
    // override at all", and the two have to stay distinguishable.
    const sinceMonth = body.since_month === undefined
      ? config.competitionFirstMonth
      : requireMonthParam(body.since_month);

    // Looked up before the sync so a bad id is a clean 404 rather than whatever `syncAthlete`
    // raises after it has already taken the lock.
    const athlete = await getAthlete(db, athleteId);
    if (!athlete) throw new HttpError(404, ERROR_CODES.NOT_FOUND, `No athlete ${athleteId}.`);

    let result;
    try {
      // `force: true` skips the 60-second cooldown ONLY. The advisory lock still applies, so a
      // rider pressing Refresh at this moment gets a clean 409 rather than a double sync.
      result = await syncAthlete(db, config, strava, athleteId, { mode, force: true, nowMs, sinceMonth });
    } catch (err) {
      throw toHttpError(err, config);
    }

    sendJson(res, 200, {
      ok: true,
      schema: API_SCHEMA,
      athlete_id: athleteId,
      display_name: athlete.display_name,
      mode: result.mode,
      /** What was ASKED for. Defaulted here, so the caller cannot otherwise know what it got. */
      since_month: sinceMonth,
      /**
       * What was actually FETCHED from, after every clamp. Differs from `since_month` when the
       * request named a month later than the current one -- which the default does whenever
       * COMPETITION_START is in the future -- or one older than SYNC_MAX_MONTHS. Reporting only
       * the request would let this endpoint claim a month it never asked Strava about.
       */
      fetched_from_month: result.firstMonth,
      synced_at: result.syncedAt,
      activities_scanned: result.activitiesScanned,
      activities_added: result.activitiesAdded,
      activities_removed: result.activitiesRemoved,
      pages_fetched: result.pagesFetched,
      /** True means the window exceeded STRAVA_MAX_PAGES: nothing was reconciled, and a bare
       *  re-run would compute the identical window. Narrow `since_month` and go in chunks. */
      truncated: result.truncated,
      /**
       * THE EVIDENCE, and the reason this route returns more than `{ok:true}`.
       *
       * `activities_added` is one number for a window spanning many months, so it cannot
       * distinguish "recovered all eight months" from "recovered January and August and silently
       * missed the six in between" -- the failure actually being debugged here. A month-by-month
       * count can, and it is scoped to this rider so a per-rider gap is visible too.
       */
      months: await activityMonthlyTotals(db, config, { athleteId }),
    });
  });

  /**
   * Per-month counted rides across every rider, plus the bounds that decide what is reachable.
   *
   * Spends no Strava quota, which is the point: it answers "is each month right?" before and
   * after a backfill without touching the API, so a run can be judged on the difference rather
   * than on whether it reported `ok`.
   *
   * `competition_first_month` next to `first_month` is the diagnostic that matters most. The
   * fetch floor cannot reach earlier than the configured start unless a month already holds
   * rides, so a `competition_first_month` of `2026-09` on a board that should go back to January
   * says the problem is COMPETITION_START (and possibly an undeployed wrangler.toml), not the
   * sync.
   */
  router.add('GET', '/api/admin/months', async (req, res, ctx) => {
    const nowMs = ctx.nowMs ?? now();
    const bounds = await selectableMonthBounds(db, config, nowMs);

    sendJson(res, 200, {
      schema: API_SCHEMA,
      today: bounds.today,
      current_month: bounds.currentMonth,
      /** What the picker offers: the union of stored data, the clock and the configured season. */
      first_month: bounds.firstMonth,
      last_month: bounds.lastMonth,
      /** What config alone says, i.e. the floor a default backfill will use. */
      competition_first_month: config.competitionFirstMonth,
      competition_last_month: config.competitionLastMonth,
      /** Meters, not miles: db/leaderboard.js is the only place in the app that converts. */
      months: await activityMonthlyTotals(db, config),
    });
  });
}
