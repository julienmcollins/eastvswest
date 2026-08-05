import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  computeSyncWindow,
  isCountedSportType,
  localDateOf,
  maxStartEpoch,
  nextQuarterHourMs,
  nextUtcMidnightMs,
  normalizeActivity,
  parseRateLimitHeaders,
  startEpochOf,
} from '../server/strava/map.js';
import { SYNC_WINDOW_PAD_SECONDS } from '../server/contracts.js';
import { epochAtEndOfDate, epochAtStartOfDate } from '../server/lib/dates.js';
import { testConfig } from './helpers/testDb.js';
import { assertScope, buildAuthorizeUrl, redirectUri } from '../server/strava/authUrl.js';
import { StravaScopeError } from '../server/strava/client.js';

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/activities.json', import.meta.url), 'utf8'));
const ALLOWED = FIXTURE.allowed_sport_types;
const byWhy = (needle) => FIXTURE.activities.find((a) => a._why.includes(needle));

// ------------------------------------------------------------------ sport type filter

test('isCountedSportType matches on sport_type only', () => {
  for (const s of ALLOWED) assert.equal(isCountedSportType(s, ALLOWED), true, s);
  for (const s of ['Run', 'EBikeRide', 'Walk', 'Hike', '']) {
    assert.equal(isCountedSportType(s, ALLOWED), false, s);
  }
  assert.equal(isCountedSportType(undefined, ALLOWED), false);
  assert.equal(isCountedSportType(null, ALLOWED), false);
  // Case matters: a mis-cased config entry must not silently start counting.
  assert.equal(isCountedSportType('ride', ALLOWED), false);
});

test('isCountedSportType rejects EMountainBikeRide even though its legacy type is "Ride"', () => {
  const emtb = FIXTURE.activities.find((a) => a.sport_type === 'EMountainBikeRide');
  assert.equal(emtb.type, 'Ride', 'fixture canary must keep legacy type "Ride"');
  assert.equal(isCountedSportType(emtb.sport_type, ALLOWED), false);
  // The bug this catches: filtering on the legacy field would count 40 e-bike miles.
  assert.equal(isCountedSportType(emtb.type, ALLOWED), true);
});

test('isCountedSportType refuses a non-array allowlist rather than returning false', () => {
  assert.throws(() => isCountedSportType('Ride', 'Ride,GravelRide'), TypeError);
});

// ------------------------------------------------------------------ normalizeActivity

const BINDABLE = new Set(['string', 'number']);

function assertBindable(row) {
  for (const [key, value] of Object.entries(row)) {
    if (value === null) continue;
    assert.notEqual(typeof value, 'boolean', `${key} must not be a boolean (SQLite bind throws)`);
    assert.notEqual(value, undefined, `${key} must not be undefined (SQLite bind throws)`);
    assert.ok(BINDABLE.has(typeof value), `${key} is a ${typeof value}; only null|number|string can be bound`);
    if (typeof value === 'number') assert.ok(Number.isFinite(value), `${key} is ${value}`);
  }
}

test('normalizeActivity emits 1/0 integers for every boolean, never true/false', () => {
  const trainer = byWhy('VirtualRide on a trainer');
  const priv = byWhy('private ride');
  const manual = byWhy('manual entry');

  const t = normalizeActivity(trainer);
  assert.equal(t.is_trainer, 1);
  assert.equal(t.is_private, 0);
  assert.equal(t.is_manual, 0);
  assertBindable(t);

  const p = normalizeActivity(priv);
  assert.equal(p.is_private, 1);
  assert.equal(p.is_trainer, 0);
  assertBindable(p);

  const m = normalizeActivity(manual);
  assert.equal(m.is_manual, 1);
  assertBindable(m);

  // Belt and braces: the strict-equality check a naive mapper would pass.
  assert.notEqual(t.is_trainer, true);
  assert.notEqual(p.is_private, true);
});

