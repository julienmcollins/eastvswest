import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { freshDb, testConfig, seedAthlete, seedActivity } from './helpers/testDb.js';
import { buildLeaderboard, teamTotals, riderTotals } from '../server/db/leaderboard.js';
import { setManualApproved } from '../server/db/activities.js';
import { markRevoked } from '../server/db/athletes.js';
import { ensureSyncState, recordOk } from '../server/db/syncState.js';
import { monthSpan } from '../server/lib/dates.js';
import { MAX_PICKER_MONTHS } from '../server/contracts.js';

/**
 * Frozen instant used everywhere: 2026-08-04 in UTC, so the CURRENT month is 2026-08 and the
 * picker bounds from testConfig() are 2026-06 .. 2026-08.
 */
const NOW = Date.parse('2026-08-04T19:52:00Z');
/**
 * The month almost every test below queries EXPLICITLY.
 *
 * Every calendar month is its own competition, so `buildLeaderboard` returns exactly one
 * month and a test that relied on the default would be asserting against whatever month the
 * frozen clock happens to land in. seedActivity() defaults its rides to 2026-07-01, so this is
 * the month those rides score in -- named rather than repeated so a reader can see at a glance
 * that the numbers below are ONE MONTH's numbers.
 */
const MONTH = '2026-07';
const MILE = 1609.344;

const FIXTURE = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'leaderboard.sample.json'), 'utf8'),
);

test('a team with zero miles is still on the board -- the LEFT JOIN regression', async () => {
  const db = await freshDb();
  const config = testConfig();

  await seedAthlete(db, { id: 1, name: 'Alice A', team: 'EAST' });
  await seedAthlete(db, { id: 2, name: 'Bob B', team: 'EAST' });
  await seedAthlete(db, { id: 3, name: 'Cara C', team: 'WEST' });
  await seedActivity(db, { id: 101, athleteId: 1, meters: MILE * 10 });
  await seedActivity(db, { id: 102, athleteId: 2, meters: MILE });

  const lb = await buildLeaderboard(db, config, { month: MONTH, nowMs: NOW });

  assert.equal(lb.teams.length, 2, 'always exactly two team entries');
  assert.equal(lb.teams[0].team, 'EAST', 'EAST is always first, regardless of who leads');
  assert.equal(lb.teams[1].team, 'WEST');
  // The whole point: WEST has a member and no rides. A filter in the WHERE clause instead of
  // the ON clause would have deleted this row from the result entirely.
  assert.equal(lb.teams[1].miles, 0);
  assert.equal(lb.teams[1].ride_count, 0);
  assert.equal(lb.teams[1].rider_count, 1);
  assert.equal(lb.teams[0].miles, 11);
  assert.equal(lb.teams[0].rider_count, 2);

  assert.equal(lb.totals.miles, 11);
  assert.equal(lb.totals.ride_count, 2);
  assert.equal(lb.totals.rider_count, 3);
  assert.deepEqual(lb.leader, { team: 'EAST', margin_miles: 11 });

  // A rider with a team and no rides is present, at zero, with NO numeric rank.
  const cara = lb.riders.find((r) => r.athlete_id === 3);
  assert.equal(cara.miles, 0);
  assert.equal(cara.ride_count, 0);
  assert.equal(cara.longest_ride_miles, 0);
  assert.equal(cara.rank, null);
  assert.deepEqual(lb.riders.map((r) => r.rank), [1, 2, null]);

  await db.close();
});

test('an empty month still renders: two teams, even split, no leader', async () => {
  const db = await freshDb();
  const lb = await buildLeaderboard(db, testConfig(), { month: MONTH, nowMs: NOW });

  assert.deepEqual(lb.teams.map((t) => t.team), ['EAST', 'WEST']);
  assert.deepEqual(lb.teams.map((t) => t.miles), [0, 0]);
  // Both 0.5 rather than 0 or NaN, so the split bar is even instead of collapsed.
  assert.deepEqual(lb.teams.map((t) => t.share), [0.5, 0.5]);
  assert.equal(lb.leader, null);
  assert.deepEqual(lb.riders, []);
  assert.equal(lb.totals.miles, 0);
  assert.equal(lb.sync.last_synced_at, null, 'null drives the client empty state');
  await db.close();
});

