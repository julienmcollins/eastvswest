import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, testConfig, seedActivity, seedAthlete } from './helpers/testDb.js';
import { createFakeStrava, ACTIVITY_FIXTURE } from './helpers/fakeStrava.js';
import { createStravaClient, StravaError } from '../server/strava/client.js';
import { syncAthlete, sweepStaleSyncLocks } from '../server/strava/sync.js';
import { _resetSingleFlightForTests } from '../server/strava/tokenService.js';
import { saveTokens } from '../server/db/tokens.js';
import { getActivity } from '../server/db/activities.js';
import { acquireLock, getSyncState } from '../server/db/syncState.js';
import { buildLeaderboard } from '../server/db/leaderboard.js';
import { HttpError } from '../server/http/respond.js';
import { setLogSink } from '../server/lib/log.js';

/**
 * Sync tests, all against a REAL `:memory:` database.
 *
 * That is not incidental. Node's SQLite bindings reject a JS boolean and `undefined` at bind
 * time ("Provided value cannot be bound to SQLite parameter N"), and Strava's JSON is nothing
 * but booleans and absent fields. A pure mapper test asserting `row.is_trainer === true`
 * passes happily while every real insert fails, so the fixtures with `trainer:true`,
 * `private:true` and a missing `timezone`/`type` only mean something here.
 */

const ATHLETE_ID = 12345678;

/**
 * Frozen clock, deliberately just AFTER the competition ends.
 *
 * The fetch window is `[START-1d, min(now, END)+1d]`, so a "now" inside the season would
 * truncate the window before the END-boundary and END+1d fixtures and the assertions below
 * could not use the fixture's own expected totals. Season state does not affect the
 * leaderboard, which always aggregates over the configured window.
 */
const NOW = Date.parse('2026-09-02T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW / 1000);

const EXPECTED = ACTIVITY_FIXTURE.expected;

/**
 * Per-month slices, because a leaderboard read now covers ONE month.
 *
 * `EXPECTED.counted_miles` (224.0) is the sum over the fixture's three months, so no single
 * `buildLeaderboard` call returns it any more. `NOW` sits in August, which is the month an
 * un-parameterised read resolves to.
 *
 * AUG = 202 records / 202.0 mi, JUL = 6 / 20.0, JUN = 2 / 2.0. The two rides these tests
 * mutate (15000000001, 1.0 mi) are dated 2026-07-05, i.e. JULY -- so an edit or a soft delete
 * of them moves July's total and leaves August's untouched.
 */
const AUG = EXPECTED.by_month['2026-08'];
const JUL = EXPECTED.by_month['2026-07'];
const JUN = EXPECTED.by_month['2026-06'];

setLogSink(() => {});

async function setup({ fakeOpts = {}, seedTokens = true, configOverrides = {} } = {}) {
  _resetSingleFlightForTests();

  const db = await freshDb();
  const config = testConfig(configOverrides);
  const fake = createFakeStrava({ now: () => NOW, logger: { error() {} }, ...fakeOpts });
  const strava = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    clientSecret: config.stravaClientSecret,
    redirectUri: config.redirectUri,
    fetchImpl: fake.fetchImpl,
    now: () => NOW,
    minRequestSpacingMs: 0,
    retryBaseMs: 1,
  });

  await seedAthlete(db, { id: ATHLETE_ID, name: 'Julien Collins', team: 'EAST' });
  if (seedTokens) {
    await saveTokens(
      db,
      config,
      ATHLETE_ID,
      {
        accessToken: fake.tokens.accessToken,
        refreshToken: fake.tokens.refreshToken,
        expiresAt: fake.tokens.expiresAt,
        scope: 'read,activity:read_all',
        tokenType: 'Bearer',
      },
      null,
    );
  }

  return { db, config, fake, strava };
}

const sync = (ctx, opts = {}) => syncAthlete(ctx.db, ctx.config, ctx.strava, ATHLETE_ID, { nowMs: NOW, ...opts });