test('normalizeActivity coalesces absent timezone and type to null, name to ""', () => {
  const sparse = byWhy('timezone and type both absent');
  assert.equal(sparse.timezone, undefined, 'fixture must really be missing timezone');
  assert.equal(sparse.type, undefined, 'fixture must really be missing type');

  const row = normalizeActivity(sparse);
  assert.equal(row.timezone, null);
  assert.equal(row.legacy_type, null);
  assert.equal(row.sport_type, 'Ride');
  assert.equal(row.sport_type_source, 'sport_type');
  assertBindable(row);

  const unnamed = normalizeActivity({ ...sparse, name: undefined });
  assert.equal(unnamed.name, '');
  assertBindable(unnamed);
});

test('normalizeActivity records sport_type_source when it had to fall back to type', () => {
  const raw = { id: 1, type: 'Ride', distance: 100, start_date: '2026-07-01T08:00:00Z', start_date_local: '2026-07-01T08:00:00Z' };
  const row = normalizeActivity(raw);
  assert.equal(row.sport_type, 'Ride');
  assert.equal(row.sport_type_source, 'type');
  assert.equal(row.legacy_type, 'Ride');

  const normal = normalizeActivity({ ...raw, sport_type: 'GravelRide' });
  assert.equal(normal.sport_type, 'GravelRide');
  assert.equal(normal.sport_type_source, 'sport_type');
  assert.equal(normal.legacy_type, 'Ride');
});

test('normalizeActivity keeps start_date_local verbatim and never reinterprets it', () => {
  const auckland = byWhy('UTC+13 edge');
  const row = normalizeActivity(auckland);
  assert.equal(row.start_date_local, auckland.start_date_local);
  assert.equal(row.start_date_local.slice(0, 10), '2026-06-01');
  assert.equal(row.start_date_utc, '2026-05-31T11:30:00.000Z');
  assert.equal(row.start_epoch, Math.floor(Date.parse(auckland.start_date) / 1000));
  // The whole point of the fixture: the two dates differ.
  assert.notEqual(row.start_date_utc.slice(0, 10), row.start_date_local.slice(0, 10));
});

test('normalizeActivity emits exactly the bound column set (no generated or writer columns)', () => {
  const row = normalizeActivity(FIXTURE.activities[0]);
  assert.deepEqual(Object.keys(row).sort(), [
    'athlete_id',
    'distance_meters',
    'elapsed_time_seconds',
    'is_manual',
    'is_private',
    'is_trainer',
    'legacy_type',
    'moving_time_seconds',
    'name',
    'sport_type',
    'sport_type_source',
    'start_date_local',
    'start_date_utc',
    'start_epoch',
    'strava_activity_id',
    'timezone',
    'total_elevation_gain_meters',
  ]);
  // local_date is GENERATED ALWAYS ... STORED: binding it is an error, so it must not appear.
  assert.equal('local_date' in row, false);
  assert.equal('deleted_at' in row, false);
  assert.equal('synced_at' in row, false);
  assert.equal('manual_approved' in row, false);
});

test('normalizeActivity takes athlete_id from the raw payload or an explicit override', () => {
  const raw = FIXTURE.activities[0];
  assert.equal(normalizeActivity(raw).athlete_id, null);
  assert.equal(normalizeActivity({ ...raw, athlete: { id: 42 } }).athlete_id, 42);
  assert.equal(normalizeActivity({ ...raw, athlete: { id: 42 } }, { athleteId: 7 }).athlete_id, 7);
});

test('every fixture activity normalizes to bindable values', () => {
  for (const raw of FIXTURE.activities) assertBindable(normalizeActivity(raw));
});

test('each malformed fixture record throws instead of producing NaN', () => {
  assert.equal(FIXTURE.malformed.length, 3);
  for (const bad of FIXTURE.malformed) {
    assert.throws(() => normalizeActivity(bad), TypeError, `should have thrown: ${bad._why}`);
  }
});

test('normalizeActivity refuses a NaN, negative, or non-numeric distance', () => {
  const base = FIXTURE.activities[0];
  for (const distance of [NaN, Infinity, -1, '1609', null, undefined, {}]) {
    assert.throws(() => normalizeActivity({ ...base, distance }), TypeError, `distance ${String(distance)}`);
  }
});

