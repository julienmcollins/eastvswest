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
import { SYNC_MAX_MONTHS, SYNC_WINDOW_PAD_SECONDS } from '../server/contracts.js';
import { addMonths, epochAtEndOfDate, epochAtStartOfDate, startOfMonth } from '../server/lib/dates.js';
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

test('computeSyncWindow never asks beyond now, and always covers the configured range', () => {
  const config = testConfig(); // 2026-06-01 .. 2026-08-31
  const PAD = 86400;

  // Well AFTER the configured competition. `before` is bounded by now + the pad, never by the
  // far end of the range -- which now reaches the current month, so an unbounded `before`
  // would ask Strava for months that cannot exist yet.
  const lateNow = Date.parse('2027-01-01T00:00:00Z');
  const late = computeSyncWindow(config, { mode: 'full', nowMs: lateNow });
  assert.equal(late.beforeEpoch, Math.floor(lateNow / 1000) + PAD);
  assert.ok(late.afterEpoch <= epochAtStartOfDate('2026-06-01'), 'the configured start stays covered');

  // Well BEFORE it: the window must stay non-empty, and `after` must not be in the future --
  // Strava rejects a future `after` outright with 400 {after: future}, so getting this wrong
  // makes every sync a 502 rather than an empty result.
  const earlyNow = Date.parse('2026-01-01T00:00:00Z');
  const early = computeSyncWindow(config, { mode: 'full', nowMs: earlyNow });
  assert.ok(early.beforeEpoch > early.afterEpoch, `${early.beforeEpoch} > ${early.afterEpoch}`);
  assert.ok(early.afterEpoch <= Math.floor(earlyNow / 1000), 'after must never be in the future');
  // January is the current month at that instant, so it is inside the window too.
  assert.ok(early.afterEpoch <= epochAtStartOfDate('2026-01-01'), 'the current month is covered');
});

test('computeSyncWindow always fetches the CURRENT month, even when the competition has not begun', () => {
  // The bug this pins down shipped and was reported as "it is not showing any of my data".
  // With COMPETITION_START/END set to a month still in the future, the configured range is
  // entirely ahead of `now`, `after` gets clamped to now, and the window collapses to
  // "between now and tomorrow": every sync answers `ok` and stores nothing, for weeks, with
  // no error anywhere. The current month must be inside the fetched range unconditionally.
  const config = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const nowSeconds = Math.floor(nowMs / 1000);

  for (const mode of ['full', 'incremental']) {
    const w = computeSyncWindow(config, { mode, nowMs });
    // All of August so far has to be inside [after, before].
    assert.ok(w.afterEpoch <= epochAtStartOfDate('2026-08-01'), `${mode}: August 1 is not covered`);
    assert.ok(w.beforeEpoch >= nowSeconds, `${mode}: today is not covered`);
    // And the invariant that made this fail loudly before it failed silently.
    assert.ok(w.afterEpoch <= nowSeconds, `${mode}: after must never be in the future`);
    // A ride uploaded this morning must fall inside the window.
    const thisMorning = Math.floor(Date.parse('2026-08-05T08:00:00Z') / 1000);
    assert.ok(
      thisMorning > w.afterEpoch && thisMorning < w.beforeEpoch,
      `${mode}: a ride from this morning is outside the fetch window`,
    );
  }

  // A competition entirely in the PAST must still pick up the current month, for the same
  // reason: the picker offers it, so it has to be fetchable.
  const past = testConfig({ COMPETITION_START: '2026-01-01', COMPETITION_END: '2026-01-31' });
  const w = computeSyncWindow(past, { mode: 'full', nowMs });
  assert.ok(w.afterEpoch <= epochAtStartOfDate('2026-01-01'), 'the configured month stays covered');
  assert.ok(w.beforeEpoch >= nowSeconds, 'the current month is covered too');
});

