import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, testConfig, seedAthlete, seedActivity } from './helpers/testDb.js';
import {
  upsertAthleteFromStrava, getAthlete, claimTeam, adminSetTeam, setAdmin, listAthletes,
  markRevoked, clearRevoked, markDisconnected, deleteAthlete,
  displayNameFrom, normalizeAvatarUrl,
} from '../server/db/athletes.js';
import { saveTokens, loadTokens, deleteTokens, hasTokens } from '../server/db/tokens.js';
import {
  upsertActivities, reconcileDeletions, listAthleteActivities, purgeAthleteActivities,
  setManualApproved, getActivity, maxStartEpoch,
  activityMonthExtent, activityMonthlyTotals,
} from '../server/db/activities.js';
import {
  insertSession, findSessionByHash, touchSession, deleteSession,
  deleteSessionsForAthlete, purgeExpiredSessions,
} from '../server/db/sessions.js';
import { insertState, consumeState, purgeExpiredStates, enforceStateCap, countStates } from '../server/db/oauthStates.js';
import {
  getSyncState, ensureSyncState, acquireLock, releaseLock, recordOk, recordError,
  advanceWatermark, sweepStaleLocks,
} from '../server/db/syncState.js';

const MILE = 1609.344;

/** A minimal Strava /athlete payload. */
function stravaAthlete(overrides = {}) {
  return { id: 7, username: 'jc', firstname: 'Julien', lastname: 'Collins', profile: 'avatar/athlete/large.png', ...overrides };
}

/** One normalized activity, in the column-named shape the mapper produces. */
function activityRow(overrides = {}) {
  const startLocal = '2026-07-01T08:00:00Z';
  return {
    strava_activity_id: 15000000001,
    name: 'Morning Ride',
    sport_type: 'Ride',
    legacy_type: 'Ride',
    sport_type_source: 'sport_type',
    distance_meters: MILE * 10,
    moving_time_seconds: 3600,
    elapsed_time_seconds: 3700,
    total_elevation_gain_meters: 120.5,
    start_date_utc: '2026-07-01T08:00:00Z',
    start_epoch: Math.floor(Date.parse('2026-07-01T08:00:00Z') / 1000),
    start_date_local: startLocal,
    timezone: '(GMT-05:00) America/New_York',
    is_private: false,
    is_manual: false,
    is_trainer: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------- athletes

test('upsertAthleteFromStrava derives a display name and normalizes the avatar', async () => {
  const db = await freshDb();

  const a = await upsertAthleteFromStrava(db, stravaAthlete(), { grantedScope: 'read,activity:read_all' });
  assert.equal(a.strava_athlete_id, 7);
  assert.equal(a.display_name, 'Julien C.');
  // Strava's bare relative string for a photo-less athlete must land as NULL, not as a broken src.
  assert.equal(a.avatar_url, null);
  assert.equal(a.granted_scope, 'read,activity:read_all');

  assert.equal(normalizeAvatarUrl('avatar/athlete/large.png'), null);
  assert.equal(normalizeAvatarUrl('http://cdn.example/x.png'), null, 'http is not https');
  assert.equal(normalizeAvatarUrl(undefined), null);
  assert.equal(normalizeAvatarUrl('https://cdn.example/x.png'), 'https://cdn.example/x.png');

  assert.equal(displayNameFrom({ firstname: 'Julien', lastname: 'Collins' }), 'Julien C.');
  assert.equal(displayNameFrom({ firstname: 'Cher' }), 'Cher');
  assert.equal(displayNameFrom({ username: 'solo' }), 'solo');
  assert.equal(displayNameFrom({ id: 5 }), 'Athlete 5');
  // A surrogate pair must not be sliced in half by `lastname[0]`.
  assert.equal(displayNameFrom({ firstname: 'A', lastname: '\u{1F600}B' }), 'A \u{1F600}.');

  await db.close();
});

test('a re-login refreshes the profile but never resets team or scope', async () => {
  const db = await freshDb();
  await upsertAthleteFromStrava(db, stravaAthlete(), { grantedScope: 'read,activity:read_all' });
  assert.equal(await claimTeam(db, 7, 'EAST'), 'EAST');

  // Sync's athlete refresh: no scope known, new photo, same identity.
  const again = await upsertAthleteFromStrava(db, stravaAthlete({ firstname: 'Julien', lastname: 'Collins', profile: 'https://cdn.example/7/large.jpg' }));
  assert.equal(again.team, 'EAST', 'the one-time pick survives, so the picker does not reappear');
  assert.ok(again.team_locked_at);
  assert.equal(again.granted_scope, 'read,activity:read_all', 'an unknown scope must not wipe read_all');
  assert.equal(again.avatar_url, 'https://cdn.example/7/large.jpg');

  const rows = await db.all('SELECT strava_athlete_id FROM athletes');
  assert.equal(rows.length, 1, 'matching on athlete.id means one row, not two');
  await db.close();
});

test('claimTeam is a one-shot: the second call loses', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: null });

  assert.equal(await claimTeam(db, 1, 'EAST'), 'EAST');
  // A read-then-write would let this one win too, silently moving the rider.
  assert.equal(await claimTeam(db, 1, 'WEST'), undefined);
  assert.equal((await getAthlete(db, 1)).team, 'EAST');

  assert.equal(await claimTeam(db, 404, 'EAST'), undefined, 'no such athlete is also undefined');
  await assert.rejects(() => claimTeam(db, 1, 'NORTH'), /Invalid team/);
  await db.close();
});

