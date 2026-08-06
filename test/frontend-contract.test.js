/**
 * Group D contract tests: public/ against the frozen fixtures.
 *
 * There is no browser here and no server to talk to, so the strategy is:
 *
 *  - Import the public/ modules DIRECTLY in Node. They are plain ES modules with zero
 *    dependencies and no DOM access at import time, so this works — and the fact that it
 *    works is itself one of the assertions (a stray top-level `document.getElementById`
 *    would throw on import and fail this whole file).
 *  - Drive the pure functions with `test/fixtures/leaderboard.sample.json` and
 *    `test/fixtures/me.sample.json`, which are the frozen contract.
 *  - Read `public/index.html` as text and regex it for the two migration/security guards
 *    that no unit test can express: no HTML-parsing sink, and no root-absolute paths.
 *
 * Every test named "TRAP" below corresponds to a real bug caught in review. If one of
 * them goes red, do not adjust the test.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as serverContracts from '../server/contracts.js';
import * as api from '../public/api.js?v=2';
import * as app from '../public/app.js?v=2';
import * as config from '../public/config.js?v=2';
import * as fmt from '../public/format.js?v=2';
import * as render from '../public/render.js?v=2';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const leaderboard = JSON.parse(await readFile(here('./fixtures/leaderboard.sample.json'), 'utf8'));
const meFixtures = JSON.parse(await readFile(here('./fixtures/me.sample.json'), 'utf8'));
const indexHtml = await readFile(here('../public/index.html'), 'utf8');
const notFoundHtml = await readFile(here('../public/404.html'), 'utf8');
const renderSource = await readFile(here('../public/render.js'), 'utf8');
const appSource = await readFile(here('../public/app.js'), 'utf8');
const apiSource = await readFile(here('../public/api.js'), 'utf8');
const configSource = await readFile(here('../public/config.js'), 'utf8');
const stylesCss = await readFile(here('../public/styles.css'), 'utf8');

/** Wrap a value the way Promise.allSettled would on success. */
const fulfilled = (value) => ({ status: 'fulfilled', value });
/** Wrap a reason the way Promise.allSettled would on failure. */
const rejected = (reason) => ({ status: 'rejected', reason });

/* ==================================================================== format.js ==== */

describe('format.js — total functions', () => {
  test('TRAP: safeAvatar survives the bare relative string Strava returns for photo-less athletes', () => {
    // new URL('avatar/athlete/large.png') THROWS. Uncaught inside riders.map(rowFor) that
    // one rider blanks the entire roster.
    assert.doesNotThrow(() => fmt.safeAvatar('avatar/athlete/large.png'));
    assert.equal(fmt.safeAvatar('avatar/athlete/large.png'), fmt.AVATAR_FALLBACK);
  });

  test('safeAvatar falls back for every non-https input and never throws', () => {
    for (const bad of [
      null, undefined, '', 0, 42, {}, [], true, NaN,
      'avatar/athlete/large.png', '/pictures/x.png', '//evil.example/x.png',
      'http://insecure.example/x.png', 'javascript:alert(1)',
      'data:image/svg+xml,<svg onload=alert(1)>', 'file:///etc/passwd', 'not a url at all',
    ]) {
      let result;
      assert.doesNotThrow(() => { result = fmt.safeAvatar(bad); }, `threw on ${String(bad)}`);
      assert.equal(result, fmt.AVATAR_FALLBACK, `did not fall back for ${String(bad)}`);
    }
  });

  test('safeAvatar passes an absolute https URL through', () => {
    const url = 'https://dgalywyr863hv.cloudfront.net/pictures/athletes/12345678/1/large.jpg';
    assert.equal(fmt.safeAvatar(url), url);
  });

  test('TRAP: safeHref rejects javascript: and every other non-https scheme', () => {
    assert.equal(fmt.safeHref('javascript:alert(1)'), null);
    assert.equal(fmt.safeHref('JavaScript:alert(1)'), null);
    assert.equal(fmt.safeHref('data:text/html,<script>alert(1)</script>'), null);
    assert.equal(fmt.safeHref('vbscript:msgbox(1)'), null);
    assert.equal(fmt.safeHref('http://www.strava.com/athletes/1'), null);
    assert.equal(fmt.safeHref('/athletes/1'), null);
    assert.equal(fmt.safeHref('//evil.example'), null);
  });

  test('safeHref is total and passes https through', () => {
    for (const bad of [null, undefined, '', 0, {}, [], true, NaN, 'nope']) {
      assert.doesNotThrow(() => fmt.safeHref(bad));
      assert.equal(fmt.safeHref(bad), null);
    }
    assert.equal(
      fmt.safeHref('https://www.strava.com/athletes/12345678'),
      'https://www.strava.com/athletes/12345678',
    );
  });

  test('miles() formats with exactly one decimal and never converts units', () => {
    assert.equal(fmt.miles(412.8), '412.8');
    assert.equal(fmt.miles(0), '0.0');
    assert.equal(fmt.miles(54), '54.0');
    assert.equal(fmt.miles(1423.7), '1,423.7');
    assert.equal(fmt.miles(2626.1), '2,626.1');
    assert.match(fmt.miles(412.8), /^\d[\d,]*\.\d$/);
    assert.equal(fmt.miles(undefined), fmt.EM_DASH);
    assert.equal(fmt.miles('not a number'), fmt.EM_DASH);
  });

  test('int() groups and degrades to an em-dash', () => {
    assert.equal(fmt.int(163), '163');
    assert.equal(fmt.int(1), '1');
    assert.equal(fmt.int(12345), '12,345');
    assert.equal(fmt.int(undefined), fmt.EM_DASH);
  });

  test('pct() clamps and rounds', () => {
    assert.equal(fmt.pct(0.542), '54%');
    assert.equal(fmt.pct(0.458), '46%');
    assert.equal(fmt.pct(0.5), '50%');
    assert.equal(fmt.pct(1.4), '100%');
    assert.equal(fmt.pct(-2), '0%');
    assert.equal(fmt.pct(undefined), fmt.EM_DASH);
  });

  test('TRAP: relTime(null) is the expected day-one input, not an error', () => {
    // sync.last_synced_at and rider.last_synced_at are null until someone syncs.
    assert.doesNotThrow(() => fmt.relTime(null));
    assert.equal(fmt.relTime(null), 'never');
    assert.equal(fmt.relTime(undefined), 'never');
    assert.equal(fmt.relTime(''), 'never');
    assert.equal(fmt.relTime('not a timestamp'), fmt.EM_DASH);
    assert.equal(fmt.relTime(12345), fmt.EM_DASH);
  });

  test('relTime buckets coarsely against an injected clock', () => {
    const now = Date.parse('2026-08-04T19:52:00.000Z');
    assert.equal(fmt.relTime('2026-08-04T19:51:40.000Z', now), 'just now');
    assert.equal(fmt.relTime('2026-08-04T19:22:00.000Z', now), '30 min ago');
    assert.equal(fmt.relTime('2026-08-04T18:22:01.000Z', now), '2 hr ago');
    assert.equal(fmt.relTime('2026-07-28T09:12:00.000Z', now), '7 days ago');
    // Clock skew into the future must not read as "in -3 hours".
    assert.equal(fmt.relTime('2026-08-04T22:52:00.000Z', now), 'just now');
  });

  test('dateRange formats calendar dates without a timezone shift', () => {
    // new Date('2026-06-01') is midnight UTC and formats as May 31 west of Greenwich.
    assert.equal(fmt.dateRange('2026-06-01', '2026-08-31'), 'Jun 1 – Aug 31, 2026');
    assert.equal(fmt.dateRange('2025-12-01', '2026-02-28'), 'Dec 1, 2025 – Feb 28, 2026');
    assert.equal(fmt.dateRange(null, null), fmt.EM_DASH);
    assert.equal(fmt.dateRange('garbage', '2026-08-31'), fmt.EM_DASH);
  });
});