test('a month nobody rode is a zeroed board, not an error and not another month\'s numbers', async () => {
  const db = await freshDb();
  const config = testConfig();

  // Riders, rides, and a recorded sync all exist -- just not in June. With a month picker this
  // is not an edge case but one click away at all times, so it has to be the ordinary 200 with
  // zeroes rather than anything the client needs a special branch for.
  await seedAthlete(db, { id: 1, name: 'Alice A', team: 'EAST' });
  await seedAthlete(db, { id: 2, name: 'Cara C', team: 'WEST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE * 10, localDate: '2026-07-04' });
  await ensureSyncState(db, 1);
  await recordOk(db, 1, { nowEpoch: Math.floor(NOW / 1000), activitiesUpserted: 1, pagesFetched: 1 });

  const june = await buildLeaderboard(db, config, { month: '2026-06', nowMs: NOW });

  assert.equal(june.competition.month, '2026-06');
  assert.equal(june.competition.state, 'closed', 'June is over at the frozen instant');
  assert.equal(june.totals.miles, 0, "July's rides must not leak into June");
  assert.equal(june.totals.ride_count, 0);
  assert.deepEqual(june.teams.map((t) => t.miles), [0, 0]);
  assert.deepEqual(june.teams.map((t) => t.share), [0.5, 0.5]);
  assert.equal(june.leader, null, 'nobody leads a month nobody rode');
  // The roster is NOT empty: both riders are still on the board at zero with rank null. An
  // empty `riders` here would read as "nobody has signed up" rather than "nobody rode in June".
  assert.equal(june.teams[0].rider_count, 1);
  assert.deepEqual(june.riders.map((r) => r.athlete_id), [1, 2]);
  assert.deepEqual(june.riders.map((r) => r.rank), [null, null]);
  // `sync` is about riders, not about the month, so a synced rider still reports a clock here.
  assert.equal(june.sync.last_synced_at, '2026-08-04T19:52:00.000Z');
  assert.equal(june.sync.riders_never_synced, 1);

  // ...and the same database, one month over, is not empty at all.
  assert.equal((await buildLeaderboard(db, config, { month: '2026-07', nowMs: NOW })).totals.miles, 10);
  await db.close();
});

test('everything that must not count, does not count', async () => {
  const db = await freshDb();
  const config = testConfig();

  await seedAthlete(db, { id: 1, name: 'Alice A', team: 'EAST' });
  await seedAthlete(db, { id: 9, name: 'Ghost G', team: null });

  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE });                                  // counted
  await seedActivity(db, { id: 2, athleteId: 1, meters: MILE * 10, sportType: 'Run' });
  // Out of the SELECTED MONTH by one day in each direction. Both are deliberately inside the
  // picker bounds (2026-06 .. 2026-08), so counting them would mean the query is filtering on
  // the configured range rather than on the one month asked for -- which is exactly the bug the
  // month refactor could have introduced.
  await seedActivity(db, { id: 3, athleteId: 1, meters: MILE * 10, localDate: '2026-06-30' });
  await seedActivity(db, { id: 4, athleteId: 1, meters: MILE * 10, localDate: '2026-08-01' });
  await seedActivity(db, { id: 5, athleteId: 1, meters: MILE * 10, deletedAt: 1780000000 });        // soft-deleted
  await seedActivity(db, { id: 6, athleteId: 1, meters: MILE * 10, isManual: true });
  // The canary: an e-MTB reports legacy type "Ride". A filter keyed on `type` would count it.
  await seedActivity(db, { id: 7, athleteId: 1, meters: MILE * 10, sportType: 'EMountainBikeRide', legacyType: 'Ride' });
  await seedActivity(db, { id: 8, athleteId: 9, meters: 50000 });                                   // teamless rider

  const lb = await buildLeaderboard(db, config, { month: MONTH, nowMs: NOW });
  assert.equal(lb.teams[0].miles, 1, 'only the single counted mile survives');
  assert.equal(lb.totals.miles, 1);
  assert.equal(lb.totals.ride_count, 1);
  assert.deepEqual(lb.riders.map((r) => r.athlete_id), [1], 'a rider with no team is excluded entirely');
  // And the neighbouring months are exactly the two rides this month rejected -- the rides went
  // to another board rather than nowhere.
  assert.equal((await buildLeaderboard(db, config, { month: '2026-06', nowMs: NOW })).totals.miles, 10);
  assert.equal((await buildLeaderboard(db, config, { month: '2026-08', nowMs: NOW })).totals.miles, 10);

  // The month bounds are INCLUSIVE at both ends, which is what the two rides above are testing
  // against: one day further in and they count.
  await seedActivity(db, { id: 20, athleteId: 1, meters: MILE, localDate: '2026-07-01' });
  await seedActivity(db, { id: 21, athleteId: 1, meters: MILE, localDate: '2026-07-31' });
  assert.equal((await buildLeaderboard(db, config, { month: MONTH, nowMs: NOW })).totals.miles, 3);

  // An admin-approved manual ride counts even while COUNT_MANUAL_ACTIVITIES is false.
  await setManualApproved(db, 6, true);
  assert.equal((await buildLeaderboard(db, config, { month: MONTH, nowMs: NOW })).totals.miles, 13);

  await db.close();
});