test('normalizeActivity refuses unusable dates and a missing sport type', () => {
  const base = FIXTURE.activities[0];
  assert.throws(() => normalizeActivity({ ...base, start_date: 'not-a-date' }), TypeError);
  assert.throws(() => normalizeActivity({ ...base, start_date_local: '2026-07-01' }), TypeError);
  assert.throws(() => normalizeActivity({ ...base, sport_type: undefined, type: undefined }), TypeError);
  assert.throws(() => normalizeActivity(null), TypeError);
  assert.throws(() => normalizeActivity([]), TypeError);
});

test('normalizeActivity refuses a non-numeric moving_time rather than defaulting it to 0', () => {
  // A silent 0 here would understate a rider's moving time with no error to find.
  assert.throws(() => normalizeActivity({ ...FIXTURE.activities[0], moving_time: '3600' }), TypeError);
  const row = normalizeActivity({ ...FIXTURE.activities[0], moving_time: undefined });
  assert.equal(row.moving_time_seconds, 0);
});

// ------------------------------------------------------------------ localDateOf

test('localDateOf slices, never parses', () => {
  assert.equal(localDateOf('2026-06-01T00:30:00Z'), '2026-06-01');
  assert.equal(localDateOf('2026-08-31T23:59:59Z'), '2026-08-31');
  for (const bad of ['2026-06-01', '', null, undefined, 20260601, 'yesterday']) {
    assert.throws(() => localDateOf(bad), TypeError, String(bad));
  }
});

// ------------------------------------------------------------------ watermark

test('maxStartEpoch is order-independent and NaN-proof', () => {
  const all = FIXTURE.activities;
  const expected = Math.max(...all.map((a) => Math.floor(Date.parse(a.start_date) / 1000)));

  assert.equal(maxStartEpoch(all), expected);
  assert.equal(maxStartEpoch([...all].reverse()), expected);
  assert.equal(maxStartEpoch([...all].sort(() => Math.random() - 0.5)), expected);

  // A positional read is wrong under at least one ordering -- that is the trap.
  const ascending = [...all].sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date));
  assert.notEqual(Math.floor(Date.parse(ascending[0].start_date) / 1000), expected);

  // An unparseable date must be skipped, not folded in: Math.max(x, NaN) is NaN.
  assert.equal(maxStartEpoch([...all, { start_date: 'garbage' }]), expected);
  assert.equal(maxStartEpoch([{ start_date: 'garbage' }]), 0);
  assert.equal(maxStartEpoch([], 999), 999);
  // Never goes backwards from the seed.
  assert.equal(maxStartEpoch(all, expected + 5), expected + 5);
  assert.equal(startEpochOf({ start_date: 'garbage' }), null);
});

// ------------------------------------------------------------------ computeSyncWindow

test('computeSyncWindow pads +/-86400 s on both ends in full mode', () => {
  const config = testConfig();
  const nowMs = Date.parse('2026-07-15T12:00:00Z');
  const { afterEpoch, beforeEpoch } = computeSyncWindow(config, { mode: 'full', watermarkEpoch: 0, nowMs });

  assert.equal(SYNC_WINDOW_PAD_SECONDS, 86400);
  assert.equal(afterEpoch, epochAtStartOfDate('2026-06-01') - 86400);
  assert.equal(beforeEpoch, Math.floor(nowMs / 1000) + 86400);
  // The padding is what makes the window correct whether Strava compares start_date or
  // start_date_local: no UTC offset exceeds 14 h < 24 h.
  assert.ok(beforeEpoch - afterEpoch > 14 * 3600);
});

test('computeSyncWindow full mode ignores the watermark entirely', () => {
  const config = testConfig();
  const nowMs = Date.parse('2026-07-15T12:00:00Z');
  const fresh = computeSyncWindow(config, { mode: 'full', watermarkEpoch: 0, nowMs });
  const stale = computeSyncWindow(config, { mode: 'full', watermarkEpoch: Math.floor(nowMs / 1000) - 60, nowMs });
  assert.deepEqual(fresh, stale);
});