/* ==================================================================== config.js ==== */

describe('config.js — the migration seam', () => {
  test('localhost and friends resolve to same origin', () => {
    for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', '']) {
      assert.equal(config.apiBaseFor(host), '');
    }
    assert.equal(config.API_BASE, '', 'today every host is same-origin');
  });

  test('apiBaseFor is total and prototype-safe', () => {
    for (const host of ['constructor', '__proto__', 'toString', null, undefined, 42]) {
      assert.equal(config.apiBaseFor(host), '');
    }
  });

  test('the public mirror of server/contracts.js has not drifted', () => {
    assert.equal(config.API_SCHEMA, serverContracts.API_SCHEMA);
    assert.deepEqual([...config.TEAMS], [...serverContracts.TEAMS]);
    assert.deepEqual({ ...config.TEAM_LABELS }, { ...serverContracts.TEAM_LABELS });
    assert.equal(config.CSRF_COOKIE, serverContracts.COOKIES.CSRF);
    // The two caps must be EQUAL, not merely both present: the server trims first_month..last_month
    // to its copy, so a smaller client copy silently offers fewer options than prev_month steps to,
    // and a larger one lets a runaway server range through to the DOM.
    assert.equal(config.MAX_PICKER_MONTHS, serverContracts.MAX_PICKER_MONTHS);
    assert.equal(leaderboard.schema, config.API_SCHEMA, 'fixture schema matches the client');
  });

  test('the 409 sync poll is bounded', () => {
    assert.ok(config.SYNC_POLL_INTERVAL_MS > 0);
    assert.ok(Number.isFinite(config.SYNC_POLL_MAX_MS));
    assert.ok(config.SYNC_POLL_MAX_MS <= 30000, 'an unbounded poll never clears the spinner');
  });
});

/* ======================================================= app.js — boot reducer ==== */