test('COUNT_MANUAL_ACTIVITIES=true counts unapproved manual rides', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE, isManual: true });

  assert.equal((await buildLeaderboard(db, testConfig(), { month: MONTH, nowMs: NOW })).totals.miles, 0);
  const counting = testConfig({ COUNT_MANUAL_ACTIVITIES: 'true' });
  assert.equal((await buildLeaderboard(db, counting, { month: MONTH, nowMs: NOW })).totals.miles, 1);
  await db.close();
});

test('a ride at 00:30 in UTC+13 scores on its LOCAL date, not its UTC date', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  // 2026-06-01T00:30 in Pacific/Auckland is 2026-05-31T11:30Z -- the day BEFORE the first
  // selectable month opens. Judged on UTC this ride vanishes; judged on the rider's own
  // calendar it counts, on June's board.
  await seedActivity(db, {
    id: 1,
    athleteId: 1,
    meters: MILE * 10,
    localDate: '2026-06-01',
    localTime: '00:30:00',
    startDateUtc: '2026-05-31T11:30:00Z',
  });

  // The same edge one month boundary later, this time entirely INSIDE the picker: 2026-08-01
  // local, 2026-07-31 in UTC. Under the monthly model the local date does not merely decide
  // whether a ride counts, it decides WHICH COMPETITION it counts in -- so judging on UTC here
  // does not drop the ride, it silently credits it to the wrong month's winner.
  await seedActivity(db, {
    id: 2,
    athleteId: 1,
    meters: MILE * 7,
    localDate: '2026-08-01',
    localTime: '00:30:00',
    startDateUtc: '2026-07-31T11:30:00Z',
  });

  const row = await db.get('SELECT start_date_utc, local_date FROM activities WHERE strava_activity_id = 1');
  assert.equal(row.start_date_utc.slice(0, 10), '2026-05-31', 'the UTC instant really is out of range');
  assert.equal(row.local_date, '2026-06-01');

  assert.equal((await buildLeaderboard(db, config, { month: '2026-06', nowMs: NOW })).totals.miles, 10);
  assert.equal((await buildLeaderboard(db, config, { month: '2026-07', nowMs: NOW })).totals.miles, 0,
    'the July board must claim neither ride: one is a June local date, the other an August one');
  assert.equal((await buildLeaderboard(db, config, { month: '2026-08', nowMs: NOW })).totals.miles, 7);
  await db.close();
});