test('computeSyncWindow incremental starts at the watermark, clamped to the competition', () => {
  const config = testConfig();
  const nowMs = Date.parse('2026-07-15T12:00:00Z');
  const watermarkEpoch = epochAtStartOfDate('2026-07-10');

  const inc = computeSyncWindow(config, { mode: 'incremental', watermarkEpoch, nowMs });
  assert.equal(inc.afterEpoch, watermarkEpoch - 86400);

  // A watermark before the competition (or zero) can never narrow the window.
  const zero = computeSyncWindow(config, { mode: 'incremental', watermarkEpoch: 0, nowMs });
  assert.equal(zero.afterEpoch, epochAtStartOfDate('2026-06-01') - 86400);
});

test('computeSyncWindow never asks past the competition end nor into the future', () => {
  const config = testConfig();
  const afterEnd = computeSyncWindow(config, { mode: 'full', nowMs: Date.parse('2027-01-01T00:00:00Z') });
  assert.equal(afterEnd.beforeEpoch, epochAtEndOfDate('2026-08-31') + 86400);

  // Before the competition opens the naive window inverts; it must stay non-empty.
  const early = computeSyncWindow(config, { mode: 'full', nowMs: Date.parse('2026-01-01T00:00:00Z') });
  assert.ok(early.beforeEpoch > early.afterEpoch, `${early.beforeEpoch} > ${early.afterEpoch}`);
});

test('computeSyncWindow rejects a bogus mode', () => {
  assert.throws(() => computeSyncWindow(testConfig(), { mode: 'quick' }), TypeError);
});

// ------------------------------------------------------------------ rate-limit headers

test('parseRateLimitHeaders reads both pairs from a Headers instance', () => {
  const headers = new Headers({
    'X-RateLimit-Limit': '100,1000',
    'X-RateLimit-Usage': '37,412',
    'X-ReadRateLimit-Limit': '90,900',
    'X-ReadRateLimit-Usage': '12,140',
    'Retry-After': '300',
  });
  assert.deepEqual(parseRateLimitHeaders(headers), {
    shortUsage: 37,
    shortLimit: 100,
    dailyUsage: 412,
    dailyLimit: 1000,
    readShortUsage: 12,
    readShortLimit: 90,
    readDailyUsage: 140,
    readDailyLimit: 900,
    retryAfterSeconds: 300,
    headersSeen: true,
  });
});

test('parseRateLimitHeaders tolerates a plain object and any missing pair', () => {
  const onlyOverall = parseRateLimitHeaders({ 'x-ratelimit-limit': '200,2000', 'x-ratelimit-usage': '5,50' });
  assert.equal(onlyOverall.shortLimit, 200);
  assert.equal(onlyOverall.readShortLimit, null);
  assert.equal(onlyOverall.readShortUsage, null);
  assert.equal(onlyOverall.retryAfterSeconds, null);
  assert.equal(onlyOverall.headersSeen, true);

  const onlyRead = parseRateLimitHeaders({ 'X-ReadRateLimit-Usage': '3,30' });
  assert.equal(onlyRead.readShortUsage, 3);
  assert.equal(onlyRead.shortUsage, null);
  assert.equal(onlyRead.headersSeen, true);
});

test('parseRateLimitHeaders reports headersSeen=false rather than usage 0 when nothing is present', () => {
  // A missing header must never read as "usage 0" -- that would hand back the full quota
  // on exactly the response that says we are out of it.
  for (const headers of [undefined, null, {}, new Headers()]) {
    const parsed = parseRateLimitHeaders(headers);
    assert.equal(parsed.headersSeen, false);
    assert.equal(parsed.shortUsage, null);
    assert.equal(parsed.dailyLimit, null);
  }
  const garbage = parseRateLimitHeaders({ 'X-RateLimit-Usage': 'lots,more' });
  assert.equal(garbage.shortUsage, null);
  assert.equal(garbage.headersSeen, false);
});

// ------------------------------------------------------------------ bucket boundaries

