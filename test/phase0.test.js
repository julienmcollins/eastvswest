import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, toBindable, placeholders } from '../server/db/db.js';
import { migrate, schemaVersion } from '../server/db/migrate.js';
import { freshDb, testConfig } from './helpers/testDb.js';
import { loadConfig, ConfigError } from '../server/config.js';
import { milesFromMeters, round1, share } from '../server/lib/units.js';
import {
  isCalendarDate,
  addDays,
  isCalendarMonth,
  monthOf,
  startOfMonth,
  endOfMonth,
  addMonths,
  clampMonth,
  monthSpan,
  monthBounds,
  resolveMonth,
  monthStatus,
} from '../server/lib/dates.js';
import { MAX_PICKER_MONTHS } from '../server/contracts.js';

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

test('WEB_BASE_PATH is normalized, kept out of the CORS allowlist, and validated', () => {
  // The default-domain deploy: Pages serves a PROJECT site from a sub-path, but an Origin
  // header has no path component, so the two must stay separate values.
  const c = testConfig({
    WEB_ORIGIN: 'https://julienmcollins.github.io',
    API_BASE_URL: 'https://eastvswest.julienmcollins.workers.dev',
    WEB_BASE_PATH: '/eastvswest/',
  });
  assert.equal(c.webBasePath, '/eastvswest', 'the trailing slash is normalized off');
  assert.equal(c.webAppUrl, 'https://julienmcollins.github.io/eastvswest');
  assert.equal(c.webOrigin, 'https://julienmcollins.github.io');
  // The allowlist is compared against real browser Origin headers, which never carry a path.
  assert.deepEqual(
    c.corsAllowedOrigins.filter((o) => o.includes('/eastvswest')),
    [],
    'a path in the CORS allowlist would match no browser Origin and 403 every mutating request',
  );

  // Absent, empty, and a bare "/" all mean "served at the domain root".
  assert.equal(testConfig().webBasePath, '');
  assert.equal(testConfig({ WEB_BASE_PATH: '' }).webBasePath, '');
  assert.equal(testConfig({ WEB_BASE_PATH: '/' }).webBasePath, '');
  assert.equal(testConfig({ WEB_BASE_PATH: 'eastvswest' }).webBasePath, '/eastvswest');
  assert.equal(testConfig().webAppUrl, 'http://localhost:3000');

  // Anything that is not a bare path is refused at boot, not concatenated into a Location.
  for (const bad of ['https://evil.com/x', '//evil.com', '/x?y=1', '/x#y']) {
    assert.throws(() => testConfig({ WEB_BASE_PATH: bad }), /WEB_BASE_PATH/, `accepted ${bad}`);
  }
});

test('AUTH_TOKEN_IN_FRAGMENT is off by default and forces a short session TTL when on', () => {
  assert.equal(testConfig().authTokenInFragment, false);
  assert.equal(testConfig({ AUTH_TOKEN_IN_FRAGMENT: 'true', SESSION_TTL_SECONDS: '43200' }).authTokenInFragment, true);

  // A 30-day HttpOnly cookie and a 30-day token in localStorage are not the same risk: the
  // token is readable by any script on the frontend origin, and on a user.github.io project
  // site that origin is shared with every other project on the account. SPEC item 5 says
  // "shorten session TTL to hours"; this is what makes that instruction real.
  assert.throws(
    () => testConfig({ AUTH_TOKEN_IN_FRAGMENT: 'true' }),
    /SESSION_TTL_SECONDS <= 86400/,
    'the default 30-day TTL must not be usable with a localStorage token',
  );
  assert.throws(
    () => testConfig({ AUTH_TOKEN_IN_FRAGMENT: 'true', SESSION_TTL_SECONDS: '86401' }),
    /SESSION_TTL_SECONDS <= 86400/,
  );
  // The ceiling itself is allowed, and the flag does not touch the TTL when it is off.
  assert.equal(testConfig({ AUTH_TOKEN_IN_FRAGMENT: 'true', SESSION_TTL_SECONDS: '86400' }).sessionTtlSeconds, 86400);
  assert.equal(testConfig({ SESSION_TTL_SECONDS: '2592000' }).sessionTtlSeconds, 2592000);
});