describe('app.js resolveBootState — the Promise.allSettled unwrap', () => {
  test('TRAP: branching on a raw settled wrapper reads undefined', () => {
    // This is the bug the reducer exists to make impossible. Documented as an assertion so
    // nobody "simplifies" resolveBootState back into the destructure below.
    const wrapper = fulfilled(meFixtures.new_rider_needing_team);
    assert.equal(wrapper.authenticated, undefined);
    assert.equal(wrapper.rider, undefined);
  });

  test('a fulfilled /api/me with needs_team:true yields showTeamPicker === true', () => {
    const boot = app.resolveBootState(
      fulfilled(meFixtures.new_rider_needing_team),
      fulfilled(leaderboard),
    );
    assert.equal(boot.showTeamPicker, true);
    assert.equal(boot.authenticated, true);
    assert.equal(boot.rider.athlete_id, 99999999);
    assert.equal(boot.canRenderBoard, true);
    assert.equal(boot.meError, null);
  });

  test('a rider who already has a team does not get the picker', () => {
    const boot = app.resolveBootState(fulfilled(meFixtures.authenticated), fulfilled(leaderboard));
    assert.equal(boot.showTeamPicker, false);
    assert.equal(boot.authenticated, true);
    assert.equal(boot.rider.team, 'EAST');
  });

  test('an anonymous visitor gets no picker and still gets a board', () => {
    const boot = app.resolveBootState(fulfilled(meFixtures.anonymous), fulfilled(leaderboard));
    assert.equal(boot.authenticated, false);
    assert.equal(boot.rider, null);
    assert.equal(boot.showTeamPicker, false);
    assert.equal(boot.canRenderBoard, true);
  });

  test('a REJECTED /api/me with a fulfilled leaderboard still yields a renderable board', () => {
    const boom = new Error('500 from /api/me');
    const boot = app.resolveBootState(rejected(boom), fulfilled(leaderboard));
    assert.equal(boot.me, null);
    assert.equal(boot.authenticated, false);
    assert.equal(boot.showTeamPicker, false);
    assert.equal(boot.canRenderBoard, true, 'the leaderboard is public data; render it');
    assert.equal(boot.leaderboard, leaderboard);
    assert.equal(boot.meError, boom);
    // Identity against the fixture's own block, not a literal date: the property under test
    // is "the LEADERBOARD's competition is the one used", which a hardcoded start date only
    // ever tested by coincidence -- and which broke the moment the fixture moved to a month.
    assert.equal(boot.competition, leaderboard.competition);
    assert.equal(boot.competition.month, '2026-08');
  });

  test('a rejected leaderboard is reported without hiding the identity result', () => {
    const boot = app.resolveBootState(fulfilled(meFixtures.authenticated), rejected(new Error('nope')));
    assert.equal(boot.canRenderBoard, false);
    assert.equal(boot.authenticated, true);
    assert.ok(boot.leaderboardError instanceof Error);
    // competition still comes from /api/me so the masthead is not blank.
    assert.equal(boot.competition.end, '2026-08-31');
  });

  test('both rejected degrades without throwing', () => {
    const boot = app.resolveBootState(rejected(new Error('a')), rejected(new Error('b')));
    assert.equal(boot.canRenderBoard, false);
    assert.equal(boot.showTeamPicker, false);
    assert.equal(boot.competition, null);
    assert.equal(boot.isEmptyBoard, false);
  });

  test('undefined settled results (a short array) do not throw', () => {
    const boot = app.resolveBootState(undefined, undefined);
    assert.equal(boot.me, null);
    assert.equal(boot.canRenderBoard, false);
  });

  test('a schema mismatch is detected on either payload', () => {
    assert.equal(
      app.resolveBootState(fulfilled(meFixtures.authenticated), fulfilled(leaderboard)).schemaMismatch,
      false,
    );
    // Derived from API_SCHEMA, never a literal. This test used `schema: 2` as its
    // "impossibly future" value; the month picker then shipped API_SCHEMA = 2 and the
    // assertion silently inverted -- it began proving that a MATCHING schema mismatches.
    const future = { ...leaderboard, schema: config.API_SCHEMA + 1 };
    assert.equal(
      app.resolveBootState(fulfilled(meFixtures.authenticated), fulfilled(future)).schemaMismatch,
      true,
    );
    const futureMe = { ...meFixtures.authenticated, schema: 99 };
    assert.equal(
      app.resolveBootState(fulfilled(futureMe), fulfilled(leaderboard)).schemaMismatch,
      true,
    );
  });

  test('isEmptyBoard tracks sync.last_synced_at, not riders.length', () => {
    assert.equal(app.resolveBootState(undefined, fulfilled(leaderboard)).isEmptyBoard, false);
    const nobodySynced = { ...leaderboard, sync: { last_synced_at: null, riders_never_synced: 4 } };
    assert.equal(app.resolveBootState(undefined, fulfilled(nobodySynced)).isEmptyBoard, true);
    // Riders present but nobody synced is still the empty state.
    assert.ok(nobodySynced.riders.length > 0);
  });

  test('needs_team is the only trigger: team === null alone is not enough', () => {
    const teamlessButNotFlagged = {
      ...meFixtures.new_rider_needing_team,
      rider: { ...meFixtures.new_rider_needing_team.rider, needs_team: false },
    };
    assert.equal(teamlessButNotFlagged.rider.team, null);
    const boot = app.resolveBootState(fulfilled(teamlessButNotFlagged), fulfilled(leaderboard));
    assert.equal(boot.showTeamPicker, false);
  });
});

/* ==================================================== app.js — fragment parsing ==== */

describe('app.js parseAuthFragment — parsed once, before any replaceState', () => {
  test('TRAP: both token and error come out of a single parse', () => {
    const parsed = app.parseAuthFragment('#error=access_denied&token=abc');
    assert.equal(parsed.error, 'access_denied');
    assert.equal(parsed.token, 'abc');
    assert.equal(parsed.present, true);
  });

  test('order in the fragment does not matter', () => {
    const parsed = app.parseAuthFragment('#token=abc&error=access_denied');
    assert.equal(parsed.error, 'access_denied');
    assert.equal(parsed.token, 'abc');
  });

  test('each value alone, and neither', () => {
    assert.deepEqual(app.parseAuthFragment('#token=xyz'), { token: 'xyz', error: null, present: true });
    assert.deepEqual(app.parseAuthFragment('#error=denied'), { token: null, error: 'denied', present: true });
    assert.deepEqual(app.parseAuthFragment(''), { token: null, error: null, present: false });
    assert.deepEqual(app.parseAuthFragment('#'), { token: null, error: null, present: false });
    assert.deepEqual(app.parseAuthFragment('#somewhere-else'), { token: null, error: null, present: false });
    assert.deepEqual(app.parseAuthFragment(undefined), { token: null, error: null, present: false });
  });

  test('percent-encoding and empty values are handled', () => {
    assert.equal(app.parseAuthFragment('#token=a%2Bb%3D').token, 'a+b=');
    assert.equal(app.parseAuthFragment('#error=').error, null);
    assert.equal(app.parseAuthFragment('#error=').present, true, 'present so the URL still gets scrubbed');
  });

  test('every OAuth failure code produces a distinct human message', () => {
    const codes = ['denied', 'access_denied', 'state_expired', 'scope', 'oauth_failed', 'weird'];
    const messages = codes.map((c) => app.oauthErrorMessage(c));
    for (const message of messages) {
      assert.equal(typeof message, 'string');
      assert.ok(message.length > 10);
    }
    assert.notEqual(app.oauthErrorMessage('denied'), app.oauthErrorMessage('state_expired'));
    assert.equal(app.oauthErrorMessage('access_denied'), app.oauthErrorMessage('denied'));
  });

  test('sync error codes from server/contracts.js all map to advice', () => {
    const codes = [
      serverContracts.ERROR_CODES.RATE_LIMITED,
      serverContracts.ERROR_CODES.INSUFFICIENT_SCOPE,
      serverContracts.ERROR_CODES.STRAVA_REVOKED,
      serverContracts.ERROR_CODES.STRAVA_UNAVAILABLE,
      serverContracts.ERROR_CODES.UNAUTHENTICATED,
      'network_error',
      'something_new',
    ];
    for (const code of codes) {
      const advice = app.syncErrorMessage({ code, retryAfterSeconds: null });
      assert.equal(typeof advice.text, 'string');
      assert.ok(advice.text.length > 10, code);
    }
    assert.match(app.syncErrorMessage({ code: 'rate_limited', retryAfterSeconds: 42 }).text, /42 s/);
    assert.equal(app.syncErrorMessage({ code: 'strava_revoked' }).action, 'reconnect');
  });
});