test('computeSyncWindow reaches back to months that already hold rides', () => {
  // THE REGRESSION, reported as "a lot of rides aren't being shown for months like July and
  // prior". The floor used to be min(configured first month, current month) only. With a
  // COMPETITION_START still in the future -- the shipped `.env` said 2026-09-01 -- the configured
  // month is later than the current one, so the floor collapsed onto the first of the CURRENT
  // month, every month, forever. July was therefore fetched only while July WAS current, and
  // /athlete/activities has no `modified_after`, so nothing could ever go back for the late
  // uploads, the edits and the privacy flips. The stored-data extent is what reopens it.
  const config = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const julyRide = Math.floor(Date.parse('2026-07-14T08:00:00Z') / 1000);

  // First, pin the old behaviour as the bug it was: with no extent to widen from, July is out.
  const blind = computeSyncWindow(config, { mode: 'full', nowMs });
  assert.ok(julyRide < blind.afterEpoch, 'precondition: without dataMonths, July is unreachable');

  // Now the fix. The rider has rides stored back to March, so March onward must be re-fetched.
  const w = computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first: '2026-03', last: '2026-08' } });
  assert.ok(w.afterEpoch <= epochAtStartOfDate('2026-03-01'), 'March 1 is not covered');
  assert.ok(julyRide > w.afterEpoch && julyRide < w.beforeEpoch, 'a mid-July ride is outside the window');
  assert.equal(w.trimmedFrom, null, 'a 6-month history is nowhere near the cap');
  // The clamp that keeps `after` legal has to survive the widening.
  assert.ok(w.afterEpoch <= Math.floor(nowMs / 1000), 'after must never be in the future');
  assert.ok(w.beforeEpoch > w.afterEpoch, 'window inverted');
});

test('computeSyncWindow uses dataMonths as a FLOOR, so it can only ever widen', () => {
  // The competition is 2026-06-01..2026-08-31. A rider who only has August rides must not drag
  // the floor UP to August: June and July are configured months and stay fetchable, which is
  // what lets a rider who joins late still have their earlier rides collected.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');

  const wide = computeSyncWindow(config, { mode: 'full', nowMs });
  const narrow = computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first: '2026-08', last: '2026-08' } });
  assert.equal(narrow.afterEpoch, wide.afterEpoch, 'a late first-ride month must not raise the floor');

  // And nothing stored at all -- a brand-new athlete -- is the same as not passing it.
  const empty = computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first: null, last: null } });
  assert.equal(empty.afterEpoch, wide.afterEpoch, 'a null extent must not change the window');
});

test('computeSyncWindow caps the floor at SYNC_MAX_MONTHS and reports the trim', () => {
  // `dataMonths.first` comes from a substr over stored `local_date` values, so ONE row with a
  // corrupt start_date_local is enough to ask Strava for a millennium of pages -- for every
  // rider, on every sync. The cap is not decoration, and it must not be silent either: a
  // trimmed window still reports `ok` and still reconciles, so without `trimmedFrom` a rider
  // whose history exceeds the cap looks fully synced.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const w = computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first: '1026-05', last: '2026-08' } });

  const expectedFloor = addMonths('2026-08', -(SYNC_MAX_MONTHS - 1));
  assert.equal(w.afterEpoch, epochAtStartOfDate(startOfMonth(expectedFloor)) - SYNC_WINDOW_PAD_SECONDS);
  assert.deepEqual(w.trimmedFrom, {
    requested_first_month: '1026-05',
    first_month: expectedFloor,
    max_months: SYNC_MAX_MONTHS,
  });

  // The cap applies to a fat-fingered CONFIG floor too, not just to derived data.
  const typo = testConfig({ COMPETITION_START: '1900-01-01', COMPETITION_END: '2026-08-31' });
  const t = computeSyncWindow(typo, { mode: 'full', nowMs });
  assert.equal(t.trimmedFrom?.requested_first_month, '1900-01');
  assert.equal(t.afterEpoch, epochAtStartOfDate(startOfMonth(expectedFloor)) - SYNC_WINDOW_PAD_SECONDS);
});