test('100 rides of exactly one mile total 100.0, not 99.9', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  for (let i = 0; i < 100; i += 1) {
    await seedActivity(db, { id: 1000 + i, athleteId: 1, meters: MILE });
  }

  const lb = await buildLeaderboard(db, testConfig(), { month: MONTH, nowMs: NOW });
  // Meters are summed in SQL and converted once. Rounding each ride to 1 dp first (1.0 each)
  // happens to work here, but 100 rides of 0.049 mi would total 0.0 that way.
  assert.equal(lb.totals.miles, 100);
  assert.equal(lb.teams[0].miles, 100);
  assert.equal(lb.riders[0].miles, 100);
  assert.equal(lb.riders[0].ride_count, 100);
  await db.close();
});

test('ALLOWED_SPORT_TYPES is honoured at 2 entries and at 5 -- no hardcoded IN arity', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  const types = ['Ride', 'GravelRide', 'MountainBikeRide', 'VirtualRide', 'EBikeRide'];
  for (const [i, sportType] of types.entries()) {
    await seedActivity(db, { id: 200 + i, athleteId: 1, sportType, meters: MILE });
  }

  const two = testConfig({ ALLOWED_SPORT_TYPES: 'Ride,GravelRide' });
  const five = testConfig({ ALLOWED_SPORT_TYPES: types.join(',') });

  assert.equal((await buildLeaderboard(db, two, { month: MONTH, nowMs: NOW })).totals.miles, 2);
  assert.equal((await buildLeaderboard(db, testConfig(), { month: MONTH, nowMs: NOW })).totals.miles, 4);
  assert.equal((await buildLeaderboard(db, five, { month: MONTH, nowMs: NOW })).totals.miles, 5);
  await db.close();
});

test('an exact mileage tie still yields distinct ranks, in the documented tiebreak order', async () => {
  const db = await freshDb();
  const config = testConfig();

  // Every rider ends on exactly 10.0 miles.
  await seedAthlete(db, { id: 10, name: 'Zed Z', team: 'EAST' });
  await seedActivity(db, { id: 301, athleteId: 10, meters: MILE * 5 });
  await seedActivity(db, { id: 302, athleteId: 10, meters: MILE * 5 });   // 2 rides -> ranks first

  await seedAthlete(db, { id: 5, name: 'Amy A', team: 'WEST' });
  await seedActivity(db, { id: 303, athleteId: 5, meters: MILE * 10 });

  await seedAthlete(db, { id: 6, name: 'Amy A', team: 'EAST' });          // same display name
  await seedActivity(db, { id: 304, athleteId: 6, meters: MILE * 10 });

  await seedAthlete(db, { id: 7, name: 'Bob B', team: 'WEST' });
  await seedActivity(db, { id: 305, athleteId: 7, meters: MILE * 10 });

  const lb = await buildLeaderboard(db, config, { month: MONTH, nowMs: NOW });
  assert.deepEqual(lb.riders.map((r) => r.miles), [10, 10, 10, 10]);
  // miles DESC, ride_count DESC, display_name ASC, athlete_id ASC
  assert.deepEqual(lb.riders.map((r) => r.athlete_id), [10, 5, 6, 7]);
  assert.deepEqual(lb.riders.map((r) => r.rank), [1, 2, 3, 4], 'ranks never share a number');
  await db.close();
});

