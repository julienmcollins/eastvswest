import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  computeSyncMonths,
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
// ------------------------------------------------------------------ computeSyncMonths

/** Every month the plan asked for, in order. */
const monthsOf = (plan) => plan.months.map((m) => m.month);

/** The entry for one month, or undefined. */
const entry = (plan, month) => plan.months.find((m) => m.month === month);

/** True when `epochSeconds` falls inside the window actually sent for `month`. */
function covered(plan, month, epochSeconds) {
  const e = entry(plan, month);
  return e !== undefined && epochSeconds > e.afterEpoch && epochSeconds < e.beforeEpoch;
}

test('computeSyncMonths asks for EVERY month from the configured start to now, by name', () => {
  // THE POINT OF THE WHOLE FUNCTION. The old shape was one wide `[after, before]` with a floor
  // derived partly from the rows the fetch itself wrote, so a month missed once was unreachable
  // forever -- re-syncing recomputed the identical range and recovered nothing. A month is now
  // either in this list or it is not; there is no arithmetic in between that can drop the middle.
  const config = testConfig({ COMPETITION_START: '2026-01-01', COMPETITION_END: '2026-09-30' });
  const plan = computeSyncMonths(config, { mode: 'full', nowMs: Date.parse('2026-08-05T17:00:00Z') });

  assert.deepEqual(monthsOf(plan), [
    '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08',
  ]);
  assert.equal(plan.trimmedFrom, null);

  // And a ride in the middle of each one really is inside that month's window -- the list being
  // right is only half of it. The 15th is skipped for the current month: `now` is the 5th, so the
  // 15th has not happened, and the window correctly stops at now + the pad.
  const nowSeconds = Math.floor(Date.parse('2026-08-05T17:00:00Z') / 1000);
  for (const month of monthsOf(plan)) {
    const mid = Math.floor(Date.parse(`${month}-15T12:00:00Z`) / 1000);
    if (mid > nowSeconds) continue;
    assert.ok(covered(plan, month, mid), `a mid-${month} ride is not inside ${month}'s window`);
  }
  // For the current month, yesterday is the right probe.
  assert.ok(covered(plan, '2026-08', nowSeconds - 86400), 'a yesterday ride is not inside August');
});

test('computeSyncMonths pads each month by +/-86400 s on both ends', () => {
  const config = testConfig();
  const nowMs = Date.parse('2026-07-15T12:00:00Z');
  const plan = computeSyncMonths(config, { mode: 'full', nowMs });

  assert.equal(SYNC_WINDOW_PAD_SECONDS, 86400);

  const june = entry(plan, '2026-06');
  assert.equal(june.afterEpoch, epochAtStartOfDate('2026-06-01') - 86400);
  assert.equal(june.beforeEpoch, epochAtEndOfDate('2026-06-30') + 86400);
  // The padding is what makes each window correct whether Strava compares start_date or
  // start_date_local: no UTC offset exceeds 14 h < 24 h.
  assert.ok(june.beforeEpoch - june.afterEpoch > 30 * 86400 + 14 * 3600);

  // The current month is capped at `now`, not at the end of a month that has not happened.
  const july = entry(plan, '2026-07');
  assert.equal(july.beforeEpoch, Math.floor(nowMs / 1000) + 86400);
});

test('computeSyncMonths keeps every reconcile range strictly inside the window that was sent', () => {
  // `reconcile ⊆ fetch` by construction rather than by review. Strava's `after`/`before`
  // inclusivity is [UNVERIFIED], so a reconcile range reaching even one second past what was
  // asked for would soft-delete a ride Strava was never asked about -- silently zeroing part of a
  // rider's season. Checked for a past month AND the current one, because the current month is
  // where the two bounds differ (its window stops at `now`, its calendar does not).
  const config = testConfig({ COMPETITION_START: '2026-05-01', COMPETITION_END: '2026-08-31' });
  for (const today of ['2026-05-01', '2026-06-15', '2026-08-05', '2026-08-31']) {
    const nowMs = Date.parse(`${today}T12:00:00Z`);
    const plan = computeSyncMonths(config, { mode: 'full', nowMs });
    for (const m of plan.months) {
      assert.ok(m.startEpoch > m.afterEpoch, `@${today} ${m.month}: reconcile start is outside the fetch`);
      assert.ok(m.endEpoch <= m.beforeEpoch, `@${today} ${m.month}: reconcile end is outside the fetch`);
      assert.ok(m.endEpoch > m.startEpoch, `@${today} ${m.month}: reconcile range inverted`);
      // Half-open on an exact month boundary, which is what reconcileDeletions binds.
      assert.equal(m.startEpoch, epochAtStartOfDate(startOfMonth(m.month)));
    }
  }
});

