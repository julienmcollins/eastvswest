import { openDatabase } from '../../server/db/db.js';
import { migrate } from '../../server/db/migrate.js';
import { loadConfig } from '../../server/config.js';
import { isoUtcNow, epochSeconds } from '../../server/lib/dates.js';

/** A fresh migrated in-memory database. */
export async function freshDb() {
  const db = openDatabase(':memory:');
  await migrate(db);
  return db;
}

const SENTINEL_SECRET = 'SENTINEL_CLIENT_SECRET_do_not_log';

/**
 * A complete, valid config for tests. The client secret is a recognizable sentinel so a
 * test can assert it never appears in a response body or a log line.
 */
export function testConfig(overrides = {}) {
  const env = {
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://localhost:3000',
    DATABASE_PATH: ':memory:',
    STRAVA_CLIENT_ID: '12345',
    STRAVA_CLIENT_SECRET: SENTINEL_SECRET,
    STRAVA_API_BASE: 'https://fake.strava.test/api/v3',
    STRAVA_OAUTH_BASE: 'https://fake.strava.test/oauth',
    SESSION_SECRET: Buffer.alloc(48, 7).toString('base64'),
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    COMPETITION_START: '2026-06-01',
    COMPETITION_END: '2026-08-31',
    COMPETITION_TZ: 'UTC',
    ALLOWED_SPORT_TYPES: 'Ride,GravelRide,MountainBikeRide,VirtualRide',
    COUNT_MANUAL_ACTIVITIES: 'false',
    ...overrides,
  };
  return loadConfig(env);
}

export { SENTINEL_SECRET };

/** Insert an athlete directly, bypassing OAuth. */
export async function seedAthlete(db, { id, name = `Rider ${id}`, team = 'EAST', isAdmin = false, avatar = null }) {
  const now = isoUtcNow();
  await db.run(
    `INSERT INTO athletes (strava_athlete_id, username, firstname, lastname, display_name,
       avatar_url, team, is_admin, granted_scope, team_locked_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, null, name.split(' ')[0], name.split(' ')[1] ?? '', name, avatar, team, isAdmin,
     'read,activity:read_all', team ? now : null, now, now],
  );
  return id;
}

/**
 * Insert an activity directly.
 *
 * `localDate` is the date portion of start_date_local, which is what the leaderboard
 * judges on. `startDateUtc` defaults to the same wall clock, which is only correct for a
 * UTC rider -- tests exercising timezone edges must pass both explicitly.
 */
export async function seedActivity(db, {
  id,
  athleteId,
  sportType = 'Ride',
  meters = 1609.344,
  localDate = '2026-07-01',
  localTime = '08:00:00',
  startDateUtc = null,
  movingSeconds = 3600,
  isManual = false,
  isPrivate = false,
  isTrainer = false,
  manualApproved = false,
  deletedAt = null,
  legacyType = null,
}) {
  const startLocal = `${localDate}T${localTime}Z`;
  const utc = startDateUtc ?? startLocal;
  await db.run(
    `INSERT INTO activities (strava_activity_id, athlete_id, name, sport_type, legacy_type,
       sport_type_source, distance_meters, moving_time_seconds, elapsed_time_seconds,
       total_elevation_gain_meters, start_date_utc, start_epoch, start_date_local, timezone,
       is_private, is_manual, manual_approved, is_trainer, deleted_at, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, athleteId, `Activity ${id}`, sportType, legacyType, 'sport_type', meters,
     movingSeconds, movingSeconds, 0, utc, Math.floor(Date.parse(utc) / 1000), startLocal,
     null, isPrivate, isManual, manualApproved, isTrainer, deletedAt, isoUtcNow()],
  );
  return id;
}

/** Insert a session row directly and return the raw token the browser would hold. */
export async function seedSession(db, athleteId, rawToken, { ttlSeconds = 3600 } = {}) {
  const { sha256b64u } = await import('../../server/security/hash.js');
  const now = epochSeconds();
  await db.run(
    `INSERT INTO sessions (session_id_hash, athlete_id, created_at, expires_at, last_seen_at, user_agent)
     VALUES (?,?,?,?,?,?)`,
    [sha256b64u(rawToken), athleteId, now, now + ttlSeconds, now, 'test-agent'],
  );
  return rawToken;
}