test('an exact team tie reports no leader', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedAthlete(db, { id: 2, team: 'WEST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE * 10 });
  await seedActivity(db, { id: 2, athleteId: 2, meters: MILE * 10 });

  const lb = await buildLeaderboard(db, testConfig(), { month: MONTH, nowMs: NOW });
  assert.equal(lb.leader, null);
  assert.deepEqual(lb.teams.map((t) => t.share), [0.5, 0.5]);

  // And a real gap produces a non-negative margin on the leading team.
  await seedActivity(db, { id: 3, athleteId: 1, meters: MILE * 5 });
  const led = await buildLeaderboard(db, testConfig(), { month: MONTH, nowMs: NOW });
  assert.deepEqual(led.leader, { team: 'EAST', margin_miles: 5 });
  assert.ok(led.leader.margin_miles >= 0);
  await db.close();
});

test('the payload matches the frozen fixture shape exactly', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, name: 'Julien Collins', team: 'EAST' });
  await seedAthlete(db, { id: 2, name: 'Dana West', team: 'WEST' });
  // Seeded in the CURRENT month on purpose: the fixture pins the `open` competition block,
  // which is the only one of the three states that carries a live `days_remaining`, and it is
  // what public/ renders on a first paint with no ?month= in the URL.
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE * 10, localDate: '2026-08-02' });
  await seedActivity(db, { id: 2, athleteId: 2, meters: MILE, localDate: '2026-08-03' });

  const lb = await buildLeaderboard(db, config, { month: '2026-08', viewerAthleteId: 1, nowMs: NOW });

  const expectedTop = Object.keys(FIXTURE).filter((k) => !k.startsWith('_'));
  assert.deepEqual(Object.keys(lb), expectedTop);
  assert.deepEqual(Object.keys(lb.competition), Object.keys(FIXTURE.competition));
  assert.deepEqual(Object.keys(lb.units), Object.keys(FIXTURE.units));
  assert.deepEqual(Object.keys(lb.teams[0]), Object.keys(FIXTURE.teams[0]));
  assert.deepEqual(Object.keys(lb.totals), Object.keys(FIXTURE.totals));
  assert.deepEqual(Object.keys(lb.leader), Object.keys(FIXTURE.leader));
  assert.deepEqual(Object.keys(lb.riders[0]), Object.keys(FIXTURE.riders[0]));
  assert.deepEqual(Object.keys(lb.sync), Object.keys(FIXTURE.sync));

  // The competition block is byte-identical to the fixture at the pinned instant.
  assert.deepEqual(lb.competition, FIXTURE.competition);
  assert.deepEqual(lb.units, { distance: 'mi' });
  assert.equal(lb.schema, FIXTURE.schema);
  assert.equal(lb.generated_at, '2026-08-04T19:52:00.000Z');

  // The payload must survive a JSON round trip unchanged (no undefined, no BigInt).
  assert.deepEqual(JSON.parse(JSON.stringify(lb)), lb);

  // Selecting a different month changes ONLY the competition block's shape-identical contents:
  // the key set is a contract, so the client renders the picker from one code path whichever
  // month is on screen.
  const june = await buildLeaderboard(db, config, { month: '2026-06', viewerAthleteId: 1, nowMs: NOW });
  assert.deepEqual(Object.keys(june.competition), Object.keys(FIXTURE.competition));
  assert.deepEqual(Object.keys(june), expectedTop);
  assert.equal(june.competition.state, 'closed');
  assert.equal(june.competition.prev_month, null);
  await db.close();
});

