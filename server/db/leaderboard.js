import { TEAMS, TEAM_LABELS, API_SCHEMA, SCOPE_READ_ALL } from '../contracts.js';
import { milesFromMeters, metersToMiles, round1, share } from '../lib/units.js';
import { competitionStatus, resolveWindow, isoUtcNow, isoFromEpoch } from '../lib/dates.js';
import { countedPredicate } from './activities.js';
import { placeholders } from './db.js';
import { normalizeAvatarUrl } from './athletes.js';

/**
 * The leaderboard. This is the ONLY place meters become miles.
 *
 * SQL returns raw meters and raw counts; `milesFromMeters` is applied exactly once, when the
 * response is shaped. Rounding per activity and then summing, or summing already-rounded
 * miles, both drift: 100 rides of exactly 1609.344 m would total 99.9 instead of 100.0, and
 * the split bar would stop adding up to the headline number.
 */

/** Strava deep link. Every rider on the board authorized this app themselves. */
const STRAVA_ATHLETE_BASE = 'https://www.strava.com/athletes/';

/**
 * Per-team aggregates.
 *
 * DRIVEN FROM `athletes`, with every activity filter in the ON clause. This is not a style
 * choice: a predicate on `ac.*` in the WHERE clause silently converts the LEFT JOIN into an
 * inner join, because NULL fails every comparison. A team whose riders have no counted rides
 * would then produce no group at all and VANISH from the leaderboard -- exactly the state the
 * board is in on day one.
 *
 * `WHERE ath.team IN ('EAST','WEST')` is a predicate on the LEFT side, so it is safe.
 */
export async function teamTotals(db, config, window) {
  const counted = countedPredicate(config, window);
  return db.all(
    `SELECT ath.team                                  AS team,
            COALESCE(SUM(ac.distance_meters), 0)      AS total_meters,
            COUNT(ac.strava_activity_id)              AS ride_count,
            COUNT(DISTINCT ath.strava_athlete_id)     AS rider_count,
            COALESCE(SUM(ac.moving_time_seconds), 0)  AS moving_seconds
       FROM athletes ath
       LEFT JOIN activities ac
         ON ac.athlete_id = ath.strava_athlete_id
        AND ${counted.sql}
      WHERE ath.team IN (${placeholders(TEAMS.length)})
      GROUP BY ath.team
      ORDER BY total_meters DESC, ath.team ASC`,
    [...counted.params, ...TEAMS],
  );
}

/**
 * Per-rider aggregates, in the contractual display order.
 *
 * Same LEFT JOIN discipline as teamTotals: a rider with a team and zero counted rides must
 * still appear, at 0 miles.
 *
 * `sync_state` joins one-to-one on the primary key, so it adds no row fan-out and cannot
 * inflate the SUMs. `ss.last_sync_finished` is functionally dependent on the GROUP BY key
 * for that reason, which is why SQLite is happy to return it bare.
 *
 * ORDER BY is contractual (`miles DESC, ride_count DESC, display_name ASC, athlete_id ASC`)
 * and is sorted on METERS, not on rounded miles -- the numbers on screen are rounded, but two
 * riders 3 metres apart still get a stable, deterministic order.
 */
export async function riderTotals(db, config, window) {
  const counted = countedPredicate(config, window);
  return db.all(
    `SELECT ath.strava_athlete_id                     AS athlete_id,
            ath.display_name, ath.avatar_url, ath.team,
            ath.granted_scope, ath.strava_revoked_at,
            ss.last_sync_finished                     AS last_sync_finished,
            COALESCE(SUM(ac.distance_meters), 0)      AS meters,
            COUNT(ac.strava_activity_id)              AS ride_count,
            COALESCE(MAX(ac.distance_meters), 0)      AS longest_meters,
            COALESCE(SUM(ac.moving_time_seconds), 0)  AS moving_seconds
       FROM athletes ath
       LEFT JOIN activities ac
         ON ac.athlete_id = ath.strava_athlete_id
        AND ${counted.sql}
       LEFT JOIN sync_state ss ON ss.athlete_id = ath.strava_athlete_id
      WHERE ath.team IN (${placeholders(TEAMS.length)})
      GROUP BY ath.strava_athlete_id
      ORDER BY meters DESC, ride_count DESC, ath.display_name ASC, ath.strava_athlete_id ASC`,
    [...counted.params, ...TEAMS],
  );
}

/**
 * Build the entire `GET /api/leaderboard` payload.
 *
 * The same object is embedded verbatim in the `POST /api/me/sync` response, so Refresh is one
 * round trip. Its shape is frozen by test/fixtures/leaderboard.sample.json.
 *
 * @param {{window?:{start:string,end:string}, viewerAthleteId?:number|null, nowMs?:number}} opts
 */