/* =================================================== render.js — pure shaping ==== */

describe('render.js shapeRiderRow — against every fixture rider', () => {
  const now = Date.parse('2026-08-04T19:52:00.000Z');

  test('every rider in the frozen fixture shapes without throwing', () => {
    assert.ok(leaderboard.riders.length >= 4, 'fixture must keep its edge-case rows');
    for (const rider of leaderboard.riders) {
      let row;
      assert.doesNotThrow(() => { row = render.shapeRiderRow(rider, now); }, `threw on ${rider.athlete_id}`);
      assert.equal(typeof row.rankText, 'string');
      assert.equal(typeof row.name, 'string');
      assert.equal(typeof row.milesText, 'string');
      assert.ok(row.avatarSrc.startsWith('https://') || row.avatarSrc === fmt.AVATAR_FALLBACK);
      assert.ok(row.profileHref === null || row.profileHref.startsWith('https://'));
    }
  });

  test('the rank:null row renders an em-dash, not a 4 and not a blank', () => {
    const unranked = leaderboard.riders.find((r) => r.rank === null);
    assert.ok(unranked, 'fixture must keep the zero-mile rank:null rider');
    const row = render.shapeRiderRow(unranked, now);
    assert.equal(row.rankText, '—');
    assert.equal(row.rankText, fmt.EM_DASH);
    assert.equal(row.ranked, false);
    // Zero-mile riders are on the board, not filtered out of it.
    assert.equal(row.milesText, '0.0');
    assert.equal(row.rideCountText, '0');
    assert.equal(row.syncedText, 'never');
  });

  test('every avatar_url:null row gets the local fallback asset', () => {
    const photoless = leaderboard.riders.filter((r) => r.avatar_url === null);
    assert.ok(photoless.length >= 2, 'fixture must keep the photo-less riders');
    for (const rider of photoless) {
      assert.equal(render.shapeRiderRow(rider, now).avatarSrc, fmt.AVATAR_FALLBACK);
    }
  });

  test('badges: private_rides_counted:false and revoked:true', () => {
    const publicOnly = leaderboard.riders.find((r) => r.private_rides_counted === false);
    const revoked = leaderboard.riders.find((r) => r.revoked === true);
    assert.ok(publicOnly && revoked, 'fixture must keep the badge cases');

    const codes = (rider) => render.shapeRiderRow(rider, now).badges.map((b) => b.code);
    assert.deepEqual(codes(publicOnly), ['public-only']);
    assert.deepEqual(codes(revoked), ['revoked']);
    assert.equal(render.shapeRiderRow(revoked, now).frozen, true, 'a revoked total is frozen, not hidden');
    // A rider with neither flag carries no badge noise.
    const clean = leaderboard.riders.find((r) => r.private_rides_counted === true && r.revoked === false);
    assert.deepEqual(codes(clean), []);
  });

  test('is_you is taken from the server, never inferred', () => {
    const rows = leaderboard.riders.map((r) => render.shapeRiderRow(r, now));
    assert.equal(rows.filter((r) => r.isYou).length, 1);
    assert.equal(rows[0].isYou, true);
  });

  test('the deep link back to Strava survives shaping', () => {
    const row = render.shapeRiderRow(leaderboard.riders[0], now);
    assert.equal(row.profileHref, 'https://www.strava.com/athletes/12345678');
  });

  test('a hostile display_name is carried as plain text, not markup', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    const row = render.shapeRiderRow({ ...leaderboard.riders[0], display_name: nasty }, now);
    assert.equal(row.name, nasty, 'shaping does not escape; render.js assigns it as text');
  });

  test('a garbage rider object still produces a row', () => {
    for (const junk of [{}, null, undefined, { rank: 'x', miles: 'y', display_name: 42 }]) {
      let row;
      assert.doesNotThrow(() => { row = render.shapeRiderRow(junk, now); });
      assert.equal(typeof row.rankText, 'string');
      assert.equal(row.avatarSrc, fmt.AVATAR_FALLBACK);
    }
  });
});