test('rider fields: is_you, scope badge, revoked badge, avatar normalization, sync clock', async () => {
  const db = await freshDb();
  const config = testConfig();

  await seedAthlete(db, { id: 1, name: 'Alice A', team: 'EAST', avatar: 'https://cdn.example/1/large.jpg' });
  // Exactly what Strava sends for a photo-less athlete. Normalized to null on read as well as
  // on write, because one relative URL blanks the client's whole roster.
  await seedAthlete(db, { id: 2, name: 'Bob B', team: 'WEST', avatar: 'avatar/athlete/large.png' });
  await seedAthlete(db, { id: 3, name: 'Cara C', team: 'WEST' });

  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE * 3 });
  await seedActivity(db, { id: 2, athleteId: 2, meters: MILE * 2 });
  await seedActivity(db, { id: 3, athleteId: 3, meters: MILE });

  await db.run(`UPDATE athletes SET granted_scope = ? WHERE strava_athlete_id = ?`, ['read,activity:read', 2]);
  await markRevoked(db, 3, 1780000000);

  const syncedAt = Math.floor(Date.parse('2026-08-04T18:22:01Z') / 1000);
  await ensureSyncState(db, 1);
  await recordOk(db, 1, { nowEpoch: syncedAt, activitiesUpserted: 1, pagesFetched: 1 });

  const lb = await buildLeaderboard(db, config, { month: MONTH, viewerAthleteId: 1, nowMs: NOW });
  const [alice, bob, cara] = lb.riders;

  assert.equal(alice.is_you, true);
  assert.equal(bob.is_you, false);
  assert.equal(alice.avatar_url, 'https://cdn.example/1/large.jpg');
  assert.equal(bob.avatar_url, null);
  assert.equal(alice.profile_url, 'https://www.strava.com/athletes/1');
  assert.equal(alice.private_rides_counted, true);
  assert.equal(bob.private_rides_counted, false, 'activity:read only => private rides not counted');
  assert.equal(cara.revoked, true);
  assert.equal(alice.revoked, false);
  assert.equal(alice.last_synced_at, '2026-08-04T18:22:01.000Z');
  assert.equal(bob.last_synced_at, null);

  assert.equal(lb.sync.last_synced_at, '2026-08-04T18:22:01.000Z');
  assert.equal(lb.sync.riders_never_synced, 2);

  // No session => nobody is "you".
  const anon = await buildLeaderboard(db, config, { month: MONTH, nowMs: NOW });
  assert.equal(anon.riders.every((r) => r.is_you === false), true);
  await db.close();
});

test('a month selects only its own rides, and an out-of-range month is clamped not honoured', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE, localDate: '2026-06-15' });
  await seedActivity(db, { id: 2, athleteId: 1, meters: MILE * 10, localDate: '2026-07-15' });
  await seedActivity(db, { id: 3, athleteId: 1, meters: MILE * 100, localDate: '2025-07-15' }); // last season

  // This replaces a test of the removed `window: {start, end}` option. The property it was
  // protecting still matters and is now expressed per-month: a caller can choose WHICH month,
  // never how wide the window is.
  const july = await buildLeaderboard(db, config, { month: '2026-07', nowMs: NOW });
  assert.equal(july.totals.miles, 10, 'July sees only July');

  const june = await buildLeaderboard(db, config, { month: '2026-06', nowMs: NOW });
  assert.equal(june.totals.miles, 1, 'June sees only June — months do not accumulate');

  // The 2025-07 ride is OUTSIDE the configured season and is reachable anyway, because the
  // selectable range is a union that includes every month holding data. It used to clamp to June
  // and answer 1 mile -- a request for a month with 100 real miles in it silently served a
  // different month's numbers, with nothing in the payload admitting the substitution.
  const lastSeason = await buildLeaderboard(db, config, { month: '2025-07', nowMs: NOW });
  assert.equal(lastSeason.competition.month, '2025-07', 'a month with data is never clamped away');
  assert.equal(lastSeason.competition.first_month, '2025-07');
  // And it is still ONE month's board, not a lifetime ranking: 100, never 100 + 10 + 1. That is
  // the invariant the old clamp was really protecting, and it is a property of the per-month
  // query rather than of the range.
  assert.equal(lastSeason.totals.miles, 100);
  assert.equal(lastSeason.competition.state, 'closed');

  // Out of range on either side still CLAMPS rather than 404s or returns an empty payload.
  const ancient = await buildLeaderboard(db, config, { month: '1999-01', nowMs: NOW });
  assert.equal(ancient.competition.month, '2025-07', 'clamped to the first selectable month');
  assert.equal(ancient.totals.miles, 100);

  const far = await buildLeaderboard(db, config, { month: '2099-12', nowMs: NOW });
  assert.equal(far.competition.month, '2026-08', 'clamped to the last selectable month');
  assert.equal(far.totals.miles, 0, 'August has no rides');

  // The months between the data and the configured season are offered and render EMPTY, which is
  // what keeps prev/next stepping from hitting a hole: 2025-08 has nothing at all.
  const gap = await buildLeaderboard(db, config, { month: '2025-08', nowMs: NOW });
  assert.equal(gap.competition.month, '2025-08');
  assert.equal(gap.totals.miles, 0);
  assert.equal(gap.competition.prev_month, '2025-07');

  // A null month is "absent" and means the current month in COMPETITION_TZ, which NOW pins to
  // August. Binding `undefined` is what SQLite refuses outright, so this path is load-bearing.
  const dflt = await buildLeaderboard(db, config, { month: null, nowMs: NOW });
  assert.equal(dflt.competition.month, '2026-08');
  assert.equal(dflt.totals.miles, 0);
  await db.close();
});