test('admin mutations report whether they matched a row', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, name: 'Alice A', team: 'EAST' });

  assert.equal(await adminSetTeam(db, 1, 'WEST'), true);
  assert.equal((await getAthlete(db, 1)).team, 'WEST');
  assert.equal(await adminSetTeam(db, 404, 'WEST'), false, 'false is how the route knows to 404');

  assert.equal(await setAdmin(db, 1, true), true);
  assert.equal((await getAthlete(db, 1)).is_admin, 1);
  assert.equal(await setAdmin(db, 1, false), true);
  assert.equal((await getAthlete(db, 1)).is_admin, 0);

  assert.equal(await markRevoked(db, 1, 1780000000), true);
  assert.equal((await getAthlete(db, 1)).strava_revoked_at, 1780000000);
  assert.equal(await markDisconnected(db, 1, 1780000001), true);
  assert.equal(await clearRevoked(db, 1), true);
  const cleared = await getAthlete(db, 1);
  assert.equal(cleared.strava_revoked_at, null);
  assert.equal(cleared.disconnected_at, null);
  await db.close();
});

test('listAthletes joins the sync clock and counts pending manual rides', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 2, name: 'Bob B', team: 'WEST' });
  await seedAthlete(db, { id: 1, name: 'Alice A', team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, isManual: true });
  await seedActivity(db, { id: 2, athleteId: 1, isManual: true, manualApproved: true });
  await seedActivity(db, { id: 3, athleteId: 1, isManual: true, deletedAt: 1780000000 });
  await ensureSyncState(db, 1);
  await recordOk(db, 1, { nowEpoch: 1780000000 });

  const rows = await listAthletes(db);
  assert.deepEqual(rows.map((r) => r.athlete_id), [1, 2], 'ordered by display name');
  assert.equal(rows[0].pending_manual, 1, 'approved and deleted manual rides are not pending');
  assert.equal(rows[0].last_sync_finished, 1780000000);
  assert.equal(rows[1].pending_manual, 0);
  assert.equal(rows[1].last_sync_finished, null);
  await db.close();
});