describe('render.js shapeScoreboard — the headline', () => {
  test('the two team shares sum to ~1.0 and the headline matches totals.miles', () => {
    const shaped = render.shapeScoreboard(leaderboard);
    const shareSum = shaped.cards[0].share + shaped.cards[1].share;
    assert.ok(Math.abs(shareSum - 1) < 0.005, `shares summed to ${shareSum}`);

    const milesSum = shaped.cards[0].miles + shaped.cards[1].miles;
    assert.ok(
      Math.abs(milesSum - leaderboard.totals.miles) < 0.05,
      `split bar (${milesSum}) must add up to the headline (${leaderboard.totals.miles})`,
    );
    assert.equal(shaped.totalMiles, leaderboard.totals.miles);
    assert.equal(shaped.totalMilesText, fmt.miles(leaderboard.totals.miles));
    assert.equal(shaped.totalMilesText, '2,626.1');
  });

  test('EAST is always first, even if the server ever sends them the other way round', () => {
    const forwards = render.shapeScoreboard(leaderboard);
    assert.deepEqual(forwards.cards.map((c) => c.team), ['EAST', 'WEST']);
    const reversed = render.shapeScoreboard({ ...leaderboard, teams: [...leaderboard.teams].reverse() });
    assert.deepEqual(reversed.cards.map((c) => c.team), ['EAST', 'WEST']);
    assert.equal(reversed.cards[0].milesText, '1,423.7');
  });

  test('the leader and the margin are named', () => {
    const shaped = render.shapeScoreboard(leaderboard);
    assert.equal(shaped.tie, false);
    assert.match(shaped.leaderText, /East/);
    assert.match(shaped.leaderText, /221\.3/);
  });

  test('leader:null is reported as a tie, honestly', () => {
    const tied = {
      ...leaderboard,
      teams: [
        { ...leaderboard.teams[0], miles: 1313.05, share: 0.5 },
        { ...leaderboard.teams[1], miles: 1313.05, share: 0.5 },
      ],
      leader: null,
    };
    const shaped = render.shapeScoreboard(tied);
    assert.equal(shaped.tie, true);
    assert.match(shaped.leaderText, /Dead heat/i);
    assert.doesNotMatch(shaped.leaderText, /leads/);
  });

  test('a day-one zeroed board reads as "no miles yet", not as a dead heat', () => {
    const zeroed = {
      ...leaderboard,
      teams: [
        { team: 'EAST', label: 'East', miles: 0, ride_count: 0, rider_count: 3, share: 0.5 },
        { team: 'WEST', label: 'West', miles: 0, ride_count: 0, rider_count: 2, share: 0.5 },
      ],
      totals: { miles: 0, ride_count: 0, rider_count: 5 },
      leader: null,
    };
    const shaped = render.shapeScoreboard(zeroed);
    assert.equal(shaped.tie, true);
    assert.match(shaped.leaderText, /No miles/i);
    assert.equal(shaped.cards[0].shareCss, '50.0%');
    assert.equal(shaped.cards[0].milesText, '0.0');
  });

  test('a zero-mile team is still a card, never a missing one', () => {
    const oneSided = {
      ...leaderboard,
      teams: [
        { team: 'EAST', label: 'East', miles: 120.5, ride_count: 4, rider_count: 2, share: 1 },
        { team: 'WEST', label: 'West', miles: 0, ride_count: 0, rider_count: 1, share: 0 },
      ],
      totals: { miles: 120.5, ride_count: 4, rider_count: 3 },
      leader: { team: 'EAST', margin_miles: 120.5 },
    };
    const shaped = render.shapeScoreboard(oneSided);
    assert.equal(shaped.cards[1].milesText, '0.0');
    assert.equal(shaped.cards[1].shareCss, '0.0%');
  });

  test('shapeScoreboard is total against junk', () => {
    for (const junk of [undefined, null, {}, { teams: null }, { teams: [null, 'x'] }]) {
      let shaped;
      assert.doesNotThrow(() => { shaped = render.shapeScoreboard(junk); });
      assert.equal(shaped.cards.length, 2);
      assert.deepEqual(shaped.cards.map((c) => c.team), ['EAST', 'WEST']);
    }
  });
});

describe('render.js shapeCompetition — window and days remaining', () => {
  test('the window and the countdown are both present', () => {
    const shaped = render.shapeCompetition(leaderboard.competition);
    // A month, not a date span: every calendar month is its own competition now, so the
    // masthead names the month rather than reciting a start and end date the reader already
    // knows from the picker sitting underneath it.
    assert.equal(shaped.rangeText, 'August 2026');
    assert.match(shaped.statusText, /28 days to go/);
    assert.match(shaped.timezoneText, /UTC/);
    assert.match(shaped.sportsText, /Ride, GravelRide, MountainBikeRide, VirtualRide/);
    assert.match(shaped.manualText, /do not count/);
  });

  test('every competition state says something sensible', () => {
    assert.match(render.shapeCompetition({ ...leaderboard.competition, state: 'upcoming' }).statusText, /Not started/);
    assert.match(render.shapeCompetition({ ...leaderboard.competition, state: 'closed' }).statusText, /Final/);
    assert.match(render.shapeCompetition({ ...leaderboard.competition, days_remaining: 0 }).statusText, /Last day/);
    assert.match(render.shapeCompetition({ ...leaderboard.competition, days_remaining: 1 }).statusText, /^1 day to go/);
    assert.equal(render.shapeCompetition(undefined).rangeText, fmt.EM_DASH);
  });

  test('manual rides being countable is stated when the server says so', () => {
    const shaped = render.shapeCompetition({ ...leaderboard.competition, manual_rides_counted: true });
    assert.match(shaped.manualText, /admin/);
  });
});

/* ================================================================= the month picker ==== */