test('the picker range is a union of data, now, and config -- and is contiguous', async () => {
  const db = await freshDb();
  // The user's own shape of config: a ONE-MONTH season, which used to make the client hide the
  // whole picker because exactly one month was selectable.
  const config = testConfig({ COMPETITION_START: '2026-09-01', COMPETITION_END: '2026-09-30' });
  await seedAthlete(db, { id: 1, team: 'EAST' });

  // Nothing stored at all: still two months, because the current month (August, from NOW) joins
  // the configured September.
  const bare = await buildLeaderboard(db, config, { month: null, nowMs: NOW });
  assert.equal(bare.competition.first_month, '2026-08', 'the current month is always selectable');
  assert.equal(bare.competition.last_month, '2026-09', 'a configured season is never dropped');
  assert.equal(bare.competition.month, '2026-09', 'the default stays inside the configured season');
  assert.equal(bare.competition.next_month, null);
  assert.equal(bare.competition.prev_month, '2026-08');

  // A ride two months before the season widens the range to cover it, and every month in between
  // is offered so that stepping never lands on a month the server would refuse.
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE * 3, localDate: '2026-06-10' });
  const wide = await buildLeaderboard(db, config, { month: null, nowMs: NOW });
  assert.equal(wide.competition.first_month, '2026-06');
  assert.equal(wide.competition.last_month, '2026-09');

  // Walk the whole range through prev_month from the top and require every step to resolve to
  // exactly the month asked for. A gap would surface here as a clamp, and as a shorter walk.
  const walked = [];
  let cursor = wide.competition.last_month;
  while (cursor !== null) {
    const lb = await buildLeaderboard(db, config, { month: cursor, nowMs: NOW });
    assert.equal(lb.competition.month, cursor, `${cursor} must resolve to itself, not be clamped`);
    walked.push(cursor);
    cursor = lb.competition.prev_month;
  }
  assert.deepEqual(walked, ['2026-09', '2026-08', '2026-07', '2026-06']);

  // Only the month that HOLDS the ride shows it; the contiguity fillers are empty boards.
  const junE = await buildLeaderboard(db, config, { month: '2026-06', nowMs: NOW });
  assert.equal(junE.totals.miles, 3);
  const julY = await buildLeaderboard(db, config, { month: '2026-07', nowMs: NOW });
  assert.equal(julY.totals.miles, 0);
  await db.close();
});