test('nextQuarterHourMs is strictly greater than now, ESPECIALLY on an exact boundary', () => {
  const boundary = Date.parse('2026-08-04T14:30:00.000Z');
  const next = nextQuarterHourMs(boundary);
  // Math.ceil here is the identity, giving blockedUntil === now: a tight 429 burn loop.
  assert.ok(next > boundary, `${next} > ${boundary}`);
  assert.equal(next, Date.parse('2026-08-04T14:45:01.000Z'));

  const mid = Date.parse('2026-08-04T14:31:07.500Z');
  assert.equal(nextQuarterHourMs(mid), Date.parse('2026-08-04T14:45:01.000Z'));
  assert.ok(nextQuarterHourMs(mid) > mid);

  const justBefore = Date.parse('2026-08-04T14:44:59.999Z');
  assert.ok(nextQuarterHourMs(justBefore) > justBefore);
  assert.throws(() => nextQuarterHourMs(NaN), TypeError);
});

test('nextUtcMidnightMs is strictly greater than now on an exact midnight', () => {
  const midnight = Date.parse('2026-08-04T00:00:00.000Z');
  assert.equal(nextUtcMidnightMs(midnight), Date.parse('2026-08-05T00:00:01.000Z'));
  assert.ok(nextUtcMidnightMs(midnight) > midnight);

  const late = Date.parse('2026-08-04T23:59:59.999Z');
  assert.equal(nextUtcMidnightMs(late), Date.parse('2026-08-05T00:00:01.000Z'));
  assert.ok(nextUtcMidnightMs(late) > late);
  assert.throws(() => nextUtcMidnightMs('now'), TypeError);
});

// ------------------------------------------------------------------ authUrl

test('buildAuthorizeUrl carries every parameter Strava needs', () => {
  const config = testConfig();
  const url = new URL(buildAuthorizeUrl(config, { state: 'st-123' }));
  assert.equal(url.origin + url.pathname, 'https://fake.strava.test/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), '12345');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('approval_prompt'), 'auto');
  assert.equal(url.searchParams.get('scope'), 'read,activity:read_all');
  assert.equal(url.searchParams.get('state'), 'st-123');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:3000/api/auth/strava/callback');
  assert.equal(redirectUri(config), config.redirectUri);

  const forced = new URL(buildAuthorizeUrl(config, { state: 'st', approvalPrompt: 'force' }));
  assert.equal(forced.searchParams.get('approval_prompt'), 'force');
});

test('buildAuthorizeUrl refuses a missing state or a bogus approval prompt', () => {
  const config = testConfig();
  assert.throws(() => buildAuthorizeUrl(config, {}), TypeError);
  assert.throws(() => buildAuthorizeUrl(config, { state: '' }), TypeError);
  assert.throws(() => buildAuthorizeUrl(config, { state: 's', approvalPrompt: 'yes' }), TypeError);
});

test('assertScope accepts read_all OR read, and only throws when neither is present', () => {
  assert.equal(assertScope('read,activity:read_all'), 'read_all');
  assert.equal(assertScope('activity:read_all'), 'read_all');
  assert.equal(assertScope('read,activity:read'), 'read');
  assert.equal(assertScope('activity:read'), 'read');
  // Space-separated is the OAuth2 spelling; tolerate it.
  assert.equal(assertScope('read activity:read_all'), 'read_all');
  // read_all wins when both somehow appear.
  assert.equal(assertScope('activity:read,activity:read_all'), 'read_all');

  for (const bad of ['read', '', 'profile:read_all', null, undefined, 'activity:write']) {
    assert.throws(() => assertScope(bad), StravaScopeError, String(bad));
  }
});

test('StravaScopeError says what was granted and what was needed', () => {
  try {
    assertScope('read');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof StravaScopeError);
    assert.equal(err.code, 'insufficient_scope');
    assert.equal(err.granted, 'read');
    assert.deepEqual(err.required, ['activity:read_all', 'activity:read']);
    assert.equal(JSON.parse(JSON.stringify(err)).granted, 'read');
  }
});