test('computeSyncWindow ignores an unusable dataMonths.first rather than honouring it', () => {
  // A 13th month cannot be ordered against anything sensibly. Ignoring it degrades to the
  // config-plus-clock floor; honouring it would either invert the range or ask for year 1026.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const baseline = computeSyncWindow(config, { mode: 'full', nowMs });

  for (const first of ['1026-13', '2026-1', 'nonsense', '', null, undefined, 42, {}]) {
    const w = computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first, last: '2026-08' } });
    assert.equal(w.afterEpoch, baseline.afterEpoch, `dataMonths.first=${JSON.stringify(first)} changed the window`);
    assert.equal(w.trimmedFrom, null, `dataMonths.first=${JSON.stringify(first)} reported a bogus trim`);
  }
});

test('computeSyncWindow incremental stays cheap even with a wide stored history', () => {
  // The widening is a FULL-mode concern. Incremental still starts at the watermark, or the whole
  // point of having two modes is lost: every Refresh click would re-page two years of rides.
  const config = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const watermarkEpoch = Math.floor(Date.parse('2026-08-04T09:00:00Z') / 1000);
  const dataMonths = { first: '2025-01', last: '2026-08' };

  const inc = computeSyncWindow(config, { mode: 'incremental', watermarkEpoch, nowMs, dataMonths });
  assert.equal(inc.afterEpoch, watermarkEpoch - SYNC_WINDOW_PAD_SECONDS);

  const full = computeSyncWindow(config, { mode: 'full', watermarkEpoch, nowMs, dataMonths });
  assert.ok(full.afterEpoch < inc.afterEpoch, 'full mode must still ignore the watermark and go wide');
});

test('computeSyncWindow never sends a future `after`, whenever "now" falls', () => {
  // The competition is 2026-06-01..2026-08-31; walk from well before it to well after.
  const config = testConfig();
  for (const today of ['2025-01-01', '2026-05-30', '2026-05-31', '2026-06-01', '2026-07-15', '2026-08-31', '2027-06-01']) {
    const nowMs = Date.parse(`${today}T12:00:00Z`);
    const nowSeconds = Math.floor(nowMs / 1000);
    for (const mode of ['full', 'incremental']) {
      // A watermark in the future is not reachable in normal operation, but the clamp is
      // what keeps a corrupted one from poisoning every subsequent sync with a 400.
      for (const watermarkEpoch of [0, nowSeconds - 60, nowSeconds + 30 * 86400]) {
        const w = computeSyncWindow(config, { mode, watermarkEpoch, nowMs });
        assert.ok(w.afterEpoch <= nowSeconds, `${mode} @${today} wm=${watermarkEpoch}: after ${w.afterEpoch} > now ${nowSeconds}`);
        assert.ok(w.beforeEpoch > w.afterEpoch, `${mode} @${today} wm=${watermarkEpoch}: window inverted`);
        assert.ok(w.afterEpoch >= 0, `${mode} @${today}: negative after`);
      }
    }
  }
});

test('computeSyncWindow rejects a bogus mode', () => {
  assert.throws(() => computeSyncWindow(testConfig(), { mode: 'quick' }), TypeError);
});

// ------------------------------------------------------- computeSyncWindow: sinceMonth

test('computeSyncWindow honours sinceMonth with NOTHING stored, which no other source can', () => {
  // THE BUG THE OTHER FLOOR SOURCES CANNOT FIX, reported as "running backfill still doesn't get me
  // the correct data for months prior to September and August".
  //
  // The three-source union is circular: `dataMonths.first` is derived from the rows the fetch
  // itself writes, so it can only ever widen to a month that ALREADY holds rides. A month that was
  // never fetched in the first place is invisible to it, the configured floor is in the future, and
  // the current month is August -- so every source agrees on August and re-running the backfill
  // computes the identical window forever. `sinceMonth` is the only way out.
  const config = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const januaryRide = Math.floor(Date.parse('2026-01-14T08:00:00Z') / 1000);

  // The precondition, stated as an assertion so this test fails loudly if the floor ever widens on
  // its own and stops being the thing sinceMonth is needed for.
  const stuck = computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first: null, last: null } });
  assert.ok(januaryRide < stuck.afterEpoch, 'precondition: January is unreachable without sinceMonth');
  assert.equal(stuck.afterEpoch, epochAtStartOfDate('2026-08-01') - SYNC_WINDOW_PAD_SECONDS);

  const w = computeSyncWindow(config, {
    mode: 'full',
    nowMs,
    dataMonths: { first: null, last: null },
    sinceMonth: '2026-01',
  });
  assert.equal(w.afterEpoch, epochAtStartOfDate('2026-01-01') - SYNC_WINDOW_PAD_SECONDS);
  assert.ok(januaryRide > w.afterEpoch && januaryRide < w.beforeEpoch, 'a mid-January ride is outside the window');
  assert.equal(w.trimmedFrom, null);
  // Every month between January and August has to be inside one window, not just the endpoints:
  // recovering January and August while missing the six between them is the failure mode that
  // `activityMonthlyTotals` exists to expose, and it must not be reachable from here.
  for (const month of ['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']) {
    const mid = Math.floor(Date.parse(`${month}-15T12:00:00Z`) / 1000);
    assert.ok(mid > w.afterEpoch && mid < w.beforeEpoch, `${month} is not inside the window`);
  }
});