test('only rides the board would COUNT widen the range -- not a Run, a deleted ride, or an unapproved manual', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  // Each of these is stored (sync.js rule 1 stores everything) and none of them can ever appear
  // on a board, so opening its month would offer a guaranteed-empty option and, worse, move
  // first_month somewhere no ride exists.
  await seedActivity(db, { id: 1, athleteId: 1, sportType: 'Run', localDate: '2024-01-15' });
  await seedActivity(db, { id: 2, athleteId: 1, localDate: '2024-02-15', deletedAt: 1767225600 });
  await seedActivity(db, { id: 3, athleteId: 1, localDate: '2024-03-15', isManual: true });

  const lb = await buildLeaderboard(db, config, { month: null, nowMs: NOW });
  assert.equal(lb.competition.first_month, '2026-06', 'none of the three opened its month');

  // Approving the manual ride makes it countable, so its month becomes selectable in the same
  // step -- the range is derived from the shared counted predicate, not from a second definition
  // of "has data" that could drift from it.
  await setManualApproved(db, 3, true);
  const after = await buildLeaderboard(db, config, { month: null, nowMs: NOW });
  assert.equal(after.competition.first_month, '2024-03');
  const march = await buildLeaderboard(db, config, { month: '2024-03', nowMs: NOW });
  assert.equal(march.competition.month, '2024-03');
  assert.equal(march.totals.miles, 1);
  await db.close();
});

test('MAX_PICKER_MONTHS trims the OLDEST months and always keeps the current month', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  // A ride from 1998 -- what a corrupt `start_date_local` or a fat-fingered COMPETITION_START
  // produces. Unbounded, this would ask the browser for ~340 <option> elements.
  await seedActivity(db, { id: 1, athleteId: 1, localDate: '1998-04-15' });

  const lb = await buildLeaderboard(db, config, { month: null, nowMs: NOW });
  const { first_month: first, last_month: last, current_month: current } = lb.competition;
  assert.equal(last, '2026-08');
  assert.equal(monthSpan(first, last), MAX_PICKER_MONTHS, 'capped, not merely large');
  assert.equal(first, '2016-09', 'the 120 months ending at the last selectable one');
  // The whole reason the cap trims this end: the current month is the only one that can be
  // `open`, and a cap that dropped it would hide "now" from its own picker.
  assert.ok(first <= current && current <= last, 'the current month survives the cap');

  // The far end of the cap is not a hole either -- it clamps, exactly like any out-of-range month.
  const ancient = await buildLeaderboard(db, config, { month: '1998-04', nowMs: NOW });
  assert.equal(ancient.competition.month, first, 'trimmed months clamp to the surviving oldest');
  await db.close();
});

test('a COMPETITION_END far in the future cannot cap the current month out of the picker', async () => {
  const db = await freshDb();
  // The typo this defends against: a century-long season. Trimming the oldest end here would
  // start the range in 2246 and leave the reader with no option for the month they are in.
  const config = testConfig({ COMPETITION_START: '2026-06-01', COMPETITION_END: '2260-12-31' });
  const lb = await buildLeaderboard(db, config, { month: null, nowMs: NOW });
  const { first_month: first, last_month: last, current_month: current } = lb.competition;

  assert.equal(monthSpan(first, last), MAX_PICKER_MONTHS, 'still capped');
  assert.equal(first, current, 'the current month becomes the oldest offered');
  assert.equal(first, '2026-08');
  assert.equal(last, '2036-07', 'the FUTURE end absorbs the trim once the oldest end cannot');
  await db.close();
});

test('teamTotals and riderTotals return raw meters, never rounded miles', async () => {
  const db = await freshDb();
  const config = testConfig();
  const window = { start: '2026-06-01', end: '2026-08-31' };
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: 1234.5, movingSeconds: 600 });
  await seedActivity(db, { id: 2, athleteId: 1, meters: 5678.25, movingSeconds: 900 });

  const teams = await teamTotals(db, config, window);
  const east = teams.find((t) => t.team === 'EAST');
  assert.equal(east.total_meters, 1234.5 + 5678.25);
  assert.equal(east.ride_count, 2);
  assert.equal(east.moving_seconds, 1500);

  const [rider] = await riderTotals(db, config, window);
  assert.equal(rider.meters, 1234.5 + 5678.25);
  assert.equal(rider.longest_meters, 5678.25, 'longest is a MAX over meters, not over miles');
  await db.close();
});