async function countRows(db, where = '', params = []) {
  const row = await db.get(`SELECT COUNT(*) AS n FROM activities${where ? ` WHERE ${where}` : ''}`, params);
  return Number(row.n);
}

// ------------------------------------------------------- the widened fetch floor

test('a full sync fetches back to the months that already hold rides', async () => {
  // THE REGRESSION, reported as "a lot of rides aren't being shown for months like July and
  // prior". `computeSyncWindow` floors the fetch range at the earliest of {configured first
  // month, current month, first month holding rides}. Before that third source existed, a
  // COMPETITION_START in the future -- which is what shipped -- pushed the floor onto the first
  // of the CURRENT month, every month, forever. Since /athlete/activities has no
  // `modified_after`, the full rescan that exists to catch late uploads and privacy flips never
  // went back for July, so July's board froze at whatever was fetched while July was current.
  //
  // This is the wiring half of the fix: map.js can compute the widened floor, but only sync.js
  // can read the extent to compute it FROM, and a window that is right in a unit test and never
  // reaches the client is the same outage.
  const ctx = await setup({ configOverrides: { COMPETITION_START: '2026-12-01', COMPETITION_END: '2026-12-31' } });

  // A stored July ride is the only thing that can pull the floor back: NOW is 2026-09-02 and
  // the configured season is December, so config and clock alone floor this at September 1.
  await seedActivity(ctx.db, { id: 99000001, athleteId: ATHLETE_ID, localDate: '2026-07-04' });

  await sync(ctx, { mode: 'full' });

  const pages = ctx.fake.requests.filter((r) => r.pathname.endsWith('/athlete/activities'));
  assert.ok(pages.length > 0, 'no activity page was requested at all');

  const julyFirst = Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000);
  for (const page of pages) {
    const after = Number(page.query.after);
    assert.ok(
      after <= julyFirst,
      `asked Strava for after=${new Date(after * 1000).toISOString()}, which misses July`,
    );
    // Every page must carry the SAME bounds. Paging with a moving window silently skips
    // records, because page N means different rides once the filter changes underneath it.
    assert.equal(page.query.after, pages[0].query.after);
    assert.equal(page.query.before, pages[0].query.before);
  }

  // And the rides really landed: the fixture's July records are now stored, which is the
  // outcome the rider was reporting as missing. Counted off the fixture rather than hardcoded,
  // because this is EVERY July record (rule 1: store everything) and not the 6 countable ones
  // that `JUL.records` describes. The seeded row is excluded -- Strava does not report it, so a
  // full sync correctly reconciles it away; that is the next test's subject.
  const julyInFixture = ACTIVITY_FIXTURE.activities
    .filter((a) => String(a.start_date_local).startsWith('2026-07')).length;
  assert.equal(
    await countRows(ctx.db, `local_date LIKE '2026-07-%' AND strava_activity_id != ? AND deleted_at IS NULL`, [99000001]),
    julyInFixture,
  );
});

test('the widened window reconciles the months it now actually fetched', async () => {
  // The other edge of the same change. Widening the fetch range widens the reconcile range with
  // it -- they are both derived from the one `window` object, which is what keeps
  // `reconcile ⊆ fetch` true by construction rather than by review. That is required, not
  // incidental: a ride the rider deleted in July has to stop counting, and before the widening
  // it could not, because July was outside the range reconciliation was allowed to touch.
  const ctx = await setup({ configOverrides: { COMPETITION_START: '2026-12-01', COMPETITION_END: '2026-12-31' } });

  // Two rows Strava does not report: one in July (now inside the fetched range, so it must be
  // soft-deleted) and one in a month nothing was ever stored for, far below the floor.
  await seedActivity(ctx.db, { id: 99000002, athleteId: ATHLETE_ID, localDate: '2026-07-04' });
  await seedActivity(ctx.db, { id: 99000003, athleteId: ATHLETE_ID, localDate: '2020-01-15' });

  const res = await sync(ctx, { mode: 'full' });
  assert.equal(res.truncated, false, 'precondition: reconciliation only runs on a complete fetch');

  const stale = await getActivity(ctx.db, 99000002);
  assert.notEqual(stale.deleted_at, null, 'a July row Strava no longer reports must be soft-deleted');

  // Untouched, because it is outside the window that was actually fetched. Soft-deleting it
  // would be reconciliation deleting rides nobody looked for -- the failure that the
  // `reconcile ⊆ fetch` invariant exists to prevent.
  const ancient = await getActivity(ctx.db, 99000003);
  assert.equal(ancient.deleted_at, null, 'a row outside the fetch window must never be reconciled away');
});

