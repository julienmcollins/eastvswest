import { API_SCHEMA, ERROR_CODES } from '../contracts.js';
import { HttpError, sendJson } from '../http/respond.js';
import { requireSession } from '../security/guards.js';
import { buildLeaderboard } from '../db/leaderboard.js';
import { listAthleteActivities, selectableMonthBounds } from '../db/activities.js';
import { getAthlete } from '../db/athletes.js';
import { isCalendarMonth, resolveMonth } from '../lib/dates.js';
import { milesFromMeters } from '../lib/units.js';

/** Every rider on the board authorized this app themselves, so a deep link is always valid. */
const STRAVA_ACTIVITY_BASE = 'https://www.strava.com/activities/';

/** Shown instead of a private ride's title to anyone who is not its owner or an admin. */
const PRIVATE_RIDE_TITLE = 'Private ride';

/**
 * Validate `?month=` (or the same field in a JSON body) and hand back `null` for "absent".
 *
 * Format is validated STRICTLY and answers 400, because `?month=august` is a caller bug and
 * silently substituting the current month for it produces a board that disagrees with the URL
 * with nothing to point at. Being OUT OF RANGE is a different matter and is clamped rather
 * than rejected -- see `resolveMonth` in server/lib/dates.js for why.
 *
 * Exported and shared by /api/me and /api/me/sync so the three entry points cannot drift into
 * three different definitions of a valid month. The value never reaches SQL as text: it is
 * turned into two bound `?` parameters by `countedPredicate`.
 *
 * @param {unknown} raw
 * @returns {string|null}
 */
export function requireMonthParam(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isCalendarMonth(raw)) {
    throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'month must be a calendar month in YYYY-MM form, e.g. 2026-08.', {
      month: null,
    });
  }
  return raw;
}

export function registerLeaderboardRoutes(router, { config, db, now }) {
  /**
   * The single call the page renders from, for ONE MONTH. 200 ALWAYS, including the empty state.
   *
   * There is no 401 branch and no "no data" branch: a logged-out visitor sees the same board
   * with `is_you` false everywhere, and a month nobody rode returns two zeroed teams with
   * `riders: []`. Every alternative pushes a special case into public/render.js -- and with a
   * month picker the empty month is no longer an edge case but a click away at all times.
   */
  router.add('GET', '/api/leaderboard', async (req, res, ctx) => {
    const nowMs = ctx.nowMs ?? now();
    const month = requireMonthParam(ctx.query.get('month'));

    const payload = await buildLeaderboard(db, config, {
      // Absent => the current month in COMPETITION_TZ, clamped to the picker bounds. The
      // server picks the default, not the client, so a first paint with no query string
      // shows the same month as the `<select>` the response tells it to render.
      month,
      // Server-set from the session, never inferred by the client and never read from a
      // query parameter -- `?is_you=` would be an identity claim from the caller.
      viewerAthleteId: ctx.session?.athleteId ?? null,
      nowMs,
    });

    sendJson(res, 200, payload);
  });

  /**
   * One rider's itemized rides for one month. Requires a session.
   *
   * Contains no lat/lng and no polylines -- not filtered out here, but never stored at all,
   * which is the only version of that promise that survives a future refactor.
   */
  router.add('GET', '/api/riders/:athleteId/activities', async (req, res, ctx) => {
    const viewer = requireSession(ctx);
    const nowMs = ctx.nowMs ?? now();
    const month = requireMonthParam(ctx.query.get('month'));

    const athleteId = Number(ctx.params.athleteId);
    if (!Number.isInteger(athleteId) || athleteId <= 0) {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'Rider id must be a positive integer.');
    }

    const athlete = await getAthlete(db, athleteId);
    if (!athlete) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'No such rider.');

    // Clamped against the SAME widened range the board uses. Sharing it is what keeps this list
    // and the leaderboard row it expands from ever describing two different months: a rider's
    // June rides open in a drawer under a June total, not under whatever month a narrower range
    // would have clamped the request to.
    const window = resolveMonth(config, month, nowMs, await selectableMonthBounds(db, config, nowMs));
    const rows = await listAthleteActivities(db, config, athleteId, window);

    // Own rides, or an admin auditing a total, get the real titles. Anyone else sees a
    // private ride as an anonymous line item: it still counts toward the team total (which is
    // why it cannot simply be dropped -- the itemized list would stop reconciling with the
    // headline number), but the rider marked it "Only You" and a title is detail.
    const canSeePrivateDetail = viewer.athleteId === athleteId || Number(athlete.is_admin) === 1;

    sendJson(res, 200, {
      schema: API_SCHEMA,
      athlete_id: athleteId,
      month: window.month,
      window: { start: window.start, end: window.end },
      activities: rows.map((row) => ({
        strava_activity_id: Number(row.strava_activity_id),
        name: !canSeePrivateDetail && Number(row.is_private) === 1 ? PRIVATE_RIDE_TITLE : row.name,
        sport_type: row.sport_type,
        // Rounded once, here, from raw meters. The client never divides by 1609.344.
        miles: milesFromMeters(Number(row.distance_meters)),
        moving_seconds: Number(row.moving_time_seconds),
        local_date: row.local_date,
        is_private: Number(row.is_private) === 1,
        is_manual: Number(row.is_manual) === 1,
        manual_approved: Number(row.manual_approved) === 1,
        is_trainer: Number(row.is_trainer) === 1,
        // Computed in SQL from the SAME predicate the aggregates use, so this list can never
        // claim a ride counts while the leaderboard disagrees.
        counted: Number(row.counted) === 1,
        strava_url: `${STRAVA_ACTIVITY_BASE}${row.strava_activity_id}`,
      })),
      generated_at: new Date(nowMs).toISOString(),
    });
  });
}