test('computeSyncMonths always includes the CURRENT month, even when the competition has not begun', () => {
  // The bug this pins down shipped and was reported as "it is not showing any of my data". With
  // COMPETITION_START/END set to a month still in the future, the configured range is entirely
  // ahead of `now`; a plan that honoured it literally would ask Strava only for months that
  // cannot have been ridden yet, answering `ok` and storing nothing, for weeks, with no error.
  const config = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const nowSeconds = Math.floor(nowMs / 1000);

  for (const mode of ['full', 'incremental']) {
    const plan = computeSyncMonths(config, { mode, nowMs });
    assert.deepEqual(monthsOf(plan), ['2026-08'], `${mode}: the current month must be the plan`);
    assert.ok(covered(plan, '2026-08', nowSeconds - 3600), `${mode}: an hour-old ride is not covered`);
  }
});

test('computeSyncMonths never asks for a month in the future', () => {
  // `competitionLastMonth` is routinely ahead of now -- that is the normal state of a running
  // season. Asking for months that have not happened only spends a rate limit that is the one
  // genuinely scarce resource here.
  const config = testConfig({ COMPETITION_START: '2026-06-01', COMPETITION_END: '2026-12-31' });
  const plan = computeSyncMonths(config, { mode: 'full', nowMs: Date.parse('2026-08-05T17:00:00Z') });

  assert.deepEqual(monthsOf(plan), ['2026-06', '2026-07', '2026-08']);
  assert.equal(entry(plan, '2026-09'), undefined);
});

