import { API_SCHEMA, ERROR_CODES, SCOPE_READ_ALL, TEAMS } from '../contracts.js';
import { HttpError, sendJson } from '../http/respond.js';
import { readJsonBody } from '../http/body.js';
import { requireNotRevoked, requireSession } from '../security/guards.js';
import { revokeAllForAthlete } from '../security/sessionStore.js';
import { claimTeam, getAthlete, markDisconnected, deleteAthlete, normalizeAvatarUrl } from '../db/athletes.js';
import { deleteTokens } from '../db/tokens.js';
import { purgeAthleteActivities, selectableMonthBounds } from '../db/activities.js';
import { getSyncState } from '../db/syncState.js';
import { buildLeaderboard } from '../db/leaderboard.js';
import { getValidAccessToken } from '../strava/tokenService.js';
import { syncAthlete } from '../strava/sync.js';
import {
  StravaError,
  StravaGrantRevokedError,
  StravaRateLimitError,
  StravaScopeError,
} from '../strava/client.js';
import { monthStatus, epochSeconds, isoFromEpoch, isoUtcNow } from '../lib/dates.js';
import { clearAuthCookies } from './auth.js';
import { requireMonthParam } from './leaderboard.js';

/**
 * Everything scoped to "the rider making this request".
 *
 * The identity used by every handler here is `ctx.session.athleteId` and nothing else. No
 * body field, no query parameter, and no path segment is ever read as an athlete id outside
 * the requireAdmin-gated /api/admin routes -- that is what makes "act as another rider"
 * structurally impossible rather than merely unimplemented.
 */

const STRAVA_ATHLETE_BASE = 'https://www.strava.com/athletes/';

const SYNC_MODES = new Set(['incremental', 'full']);

/**
 * The `rider` block of /api/me. Shape frozen by test/fixtures/me.sample.json.
 *
 * `scope` deserves its comment: 'read' means the rider unchecked "private activities" on
 * Strava's consent screen. They are FULLY functional -- their public rides count and they get
 * a badge, not a lockout. Treating that as an error would turn a privacy preference into a
 * permanent exclusion from the competition.
 */
