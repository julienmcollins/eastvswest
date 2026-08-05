import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, toBindable, placeholders } from '../server/db/db.js';
import { migrate, schemaVersion } from '../server/db/migrate.js';
import { freshDb, testConfig } from './helpers/testDb.js';
import { loadConfig, ConfigError } from '../server/config.js';
import { milesFromMeters, round1, share } from '../server/lib/units.js';
import { resolveWindow, competitionStatus, isCalendarDate, addDays } from '../server/lib/dates.js';

test('migrate is idempotent and bumps user_version exactly once', async () => {
  const db = openDatabase(':memory:');
  const first = await migrate(db);
  assert.equal(first.from, 0);
  assert.equal(first.to, 1);
  assert.deepEqual(first.applied, ['001_init.sql']);

  const second = await migrate(db);
  assert.deepEqual(second.applied, [], 're-running must apply nothing');
  assert.equal(schemaVersion(db), 1);
  await db.close();
});

test('foreign keys are enforced', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => db.run('INSERT INTO oauth_tokens (athlete_id, access_token_enc, refresh_token_enc, expires_at, updated_at) VALUES (?,?,?,?,?)',
      [999, 'v1.a.b.c', 'v1.a.b.c', 0, '2026-01-01T00:00:00Z']),
    /FOREIGN KEY/i,
  );
  await db.close();
});

test('toBindable coerces booleans and undefined, rejects the rest', () => {
  // The bug this exists to prevent: node:sqlite throws on a raw boolean or undefined,
  // and Strava's JSON is full of both.
  assert.equal(toBindable(true), 1);
  assert.equal(toBindable(false), 0);
  assert.equal(toBindable(undefined), null);
  assert.equal(toBindable(null), null);
  assert.equal(toBindable(42), 42);
  assert.equal(toBindable('x'), 'x');
  assert.throws(() => toBindable(NaN), /non-finite/);
  assert.throws(() => toBindable(Infinity), /non-finite/);
  assert.throws(() => toBindable({}), /unsupported type object/);
  assert.throws(() => toBindable([1]), /unsupported type object/);
});

test('adapter binds booleans that raw node:sqlite would reject', async () => {
  const db = await freshDb();
  const now = '2026-07-01T00:00:00Z';
  await db.run(
    `INSERT INTO athletes (strava_athlete_id, display_name, team, is_admin, created_at, updated_at)
     VALUES (?,?,?,?,?,?)`,
    [1, 'Rider', 'EAST', true, now, now], // <- a raw boolean
  );
  const row = await db.get('SELECT is_admin FROM athletes WHERE strava_athlete_id = ?', [1]);
  assert.equal(row.is_admin, 1);

  // And the raw driver confirms it would have thrown.
  assert.throws(
    () => db.raw.prepare('UPDATE athletes SET is_admin = ? WHERE strava_athlete_id = 1').run(true),
    /cannot be bound/,
  );
  await db.close();
});