test('deleting an athlete cascades to tokens, sessions, activities and sync state', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1 });
  await saveTokens(db, config, 1, { accessToken: 'access-alpha', refreshToken: 'refresh-alpha', expiresAt: 1780000000 });
  await insertSession(db, { sessionIdHash: 'h1', athleteId: 1, createdAt: 0, expiresAt: 99999 });
  await ensureSyncState(db, 1);

  assert.equal(await deleteAthlete(db, 1), true);
  for (const table of ['activities', 'oauth_tokens', 'sessions', 'sync_state']) {
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`);
    assert.equal(row.n, 0, `${table} must cascade`);
  }
  await db.close();
});

// ------------------------------------------------------------------------------ tokens

test('tokens round-trip through encryption and never store plaintext', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  const first = await saveTokens(db, config, 1, {
    accessToken: 'access-token-alpha-0001',
    refreshToken: 'refresh-token-alpha-0001',
    expiresAt: 1780000000,
    scope: 'read,activity:read_all',
    tokenType: 'Bearer',
  });
  assert.deepEqual(first, { ok: true, version: 0 });

  const loaded = await loadTokens(db, config, 1);
  assert.equal(loaded.accessToken, 'access-token-alpha-0001');
  assert.equal(loaded.refreshToken, 'refresh-token-alpha-0001');
  assert.equal(loaded.expiresAt, 1780000000);
  assert.equal(loaded.scope, 'read,activity:read_all');
  assert.equal(loaded.tokenType, 'Bearer');
  assert.equal(loaded.tokenVersion, 0);

  const row = await db.get('SELECT access_token_enc, refresh_token_enc FROM oauth_tokens WHERE athlete_id = 1');
  assert.match(row.access_token_enc, /^v1\./, 'versioned envelope, so the key can be rotated');
  assert.equal(row.access_token_enc.includes('access-token-alpha-0001'), false);
  assert.equal(row.refresh_token_enc.includes('refresh-token-alpha-0001'), false);

  assert.equal(await hasTokens(db, 1), true);
  assert.equal(await loadTokens(db, config, 404), null);
  await db.close();
});

test('sealing the same refresh token twice yields DIFFERENT ciphertext -- why the CAS is on token_version', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  const same = { accessToken: 'access-same', refreshToken: 'refresh-token-identical', expiresAt: 1780000000 };
  await saveTokens(db, config, 1, same);
  const a = (await db.get('SELECT refresh_token_enc FROM oauth_tokens WHERE athlete_id = 1')).refresh_token_enc;
  await saveTokens(db, config, 1, same);
  const b = (await db.get('SELECT refresh_token_enc FROM oauth_tokens WHERE athlete_id = 1')).refresh_token_enc;

  // A fresh random IV per seal. This is exactly why `WHERE refresh_token_enc = ?` would match
  // zero rows on every refresh, discard each rotated token, and lock every athlete out.
  assert.notEqual(a, b);
  assert.equal((await loadTokens(db, config, 1)).refreshToken, 'refresh-token-identical');
  await db.close();
});

test('a stale expectedVersion loses the CAS and overwrites nothing', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  await saveTokens(db, config, 1, { accessToken: 'access-v0', refreshToken: 'refresh-v0', expiresAt: 1 });
  const winner = await saveTokens(db, config, 1, { accessToken: 'access-v1', refreshToken: 'refresh-v1', expiresAt: 2 }, 0);
  assert.deepEqual(winner, { ok: true, version: 1 });

  // The loser presents the version it read a moment ago; someone else already rotated.
  const loser = await saveTokens(db, config, 1, { accessToken: 'access-stale', refreshToken: 'refresh-stale', expiresAt: 3 }, 0);
  assert.equal(loser.ok, false);
  assert.equal(loser.version, 1, 'the caller is told which version actually won');

  const stored = await loadTokens(db, config, 1);
  assert.equal(stored.accessToken, 'access-v1', 'the winner\'s token must survive');
  assert.equal(stored.refreshToken, 'refresh-v1');
  assert.equal(stored.expiresAt, 2);
  assert.equal(stored.tokenVersion, 1);

  // A CAS against a row that does not exist is a loss, not an insert.
  await seedAthlete(db, { id: 2, team: 'EAST' });
  const missing = await saveTokens(db, config, 2, { accessToken: 'a', refreshToken: 'r', expiresAt: 1 }, 0);
  assert.equal(missing.ok, false);

  assert.equal(await deleteTokens(db, 1), true);
  assert.equal(await loadTokens(db, config, 1), null);
  assert.equal(await deleteTokens(db, 1), false);
  await db.close();
});

test('saveTokens refuses a token set it could never refresh', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await assert.rejects(() => saveTokens(db, config, 1, { accessToken: 'a', refreshToken: '', expiresAt: 1 }), /refreshToken/);
  await assert.rejects(() => saveTokens(db, config, 1, { accessToken: '', refreshToken: 'r', expiresAt: 1 }), /accessToken/);
  await assert.rejects(() => saveTokens(db, config, 1, { accessToken: 'a', refreshToken: 'r', expiresAt: 'soon' }), /expiresAt/);
  await db.close();
});

// -------------------------------------------------------------------------- activities

test('upsertActivities is idempotent and updates in place', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  const written = await upsertActivities(db, 1, [activityRow(), activityRow({ strava_activity_id: 2, start_date_local: '2026-07-02T08:00:00Z' })]);
  assert.equal(written, 2);
  const count = async () => Number((await db.get('SELECT COUNT(*) AS n FROM activities')).n);
  assert.equal(await count(), 2);

  // The same payload again: Strava's id is the primary key, so a re-sync cannot double-count.
  await upsertActivities(db, 1, [activityRow(), activityRow({ strava_activity_id: 2, start_date_local: '2026-07-02T08:00:00Z' })]);
  assert.equal(await count(), 2);

  // An edited ride updates in place, and the generated local_date follows start_date_local.
  await upsertActivities(db, 1, [activityRow({ distance_meters: 42195, start_date_local: '2026-07-09T08:00:00Z', name: 'Corrected' })]);
  const row = await getActivity(db, 15000000001);
  assert.equal(await count(), 2);
  assert.equal(row.distance_meters, 42195);
  assert.equal(row.name, 'Corrected');
  assert.equal(row.local_date, '2026-07-09', 'local_date is GENERATED and recomputes itself');

  assert.equal(await upsertActivities(db, 1, []), 0);
  await db.close();
});

test('a reappearing ride is un-deleted, and admin approval survives a re-sync', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await upsertActivities(db, 1, [activityRow({ is_manual: true })]);
  await setManualApproved(db, 15000000001, true);
  await db.run('UPDATE activities SET deleted_at = ? WHERE strava_activity_id = ?', [1780000000, 15000000001]);

  await upsertActivities(db, 1, [activityRow({ is_manual: true })]);
  const row = await getActivity(db, 15000000001);
  assert.equal(row.deleted_at, null, 'a ride Strava reports again must come back');
  assert.equal(row.manual_approved, 1, 'manual_approved is admin state, not Strava state');
  await db.close();
});

test('upsertActivities binds raw booleans and nulls that node:sqlite would reject', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await upsertActivities(db, 1, [activityRow({ is_private: true, is_trainer: true, timezone: null, legacy_type: null })]);
  const row = await getActivity(db, 15000000001);
  assert.equal(row.is_private, 1);
  assert.equal(row.is_trainer, 1);
  assert.equal(row.timezone, null);
  assert.equal(row.legacy_type, null);
  await db.close();
});

test('upsertActivities throws on a malformed row rather than writing NaN', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  const bad = activityRow();
  delete bad.distance_meters;
  await assert.rejects(() => upsertActivities(db, 1, [bad]), /distance_meters/);
  await assert.rejects(() => upsertActivities(db, 1, [activityRow({ distance_meters: Number.NaN })]), /distance_meters/);
  await assert.rejects(() => upsertActivities(db, 1, [activityRow({ sport_type: undefined })]), /sport_type/);
  await assert.rejects(() => upsertActivities(db, 1, [activityRow({ start_epoch: 'yesterday' })]), /start_epoch/);
  await assert.rejects(() => upsertActivities(db, 1, [activityRow({ sport_type_source: 'guess' })]), /sport_type_source/);

  // And validation happens BEFORE the transaction opens, so a good row in the same batch is
  // not half-written.
  await assert.rejects(() => upsertActivities(db, 1, [activityRow({ strava_activity_id: 99 }), bad]));
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM activities')).n), 0);
  await db.close();
});

test('reconcileDeletions soft-deletes only in-window rides Strava stopped reporting', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, localDate: '2026-07-05' });
  await seedActivity(db, { id: 2, athleteId: 1, localDate: '2026-07-06' });
  await seedActivity(db, { id: 3, athleteId: 1, localDate: '2026-06-01' }); // outside the fetch window

  const startEpoch = Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000);
  const endEpoch = Math.floor(Date.parse('2026-07-31T00:00:00Z') / 1000);
  const nowEpoch = 1780000000;

  // Strava returned only id 1. Ids are passed as strings on purpose: SQLite compares across
  // storage classes, so an uncoerced '1' would be NOT IN (1) and would delete everything.
  const deleted = await reconcileDeletions(db, 1, { startEpoch, endEpoch }, ['1'], nowEpoch);
  assert.equal(deleted, 1);
  assert.equal((await getActivity(db, 1)).deleted_at, null);
  assert.equal((await getActivity(db, 2)).deleted_at, nowEpoch);
  assert.equal((await getActivity(db, 3)).deleted_at, null, 'out-of-window rides are untouched');

  // Idempotent: already-deleted rows are skipped by `deleted_at IS NULL`.
  assert.equal(await reconcileDeletions(db, 1, { startEpoch, endEpoch }, [1], nowEpoch), 0);

  // An empty seenIds after a COMPLETE fetch means the rider deleted everything in the window.
  assert.equal(await reconcileDeletions(db, 1, { startEpoch, endEpoch }, [], nowEpoch), 1);
  assert.equal((await getActivity(db, 1)).deleted_at, nowEpoch);
  assert.equal((await getActivity(db, 3)).deleted_at, null);

  // A large seen-set builds its placeholders from the array length.
  const many = Array.from({ length: 2000 }, (_, i) => 900000 + i);
  assert.equal(await reconcileDeletions(db, 1, { startEpoch, endEpoch }, many, nowEpoch), 0);
  await db.close();
});

test('reconcileDeletions never touches another athlete', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedAthlete(db, { id: 2, team: 'WEST' });
  await seedActivity(db, { id: 1, athleteId: 1, localDate: '2026-07-05' });
  await seedActivity(db, { id: 2, athleteId: 2, localDate: '2026-07-05' });

  const startEpoch = Math.floor(Date.parse('2026-07-01T00:00:00Z') / 1000);
  const endEpoch = Math.floor(Date.parse('2026-07-31T00:00:00Z') / 1000);
  assert.equal(await reconcileDeletions(db, 1, { startEpoch, endEpoch }, [], 1780000000), 1);
  assert.equal((await getActivity(db, 2)).deleted_at, null);
  await db.close();
});

test('listAthleteActivities flags counted rides consistently with the totals', async () => {
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, localDate: '2026-07-05' });
  await seedActivity(db, { id: 2, athleteId: 1, localDate: '2026-07-06', sportType: 'Run' });
  await seedActivity(db, { id: 3, athleteId: 1, localDate: '2026-07-07', isManual: true });
  await seedActivity(db, { id: 4, athleteId: 1, localDate: '2026-07-08', deletedAt: 1780000000 });

  const rows = await listAthleteActivities(db, config, 1, { start: '2026-06-01', end: '2026-08-31' });
  assert.deepEqual(rows.map((r) => r.strava_activity_id), [3, 2, 1], 'newest first, soft-deleted excluded');
  const byId = new Map(rows.map((r) => [r.strava_activity_id, r.counted]));
  assert.equal(byId.get(1), 1);
  assert.equal(byId.get(2), 0, 'a Run is stored but not counted');
  assert.equal(byId.get(3), 0, 'an unapproved manual ride is stored but not counted');

  await setManualApproved(db, 3, true);
  const after = await listAthleteActivities(db, config, 1, { start: '2026-06-01', end: '2026-08-31' });
  assert.equal(after.find((r) => r.strava_activity_id === 3).counted, 1);

  assert.equal(await setManualApproved(db, 404, true), false);
  assert.equal(await getActivity(db, 404), undefined);
  await db.close();
});

test('purgeAthleteActivities really deletes, and maxStartEpoch tracks the watermark ground truth', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, { id: 1, athleteId: 1, localDate: '2026-07-05' });
  await seedActivity(db, { id: 2, athleteId: 1, localDate: '2026-07-09' });

  assert.equal(await maxStartEpoch(db, 1), Math.floor(Date.parse('2026-07-09T08:00:00Z') / 1000));
  assert.equal(await purgeAthleteActivities(db, 1), 2);
  assert.equal(await maxStartEpoch(db, 1), 0);
  await db.close();
});

test('activityMonthlyTotals shows the GAP that activityMonthExtent cannot', async () => {
  // The point of having both. The extent query answers {first, last}, which is all the fetch floor
  // and the month picker need -- and which reports the SAME answer for a backfill that recovered
  // every month and one that recovered only the two ends. That is the failure being debugged: a
  // sync covering January and August while silently missing everything between them.
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  await seedActivity(db, { id: 1, athleteId: 1, localDate: '2026-06-05', meters: MILE });
  await seedActivity(db, { id: 2, athleteId: 1, localDate: '2026-06-20', meters: MILE * 2 });
  // Nothing at all in July -- the hole.
  await seedActivity(db, { id: 3, athleteId: 1, localDate: '2026-08-02', meters: MILE * 10 });

  assert.deepEqual(await activityMonthExtent(db, config), { first: '2026-06', last: '2026-08' },
    'the extent spans the hole without revealing it');

  assert.deepEqual(await activityMonthlyTotals(db, config), [
    { month: '2026-06', ride_count: 2, meters: MILE * 3 },
    { month: '2026-08', ride_count: 1, meters: MILE * 10 },
  ], 'July must be ABSENT, not reported as zero -- the gap is the signal');
});

test('activityMonthlyTotals counts exactly what the board counts, and scopes by athlete', async () => {
  // It reuses `countedPredicate`, and that reuse is the whole value: "July has 12 rides" has to
  // mean "12 rides appear on July's board". A plain COUNT(*) would count Runs, soft-deleted rows
  // and unapproved manual entries, so a backfill would look successful while the board stayed
  // empty -- a verification number that disagrees with the thing it verifies is worse than none.
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedAthlete(db, { id: 2, team: 'WEST' });

  await seedActivity(db, { id: 1, athleteId: 1, localDate: '2026-07-05', meters: MILE });
  await seedActivity(db, { id: 2, athleteId: 1, localDate: '2026-07-06', sportType: 'Run' });
  await seedActivity(db, { id: 3, athleteId: 1, localDate: '2026-07-07', isManual: true });
  await seedActivity(db, { id: 4, athleteId: 1, localDate: '2026-07-08', deletedAt: 1780000000 });
  await seedActivity(db, { id: 5, athleteId: 2, localDate: '2026-07-09', meters: MILE * 5 });

  assert.deepEqual(await activityMonthlyTotals(db, config, { athleteId: 1 }), [
    { month: '2026-07', ride_count: 1, meters: MILE },
  ], 'the Run, the unapproved manual ride and the soft-deleted row are all excluded');

  // Admin approval flips a manual ride onto the board, so it must flip here in the same breath.
  await setManualApproved(db, 3, true);
  assert.deepEqual(await activityMonthlyTotals(db, config, { athleteId: 1 }), [
    { month: '2026-07', ride_count: 2, meters: MILE * 2 },
  ]);

  // Scoped: rider 2's five miles belong to rider 2 and to the unscoped total, nobody else.
  assert.deepEqual(await activityMonthlyTotals(db, config, { athleteId: 2 }), [
    { month: '2026-07', ride_count: 1, meters: MILE * 5 },
  ]);
  assert.deepEqual(await activityMonthlyTotals(db, config), [
    { month: '2026-07', ride_count: 3, meters: MILE * 7 },
  ]);

  // Empty is an empty array, not a row of nulls: `MIN/MAX` over no rows returns one NULL row,
  // which is why the extent query needs its `?? null` and this one does not.
  assert.deepEqual(await activityMonthlyTotals(db, config, { athleteId: 404 }), []);
  await db.close();
});

test('activityMonthlyTotals keys the month off the LOCAL date, never the UTC instant', async () => {
  // The Auckland 00:30-local ride. `start_date_local` carries a bogus trailing Z, so parsing it as
  // an instant shifts the date by the rider's UTC offset -- here it would move a July 1 ride back
  // into June and credit it to the wrong month's competition.
  const db = await freshDb();
  const config = testConfig();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedActivity(db, {
    id: 1,
    athleteId: 1,
    localDate: '2026-07-01',
    localTime: '00:30:00',
    startDateUtc: '2026-06-30T11:30:00Z',
    meters: MILE,
  });

  assert.deepEqual(await activityMonthlyTotals(db, config), [
    { month: '2026-07', ride_count: 1, meters: MILE },
  ]);
  await db.close();
});

// ------------------------------------------------------------------------------ sessions

test('findSessionByHash selects last_seen_at, without which touch logic silently dies', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await insertSession(db, {
    sessionIdHash: 'hash-a', athleteId: 1, createdAt: 1000, expiresAt: 5000, lastSeenAt: 1000, userAgent: 'agent/1',
  });

  const row = await findSessionByHash(db, 'hash-a');
  assert.ok(Object.hasOwn(row, 'last_seen_at'), 'omit this column and `now - undefined > 300` is NaN > 300 => false, forever');
  assert.equal(row.last_seen_at, 1000);
  assert.equal(row.athlete_id, 1);
  assert.equal(row.expires_at, 5000, 'expiry is returned so the caller enforces it against its own clock');
  assert.equal(row.user_agent, 'agent/1');

  // The realistic call: a session last seen 400 s ago gets its column advanced.
  const now = row.last_seen_at + 400;
  assert.equal(now - row.last_seen_at > 300, true);
  assert.equal(await touchSession(db, 'hash-a', now), true);
  assert.equal((await findSessionByHash(db, 'hash-a')).last_seen_at, now);

  assert.equal(await findSessionByHash(db, 'nope'), undefined);
  assert.equal(await touchSession(db, 'nope', now), false);
  await db.close();
});

test('sessions: defaults, single delete, per-athlete delete, expiry sweep', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedAthlete(db, { id: 2, team: 'WEST' });

  // lastSeenAt and userAgent omitted: both columns are NOT NULL, and the adapter binds
  // `undefined` as NULL, so they are defaulted in JS rather than by the column DEFAULT.
  await insertSession(db, { sessionIdHash: 'h1', athleteId: 1, createdAt: 100, expiresAt: 900 });
  const bare = await findSessionByHash(db, 'h1');
  assert.equal(bare.last_seen_at, 100);
  assert.equal(bare.user_agent, '');

  await insertSession(db, { sessionIdHash: 'h2', athleteId: 1, createdAt: 100, expiresAt: 100000, userAgent: 'x'.repeat(1000) });
  assert.equal((await findSessionByHash(db, 'h2')).user_agent.length, 256, 'a hostile UA header is truncated');
  await insertSession(db, { sessionIdHash: 'h3', athleteId: 2, createdAt: 100, expiresAt: 100000 });

  assert.equal(await deleteSession(db, 'h2'), true);
  assert.equal(await deleteSession(db, 'h2'), false, 'logout is idempotent');

  assert.equal(await purgeExpiredSessions(db, 1000), 1, 'h1 was expired');
  assert.equal(await deleteSessionsForAthlete(db, 2), 1, 'a privilege change drops every session');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM sessions')).n), 0);
  await db.close();
});

// --------------------------------------------------------------------------- oauth states

test('an oauth state is single-use, and insert sweeps expired rows', async () => {
  const db = await freshDb();

  await insertState(db, { stateHash: 'old', nonceHash: 'n0', expiresAt: 500, returnTo: '/', nowEpoch: 100 });
  // The insert at t=1000 purges anything already expired, so the table is swept by exactly
  // the traffic that grows it.
  await insertState(db, { stateHash: 's1', nonceHash: 'n1', expiresAt: 1600, returnTo: '/board', nowEpoch: 1000 });
  assert.equal(await countStates(db), 1);

  const consumed = await consumeState(db, 's1');
  // Field-by-field, not deepEqual against a literal: node:sqlite returns null-prototype rows,
  // which deepStrictEqual reports as unequal to a plain object.
  assert.equal(consumed.nonce_hash, 'n1');
  assert.equal(consumed.return_to, '/board');
  assert.equal(consumed.expires_at, 1600, 'expiry comes back so the caller can tell expired from replayed');
  // DELETE..RETURNING is what makes replay impossible; a SELECT-then-DELETE leaves a window
  // where two concurrent callbacks both mint a session.
  assert.equal(await consumeState(db, 's1'), undefined);

  await insertState(db, { stateHash: 's2', nonceHash: 'n2', expiresAt: 2000, nowEpoch: 1500 });
  assert.equal((await consumeState(db, 's2')).return_to, '/', 'returnTo defaults to /');
  await db.close();
});

test('pending states are bounded by both a TTL and a hard row cap', async () => {
  const db = await freshDb();
  for (let i = 0; i < 6; i += 1) {
    await insertState(db, { stateHash: `s${i}`, nonceHash: 'n', expiresAt: 100000, nowEpoch: 1000 + i });
  }
  assert.equal(await countStates(db), 6);

  // Keep the newest 2. Without a cap, /login -- an unauthenticated GET that writes a row -- is
  // an unbounded growth vector for the whole 600 s TTL.
  assert.equal(await enforceStateCap(db, 2), 4);
  const left = await db.all('SELECT state_hash FROM oauth_states ORDER BY created_at DESC');
  assert.deepEqual(left.map((r) => r.state_hash), ['s5', 's4']);

  assert.equal(await purgeExpiredStates(db, 200000), 2);
  assert.equal(await countStates(db), 0);
  await assert.rejects(() => enforceStateCap(db, 0), /positive integer/);
  await db.close();
});

// ---------------------------------------------------------------------------- sync state

test('the sync lock is atomic, self-healing, and reports a retry delay', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });

  const first = await acquireLock(db, 1, { nowEpoch: 1000, ttlSeconds: 300 });
  assert.equal(first.acquired, true);
  assert.equal(first.lockExpiresAt, 1300);
  assert.equal((await getSyncState(db, 1)).last_status, 'running');

  // A double-clicked Refresh. A read-then-write would let this one through and burn double the
  // rate-limit budget.
  const second = await acquireLock(db, 1, { nowEpoch: 1010, ttlSeconds: 300 });
  assert.equal(second.acquired, false);
  assert.equal(second.retryAfterSeconds, 290);

  // Self-heal: the holder died without releasing, so the lock expires on its own.
  const afterTtl = await acquireLock(db, 1, { nowEpoch: 1400, ttlSeconds: 300 });
  assert.equal(afterTtl.acquired, true);

  assert.equal(await releaseLock(db, 1), true);
  assert.equal((await getSyncState(db, 1)).lock_expires_at, null);
  assert.equal((await acquireLock(db, 1, { nowEpoch: 1500 })).acquired, true);
  await db.close();
});

test('sync outcomes are recorded, and a failure still stamps the cooldown clock', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await acquireLock(db, 1, { nowEpoch: 1000 });

  await recordOk(db, 1, { nowEpoch: 1100, activitiesUpserted: 12, pagesFetched: 2, truncated: false });
  let row = await getSyncState(db, 1);
  assert.equal(row.last_status, 'ok');
  assert.equal(row.last_error, null);
  assert.equal(row.last_sync_finished, 1100);
  assert.equal(row.activities_upserted, 12);
  assert.equal(row.pages_fetched, 2);
  assert.equal(row.truncated, 0);
  assert.equal(row.lock_expires_at, null, 'recording an outcome also releases the lock');

  await acquireLock(db, 1, { nowEpoch: 2000 });
  await recordError(db, 1, { nowEpoch: 2100, message: 'x'.repeat(900) });
  row = await getSyncState(db, 1);
  assert.equal(row.last_status, 'error');
  assert.equal(row.last_error.length, 500, 'the message is capped');
  // Stamped on failure too: the 60 s cooldown derives from it, and without that a failing sync
  // is retryable in a tight loop and a rate-limit error becomes a rate-limit storm.
  assert.equal(row.last_sync_finished, 2100);
  await db.close();
});

test('the watermark only ever moves forward, and only full syncs set last_full_sync_at', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await ensureSyncState(db, 1);
  await ensureSyncState(db, 1); // idempotent

  await advanceWatermark(db, 1, 5000);
  assert.equal((await getSyncState(db, 1)).watermark_epoch, 5000);

  // A stale or out-of-order run must not rewind it.
  await advanceWatermark(db, 1, 4000);
  assert.equal((await getSyncState(db, 1)).watermark_epoch, 5000);

  await advanceWatermark(db, 1, 6000, { fullSyncAt: 6001 });
  let row = await getSyncState(db, 1);
  assert.equal(row.watermark_epoch, 6000);
  assert.equal(row.last_full_sync_at, 6001);

  // An incremental run leaves last_full_sync_at alone, so it cannot suppress the daily full sync.
  await advanceWatermark(db, 1, 7000);
  row = await getSyncState(db, 1);
  assert.equal(row.watermark_epoch, 7000);
  assert.equal(row.last_full_sync_at, 6001);
  await db.close();
});

test('sweepStaleLocks flips crashed runs to error rather than leaving them running forever', async () => {
  const db = await freshDb();
  await seedAthlete(db, { id: 1, team: 'EAST' });
  await seedAthlete(db, { id: 2, team: 'WEST' });
  await acquireLock(db, 1, { nowEpoch: 1000, ttlSeconds: 300 });   // stale by t=2000
  await acquireLock(db, 2, { nowEpoch: 1900, ttlSeconds: 300 });   // still live at t=2000

  assert.equal(await sweepStaleLocks(db, 2000), 1);
  const healed = await getSyncState(db, 1);
  assert.equal(healed.last_status, 'error');
  assert.equal(healed.lock_expires_at, null);
  assert.match(healed.last_error, /lock expired/);
  // 'running' forever is indistinguishable from "in progress", so the athlete's Refresh would
  // keep returning 409 with nothing to point at.
  assert.equal((await getSyncState(db, 2)).last_status, 'running');
  assert.equal(await sweepStaleLocks(db, 2000), 0);

  assert.equal(await getSyncState(db, 404), undefined);
  await db.close();
});