// ------------------------------------------------------- the whole fixture, end to end

test('a full sync stores EVERY record, counts only the countable ones, and totals 224.0 mi', async () => {
  const ctx = await setup();

  const res = await sync(ctx);

  assert.equal(res.ok, true);
  assert.equal(res.mode, 'full', 'no last_full_sync_at => auto mode picks full');
  assert.equal(res.truncated, false);
  assert.equal(res.pagesFetched, 2, '216 records at per_page=200 is two pages, ending short');
  assert.equal(typeof res.syncedAt, 'string');

  // Rule 1: store everything, filter at query time. The Run, the e-bikes, the out-of-window
  // rides and the manual entry are all PERSISTED -- dropping them here would make any future
  // ALLOWED_SPORT_TYPES change a full re-sync of every athlete against a rate-limited API.
  assert.equal(res.activitiesScanned, EXPECTED.total_records);
  assert.equal(res.activitiesAdded, EXPECTED.total_records);
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);
  assert.equal(res.activitiesRemoved, 0);

  // ...and the counted number agrees with what the board will show. `activitiesCounted` is a
  // property of the FETCH, so it stays the whole-fixture 210 across all three months.
  assert.equal(res.activitiesCounted, EXPECTED.counted_records);

  // The board, by contrast, is one month. August is what NOW resolves to.
  const lb = await buildLeaderboard(ctx.db, ctx.config, { nowMs: NOW });
  assert.equal(lb.teams[0].team, 'EAST');
  assert.equal(lb.teams[0].miles, AUG.miles);
  assert.equal(lb.totals.miles, AUG.miles);
  assert.equal(lb.teams[0].ride_count, AUG.records);

  // Every month of the fixture, so the 224.0 mi this test is named for is still fully
  // accounted for -- just spread across three separate competitions instead of pooled into
  // one. Without this, dropping to a single month would have quietly halved the coverage.
  const july = await buildLeaderboard(ctx.db, ctx.config, { month: '2026-07', nowMs: NOW });
  const june = await buildLeaderboard(ctx.db, ctx.config, { month: '2026-06', nowMs: NOW });
  assert.equal(july.totals.miles, JUL.miles);
  assert.equal(june.totals.miles, JUN.miles);
  assert.equal(
    AUG.miles + JUL.miles + JUN.miles,
    EXPECTED.counted_miles,
    'the three months must still sum to the fixture total',
  );

  const state = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(state.last_status, 'ok');
  assert.equal(state.lock_expires_at, null, 'the lock is always released');
  assert.equal(state.last_full_sync_at, NOW_SECONDS);
  assert.ok(state.watermark_epoch > 0);
});