describe('render.js shapeMonthPicker — the control that got reported missing', () => {
  test('the frozen fixture produces one option per month, oldest first, with the current one flagged', () => {
    const shaped = render.shapeMonthPicker(leaderboard.competition);
    assert.deepEqual(shaped.options.map((o) => o.month), ['2026-06', '2026-07', '2026-08']);
    assert.deepEqual(shaped.options.map((o) => o.label), ['June 2026', 'July 2026', 'August 2026']);
    assert.deepEqual(shaped.options.map((o) => o.current), [false, false, true]);
    assert.equal(shaped.selected, '2026-08');
    assert.equal(shaped.usable, true);
    // Straight off the wire: null IS the disabled state, so the client does no arithmetic.
    assert.equal(shaped.hasPrev, true);
    assert.equal(shaped.hasNext, false);
    assert.equal(shaped.next, null);
  });

  test('THE BUG: a single selectable month keeps the picker VISIBLE', () => {
    // A one-month `COMPETITION_START`/`END` used to make `usable` false, which hid the control
    // outright -- and a hidden control is indistinguishable from an unimplemented one, which is
    // exactly how it was reported. The server-side union makes this rare; it stays legitimate for
    // a genuinely single-month deployment, and it must still render.
    const solo = render.shapeMonthPicker({
      ...leaderboard.competition,
      month: '2026-09',
      first_month: '2026-09',
      last_month: '2026-09',
      current_month: '2026-09',
      prev_month: null,
      next_month: null,
    });
    assert.equal(solo.options.length, 1);
    assert.equal(solo.usable, true, 'visible with one option and two dead arrows');
    assert.equal(solo.hasPrev, false);
    assert.equal(solo.hasNext, false);
    assert.equal(solo.selected, '2026-09');
  });

  test('a payload with no months at all is the one case that hides it', () => {
    // A stale or half-failed payload, not a deployment shape. An empty `<select>` is worse than
    // no `<select>`, because it looks broken rather than absent.
    for (const competition of [undefined, {}, { first_month: 'nope', last_month: null }]) {
      const shaped = render.shapeMonthPicker(competition);
      assert.deepEqual(shaped.options, []);
      assert.equal(shaped.usable, false);
    }
  });

  test('monthOptions walks the range inclusively and refuses an inverted one', () => {
    assert.deepEqual(render.monthOptions('2026-11', '2027-02'), ['2026-11', '2026-12', '2027-01', '2027-02']);
    assert.deepEqual(render.monthOptions('2026-08', '2026-08'), ['2026-08']);
    // Inverted or malformed yields NO options rather than a loop that never terminates.
    assert.deepEqual(render.monthOptions('2026-09', '2026-08'), []);
    assert.deepEqual(render.monthOptions('august', '2026-08'), []);
    assert.deepEqual(render.monthOptions(null, undefined), []);
  });

  test('the client cap trims the OLDEST months, so "now" survives a server that ignored its own', () => {
    const options = render.monthOptions('1900-01', '2026-08');
    assert.equal(options.length, config.MAX_PICKER_MONTHS);
    assert.equal(options.at(-1), '2026-08', 'the newest month is kept');
    assert.equal(options[0], '2016-09');
  });

  test('a selected month the range does not contain is added rather than silently dropped', () => {
    // Only reachable if the server contradicts its own bounds. Dropping it would leave the
    // <select> displaying a different month than the board beneath it, with nothing to see.
    const shaped = render.shapeMonthPicker({ ...leaderboard.competition, month: '2027-01' });
    assert.equal(shaped.selected, '2027-01');
    assert.ok(shaped.options.some((o) => o.month === '2027-01'));
    assert.deepEqual(shaped.options.map((o) => o.month), ['2026-06', '2026-07', '2026-08', '2027-01']);
  });
});

/* ============================================= DOM-free-at-import + api surface ==== */

describe('module hygiene', () => {
  test('the DOM writers are reachable but were not invoked at import time', () => {
    // Importing this file at all proves no module touched `document` on load. Calling a
    // DOM writer with no document must fail loudly rather than silently no-op.
    assert.equal(typeof globalThis.document, 'undefined');
    assert.throws(() => render.renderScoreboard(leaderboard), /require a document/);
    assert.throws(() => render.openTeamPicker(), /require a document/);
  });

  test('api.js exports the full contract surface and nothing else fetches', () => {
    for (const name of [
      'getMe', 'getLeaderboard', 'setTeam', 'syncNow', 'disconnect', 'logout',
      'riderActivities', 'startLogin', 'loginHref', 'storeToken', 'clearStoredToken',
    ]) {
      assert.equal(typeof api[name], 'function', `api.${name} missing`);
    }
    assert.equal(api.storedToken(), null, 'no localStorage in Node, and no throw');
  });

  test('ApiError carries status, code and the parsed body', () => {
    const error = new api.ApiError(409, 'sync_in_progress', { error: 'sync_in_progress', retry_after_seconds: 12 });
    assert.ok(error instanceof Error);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'sync_in_progress');
    assert.equal(error.body.retry_after_seconds, 12);
    assert.equal(error.retryAfterSeconds, 12);
    assert.equal(new api.ApiError(500, 'internal', null).retryAfterSeconds, null);
    assert.equal(new api.ApiError(403, 'strava_revoked', { reauth_url: '/api/auth/strava/reconnect' }).reauthUrl,
      '/api/auth/strava/reconnect');
  });

  test('login is a navigation target, never fetched', () => {
    // No `location` in Node, so startLogin returns the URL instead of navigating.
    assert.equal(api.startLogin(), '/api/auth/strava/login');
    assert.equal(api.loginHref({ reconnect: true }), '/api/auth/strava/reconnect');
  });
});

/* ================================================== index.html migration guards ==== */