test('computeSyncWindow lets sinceMonth NARROW the window too, not only widen it', () => {
  // Unconditional in both directions on purpose. Narrowing is the manual chunking escape hatch for
  // a rider whose history exceeds STRAVA_MAX_PAGES, where a bare re-run recomputes the identical
  // truncating window forever. It is safe precisely because the fetch window is also the reconcile
  // range, so a narrow fetch can only reconcile the months it actually asked Strava about.
  const config = testConfig(); // 2026-06-01 .. 2026-08-31
  const nowMs = Date.parse('2026-08-05T17:00:00Z');

  const wide = computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first: '2025-01', last: '2026-08' } });
  const narrow = computeSyncWindow(config, {
    mode: 'full',
    nowMs,
    dataMonths: { first: '2025-01', last: '2026-08' },
    sinceMonth: '2026-08',
  });

  assert.ok(narrow.afterEpoch > wide.afterEpoch, 'sinceMonth did not narrow anything');
  assert.equal(narrow.afterEpoch, epochAtStartOfDate('2026-08-01') - SYNC_WINDOW_PAD_SECONDS);
  // The upper bound is untouched: narrowing the floor must not stop the current month being fetched.
  assert.equal(narrow.beforeEpoch, wide.beforeEpoch);
});

test('computeSyncWindow clamps sinceMonth to SYNC_MAX_MONTHS and reports it', () => {
  // `--since 1990-01` is a typo, not a request. It has to be clamped like every other floor source
  // AND reported, because a trimmed window still returns `ok` and still reconciles -- a silent cap
  // reads as "we fetched everything" when it did not.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const expectedFloor = addMonths('2026-08', -(SYNC_MAX_MONTHS - 1));

  const w = computeSyncWindow(config, { mode: 'full', nowMs, sinceMonth: '1990-01' });
  assert.equal(w.afterEpoch, epochAtStartOfDate(startOfMonth(expectedFloor)) - SYNC_WINDOW_PAD_SECONDS);
  assert.deepEqual(w.trimmedFrom, {
    requested_first_month: '1990-01',
    first_month: expectedFloor,
    max_months: SYNC_MAX_MONTHS,
  });
});

test('computeSyncWindow THROWS on a malformed sinceMonth rather than falling back', () => {
  // Unlike `dataMonths.first`, which is derived from stored rows and is tolerated when corrupt,
  // this one is a human typing a month on a command line. Silently falling back to the union would
  // run a backfill that reports success while covering exactly the range that was already broken --
  // the operator would conclude the data is genuinely missing upstream.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');

  for (const bad of ['2026-13', '2026-1', '2026', 'nonsense', '', 42, {}, '2026-00']) {
    assert.throws(
      () => computeSyncWindow(config, { mode: 'full', nowMs, sinceMonth: bad }),
      TypeError,
      `sinceMonth=${JSON.stringify(bad)} was accepted`,
    );
  }

  // null and undefined are the documented "no override" values and must NOT throw.
  const baseline = computeSyncWindow(config, { mode: 'full', nowMs });
  for (const absent of [null, undefined]) {
    assert.deepEqual(computeSyncWindow(config, { mode: 'full', nowMs, sinceMonth: absent }), baseline);
  }
});