async function riderView(db, athlete) {
  const athleteId = Number(athlete.strava_athlete_id);
  const sync = await getSyncState(db, athleteId);

  const scopes = String(athlete.granted_scope ?? '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const readAll = scopes.includes(SCOPE_READ_ALL);

  return {
    athlete_id: athleteId,
    display_name: athlete.display_name,
    // Re-normalized on read as well as write: one legacy row holding Strava's relative
    // `avatar/athlete/large.png` throws inside the client's `new URL()` and, from inside
    // `riders.map()`, blanks the entire roster over one photo-less rider.
    avatar_url: normalizeAvatarUrl(athlete.avatar_url),
    profile_url: `${STRAVA_ATHLETE_BASE}${athleteId}`,
    team: athlete.team ?? null,
    /**
     * The ONE authoritative trigger for the mandatory team picker. public/ must not infer it
     * from a URL fragment or re-derive it from `team === null` anywhere else, or the two
     * checks drift and a rider ends up on the board with no column.
     */
    needs_team: athlete.team === null || athlete.team === undefined,
    // Read from the row, never cached in the session: an admin flag copied at login stays
    // true for the life of that session after the flag is revoked.
    is_admin: Number(athlete.is_admin) === 1,
    // 'read_all' | 'read' -- the wire values the frozen fixture pins, not the raw csv. The
    // raw csv stays in `granted_scope` for forensics.
    scope: readAll ? 'read_all' : 'read',
    private_rides_counted: readAll,
    revoked: athlete.strava_revoked_at !== null && athlete.strava_revoked_at !== undefined,
    last_synced_at: isoFromEpoch(sync?.last_sync_finished ?? null),
  };
}

export function registerMeRoutes(router, { config, db, strava, now }) {
  /**
   * 200 WHEN LOGGED OUT, with `rider: null`. Never 401.
   *
   * A 401 here makes the ordinary anonymous visit look like an error to every caller: the
   * client's boot path would branch into its error handler on the happy path, and `Promise
   * .allSettled` consumers would treat a first-time visitor as a broken server.
   */
  router.add('GET', '/api/me', async (req, res, ctx) => {
    const nowMs = ctx.nowMs ?? now();
    const athlete = ctx.athlete ?? null;
    // Accepted so a deep-linked month renders one consistent masthead: the client sends the
    // same `?month=` to both boot endpoints, and without it this block would describe a
    // different month than the board rendered beside it.
    const month = requireMonthParam(ctx.query.get('month'));

    sendJson(res, 200, {
      authenticated: athlete !== null,
      rider: athlete === null ? null : await riderView(db, athlete),
      // One MONTH's race -- `state` and `days_remaining` belong to the selected month, and
      // absent `?month=` means the current month in COMPETITION_TZ. The bounds are loaded from
      // the database rather than left to default, or this block would advertise a NARROWER
      // first_month/last_month than the board beside it and the two would disagree about how
      // many options the picker has.
      competition: monthStatus(config, month, nowMs, await selectableMonthBounds(db, config, nowMs)),
      server_time: isoUtcNow(nowMs),
      schema: API_SCHEMA,
    });
  });

  /**
   * The one-time team claim.
   *
   * Re-POSTing the SAME team is a 200, not a 409. An impatient double-click is the normal
   * case, and the second click must not greet a rider with an error for doing exactly what
   * they were asked to do. A DIFFERENT team is the 409.
   */
  router.add('POST', '/api/me/team', async (req, res, ctx) => {
    const session = requireSession(ctx);
    const body = await readJsonBody(req);
    const team = body.team;

    if (!TEAMS.includes(team)) {
      throw new HttpError(400, ERROR_CODES.INVALID_TEAM, `Team must be one of ${TEAMS.join(', ')}.`, {
        allowed: [...TEAMS],
      });
    }

    // One atomic `UPDATE ... WHERE team IS NULL RETURNING team`. A read-then-write lets two
    // concurrent POSTs both observe a null team and both write, so the rider sees a 200 for
    // EAST and silently ends up on WEST.
    const claimed = await claimTeam(db, session.athleteId, team);

    if (claimed === undefined) {
      const athlete = await getAthlete(db, session.athleteId);
      if (athlete?.team !== team) {
        throw new HttpError(409, ERROR_CODES.TEAM_ALREADY_SET, 'Your team is already set and cannot be changed.', {
          // The CURRENT team, so the client can correct its own state instead of guessing.
          team: athlete?.team ?? null,
        });
      }
      sendJson(res, 200, { ok: true, team, rider: await riderView(db, athlete) });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      team: claimed,
      rider: await riderView(db, await getAthlete(db, session.athleteId)),
    });
  });

  /**
   * Sync, then return the WHOLE leaderboard embedded.
   *
   * Embedding it is what makes Refresh one round trip: a sync followed by a separate
   * GET /api/leaderboard is two requests whose results can disagree, and the gap shows up as
   * a board that flickers back to the old totals.
   */
  router.add('POST', '/api/me/sync', async (req, res, ctx) => {
    const session = requireSession(ctx);
    // Blocks the Strava call, not the account: a revoked rider keeps their row, their team,
    // their history, and their place on the board with a frozen total.
    requireNotRevoked(ctx);

    const nowMs = ctx.nowMs ?? now();
    const body = await readJsonBody(req);

    let mode = null;
    if (body.mode !== undefined && body.mode !== null) {
      if (!SYNC_MODES.has(body.mode)) {
        throw new HttpError(400, ERROR_CODES.BAD_REQUEST, `mode must be one of ${[...SYNC_MODES].join(', ')}.`);
      }
      mode = body.mode;
    }

    // The month the rider is LOOKING AT, not the month being synced. Sync itself always
    // covers the whole picker range (one fetch serves every month), but the embedded
    // leaderboard has to come back for the month on screen -- otherwise pressing Refresh
    // while viewing June silently snaps the board to the current month.
    const month = requireMonthParam(body.month);

    let result;
    try {
      result = await syncAthlete(db, config, strava, session.athleteId, { mode, nowMs });
    } catch (err) {
      throw toHttpError(err, config);
    }

    const leaderboard = await buildLeaderboard(db, config, {
      month,
      viewerAthleteId: session.athleteId,
      nowMs,
    });
    const me = leaderboard.riders.find((r) => r.athlete_id === session.athleteId);

    sendJson(res, 200, {
      ok: true,
      mode: result.mode,
      synced_at: result.syncedAt,
      activities_scanned: result.activitiesScanned,
      activities_counted: result.activitiesCounted,
      activities_added: result.activitiesAdded,
      activities_removed: result.activitiesRemoved,
      pages_fetched: result.pagesFetched,
      truncated: result.truncated,
      // A rider with no team yet is absent from `riders` by contract, so 0 rather than
      // undefined -- the client renders this number directly.
      miles: me?.miles ?? 0,
      leaderboard,
    });
  });

  /**
   * Voluntary disconnect: revoke at Strava, drop the tokens, keep everything else.
   *
   * The athlete row, their team, and every activity survive. Deleting them would silently
   * rewrite the standings mid-competition, which is a much bigger action than the one the
   * rider asked for. DELETE /api/me?purge=1 is the route for actually removing data.
   */
  router.add('POST', '/api/me/disconnect', async (req, res, ctx) => {
    const session = requireSession(ctx);
    const nowMs = ctx.nowMs ?? now();

    await deauthorizeQuietly(ctx, { config, db, strava }, session.athleteId, nowMs);

    await deleteTokens(db, session.athleteId);
    await markDisconnected(db, session.athleteId, epochSeconds(nowMs));
    // Every session, not just this one: a second browser holding a live session for an
    // account with no tokens would present a Refresh button that can only ever fail.
    await revokeAllForAthlete(db, session.athleteId);

    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearAuthCookies(config) });
  });

  /**
   * Account deletion.
   *
   * `?purge=1` is the destructive form: the athlete row goes and ON DELETE CASCADE takes the
   * tokens, sessions, sync state, and activities with it (which only works because
   * `PRAGMA foreign_keys` is asserted ON in openDatabase). Without the flag this behaves like
   * disconnect and keeps the history, so a mis-typed fetch cannot erase a season.
   */
  router.add('DELETE', '/api/me', async (req, res, ctx) => {
    const session = requireSession(ctx);
    const nowMs = ctx.nowMs ?? now();
    const purge = ctx.query.get('purge') === '1';

    await deauthorizeQuietly(ctx, { config, db, strava }, session.athleteId, nowMs);

    let activitiesDeleted = 0;
    if (purge) {
      // Counted before the cascade so the response can report a number; a hard delete, not a
      // soft one, because this is a data-removal request and a soft delete leaves the rides
      // in the file the rider asked to be removed from.
      activitiesDeleted = await purgeAthleteActivities(db, session.athleteId);
      await deleteAthlete(db, session.athleteId);
    } else {
      await deleteTokens(db, session.athleteId);
      await markDisconnected(db, session.athleteId, epochSeconds(nowMs));
      await revokeAllForAthlete(db, session.athleteId);
    }

    sendJson(res, 200, { ok: true, purged: purge, activities_deleted: activitiesDeleted }, {
      'Set-Cookie': clearAuthCookies(config),
    });
  });
}