describe('index.html — Pages migration and XSS guards', () => {
  test('GUARD: no HTML-parsing sink anywhere in the page', () => {
    assert.doesNotMatch(indexHtml, /innerHTML/i, 'rider names are attacker-controlled: textContent only');
    assert.doesNotMatch(indexHtml, /insertAdjacentHTML/i);
    assert.doesNotMatch(indexHtml, /document\.write/i);
    assert.doesNotMatch(renderSource, /\.innerHTML\s*=/);
    assert.doesNotMatch(renderSource, /insertAdjacentHTML/);
    assert.doesNotMatch(renderSource, /outerHTML/);
  });

  test('GUARD: every path is relative — a root-absolute path 404s under a Pages subpath', () => {
    assert.doesNotMatch(indexHtml, /\ssrc="\//, 'root-absolute src');
    assert.doesNotMatch(indexHtml, /\shref="\/(?!\/)/, 'root-absolute href');
    // Derived from MODULE_VERSION rather than hardcoded. A literal here has to be edited in
    // lockstep with every bump, and when it is missed the failure reads as "the cache-buster
    // is broken" rather than "this assertion is stale" -- which is exactly how the v1 -> v2
    // month-picker bump presented.
    assert.match(indexHtml, new RegExp(`href="\\./styles\\.css\\?v=${config.MODULE_VERSION}"`));
    assert.match(indexHtml, new RegExp(`src="\\./app\\.js\\?v=${config.MODULE_VERSION}"`));
    assert.match(indexHtml, /src="\.\/assets\/btn-strava-connect\.svg"/);
    assert.match(indexHtml, /src="\.\/assets\/powered-by-strava\.svg"/);
    for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const value = match[1];
      assert.ok(
        value.startsWith('./') || value.startsWith('https://'),
        `path "${value}" is neither relative nor absolute https`,
      );
    }
  });

  test('the CSP is present with every directive the design depends on', () => {
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(indexHtml);
    assert.ok(meta, 'meta CSP missing');
    const policy = meta[1];
    for (const directive of [
      "default-src 'none'", "script-src 'self'", "style-src 'self'",
      'img-src', "connect-src 'self'", "base-uri 'none'", "form-action 'none'",
    ]) {
      assert.ok(policy.includes(directive), `CSP missing ${directive}`);
    }
    // Documented limitation, so nobody wastes an afternoon wondering why it is absent.
    assert.doesNotMatch(policy, /frame-ancestors/);
    assert.match(indexHtml, /frame-ancestors/, 'the meta-CSP limitation must be commented');
  });

  test('DEPLOY GUARD: the CSP connect-src and the config.js API origins agree exactly', () => {
    // docs/SPEC.md "Deferred to deploy time" item 4: the CSP must be widened to the API origin
    // in LOCKSTEP with public/config.js, "same commit, or the site silently stops talking to
    // its own API". Silently is the operative word -- a missing connect-src entry is a CSP
    // violation in the console and a rejected fetch, with no 4xx and no CORS error, so the
    // symptom is "the board never loads" with nothing to point at. This test is what makes a
    // half-finished deploy edit fail here instead of in production.
    const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(indexHtml);
    assert.ok(meta, 'meta CSP missing');
    const connectSrc = /connect-src ([^;]+)/.exec(meta[1]);
    assert.ok(connectSrc, 'CSP has no connect-src directive');

    // Origins the CSP permits, beyond same-origin.
    const cspOrigins = new Set(
      connectSrc[1].trim().split(/\s+/).filter((token) => token !== "'self'"),
    );

    // Origins config.js will actually fetch from. Read as TEXT, not by importing: a commented
    // -out production entry must not count, and that distinction is invisible after evaluation.
    const configOrigins = new Set();
    for (const line of configSource.split('\n')) {
      const code = line.trim();
      if (code.startsWith('//') || code.startsWith('*')) continue; // commented-out template
      const entry = /:\s*'(https?:\/\/[^']+)'/.exec(code);
      if (entry) configOrigins.add(entry[1]);
    }

    const missingFromCsp = [...configOrigins].filter((o) => !cspOrigins.has(o));
    const missingFromConfig = [...cspOrigins].filter((o) => !configOrigins.has(o));

    assert.deepEqual(
      missingFromCsp,
      [],
      `public/config.js fetches from ${missingFromCsp.join(', ')} but the CSP connect-src does not allow it. `
      + 'Add the origin to the <meta> CSP in BOTH public/index.html and public/404.html.',
    );
    assert.deepEqual(
      missingFromConfig,
      [],
      `the CSP allows ${missingFromConfig.join(', ')} but public/config.js never fetches from it. `
      + 'Either add the hostname mapping or narrow the CSP -- an unused allowance is a widened attack surface.',
    );
  });

  test('style-src self means no inline style attribute and no style block', () => {
    assert.doesNotMatch(indexHtml, /\sstyle="/, 'inline style attributes are blocked by the CSP');
    assert.doesNotMatch(indexHtml, /<style[\s>]/);
    // The split bar therefore drives its width from a custom property set via CSSOM.
    assert.match(renderSource, /style\.setProperty\('--share'/);
    assert.match(stylesCss, /--share, 50%/);
  });

  test('module imports carry the ?v= cache-buster consistently', () => {
    const v = `?v=${config.MODULE_VERSION}`;
    assert.match(indexHtml, new RegExp(`\\./app\\.js\\?v=${config.MODULE_VERSION}`));
    // app.js and api.js are checked too, not just render.js. The v1 -> v2 bump left app.js
    // importing './config.js?v=1' while render.js imported './config.js?v=2', and because a
    // query string makes a DISTINCT module URL the browser then evaluated config.js twice as
    // two unrelated instances. Nothing threw, so only a check this broad catches it.
    for (const [name, source] of [['render.js', renderSource], ['app.js', appSource], ['api.js', apiSource]]) {
      for (const match of source.matchAll(/from '\.\/([a-z]+\.js)([^']*)'/g)) {
        assert.equal(match[2], v, `${name} imports ${match[1]} with "${match[2]}", expected "${v}"`);
      }
    }
  });

  test('the logged-out path is the official Connect with Strava button', () => {
    assert.match(indexHtml, /id="btn-connect"/);
    assert.match(indexHtml, /alt="Connect with Strava"/);
    // The href is a real link so the navigation works with JavaScript disabled, and it is
    // a navigation rather than a fetch by construction.
    assert.match(indexHtml, /id="btn-connect"[^>]*href="\.\/api\/auth\/strava\/login"/);
  });

  test('"Powered by Strava" is visible without interaction', () => {
    assert.match(indexHtml, /alt="Powered by Strava"/);
    // Strip comments first: the prose in there legitimately talks about not hiding it.
    const footer = indexHtml
      .slice(indexHtml.indexOf('<footer'), indexHtml.indexOf('</footer>'))
      .replace(/<!--[\s\S]*?-->/g, '');
    assert.match(footer, /powered-by/);
    assert.doesNotMatch(footer, /\shidden[\s>=]/, 'the attribution must never ship hidden');
    // ...and no stylesheet rule may hide it.
    const rule = /\.powered-by[^{]*\{[^}]*\}/g;
    for (const match of stylesCss.match(rule) ?? []) {
      assert.doesNotMatch(match, /display:\s*none|visibility:\s*hidden|opacity:\s*0/);
    }
  });

  test('both Strava assets are flagged as placeholders needing replacement', async () => {
    assert.match(indexHtml, /PLACEHOLDER\. MUST BE REPLACED BEFORE PUBLIC DEPLOYMENT/);
    assert.match(indexHtml, /developers\.strava\.com\/guidelines/);
    assert.match(indexHtml, /MUST NOT be restyled/);
    const readme = await readFile(here('../public/assets/README.md'), 'utf8');
    assert.match(readme, /PLACEHOLDER/);
    assert.match(readme, /developers\.strava\.com\/guidelines/);
    for (const asset of ['btn-strava-connect.svg', 'powered-by-strava.svg']) {
      const svg = await readFile(here(`../public/assets/${asset}`), 'utf8');
      assert.match(svg, /PLACEHOLDER/, `${asset} must say so in the file itself`);
      assert.match(svg, /#FC5200/i, `${asset} must use Strava orange`);
    }
  });

  test('the shell has every element render.js writes to', () => {
    for (const id of [
      'status', 'banners', 'window-range', 'window-status', 'window-meta',
      'scoreboard', 'split-bar', 'split-east', 'split-west', 'leader-line', 'totals-line',
      'east-label', 'east-miles', 'east-share', 'east-sub',
      'west-label', 'west-miles', 'west-share', 'west-sub',
      'empty-state', 'roster', 'rider-rows', 'roster-empty', 'roster-note', 'sync-line',
      'btn-connect', 'btn-refresh', 'btn-logout', 'btn-pick-team', 'btn-reconnect',
      'viewer', 'viewer-avatar', 'viewer-name', 'viewer-team',
      'team-dialog', 'team-dialog-error', 'btn-dialog-logout',
      'tpl-rider-row', 'tpl-banner', 'tpl-badge',
    ]) {
      assert.ok(indexHtml.includes(`id="${id}"`), `index.html is missing #${id}`);
    }
  });

  test('the row template carries every field render.js fills in', () => {
    const row = /<template id="tpl-rider-row">([\s\S]*?)<\/template>/.exec(indexHtml)[1];
    for (const field of ['rank', 'avatar', 'profile', 'youtag', 'team', 'miles', 'rides', 'longest', 'badges']) {
      assert.ok(row.includes(`data-f="${field}"`), `row template is missing data-f="${field}"`);
    }
    // Every outbound rider link is a safe new-tab deep link back to Strava.
    assert.match(row, /target="_blank" rel="noopener noreferrer"/);
  });

  test('the team picker is a dialog with both teams and an escape hatch', () => {
    const dialog = /<dialog id="team-dialog"[\s\S]*?<\/dialog>/.exec(indexHtml)[0];
    assert.match(dialog, /data-team="EAST"/);
    assert.match(dialog, /data-team="WEST"/);
    assert.match(dialog, /id="btn-dialog-logout"/, 'never trap a rider with no way out');
    // No form submission: form-action 'none' in the CSP, and the choice is a JSON POST.
    assert.doesNotMatch(dialog, /<form/);
    assert.match(indexHtml, /needs_team.*ONE authoritative trigger|ONE authoritative trigger/);
  });

  test('the empty state says "no rides yet" in words', () => {
    const section = /<section id="empty-state"[\s\S]*?<\/section>/.exec(indexHtml)[0];
    assert.match(section, /No rides yet/i);
    assert.match(section, /Nobody has synced/i);
  });

  test('the competition window and the countdown have a home in the masthead', () => {
    const masthead = /<header class="masthead">[\s\S]*?<\/header>/.exec(indexHtml)[0];
    assert.match(masthead, /id="window-range"/);
    assert.match(masthead, /id="window-status"/);
    assert.match(masthead, /id="btn-pick-team"/, 'the modal must never be the only path');
  });

  test('404.html is a byte-for-byte copy of index.html (Pages has no SPA fallback)', () => {
    assert.equal(notFoundHtml, indexHtml);
  });
});

describe('styles.css — theming', () => {
  test('light and dark are both first-class', () => {
    assert.match(stylesCss, /color-scheme:\s*light dark/);
    assert.match(stylesCss, /@media \(prefers-color-scheme: dark\)/);
    assert.match(stylesCss, /--bg:/);
    assert.match(stylesCss, /font-variant-numeric:\s*tabular-nums/);
  });

  test('no hardcoded white or black backgrounds', () => {
    for (const literal of ['#fff', '#ffffff', '#000', '#000000', 'background: white', 'background: black']) {
      assert.ok(!stylesCss.toLowerCase().includes(literal), `styles.css hardcodes ${literal}`);
    }
  });
});

/* ============================================================ fixture invariants ==== */

describe('the frozen fixture still declares its invariants', () => {
  test('_invariants is present, so a silent rewrite of the contract is visible in review', () => {
    assert.ok(Array.isArray(leaderboard._invariants));
    assert.ok(leaderboard._invariants.length >= 8);
    assert.ok(Array.isArray(meFixtures._invariants));
  });

  test('the shape this UI was built against has not moved', () => {
    assert.deepEqual(leaderboard.teams.map((t) => t.team), ['EAST', 'WEST']);
    assert.equal(leaderboard.units.distance, 'mi');
    assert.equal(typeof leaderboard.sync.last_synced_at, 'string');
    assert.ok(leaderboard.riders.some((r) => r.rank === null));
    assert.ok(leaderboard.riders.some((r) => r.avatar_url === null));
    assert.ok(leaderboard.riders.some((r) => r.revoked === true));
    assert.ok(leaderboard.riders.some((r) => r.private_rides_counted === false));
    assert.ok(leaderboard.riders.some((r) => r.is_you === true));
    // The 388.1 tie: ranks stay distinct, ordered by ride_count DESC on equal miles.
    const tied = leaderboard.riders.filter((r) => r.miles === 388.1);
    assert.equal(tied.length, 2);
    assert.deepEqual(tied.map((r) => r.rank), [2, 3]);
    assert.ok(tied[0].ride_count > tied[1].ride_count);
  });

  test('the whole fixture roster renders as rows, zero-mile riders included', () => {
    const rows = leaderboard.riders.map((r) => render.shapeRiderRow(r));
    assert.equal(rows.length, leaderboard.riders.length);
    assert.equal(rows.filter((r) => !r.ranked).length, 1);
    assert.equal(rows.filter((r) => r.milesText === '0.0').length, 1);
    assert.equal(new Set(rows.map((r) => r.team)).size, 2);
  });
});