test('the boolean and absent-field fixtures survive a real bind', async () => {
  const ctx = await setup();
  await sync(ctx);

  // trainer:true -- a JS boolean, which throws at bind time if it is not coerced to 0/1.
  const trainer = await getActivity(ctx.db, 15000000004);
  assert.equal(trainer.is_trainer, 1);
  assert.equal(trainer.sport_type, 'VirtualRide');

  // private:true -- counts toward totals, and is never itemized publicly.
  const priv = await getActivity(ctx.db, 15000000013);
  assert.equal(priv.is_private, 1);

  // manual:true -- stored, flagged, and excluded from the totals until an admin approves it.
  const manual = await getActivity(ctx.db, 15000000014);
  assert.equal(manual.is_manual, 1);
  assert.equal(manual.manual_approved, 0);

  // `timezone` and `type` both ABSENT. `undefined` cannot be bound at all, so these must have
  // been coalesced to SQL NULL -- and NULL, not the string "undefined".
  const missing = await ctx.db.get(
    'SELECT timezone, legacy_type, sport_type, sport_type_source FROM activities WHERE strava_activity_id = ?',
    [15000000015],
  );
  assert.equal(missing.timezone, null);
  assert.equal(missing.legacy_type, null);
  assert.equal(missing.sport_type, 'Ride');
  assert.equal(missing.sport_type_source, 'sport_type');

  // The e-MTB canary: sport_type excludes it while the legacy `type` says "Ride". A
  // type-based filter would silently credit e-bike miles to a team.
  const emtb = await getActivity(ctx.db, 15000000006);
  assert.equal(emtb.sport_type, 'EMountainBikeRide');
  assert.equal(emtb.legacy_type, 'Ride');
});

test('the UTC+13 ride is stored on its LOCAL date, inside the window', async () => {
  const ctx = await setup();
  await sync(ctx);

  const row = await getActivity(ctx.db, 15000000012);
  // start_date is 2026-05-31T11:30Z (outside the season); start_date_local is 2026-06-01T00:30
  // with a lying Z. Parsing the local string as an instant, or slicing the UTC one, would put
  // this ride a day early and outside the competition.
  assert.equal(row.start_date_utc, '2026-05-31T11:30:00.000Z');
  assert.equal(row.start_date_local, '2026-06-01T00:30:00Z');
  assert.equal(row.local_date, '2026-06-01');
  assert.ok(row.local_date >= ctx.config.competitionStart);
  assert.ok(row.local_date <= ctx.config.competitionEnd);
});

// ------------------------------------------------------- idempotency

test('two syncs leave COUNT(*) unchanged, and an edited distance updates in place', async () => {
  const ctx = await setup();
  await sync(ctx);
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);

  // `force` because the 60 s cooldown is doing its job, and an explicit `full` because auto
  // mode would pick incremental here -- and an incremental window starting at the watermark
  // would never look at the ride edited below.
  const second = await sync(ctx, { mode: 'full', force: true });
  assert.equal(second.activitiesAdded, 0, 'keyed on Strava\'s own id, so a re-sync cannot double-count');
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);

  // A rider corrects a distance and moves the ride a day: both must land on the existing row,
  // and `local_date` (a GENERATED column) must recompute from the new start_date_local.
  ctx.fake.setActivities(ctx.fake.activities.map((a) => (a.id === 15000000001
    ? { ...a, distance: 16093.44, start_date: '2026-07-05T08:00:00Z', start_date_local: '2026-07-05T08:00:00Z' }
    : a)));

  const third = await sync(ctx, { mode: 'full', force: true });
  assert.equal(third.activitiesAdded, 0);
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);

  const row = await getActivity(ctx.db, 15000000001);
  assert.equal(row.distance_meters, 16093.44);
  assert.equal(row.local_date, '2026-07-05');
  assert.equal(row.deleted_at, null);

  // 1.0 mi became 10.0 mi, so the board moved by exactly 9 miles. No double count anywhere.
  // Read JULY: the edited ride is dated 2026-07-05, so August's total never moves and this
  // assertion would pass for the wrong reason against the default month.
  const lb = await buildLeaderboard(ctx.db, ctx.config, { month: '2026-07', nowMs: NOW });
  assert.equal(lb.totals.miles, JUL.miles + 9);
});

// ------------------------------------------------------- partial fetches