test('computeSyncWindow keeps `after` legal for any sinceMonth, including future ones', () => {
  // A future sinceMonth is not exotic -- it is the DEFAULT. The admin route defaults `since_month`
  // to COMPETITION_START's month, and a season that has not begun (September, configured in
  // August) puts that month in the future. An override honoured literally would then floor the
  // fetch at September 1, `after` would clamp to now, and every sync would ask Strava for "rides
  // between now and tomorrow" -- succeeding, reporting ok, storing NOTHING. That is the original
  // bug, reachable through its own fix, which is why the floor is min(sinceMonth, currentMonth).
  const config = testConfig();
  for (const today of ['2026-05-30', '2026-08-05', '2027-06-01']) {
    const nowMs = Date.parse(`${today}T12:00:00Z`);
    const nowSeconds = Math.floor(nowMs / 1000);
    const currentMonth = today.slice(0, 7);
    for (const since of ['2026-01', '2026-08', '2027-01', '2030-12']) {
      for (const mode of ['full', 'incremental']) {
        const w = computeSyncWindow(config, { mode, nowMs, sinceMonth: since });
        assert.ok(w.afterEpoch <= nowSeconds, `${mode} @${today} since=${since}: after is in the future`);
        assert.ok(w.afterEpoch >= 0, `${mode} @${today} since=${since}: negative after`);
        assert.ok(w.beforeEpoch > w.afterEpoch, `${mode} @${today} since=${since}: window inverted`);
      }

      // Full mode must ALWAYS still cover the current month, whatever was asked for. The reported
      // floor is the effective one, so a clamped request reads as the month it really fetched.
      const w = computeSyncWindow(config, { mode: 'full', nowMs, sinceMonth: since });
      const expectedFloor = since < currentMonth ? since : currentMonth;
      assert.equal(w.firstMonth, expectedFloor, `@${today} since=${since}: wrong effective floor`);
      assert.ok(
        w.afterEpoch <= epochAtStartOfDate(`${currentMonth}-01`),
        `@${today} since=${since}: the current month fell out of its own window`,
      );
      // And a ride in the middle of the current month is genuinely inside the range, which is the
      // property "the floor covers it" is standing in for.
      const midMonth = Math.floor(Date.parse(`${currentMonth}-15T12:00:00Z`) / 1000);
      if (midMonth <= nowSeconds) {
        assert.ok(midMonth > w.afterEpoch && midMonth < w.beforeEpoch, `@${today} since=${since}: mid-month ride excluded`);
      }
    }
  }
});

test('computeSyncWindow reports the floor it USED, not the one it was given', () => {
  // An ops tool prints this, so it has to be the result rather than the request. The three ways
  // they diverge are all here: no override, a clamped-to-current override, and a capped one.
  const config = testConfig(); // 2026-06-01 .. 2026-08-31
  const nowMs = Date.parse('2026-08-05T17:00:00Z');

  assert.equal(computeSyncWindow(config, { mode: 'full', nowMs }).firstMonth, '2026-06');
  assert.equal(computeSyncWindow(config, { mode: 'full', nowMs, sinceMonth: '2026-02' }).firstMonth, '2026-02');
  assert.equal(
    computeSyncWindow(config, { mode: 'full', nowMs, sinceMonth: '2026-11' }).firstMonth,
    '2026-08',
    'a future floor is reported as the current month, because that is what was fetched',
  );
  assert.equal(
    computeSyncWindow(config, { mode: 'full', nowMs, sinceMonth: '1990-01' }).firstMonth,
    addMonths('2026-08', -(SYNC_MAX_MONTHS - 1)),
  );
  // The stored-data floor shows up here too, so a log line can say which source won.
  assert.equal(
    computeSyncWindow(config, { mode: 'full', nowMs, dataMonths: { first: '2026-03', last: '2026-08' } }).firstMonth,
    '2026-03',
  );
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