test('config rejects a reversed competition window and a bad timezone', () => {
  assert.throws(() => testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-08-01' }), /precedes/);
  assert.throws(() => testConfig({ COMPETITION_TZ: 'Mars/Olympus' }), /not a valid IANA timezone/);
  assert.throws(() => testConfig({ COMPETITION_START: '2026-02-30' }), /real YYYY-MM-DD/);
});

test('COMPETITION_START/END become whole-month picker bounds, so a mid-month start opens the whole month', () => {
  const c = testConfig();
  assert.equal(c.competitionFirstMonth, '2026-06');
  assert.equal(c.competitionLastMonth, '2026-08');

  // The behaviour the derivation exists for: half of June is not a competition. A START of
  // 2026-06-15 makes ALL of June selectable, so June 1-14 still score on June's board.
  const mid = testConfig({ COMPETITION_START: '2026-06-15', COMPETITION_END: '2026-08-04' });
  assert.equal(mid.competitionFirstMonth, '2026-06');
  assert.equal(mid.competitionLastMonth, '2026-08');

  // A single-day window is still one whole month, never an empty picker.
  const oneDay = testConfig({ COMPETITION_START: '2026-07-17', COMPETITION_END: '2026-07-17' });
  assert.equal(oneDay.competitionFirstMonth, '2026-07');
  assert.equal(oneDay.competitionLastMonth, '2026-07');
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

test('month arithmetic gets 28/29/30/31 and the year roll right without a leap table', () => {
  assert.equal(startOfMonth('2026-07'), '2026-07-01');
  assert.equal(endOfMonth('2026-07'), '2026-07-31');
  assert.equal(endOfMonth('2026-06'), '2026-06-30');
  assert.equal(endOfMonth('2026-02'), '2026-02-28');
  assert.equal(endOfMonth('2028-02'), '2028-02-29');
  // Century rules, both branches: 2100 is not a leap year, 2000 is.
  assert.equal(endOfMonth('2100-02'), '2100-02-28');
  assert.equal(endOfMonth('2000-02'), '2000-02-29');
  // THE reason utcMidnight uses setUTCFullYear and not Date.UTC: Date.UTC maps a year under
  // 100 onto 19xx, so year 0 would silently borrow 1900's non-leap February.
  assert.equal(endOfMonth('0000-02'), '0000-02-29');

  assert.equal(addMonths('2026-12', 1), '2027-01', 'December + 1 rolls the year');
  assert.equal(addMonths('2026-01', -1), '2025-12');
  assert.equal(addMonths('2026-06', 14), '2027-08');
  assert.equal(addMonths('2026-07', 0), '2026-07');
  // Four digits are padded back on, because every comparison in the app is a string compare
  // and '999-12' would sort below every real month.
  assert.equal(addMonths('0001-01', -1), '0000-12');

  assert.equal(monthOf('2026-07-01'), '2026-07');
  assert.equal(clampMonth('2026-05', '2026-06', '2026-08'), '2026-06');
  assert.equal(clampMonth('2026-09', '2026-06', '2026-08'), '2026-08');
  assert.equal(clampMonth('2026-07', '2026-06', '2026-08'), '2026-07');
});

test('isCalendarMonth rejects a 13th month, a 0th month, and everything that is not YYYY-MM', () => {
  assert.equal(isCalendarMonth('2026-08'), true);
  assert.equal(isCalendarMonth('2026-01'), true);
  assert.equal(isCalendarMonth('2026-12'), true);
  // A 13th month parses as a Date (it rolls into the next year), so the range check is the
  // only thing standing between `?month=2026-13` and a board for January 2027.
  assert.equal(isCalendarMonth('2026-13'), false);
  assert.equal(isCalendarMonth('2026-00'), false);
  assert.equal(isCalendarMonth('2026-8'), false, 'zero padding is required: string compares order months');
  assert.equal(isCalendarMonth('2026-07-01'), false, 'a date is not a month');
  assert.equal(isCalendarMonth('august'), false);
  assert.equal(isCalendarMonth(''), false);
  assert.equal(isCalendarMonth(null), false);
  assert.equal(isCalendarMonth(202608), false, 'a number is not a month, even a plausible one');
});

test('resolveMonth clamps rather than trusts, so a hand-edited URL cannot widen the race', () => {
  const c = testConfig(); // picker bounds 2026-06 .. 2026-08
  const NOW = Date.parse('2026-08-04T12:00:00Z');

  assert.deepEqual(resolveMonth(c, null, NOW), { month: '2026-08', start: '2026-08-01', end: '2026-08-31' },
    'absent falls back to the current month');
  assert.deepEqual(resolveMonth(c, '2026-06', NOW), { month: '2026-06', start: '2026-06-01', end: '2026-06-30' });

  // A month outside the bounds is CLAMPED, so no request can reach back into a previous season
  // and turn the board into an all-time ranking won by whoever has the longest Strava history.
  assert.deepEqual(resolveMonth(c, '2000-01', NOW), { month: '2026-06', start: '2026-06-01', end: '2026-06-30' });
  assert.deepEqual(resolveMonth(c, '2099-12', NOW), { month: '2026-08', start: '2026-08-01', end: '2026-08-31' });

  // Unusable input degrades to the current month rather than binding `undefined` into SQL.
  // Routes answer 400 for these first; this is the last line of defence behind that check.
  for (const bad of ['garbage', '2026-13', '2026-8', '2026-07-01', '', null, undefined, 202608]) {
    assert.equal(resolveMonth(c, bad, NOW).month, '2026-08', `resolveMonth(${JSON.stringify(bad)})`);
  }
});

test('monthBounds unions the configured season with the clock and the stored data', () => {
  const c = testConfig();

  const inside = monthBounds(c, Date.parse('2026-07-15T00:00:00Z'));
  assert.deepEqual(inside, {
    today: '2026-07-15',
    firstMonth: '2026-06',
    lastMonth: '2026-08',
    currentMonth: '2026-07',
    defaultMonth: '2026-07',
  });

  // The current month is ALWAYS selectable, even long after the configured season closed. The old
  // rule stopped the range at COMPETITION_END, and with a one-month season that left exactly one
  // option and a client that hid the entire picker -- the bug this union exists to fix.
  const after = monthBounds(c, Date.parse('2027-03-09T00:00:00Z'));
  assert.equal(after.currentMonth, '2027-03');
  assert.equal(after.lastMonth, '2027-03', 'the range grew forward to include now');
  assert.equal(after.firstMonth, '2026-06', 'the configured season is still the floor');
  // The DEFAULT is still clamped into the configured season, so a visitor does not land on a
  // month sync never fetches: guaranteed zero miles under a live "open" caption reads as a
  // broken sync rather than as a season that has ended.
  assert.equal(after.defaultMonth, '2026-08');

  const before = monthBounds(c, Date.parse('2026-01-09T00:00:00Z'));
  assert.equal(before.currentMonth, '2026-01');
  assert.equal(before.firstMonth, '2026-01', 'the range grew backward to include now');
  assert.equal(before.lastMonth, '2026-08');
  assert.equal(before.defaultMonth, '2026-06');

  // Stored data widens it further, in either direction, and only ever widens.
  const withData = monthBounds(c, Date.parse('2026-07-15T00:00:00Z'), { first: '2025-11', last: '2026-10' });
  assert.equal(withData.firstMonth, '2025-11');
  assert.equal(withData.lastMonth, '2026-10');
  assert.equal(withData.defaultMonth, '2026-07');

  // Data INSIDE the configured season cannot narrow it, and a null extent (nothing stored yet) is
  // the ordinary day-one input rather than an error.
  assert.equal(monthBounds(c, Date.parse('2026-07-15T00:00:00Z'), { first: '2026-07', last: '2026-07' }).firstMonth, '2026-06');
  assert.equal(monthBounds(c, Date.parse('2026-07-15T00:00:00Z'), { first: null, last: null }).lastMonth, '2026-08');
  assert.equal(monthBounds(c, Date.parse('2026-07-15T00:00:00Z'), null).lastMonth, '2026-08');
  // Garbage from a corrupt row is ignored rather than propagated into a `<select>`.
  assert.equal(monthBounds(c, Date.parse('2026-07-15T00:00:00Z'), { first: 'nope', last: '2026-13' }).firstMonth, '2026-06');
});

test("a one-month COMPETITION_START/END still leaves a picker with something to pick", () => {
  // Verbatim the user's own configuration, and the exact input that made the control invisible:
  // one selectable month meant the client had nothing to switch between.
  const c = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  const august = monthBounds(c, Date.parse('2026-08-05T12:00:00Z'));

  assert.equal(august.firstMonth, '2026-08', 'August is now, so it is selectable');
  assert.equal(august.lastMonth, '2026-09', 'September is configured, so it survives');
  assert.equal(monthSpan(august.firstMonth, august.lastMonth), 2, 'two options, so the picker has a job');
  assert.equal(august.defaultMonth, '2026-09', 'and it opens on the configured competition');

  // Once September arrives the configured month IS the current month. With nothing stored that is
  // a single-month range, which is a legitimate state -- the client renders the control anyway
  // rather than hiding it, because a hidden picker is indistinguishable from a missing feature.
  const september = monthBounds(c, Date.parse('2026-09-10T12:00:00Z'), { first: null, last: null });
  assert.equal(monthSpan(september.firstMonth, september.lastMonth), 1);
  assert.equal(september.defaultMonth, '2026-09');

  // And one stored ride either side of the season -- which the day of padding on the sync window
  // routinely produces -- reopens it without anyone editing `.env`.
  const withPadding = monthBounds(c, Date.parse('2026-09-10T12:00:00Z'), { first: '2026-08', last: '2026-10' });
  assert.deepEqual(
    [withPadding.firstMonth, withPadding.lastMonth],
    ['2026-08', '2026-10'],
  );
});

test('MAX_PICKER_MONTHS caps the range from the OLDEST end, keeping the current month', () => {
  const c = testConfig();
  const now = Date.parse('2026-08-04T12:00:00Z');

  const capped = monthBounds(c, now, { first: '1998-04', last: null });
  assert.equal(monthSpan(capped.firstMonth, capped.lastMonth), MAX_PICKER_MONTHS);
  assert.equal(capped.lastMonth, '2026-08', 'the newest end is kept');
  assert.equal(capped.firstMonth, '2016-09', 'the oldest months are what the cap discards');
  assert.ok(capped.firstMonth <= capped.currentMonth && capped.currentMonth <= capped.lastMonth);

  // Exactly at the cap, nothing is trimmed. Off-by-one here would silently drop a month.
  const exact = monthBounds(c, now, { first: '2016-09', last: null });
  assert.equal(exact.firstMonth, '2016-09');
  assert.equal(monthSpan(exact.firstMonth, exact.lastMonth), MAX_PICKER_MONTHS);

  // A COMPETITION_END a century out is a typo, and trimming the oldest end there would start the
  // range in 2246 -- capping the current month out of its own picker. The future end gives way
  // instead: "the current month is always offered" outranks "trim the oldest first".
  const futureTypo = monthBounds(testConfig({ COMPETITION_END: '2260-12-31' }), now);
  assert.equal(futureTypo.firstMonth, '2026-08', 'the current month becomes the oldest offered');
  assert.equal(futureTypo.firstMonth, futureTypo.currentMonth);
  assert.equal(futureTypo.lastMonth, '2036-07');
  assert.equal(monthSpan(futureTypo.firstMonth, futureTypo.lastMonth), MAX_PICKER_MONTHS);
});

test('monthSpan counts both ends, which is what makes the cap exact', () => {
  assert.equal(monthSpan('2026-08', '2026-08'), 1);
  assert.equal(monthSpan('2026-08', '2026-09'), 2);
  assert.equal(monthSpan('2026-12', '2027-01'), 2, 'across a year boundary');
  assert.equal(monthSpan('2026-01', '2026-12'), 12);
  assert.equal(monthSpan('2016-09', '2026-08'), 120);
});

test('a configured season trimmed away by the cap cannot leave the default without an option', () => {
  // A season a century in the past: the union spans 1900-01..2026-08, the cap keeps only the last
  // 120 months, and clamping the default into the CONFIGURED season alone would name 1900-02 --
  // a month the picker has no option for, which is what the clamp exists to prevent.
  const c = testConfig({ COMPETITION_START: '1900-01-01', COMPETITION_END: '1900-02-28' });
  const b = monthBounds(c, Date.parse('2026-08-04T12:00:00Z'));

  assert.equal(monthSpan(b.firstMonth, b.lastMonth), MAX_PICKER_MONTHS);
  assert.equal(b.firstMonth, '2016-09');
  assert.ok(b.defaultMonth >= b.firstMonth && b.defaultMonth <= b.lastMonth, 'the default is selectable');
  assert.equal(b.defaultMonth, '2016-09');
  // And resolution agrees, so no request can be answered with a month outside the range.
  assert.equal(resolveMonth(c, null, Date.parse('2026-08-04T12:00:00Z'), b).month, '2016-09');
  assert.equal(monthStatus(c, null, Date.parse('2026-08-04T12:00:00Z'), b).month, '2016-09');
});

test('a month is closed, open, or upcoming purely by comparison with the current month', () => {
  const c = testConfig();
  const NOW = Date.parse('2026-08-04T12:00:00Z'); // 2026-08-04 in UTC

  const past = monthStatus(c, '2026-06', NOW);
  assert.equal(past.state, 'closed', 'June is over; its result is final');
  assert.equal(past.days_remaining, 0, 'a finished race has no days left');
  assert.equal(past.month, '2026-06');
  assert.equal(past.start, '2026-06-01');
  assert.equal(past.end, '2026-06-30');
  assert.equal(past.prev_month, null, 'null IS the disabled state at the first selectable month');
  assert.equal(past.next_month, '2026-07');

  const open = monthStatus(c, '2026-08', NOW);
  assert.equal(open.state, 'open');
  assert.equal(open.days_remaining, 28, 'today counts as remaining while riders are still out');
  assert.equal(open.prev_month, '2026-07');
  assert.equal(open.next_month, null);
  assert.equal(open.current_month, '2026-08');

  // A month that has not begun. Nothing can have been ridden for it, so it is neither open nor
  // a finished result -- and days_remaining is 0 rather than a countdown to the start.
  const future = monthStatus(testConfig({ COMPETITION_END: '2026-12-31' }), '2026-11', NOW);
  assert.equal(future.state, 'upcoming');
  assert.equal(future.days_remaining, 0);
  assert.equal(future.prev_month, '2026-10');
  assert.equal(future.next_month, '2026-12');

  // The last day of the open month reads "1 day to go", not "0 days to go".
  assert.equal(monthStatus(c, '2026-08', Date.parse('2026-08-31T23:59:00Z')).days_remaining, 1);
  // ...and the first day of a 30-day month counts all 30.
  assert.equal(monthStatus(c, '2026-06', Date.parse('2026-06-01T00:00:00Z')).days_remaining, 30);
});

test('month state is evaluated in the configured timezone, not the host clock', () => {
  const c = testConfig(); // COMPETITION_TZ=UTC
  const instant = Date.parse('2026-08-31T20:00:00Z');

  // The whole point of COMPETITION_TZ: one fixed instant must yield the same verdict wherever
  // the process runs, and at this instant the two zones disagree about which month it is.
  const tokyo = testConfig({ COMPETITION_TZ: 'Asia/Tokyo' });
  const tokyoStatus = monthStatus(tokyo, '2026-08', instant);
  assert.equal(tokyoStatus.today, '2026-09-01', 'already September in Tokyo');
  assert.equal(tokyoStatus.current_month, '2026-09');
  assert.equal(tokyoStatus.state, 'closed', "August's race is over in Tokyo");
  assert.equal(tokyoStatus.days_remaining, 0);

  const utcStatus = monthStatus(c, '2026-08', instant);
  assert.equal(utcStatus.today, '2026-08-31', 'still August in UTC');
  assert.equal(utcStatus.current_month, '2026-08');
  assert.equal(utcStatus.state, 'open');
  assert.equal(utcStatus.days_remaining, 1, 'the last day still counts as a day to go');

  // The same disagreement decides which month the picker DEFAULTS to.
  assert.equal(monthBounds(tokyo, instant).defaultMonth, '2026-08', 'September is past last_month, so clamped');
  assert.equal(monthBounds(tokyo, instant).currentMonth, '2026-09');
  assert.equal(monthBounds(c, instant).currentMonth, '2026-08');

  // West of UTC the same instant is still August, and August is still the current month --
  // proving the verdict follows COMPETITION_TZ rather than sitting on a UTC fast path.
  const newYork = testConfig({ COMPETITION_TZ: 'America/New_York' });
  assert.equal(monthStatus(newYork, '2026-08', instant).today, '2026-08-31');
  assert.equal(monthStatus(newYork, '2026-08', instant).state, 'open');
  // ...and at the mirror-image instant it is New York that is a month behind UTC.
  const rollover = Date.parse('2026-09-01T02:00:00Z');
  assert.equal(monthStatus(newYork, '2026-08', rollover).state, 'open', 'still 2026-08-31 in New York');
  assert.equal(monthStatus(c, '2026-08', rollover).state, 'closed', 'already 2026-09-01 in UTC');
});

test('the current month is always an option, and the selection is still clamped to the range', () => {
  const c = testConfig(); // configured season 2026-06 .. 2026-08
  const status = monthStatus(c, null, Date.parse('2027-03-09T00:00:00Z'));

  // The range grew forward to cover "now", so the client can always render the month it is in.
  // The old rule stopped at last_month and reported a current_month with no `<option>`, which is
  // how a reader ended up looking at a picker that could not show today.
  assert.equal(status.current_month, '2027-03');
  assert.equal(status.first_month, '2026-06', 'the configured season is the floor, not the ceiling');
  assert.equal(status.last_month, '2027-03');
  assert.ok(status.first_month <= status.current_month && status.current_month <= status.last_month);

  // Absent `?month=` still opens on the configured season rather than on an empty "now".
  assert.equal(status.month, '2026-08');
  assert.equal(status.state, 'closed');
  assert.equal(status.days_remaining, 0);
  assert.equal(status.prev_month, '2026-07');
  assert.equal(status.next_month, '2026-09', 'the months since the season ended are reachable');

  // The current month itself reads as open, with a real countdown, even though the configured
  // season is long over -- every calendar month is its own competition.
  const now = monthStatus(c, '2027-03', Date.parse('2027-03-09T00:00:00Z'));
  assert.equal(now.month, '2027-03');
  assert.equal(now.state, 'open');
  assert.equal(now.days_remaining, 23);
  assert.equal(now.next_month, null, 'and it is the end of the range');

  // A month past the end is still clamped, not honoured: the range is the contract.
  assert.equal(monthStatus(c, '2030-01', Date.parse('2027-03-09T00:00:00Z')).month, '2027-03');
});

test('date helpers reject impossible dates instead of rolling them forward', () => {
  assert.equal(isCalendarDate('2026-02-30'), false);
  assert.equal(isCalendarDate('2026-2-3'), false);
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-06-01', -1), '2026-05-31');
});