test('a 500 mid-pagination persists the earlier page, leaves the watermark unmoved, and deletes nothing', async () => {
  const ctx = await setup();
  // API call 1 is GET /athlete, call 2 is activities page 1. From call 3 on, page 2 fails --
  // three times, because the client retries an idempotent GET twice before giving up.
  ctx.fake.queue500(3, { afterCalls: 2 });

  await assert.rejects(
    () => sync(ctx),
    (err) => {
      assert.ok(err instanceof StravaError, `expected a StravaError, got ${err?.name}`);
      assert.equal(err.status, 500);
      return true;
    },
  );

  // Page 1's rows are real data and the upsert is idempotent, so throwing them away would
  // cost a rate-limited re-fetch for nothing.
  assert.equal(await countRows(ctx.db), 200, 'the delivered page is persisted');

  const state = await getSyncState(ctx.db, ATHLETE_ID);
  // THE assertion. Advancing past pages that never arrived makes the gap permanent: the next
  // incremental sync starts above the missing rides and never asks for them again.
  assert.equal(state.watermark_epoch, 0, 'a truncated run must not advance the watermark');
  assert.equal(state.last_full_sync_at, null, 'nor claim a full reconciliation happened');
  assert.equal(state.last_status, 'error');
  assert.equal(state.lock_expires_at, null, 'the lock is released even on the failure path');
  assert.ok(state.last_error.length > 0);

  // And nothing is soft-deleted. Reconciling against 200 of 216 rides would have wiped 16.
  assert.equal(await countRows(ctx.db, 'deleted_at IS NOT NULL'), 0);
});

test('a Strava 429 becomes HttpError 429 {scope:"strava"} without sleeping', async () => {
  const ctx = await setup();
  ctx.fake.queue429(1, { afterCalls: 0 });

  const startedAt = Date.now();
  await assert.rejects(
    () => sync(ctx),
    (err) => {
      assert.ok(err instanceof HttpError, `expected an HttpError, got ${err?.name}`);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.extra.scope, 'strava');
      assert.ok(err.extra.retry_after_seconds > 0, 'the user needs a time, not a spinner');
      assert.equal(err.headers['Retry-After'], String(err.extra.retry_after_seconds));
      // Retry-After is not CORS-safelisted; without this the value is invisible to JS once
      // the frontend moves to its own origin.
      assert.equal(err.headers['Access-Control-Expose-Headers'], 'Retry-After');
      return true;
    },
  );
  // The block is ~15 minutes. If it were slept out rather than surfaced, this test would hang.
  assert.ok(Date.now() - startedAt < 5000, 'the handler must never sleep out a rate limit');

  const state = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(state.last_status, 'error');
  assert.equal(state.lock_expires_at, null);
});

// ------------------------------------------------------- deletion reconciliation

test('a full sync soft-deletes exactly the ride Strava no longer reports', async () => {
  const ctx = await setup();
  await sync(ctx);
  const before = await getSyncState(ctx.db, ATHLETE_ID);

  // Without reconciliation, a rider's deleted 340-mile GPS-glitch ride counts for their team
  // for the rest of the competition.
  assert.equal(ctx.fake.removeActivity(15000000001), true);

  const res = await sync(ctx, { mode: 'full', force: true });

  assert.equal(res.activitiesRemoved, 1);
  assert.equal(await countRows(ctx.db, 'deleted_at IS NOT NULL'), 1);
  const gone = await getActivity(ctx.db, 15000000001);
  assert.equal(typeof gone.deleted_at, 'number');
  // The row is still there -- a soft delete, so an un-hidden ride can come back.
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);

  // It was a 1.0 mi ride, so the board drops by exactly one mile -- in JULY, where that ride
  // lives (2026-07-05). Against August the soft delete is invisible and this would assert
  // nothing at all.
  const lb = await buildLeaderboard(ctx.db, ctx.config, { month: '2026-07', nowMs: NOW });
  assert.equal(lb.totals.miles, JUL.miles - 1);
  assert.equal(lb.teams[0].ride_count, JUL.records - 1);

  const after = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(after.watermark_epoch, before.watermark_epoch);
});

