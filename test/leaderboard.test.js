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

/** Frozen instant used everywhere: 2026-08-04 in UTC, 28 days left in the season. */
const NOW = Date.parse('2026-08-04T19:52:00Z');
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

  const lb = await buildLeaderboard(db, config, { nowMs: NOW });

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

test('an empty competition still renders: two teams, even split, no leader', async () => {
  const db = await freshDb();
  const lb = await buildLeaderboard(db, testConfig(), { nowMs: NOW });

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

test('everything that must not count, does not count', async () => {
  const db = await freshDb();
  const config = testConfig();

  await seedAthlete(db, { id: 1, name: 'Alice A', team: 'EAST' });
  await seedAthlete(db, { id: 9, name: 'Ghost G', team: null });

  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE });                                  // counted
  await seedActivity(db, { id: 2, athleteId: 1, meters: MILE * 10, sportType: 'Run' });
  await seedActivity(db, { id: 3, athleteId: 1, meters: MILE * 10, localDate: '2026-05-31' });      // before window
  await seedActivity(db, { id: 4, athleteId: 1, meters: MILE * 10, localDate: '2026-09-01' });      // after window
  await seedActivity(db, { id: 5, athleteId: 1, meters: MILE * 10, deletedAt: 1780000000 });        // soft-deleted
  await seedActivity(db, { id: 6, athleteId: 1, meters: MILE * 10, isManual: true });
  // The canary: an e-MTB reports legacy type "Ride". A filter keyed on `type` would count it.
  await seedActivity(db, { id: 7, athleteId: 1, meters: MILE * 10, sportType: 'EMountainBikeRide', legacyType: 'Ride' });
  await seedActivity(db, { id: 8, athleteId: 9, meters: 50000 });                                   // teamless rider

  const lb = await buildLeaderboard(db, config, { nowMs: NOW });
  assert.equal(lb.teams[0].miles, 1, 'only the single counted mile survives');
  assert.equal(lb.totals.miles, 1);
  assert.equal(lb.totals.ride_count, 1);
  assert.deepEqual(lb.riders.map((r) => r.athlete_id), [1], 'a rider with no team is excluded entirely');

  // Bounds are INCLUSIVE, which is what the two out-of-window rides above are testing against.
  await seedActivity(db, { id: 20, athleteId: 1, meters: MILE, localDate: '2026-06-01' });
  await seedActivity(db, { id: 21, athleteId: 1, meters: MILE, localDate: '2026-08-31' });
  assert.equal((await buildLeaderboard(db, config, { nowMs: NOW })).totals.miles, 3);

  // An admin-approved manual ride counts even while COUNT_MANUAL_ACTIVITIES is false.
  await setManualApproved(db, 6, true);
  assert.equal((await buildLeaderboard(db, config, { nowMs: NOW })).totals.miles, 13);

  await db.close();
});

test('COUNT_MANUAL_ACTIVITIES=true counts unapproved manual rides', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE, isManual: true });

  assert.equal((await buildLeaderboard(db, testConfig(), { nowMs: NOW })).totals.miles, 0);
  const counting = testConfig({ COUNT_MANUAL_ACTIVITIES: 'true' });
  assert.equal((await buildLeaderboard(db, counting, { nowMs: NOW })).totals.miles, 1);
  await db.close();
});

test('a ride at 00:30 in UTC+13 scores on its LOCAL date, not its UTC date', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  // 2026-06-01T00:30 in Pacific/Auckland is 2026-05-31T11:30Z -- the day BEFORE the season
  // opens. Judged on UTC this ride vanishes; judged on the rider's own calendar it counts.
  await seedActivity(db, {
    id: 1,
    athleteId: 1,
    meters: MILE * 10,
    localDate: '2026-06-01',
    localTime: '00:30:00',
    startDateUtc: '2026-05-31T11:30:00Z',
  });

  const row = await db.get('SELECT start_date_utc, local_date FROM activities WHERE strava_activity_id = 1');
  assert.equal(row.start_date_utc.slice(0, 10), '2026-05-31', 'the UTC instant really is out of window');
  assert.equal(row.local_date, '2026-06-01');

  assert.equal((await buildLeaderboard(db, config, { nowMs: NOW })).totals.miles, 10);
  await db.close();
});

test('100 rides of exactly one mile total 100.0, not 99.9', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  for (let i = 0; i < 100; i += 1) {
    await seedActivity(db, { id: 1000 + i, athleteId: 1, meters: MILE });
  }

  const lb = await buildLeaderboard(db, testConfig(), { nowMs: NOW });
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

  assert.equal((await buildLeaderboard(db, two, { nowMs: NOW })).totals.miles, 2);
  assert.equal((await buildLeaderboard(db, testConfig(), { nowMs: NOW })).totals.miles, 4);
  assert.equal((await buildLeaderboard(db, five, { nowMs: NOW })).totals.miles, 5);
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

  const lb = await buildLeaderboard(db, config, { nowMs: NOW });
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

  const lb = await buildLeaderboard(db, testConfig(), { nowMs: NOW });
  assert.equal(lb.leader, null);
  assert.deepEqual(lb.teams.map((t) => t.share), [0.5, 0.5]);

  // And a real gap produces a non-negative margin on the leading team.
  await seedActivity(db, { id: 3, athleteId: 1, meters: MILE * 5 });
  const led = await buildLeaderboard(db, testConfig(), { nowMs: NOW });
  assert.deepEqual(led.leader, { team: 'EAST', margin_miles: 5 });
  assert.ok(led.leader.margin_miles >= 0);
  await db.close();
});

test('the payload matches the frozen fixture shape exactly', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, name: 'Julien Collins', team: 'EAST' });
  await seedAthlete(db, { id: 2, name: 'Dana West', team: 'WEST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE * 10 });
  await seedActivity(db, { id: 2, athleteId: 2, meters: MILE });

  const lb = await buildLeaderboard(db, config, { viewerAthleteId: 1, nowMs: NOW });

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

  const lb = await buildLeaderboard(db, config, { viewerAthleteId: 1, nowMs: NOW });
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
  const anon = await buildLeaderboard(db, config, { nowMs: NOW });
  assert.equal(anon.riders.every((r) => r.is_you === false), true);
  await db.close();
});

test('the window narrows on request but can never widen past the competition', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, meters: MILE, localDate: '2026-06-15' });
  await seedActivity(db, { id: 2, athleteId: 1, meters: MILE * 10, localDate: '2026-07-15' });
  await seedActivity(db, { id: 3, athleteId: 1, meters: MILE * 100, localDate: '2025-07-15' }); // last season

  const july = await buildLeaderboard(db, config, { window: { start: '2026-07-01', end: '2026-07-31' }, nowMs: NOW });
  assert.equal(july.totals.miles, 10);

  const alltime = await buildLeaderboard(db, config, { window: { start: '2000-01-01', end: '2099-01-01' }, nowMs: NOW });
  assert.equal(alltime.totals.miles, 11, 'last season stays out no matter what the query asks for');

  const garbage = await buildLeaderboard(db, config, { window: { start: 'nope', end: null }, nowMs: NOW });
  assert.equal(garbage.totals.miles, 11);
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