export async function buildLeaderboard(db, config, { window, viewerAthleteId = null, nowMs = Date.now() } = {}) {
  // Re-clamp even though the route already resolved the window. Clamping is cheap, and it
  // guarantees no hand-edited `?start=2000-01-01` can reach SQL and turn the competition into
  // an all-time ranking won by whoever has the longest Strava history.
  const win = resolveWindow(config, window ?? {});

  const [teamRows, riderRows] = await Promise.all([
    teamTotals(db, config, win),
    riderTotals(db, config, win),
  ]);

  // Seed BOTH teams to zero before merging. The ON-clause discipline above already keeps a
  // team with zero miles in the result, but a team with zero *members* produces no group at
  // all -- and "teams is always exactly two entries" is a contract the client relies on.
  const seeded = new Map(
    TEAMS.map((team) => [team, { team, total_meters: 0, ride_count: 0, rider_count: 0, moving_seconds: 0 }]),
  );
  for (const row of teamRows) {
    const slot = seeded.get(row.team);
    if (!slot) continue; // A CHECK constraint makes this unreachable; ignoring beats crashing.
    slot.total_meters = Number(row.total_meters);
    slot.ride_count = Number(row.ride_count);
    slot.rider_count = Number(row.rider_count);
    slot.moving_seconds = Number(row.moving_seconds);
  }

  const totalMeters = [...seeded.values()].reduce((sum, t) => sum + t.total_meters, 0);

  // Fixed EAST-then-WEST order, independent of who is winning.
  const teams = TEAMS.map((team) => {
    const t = seeded.get(team);
    return {
      team,
      label: TEAM_LABELS[team],
      miles: milesFromMeters(t.total_meters),
      ride_count: t.ride_count,
      rider_count: t.rider_count,
      moving_seconds: t.moving_seconds,
      // Precomputed so the client never divides -- and both sides come back 0.5 at zero total,
      // so the split bar is even on day one instead of collapsed or NaN.
      share: share(t.total_meters, totalMeters),
    };
  });

  const totals = {
    miles: milesFromMeters(totalMeters),
    ride_count: teams.reduce((n, t) => n + t.ride_count, 0),
    rider_count: teams.reduce((n, t) => n + t.rider_count, 0),
  };

  const [east, west] = teams;
  let leader = null;
  // Tie tested on the ROUNDED miles, i.e. on the numbers actually rendered. Comparing raw
  // meters instead would report a leader with `margin_miles: 0.0` whenever two teams differ by
  // a few metres, and "EAST leads by 0.0 mi" reads like a bug.
  if (east.miles !== west.miles) {
    const ahead = east.miles > west.miles ? east : west;
    const marginMeters = Math.abs(seeded.get('EAST').total_meters - seeded.get('WEST').total_meters);
    leader = { team: ahead.team, margin_miles: round1(metersToMiles(marginMeters)) };
  }

  const viewerId = viewerAthleteId === null || viewerAthleteId === undefined ? null : Number(viewerAthleteId);

  let rank = 0;
  const riders = riderRows.map((row) => {
    const meters = Number(row.meters);
    const miles = milesFromMeters(meters);
    return {
      // rank is null for anyone showing 0.0 miles. Zero-mile ties are the common case at the
      // start of a competition, so numbering them would present signup order as a ranking.
      // Ranks are otherwise strictly sequential -- a genuine tie is broken by the ORDER BY, so
      // two riders on the same mileage still get distinct numbers.
      rank: miles > 0 ? ++rank : null,
      athlete_id: Number(row.athlete_id),
      display_name: row.display_name,
      // Re-normalized on read as well as on write: one legacy row holding Strava's relative
      // `avatar/athlete/large.png` would throw inside the client's `new URL()` and blank the
      // whole roster.
      avatar_url: normalizeAvatarUrl(row.avatar_url),
      profile_url: `${STRAVA_ATHLETE_BASE}${row.athlete_id}`,
      team: row.team,
      miles,
      ride_count: Number(row.ride_count),
      longest_ride_miles: milesFromMeters(Number(row.longest_meters)),
      moving_seconds: Number(row.moving_seconds),
      // A rider who unchecked "private activities" is fully functional; the flag exists so the
      // UI can badge the difference instead of treating a privacy choice as a lockout.
      private_rides_counted: String(row.granted_scope ?? '').split(',').map((s) => s.trim()).includes(SCOPE_READ_ALL),
      revoked: row.strava_revoked_at !== null && row.strava_revoked_at !== undefined,
      last_synced_at: isoFromEpoch(row.last_sync_finished ?? null),
      // Always server-set from the session, never inferred by the client.
      is_you: viewerId !== null && Number(row.athlete_id) === viewerId,
    };
  });

  const syncedEpochs = riderRows
    .map((r) => r.last_sync_finished)
    .filter((v) => v !== null && v !== undefined)
    .map(Number);

  return {
    schema: API_SCHEMA,
    // The competition block describes the CONFIGURED season, not the requested window: `state`
    // and `days_remaining` are season-level facts, and a narrowed ?start/?end must not make the
    // competition look shorter than it is.
    competition: competitionStatus(config, nowMs),
    units: { distance: 'mi' },
    teams,
    totals,
    leader,
    riders,
    sync: {
      // null when nobody has ever synced, which is what drives the client's empty state.
      last_synced_at: syncedEpochs.length > 0 ? isoFromEpoch(Math.max(...syncedEpochs)) : null,
      riders_never_synced: riderRows.filter((r) => r.last_sync_finished === null || r.last_sync_finished === undefined).length,
    },
    generated_at: isoUtcNow(nowMs),
  };
}