/**
 * Best-effort revocation at Strava.
 *
 * Two deliberate choices. (1) A fresh access token is fetched first: deauthorizing with an
 * EXPIRED token gets a 401, which the client reports as success, so the grant would silently
 * survive on Strava's side while we report `ok`. (2) Any failure is logged and swallowed. The
 * local end state -- no tokens, no session -- is what the rider asked for, and refusing to
 * complete a disconnect because Strava is having an outage leaves them connected with a
 * button that does not work.
 */
async function deauthorizeQuietly(ctx, { config, db, strava }, athleteId, nowMs) {
  let accessToken = null;
  try {
    accessToken = await getValidAccessToken(db, config, strava, athleteId, { nowMs });
  } catch {
    // No usable grant left (never connected, already revoked, refresh token dead). There is
    // nothing to revoke, which is the desired end state anyway.
    return;
  }
  if (!accessToken) return;

  try {
    // The client already treats Strava's 401 as success: "already revoked" IS the outcome
    // the caller asked for, and erroring makes Disconnect un-completable for exactly the
    // athletes who already revoked us in Strava's own settings page.
    await strava.deauthorize(accessToken);
  } catch (err) {
    ctx.log?.warn?.('strava deauthorize failed; disconnecting locally anyway', {
      athlete_id: athleteId,
      error_name: err?.name,
      error_message: err?.message,
    });
  }
}