test('computeSyncMonths reaches back to months that already hold rides', () => {
  // Sync must rescan every month the PICKER offers, or a ride deleted at Strava in an old month
  // can never be reconciled away. `monthBounds` unions stored data into what a reader may select,
  // so this list is fed from the same `activityMonthExtent` query -- one predicate, not two that
  // can drift.
  const config = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  const nowMs = Date.parse('2026-08-05T17:00:00Z');

  const blind = computeSyncMonths(config, { mode: 'full', nowMs });
  assert.deepEqual(monthsOf(blind), ['2026-08'], 'precondition: nothing stored, nothing to widen from');

  const plan = computeSyncMonths(config, { mode: 'full', nowMs, dataMonths: { first: '2026-03', last: '2026-08' } });
  assert.deepEqual(monthsOf(plan), ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08']);
  assert.equal(plan.trimmedFrom, null, 'a 6-month history is nowhere near the cap');
});

test('computeSyncMonths uses dataMonths as a FLOOR, so it can only ever widen', () => {
  // The competition is 2026-06-01..2026-08-31. A rider who only has August rides must not drag the
  // list up to August alone: June and July are configured months and stay fetchable, which is what
  // lets a rider who joins late still have their earlier rides collected.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');

  const wide = computeSyncMonths(config, { mode: 'full', nowMs });
  assert.deepEqual(monthsOf(wide), ['2026-06', '2026-07', '2026-08']);

  for (const dataMonths of [{ first: '2026-08', last: '2026-08' }, { first: null, last: null }, null]) {
    assert.deepEqual(
      monthsOf(computeSyncMonths(config, { mode: 'full', nowMs, dataMonths })),
      monthsOf(wide),
      `dataMonths=${JSON.stringify(dataMonths)} narrowed the list`,
    );
  }
});

test('computeSyncMonths caps the list at SYNC_MAX_MONTHS and reports the trim', () => {
  // `dataMonths.first` comes from a substr over stored `local_date` values, so ONE row with a
  // corrupt start_date_local is enough to ask Strava for a millennium -- and now that is a
  // millennium of REQUESTS, one per month, not one wide range. The cap bounds the request count,
  // and it must not be silent either: a trimmed list still reports `ok`, so without `trimmedFrom`
  // a rider whose history exceeds the cap looks fully synced.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const plan = computeSyncMonths(config, { mode: 'full', nowMs, dataMonths: { first: '1026-05', last: '2026-08' } });

  const expectedFloor = addMonths('2026-08', -(SYNC_MAX_MONTHS - 1));
  assert.equal(plan.months.length, SYNC_MAX_MONTHS);
  assert.equal(plan.months[0].month, expectedFloor);
  assert.equal(plan.months.at(-1).month, '2026-08');
  assert.deepEqual(plan.trimmedFrom, {
    requested_first_month: '1026-05',
    first_month: expectedFloor,
    max_months: SYNC_MAX_MONTHS,
  });

  // The cap applies to a fat-fingered CONFIG floor too, not just to derived data.
  const typo = testConfig({ COMPETITION_START: '1900-01-01', COMPETITION_END: '2026-08-31' });
  const t = computeSyncMonths(typo, { mode: 'full', nowMs });
  assert.equal(t.trimmedFrom?.requested_first_month, '1900-01');
  assert.equal(t.months.length, SYNC_MAX_MONTHS);
});

test('computeSyncMonths ignores an unusable dataMonths.first rather than honouring it', () => {
  // A 13th month cannot be ordered against anything sensibly. Ignoring it degrades to the
  // config-plus-clock list; honouring it would either invert the range or ask for year 1026.
  const config = testConfig();
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const baseline = monthsOf(computeSyncMonths(config, { mode: 'full', nowMs }));

  for (const first of ['1026-13', '2026-1', 'nonsense', '', null, undefined, 42, {}]) {
    const plan = computeSyncMonths(config, { mode: 'full', nowMs, dataMonths: { first, last: '2026-08' } });
    assert.deepEqual(monthsOf(plan), baseline, `dataMonths.first=${JSON.stringify(first)} changed the list`);
    assert.equal(plan.trimmedFrom, null, `dataMonths.first=${JSON.stringify(first)} reported a bogus trim`);
  }
});

test('computeSyncMonths incremental asks only from the watermark month onward', () => {
  // This is what keeps an ordinary Refresh at one request instead of one per month. Without it the
  // per-month shape would make every Refresh click re-page two years of rides.
  const config = testConfig({ COMPETITION_START: '2025-01-01', COMPETITION_END: '2026-12-31' });
  const nowMs = Date.parse('2026-08-05T17:00:00Z');
  const dataMonths = { first: '2025-01', last: '2026-08' };

  const full = computeSyncMonths(config, { mode: 'full', nowMs, dataMonths });
  assert.equal(full.months.length, 20, 'Jan 2025 .. Aug 2026');

  const watermarkEpoch = Math.floor(Date.parse('2026-08-04T09:00:00Z') / 1000);
  const inc = computeSyncMonths(config, { mode: 'incremental', watermarkEpoch, nowMs, dataMonths });
  // The watermark's OWN month is included, never skipped: rides later in that month than the
  // watermark are exactly what an incremental sync exists to pick up.
  assert.deepEqual(monthsOf(inc), ['2026-08']);
  assert.ok(covered(inc, '2026-08', watermarkEpoch + 3600));

  // A watermark in a previous month still sweeps forward to now, so a rider who has not synced
  // since June gets June, July and August rather than August alone.
  const stale = Math.floor(Date.parse('2026-06-20T09:00:00Z') / 1000);
  assert.deepEqual(monthsOf(computeSyncMonths(config, { mode: 'incremental', watermarkEpoch: stale, nowMs, dataMonths })),
    ['2026-06', '2026-07', '2026-08']);

  // No watermark at all -- a brand-new athlete -- must not narrow anything.
  const zero = computeSyncMonths(config, { mode: 'incremental', watermarkEpoch: 0, nowMs, dataMonths });
  assert.deepEqual(monthsOf(zero), monthsOf(full));
});

test('computeSyncMonths full mode ignores the watermark entirely', () => {
  // Full mode exists BECAUSE a watermark is provably wrong: a trip uploaded a week late, a Garmin
  // backfill, or a ride flipped from "Only You" to "Everyone" all carry a start_date older than
  // the watermark, and /athlete/activities has no `modified_after` to find them with.
  const config = testConfig();
  const nowMs = Date.parse('2026-07-15T12:00:00Z');
  const fresh = computeSyncMonths(config, { mode: 'full', watermarkEpoch: 0, nowMs });
  const stale = computeSyncMonths(config, { mode: 'full', watermarkEpoch: Math.floor(nowMs / 1000) - 60, nowMs });
  assert.deepEqual(fresh, stale);
});

test('computeSyncMonths never sends a future `after`, whenever "now" falls', () => {
  // Strava rejects a future `after` outright with 400 {field:'after', code:'future'}, so getting
  // this wrong makes every sync a 502 rather than an empty result. The competition is
  // 2026-06-01..2026-08-31; walk from well before it to well after.
  const config = testConfig();
  for (const today of ['2025-01-01', '2026-05-30', '2026-05-31', '2026-06-01', '2026-07-15', '2026-08-31', '2027-06-01']) {
    const nowMs = Date.parse(`${today}T12:00:00Z`);
    const nowSeconds = Math.floor(nowMs / 1000);
    for (const mode of ['full', 'incremental']) {
      // A watermark in the future is not reachable in normal operation, but the clamp is what
      // keeps a corrupted one from poisoning every subsequent sync with a 400.
      for (const watermarkEpoch of [0, nowSeconds - 60, nowSeconds + 30 * 86400]) {
        const plan = computeSyncMonths(config, { mode, watermarkEpoch, nowMs });
        assert.ok(plan.months.length > 0, `${mode} @${today} wm=${watermarkEpoch}: empty plan`);
        for (const m of plan.months) {
          assert.ok(m.afterEpoch <= nowSeconds, `${mode} @${today} ${m.month}: after ${m.afterEpoch} > now ${nowSeconds}`);
          assert.ok(m.afterEpoch >= 0, `${mode} @${today} ${m.month}: negative after`);
          assert.ok(m.beforeEpoch > m.afterEpoch, `${mode} @${today} ${m.month}: window inverted`);
        }
      }
    }
  }
});

test('computeSyncMonths rejects a bogus mode', () => {
  assert.throws(() => computeSyncMonths(testConfig(), { mode: 'quick' }), TypeError);
  assert.throws(() => computeSyncMonths(testConfig(), { nowMs: NaN }), TypeError);
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
