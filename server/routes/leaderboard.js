import { API_SCHEMA, ERROR_CODES } from '../contracts.js';
import { HttpError, sendJson } from '../http/respond.js';
import { requireSession } from '../security/guards.js';
import { buildLeaderboard } from '../db/leaderboard.js';
import { listAthleteActivities } from '../db/activities.js';
import { getAthlete } from '../db/athletes.js';
import { resolveWindow } from '../lib/dates.js';
import { milesFromMeters } from '../lib/units.js';

/** Every rider on the board authorized this app themselves, so a deep link is always valid. */
const STRAVA_ACTIVITY_BASE = 'https://www.strava.com/activities/';

/** Shown instead of a private ride's title to anyone who is not its owner or an admin. */
const PRIVATE_RIDE_TITLE = 'Private ride';

export function registerLeaderboardRoutes(router, { config, db, now }) {
  /**
   * The single call the page renders from. 200 ALWAYS, including the empty state.
   *
   * There is no 401 branch and no "no data" branch: a logged-out visitor sees the same board
   * with `is_you` false everywhere, and an empty competition returns two zeroed teams with
   * `riders: []`. Every alternative pushes a special case into public/render.js.
   */
  router.add('GET', '/api/leaderboard', async (req, res, ctx) => {
    const nowMs = ctx.nowMs ?? now();
    // resolveWindow CLAMPS rather than validates, so `?start=2000-01-01` narrows nothing and
    // cannot widen the board into an all-time ranking won by whoever has the longest Strava
    // history. (buildLeaderboard re-clamps too; both are cheap.)
    const window = resolveWindow(config, { start: ctx.query.get('start'), end: ctx.query.get('end') });

    const payload = await buildLeaderboard(db, config, {
      window,
      // Server-set from the session, never inferred by the client and never read from a
      // query parameter -- `?is_you=` would be an identity claim from the caller.
      viewerAthleteId: ctx.session?.athleteId ?? null,
      nowMs,
    });

    sendJson(res, 200, payload);
  });

  /**
   * One rider's itemized rides. Requires a session.
   *
   * Contains no lat/lng and no polylines -- not filtered out here, but never stored at all,
   * which is the only version of that promise that survives a future refactor.
   */
  router.add('GET', '/api/riders/:athleteId/activities', async (req, res, ctx) => {
    const viewer = requireSession(ctx);
    const nowMs = ctx.nowMs ?? now();

    const athleteId = Number(ctx.params.athleteId);
    if (!Number.isInteger(athleteId) || athleteId <= 0) {
      throw new HttpError(400, ERROR_CODES.BAD_REQUEST, 'Rider id must be a positive integer.');
    }

    const athlete = await getAthlete(db, athleteId);
    if (!athlete) throw new HttpError(404, ERROR_CODES.NOT_FOUND, 'No such rider.');

    const window = resolveWindow(config, { start: ctx.query.get('start'), end: ctx.query.get('end') });
    const rows = await listAthleteActivities(db, config, athleteId, window);

    // Own rides, or an admin auditing a total, get the real titles. Anyone else sees a
    // private ride as an anonymous line item: it still counts toward the team total (which is
    // why it cannot simply be dropped -- the itemized list would stop reconciling with the
    // headline number), but the rider marked it "Only You" and a title is detail.
    const canSeePrivateDetail = viewer.athleteId === athleteId || Number(athlete.is_admin) === 1;

    sendJson(res, 200, {
      schema: API_SCHEMA,
      athlete_id: athleteId,
      window,
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