test('a realistic Strava activity id round-trips exactly', async () => {
  const db = await freshDb();
  const now = '2026-07-01T00:00:00Z';
  await db.run(
    `INSERT INTO athletes (strava_athlete_id, display_name, created_at, updated_at) VALUES (?,?,?,?)`,
    [1, 'R', now, now],
  );
  const id = 15000000001;
  await db.run(
    `INSERT INTO activities (strava_activity_id, athlete_id, sport_type, distance_meters,
       moving_time_seconds, start_date_utc, start_epoch, start_date_local, synced_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, 1, 'Ride', 1609.344, 3600, now, 1783000000, '2026-07-01T08:00:00Z', now],
  );
  const row = await db.get('SELECT strava_activity_id, local_date FROM activities');
  assert.equal(row.strava_activity_id, id);
  assert.equal(row.local_date, '2026-07-01', 'generated column derives local_date');
  await db.close();
});

test('batch is all-or-nothing', async () => {
  const db = await freshDb();
  const now = '2026-07-01T00:00:00Z';
  await assert.rejects(() =>
    db.batch([
      [`INSERT INTO athletes (strava_athlete_id, display_name, created_at, updated_at) VALUES (?,?,?,?)`, [1, 'A', now, now]],
      [`INSERT INTO athletes (strava_athlete_id, display_name, created_at, updated_at) VALUES (?,?,?,?)`, [1, 'dup PK', now, now]],
    ]),
  );
  const rows = await db.all('SELECT * FROM athletes');
  assert.equal(rows.length, 0, 'a failed batch must leave zero rows');
  await db.close();
});

test('adapter refuses multiple statements and named parameters', async () => {
  const db = await freshDb();
  await assert.rejects(() => db.all('SELECT 1; SELECT 2'), /one statement per call/);
  await assert.rejects(() => db.all('SELECT $foo'), /positional \? placeholders only/);
  await db.close();
});

test('DELETE ... RETURNING is single-use, which is what makes state consumption atomic', async () => {
  const db = await freshDb();
  await db.run('INSERT INTO oauth_states (state_hash, nonce_hash, created_at, expires_at, return_to) VALUES (?,?,?,?,?)',
    ['h1', 'n1', 0, 999, '/x']);
  const first = await db.get('DELETE FROM oauth_states WHERE state_hash = ? RETURNING return_to', ['h1']);
  const second = await db.get('DELETE FROM oauth_states WHERE state_hash = ? RETURNING return_to', ['h1']);
  assert.equal(first.return_to, '/x');
  assert.equal(second, undefined);
  await db.close();
});

test('placeholders() scales with the actual array length', () => {
  assert.equal(placeholders(1), '?');
  assert.equal(placeholders(4), '?,?,?,?');
  assert.throws(() => placeholders(0));
});

test('config refuses to boot on a truncated encryption key', () => {
  assert.throws(() => testConfig({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(31, 1).toString('base64') }),
    (e) => e instanceof ConfigError && /exactly 32 bytes, got 31/.test(e.message));
  assert.throws(() => testConfig({ SESSION_SECRET: Buffer.alloc(16, 1).toString('base64') }),
    /at least 32 bytes, got 16/);
});

test('config honours the Strava base overrides and derives redirect_uri', () => {
  const c = testConfig();
  assert.equal(c.stravaApiBase, 'https://fake.strava.test/api/v3');
  assert.equal(c.redirectUri, 'http://localhost:3000/api/auth/strava/callback');
  assert.equal(c.isCrossOrigin, false);
  assert.equal(c.competitionTz, 'UTC');
});

test('API_BASE_URL and WEB_ORIGIN default to APP_BASE_URL but split cleanly', () => {
  const c = testConfig({ API_BASE_URL: 'https://api.example.com', WEB_ORIGIN: 'https://www.example.com' });
  assert.equal(c.redirectUri, 'https://api.example.com/api/auth/strava/callback');
  assert.equal(c.isCrossOrigin, true);
  assert.ok(c.corsAllowedOrigins.includes('https://www.example.com'));
});

test('config rejects a reversed competition window and a bad timezone', () => {
  assert.throws(() => testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-08-01' }), /precedes/);
  assert.throws(() => testConfig({ COMPETITION_TZ: 'Mars/Olympus' }), /not a valid IANA timezone/);
  assert.throws(() => testConfig({ COMPETITION_START: '2026-02-30' }), /real YYYY-MM-DD/);
});

test('mileage conversion is exact at the boundary and never accumulates rounding', () => {
  assert.equal(milesFromMeters(1609.344), 1.0);
  assert.equal(milesFromMeters(16093.44), 10.0);
  // Summing meters then converting once must not drift the way summing rounded miles does.
  assert.equal(milesFromMeters(1609.344 * 100), 100.0);
  assert.equal(round1(0.049), 0.0);
  assert.throws(() => milesFromMeters(NaN), /finite/);
});

test('share is even rather than NaN before anyone has ridden', () => {
  assert.equal(share(0, 0), 0.5);
  assert.equal(share(1423.7, 2626.1), 0.542);
});

test('resolveWindow clamps rather than trusts, so a hand-edited URL cannot widen the race', () => {
  const c = testConfig(); // 2026-06-01 .. 2026-08-31
  assert.deepEqual(resolveWindow(c, {}), { start: '2026-06-01', end: '2026-08-31' });
  assert.deepEqual(resolveWindow(c, { start: '2000-01-01', end: '2099-01-01' }),
    { start: '2026-06-01', end: '2026-08-31' }, 'an all-time request must clamp to the competition');
  assert.deepEqual(resolveWindow(c, { start: '2026-07-01', end: '2026-07-31' }),
    { start: '2026-07-01', end: '2026-07-31' }, 'narrowing is allowed');
  assert.deepEqual(resolveWindow(c, { start: 'garbage' }), { start: '2026-06-01', end: '2026-08-31' });
  assert.deepEqual(resolveWindow(c, { start: '2026-08-01', end: '2026-07-01' }),
    { start: '2026-08-01', end: '2026-08-01' }, 'end before start collapses, never inverts');
});

test('competition state is evaluated in the configured timezone, not the host clock', () => {
  const c = testConfig();
  const open = competitionStatus(c, Date.parse('2026-08-04T12:00:00Z'));
  assert.equal(open.state, 'open');
  assert.equal(open.days_remaining, 28, 'today counts as remaining while riders are still out');

  assert.equal(competitionStatus(c, Date.parse('2026-05-31T23:00:00Z')).state, 'upcoming');
  assert.equal(competitionStatus(c, Date.parse('2026-09-01T00:00:00Z')).state, 'closed');

  // The whole point of COMPETITION_TZ: a fixed instant must yield the same verdict
  // regardless of where the process runs.
  const tokyo = testConfig({ COMPETITION_TZ: 'Asia/Tokyo' });
  assert.equal(competitionStatus(tokyo, Date.parse('2026-08-31T20:00:00Z')).state, 'closed',
    'already 2026-09-01 in Tokyo');
  assert.equal(competitionStatus(c, Date.parse('2026-08-31T20:00:00Z')).state, 'open',
    'still 2026-08-31 in UTC');
});

test('date helpers reject impossible dates instead of rolling them forward', () => {
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-2-3'), false);
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-06-01', -1), '2026-05-31');
});