test('an incremental sync never soft-deletes, even though its window looks complete', async () => {
  const ctx = await setup();
  await sync(ctx);
  ctx.fake.removeActivity(15000000001);

  const res = await sync(ctx, { mode: 'incremental', force: true });

  // The incremental window starts at the watermark, so almost every stored ride is outside
  // what was fetched. Reconciling here would delete the whole season.
  assert.equal(res.activitiesRemoved, 0);
  assert.equal(await countRows(ctx.db, 'deleted_at IS NOT NULL'), 0);
});

test('a TRUNCATED full run soft-deletes nothing and does not advance the watermark', async () => {
  const ctx = await setup();
  await sync(ctx);
  const before = await getSyncState(ctx.db, ATHLETE_ID);
  ctx.fake.removeActivity(15000000001);

  // A client whose page budget ran out. Everything else about the run looks perfect -- which
  // is exactly why `truncated` has to be honoured rather than inferred.
  const truncating = {
    getAthlete: (token) => ctx.strava.getAthlete(token),
    refreshTokens: (rt) => ctx.strava.refreshTokens(rt),
    fetchAllActivities: async (opts) => ({ ...(await ctx.strava.fetchAllActivities(opts)), truncated: true }),
  };

  const res = await syncAthlete(ctx.db, ctx.config, truncating, ATHLETE_ID, { mode: 'full', force: true, nowMs: NOW });

  assert.equal(res.truncated, true);
  assert.equal(res.activitiesRemoved, 0, 'a partial page set is indistinguishable from mass deletion');
  assert.equal(await countRows(ctx.db, 'deleted_at IS NOT NULL'), 0);

  const after = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(after.watermark_epoch, before.watermark_epoch);
  assert.equal(after.last_full_sync_at, before.last_full_sync_at);
  assert.equal(after.truncated, 1);
});

// ------------------------------------------------------- the lock and the cooldown

test('a second immediate sync is refused with 429 {scope:"local"}, and force gets through', async () => {
  const ctx = await setup();
  const first = await sync(ctx);
  assert.equal(first.ok, true);

  await assert.rejects(
    () => sync(ctx),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.extra.scope, 'local', 'our own cooldown, not Strava\'s quota');
      assert.ok(err.extra.retry_after_seconds > 0);
      assert.ok(err.extra.retry_after_seconds <= ctx.config.syncCooldownSeconds);
      return true;
    },
  );

  // The refused attempt must leave the row exactly as the successful run left it: still 'ok',
  // unlocked, and -- critically -- with `last_sync_finished` UNMOVED, or a rider clicking
  // Refresh in a loop would push the cooldown ahead of themselves forever.
  const state = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(state.last_status, 'ok');
  assert.equal(state.lock_expires_at, null);
  assert.equal(state.last_sync_finished, NOW_SECONDS);

  const forced = await sync(ctx, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);
});

test('a live lock is a 409 with a bounded retry_after_seconds, and no request is sent', async () => {
  const ctx = await setup();
  const taken = await acquireLock(ctx.db, ATHLETE_ID, { nowEpoch: NOW_SECONDS });
  assert.equal(taken.acquired, true);

  await assert.rejects(
    () => sync(ctx),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 409);
      assert.equal(err.code, 'sync_in_progress');
      assert.ok(err.extra.retry_after_seconds > 0);
      return true;
    },
  );

  assert.equal(ctx.fake.requests.length, 0, 'a concurrent run must not burn the rate limit');
  // The other holder still owns the lock: refusing must never release it.
  const state = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(state.lock_expires_at, taken.lockExpiresAt);
});