/**
 * Translate a sync failure into the documented HTTP response.
 *
 * Order matters: StravaRateLimitError, StravaScopeError and StravaGrantRevokedError are all
 * subclasses of StravaError, so a `StravaError` branch placed first would swallow every one
 * of them into a 502 and the client would show "Strava unavailable" for a revoked grant.
 */
function toHttpError(err, config) {
  const reauthUrl = `${config.apiBaseUrl}/api/auth/strava/reconnect`;

  if (err instanceof HttpError) {
    // sync.js already shaped 409 sync_in_progress and 429 rate_limited. The 429 needs two
    // headers the body alone cannot replace: `Retry-After`, and the Expose-Headers that makes
    // it readable to cross-origin JS at all (which is also why the body repeats it).
    if (err.status === 429) {
      const seconds = Number(err.extra?.retry_after_seconds);
      if (Number.isFinite(seconds)) {
        err.headers = {
          ...err.headers,
          'Retry-After': String(Math.max(1, Math.ceil(seconds))),
          'Access-Control-Expose-Headers': 'Retry-After',
        };
      }
    }
    return err;
  }

  if (err instanceof StravaScopeError) {
    return new HttpError(403, ERROR_CODES.INSUFFICIENT_SCOPE, 'Strava did not grant permission to read your rides.', {
      granted: err.granted,
      required: err.required,
      reauth_url: reauthUrl,
    });
  }

  if (err instanceof StravaGrantRevokedError) {
    return new HttpError(403, ERROR_CODES.STRAVA_REVOKED, 'Your Strava connection was revoked. Reconnect to keep syncing.', {
      reauth_url: reauthUrl,
    });
  }

  if (err instanceof StravaRateLimitError) {
    const seconds = Math.max(1, Math.ceil(err.retryAfterMs / 1000));
    const httpErr = new HttpError(429, ERROR_CODES.RATE_LIMITED, 'Strava is rate limiting us. Try again shortly.', {
      retry_after_seconds: seconds,
      // 'local' is our own pre-emptive gate; 'short'/'daily' came from Strava's own 429.
      scope: err.bucket === 'local' ? 'local' : 'strava',
      reset_at: err.resetAt,
    });
    httpErr.headers = { 'Retry-After': String(seconds), 'Access-Control-Expose-Headers': 'Retry-After' };
    return httpErr;
  }

  if (err instanceof StravaError) {
    // 502, not 500: the failure is upstream, and the distinction is what tells whoever reads
    // the log whether to look at this codebase or at Strava's status page.
    return new HttpError(502, ERROR_CODES.STRAVA_UNAVAILABLE, 'Strava is not responding. Try again in a few minutes.');
  }

  // Not ours to interpret. app.js turns it into {"error":"internal"} with the stack going
  // only to the server log.
  return err;
}