test('a stale lock (lock_expires_at in the past) does not block a new sync', async () => {
  const ctx = await setup();
  // A process killed mid-sync. Without the TTL self-heal this athlete could never sync again.
  await acquireLock(ctx.db, ATHLETE_ID, { nowEpoch: NOW_SECONDS - 10_000 });
  const stale = await getSyncState(ctx.db, ATHLETE_ID);
  assert.ok(stale.lock_expires_at < NOW_SECONDS);
  assert.equal(stale.last_status, 'running');

  const res = await sync(ctx);

  assert.equal(res.ok, true);
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);
});

test('sweepStaleSyncLocks flips an expired lock to error rather than leaving it "running"', async () => {
  const ctx = await setup();
  await acquireLock(ctx.db, ATHLETE_ID, { nowEpoch: NOW_SECONDS - 10_000 });

  assert.equal(await sweepStaleSyncLocks(ctx.db, { nowMs: NOW }), 1);

  const state = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(state.last_status, 'error');
  assert.equal(state.lock_expires_at, null);
  // 'running' forever is indistinguishable from "in progress", so the rider's Refresh button
  // would answer 409 with nothing to point at.
  assert.match(state.last_error, /interrupted/);

  assert.equal(await sweepStaleSyncLocks(ctx.db, { nowMs: NOW }), 0, 'idempotent');
});

// ------------------------------------------------------- mode selection

test('auto mode picks incremental within a day of a full sync, and full again after one', async () => {
  const ctx = await setup();
  const first = await sync(ctx);
  assert.equal(first.mode, 'full');

  const soon = NOW + 3600_000;
  const second = await syncAthlete(ctx.db, ctx.config, ctx.strava, ATHLETE_ID, { nowMs: soon, force: true });
  assert.equal(second.mode, 'incremental');
  // The incremental window starts at the watermark (padded by a day), so it re-reads only the
  // tail -- which is the entire point of keeping one.
  assert.ok(second.activitiesScanned < EXPECTED.total_records);

  const later = NOW + 86_400_000 + 60_000;
  const third = await syncAthlete(ctx.db, ctx.config, ctx.strava, ATHLETE_ID, { nowMs: later, force: true });
  assert.equal(third.mode, 'full', 'a stale last_full_sync_at forces a rescan');
  assert.equal(third.activitiesScanned, EXPECTED.total_records);
});

test('an explicit bad mode is a 400, not a 500', async () => {
  const ctx = await setup();
  await assert.rejects(
    () => sync(ctx, { mode: 'sideways' }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 400);
      return true;
    },
  );
});

// ------------------------------------------------------- identity and grant state

test('the athlete row is refreshed, and a non-https avatar is stored as NULL', async () => {
  const ctx = await setup({
    fakeOpts: {
      athlete: {
        id: ATHLETE_ID,
        username: 'julien',
        firstname: 'Julien',
        lastname: 'Collins',
        // Strava's literal response for a photo-less athlete. Stored verbatim it renders as a
        // broken image against our own origin and throws inside the client's `new URL()`,
        // which blanks the entire roster over one rider.
        profile: 'avatar/athlete/large.png',
        profile_medium: 'avatar/athlete/medium.png',
      },
    },
  });

  await sync(ctx);

  const athlete = await ctx.db.get('SELECT display_name, avatar_url, granted_scope, team FROM athletes WHERE strava_athlete_id = ?', [ATHLETE_ID]);
  assert.equal(athlete.avatar_url, null);
  assert.equal(athlete.display_name, 'Julien C.');
  // Sync does not know the granted scope, so it must not overwrite it with ''. Doing so would
  // permanently badge the rider "private rides not counted".
  assert.equal(athlete.granted_scope, 'read,activity:read_all');
  assert.equal(athlete.team, 'EAST', 'a sync never touches the one-time team pick');
});

test('a revoked grant surfaces as StravaGrantRevokedError and keeps every activity', async () => {
  const ctx = await setup();
  await sync(ctx);
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);

  ctx.fake.revokeAthlete();
  // Expire the stored token so the sync goes through a refresh, which is where a revoked
  // grant actually announces itself (there is no revocation webhook we listen to).
  await saveTokens(
    ctx.db,
    ctx.config,
    ATHLETE_ID,
    { accessToken: 'dead', refreshToken: 'fake-refresh-1', expiresAt: NOW_SECONDS - 10, scope: 'read,activity:read_all', tokenType: 'Bearer' },
    null,
  );

  await assert.rejects(() => sync(ctx, { force: true }), (err) => {
    assert.equal(err.name, 'StravaGrantRevokedError');
    return true;
  });

  const athlete = await ctx.db.get('SELECT team, strava_revoked_at FROM athletes WHERE strava_athlete_id = ?', [ATHLETE_ID]);
  assert.equal(typeof athlete.strava_revoked_at, 'number');
  assert.equal(athlete.team, 'EAST');
  // The rider stays on the board with a frozen total and a reconnect badge, rather than
  // vanishing mid-competition and taking their team's miles with them.
  assert.equal(await countRows(ctx.db), EXPECTED.total_records);
  const lb = await buildLeaderboard(ctx.db, ctx.config, { nowMs: NOW });
  assert.equal(lb.totals.miles, AUG.miles);
  assert.equal(lb.riders[0].revoked, true);
});

test('an athlete who granted no activity scope fails fast, before any request', async () => {
  const ctx = await setup();
  await ctx.db.run('UPDATE athletes SET granted_scope = ? WHERE strava_athlete_id = ?', ['read', ATHLETE_ID]);

  await assert.rejects(() => sync(ctx), (err) => {
    assert.equal(err.name, 'StravaScopeError');
    assert.equal(err.code, 'insufficient_scope');
    return true;
  });

  assert.equal(ctx.fake.requests.length, 0, 'no point spending a request we know returns nothing');
  const state = await getSyncState(ctx.db, ATHLETE_ID);
  assert.equal(state, undefined, 'and no lock row was created');
});

test('a mid-sync 401 is refreshed once and the sync completes', async () => {
  const ctx = await setup();
  ctx.fake.expireAccessToken();

  const res = await sync(ctx);

  assert.equal(res.activitiesScanned, EXPECTED.total_records);
  const posts = ctx.fake.requests.filter((r) => r.method === 'POST' && r.pathname.endsWith('/oauth/token'));
  assert.equal(posts.length, 1, 'exactly one refresh for the whole run');
  const stored = await ctx.db.get('SELECT token_version FROM oauth_tokens WHERE athlete_id = ?', [ATHLETE_ID]);
  assert.equal(Number(stored.token_version), 1);
});

test('syncing an unknown athlete is a 404, not a foreign-key error', async () => {
  const ctx = await setup();
  await assert.rejects(
    () => syncAthlete(ctx.db, ctx.config, ctx.strava, 99, { nowMs: NOW }),
    (err) => {
      assert.ok(err instanceof HttpError);
      assert.equal(err.status, 404);
      return true;
    },
  );
});

// ------------------------------------------------------- either before/after interpretation

test('the padded window captures the UTC+13 edge ride under BOTH before/after readings', async () => {
  // [UNVERIFIED] whether Strava's before/after compare start_date or start_date_local. The
  // +/-86400 s padding is correct either way because no UTC offset exceeds 14 hours; flipping
  // the fake's interpretation is what proves it.
  const ctx = await setup({ fakeOpts: { windowField: 'start_date_local' } });

  const res = await sync(ctx);

  assert.equal(res.activitiesScanned, EXPECTED.total_records);
  assert.equal(res.activitiesCounted, EXPECTED.counted_records);
  const row = await getActivity(ctx.db, 15000000012);
  assert.equal(row.local_date, '2026-06-01');
});
