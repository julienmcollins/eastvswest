#!/usr/bin/env node
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { listAthletes } from '../server/db/athletes.js';
import { activityMonthlyTotals } from '../server/db/activities.js';
import { createStravaClient } from '../server/strava/client.js';
import { syncAthlete } from '../server/strava/sync.js';
import { ERROR_CODES } from '../server/contracts.js';
import { isCalendarMonth } from '../server/lib/dates.js';
import { milesFromMeters } from '../server/lib/units.js';

/**
 * Force a full re-sync of every athlete, oldest history included, and PROVE it month by month.
 *
 *   npm run backfill -- --remote                       # production D1, via the admin API
 *   npm run backfill -- --remote --since 2026-01        # reach back to January explicitly
 *   npm run backfill -- --remote 12345678              # one athlete
 *   npm run backfill -- --remote --dry-run             # list who WOULD be synced, spend no quota
 *   npm run backfill                                   # LOCAL sqlite file (development only)
 *
 * ---------------------------------------------------------------------------------------------
 * WHY `--remote` EXISTS, AND WHY IT IS NOT THE DEFAULT.
 *
 * This script used to have exactly one mode: open `config.databasePath` with node:sqlite and call
 * `syncAthlete` directly. On a deployment that is a no-op with a success exit code. Production
 * runs on Cloudflare D1 -- `openD1` is called from server/worker.js and nowhere else -- so the
 * local path migrated an empty file, found no athletes, printed "No athletes to back-fill yet."
 * and exited 0. Every run looked fine and nothing changed, which is a worse failure than a crash.
 *
 * `--remote` drives `POST /api/admin/athletes/:id/sync` instead, so the sync runs inside the
 * Worker with the D1 binding and the deployed config. It stays opt-in because the local mode is
 * still the right thing when developing against `npm start`, and because silently switching which
 * database a write goes to based on which environment variables happen to be set is how this
 * class of bug starts. Local mode now says out loud which file it is touching.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY `--since` EXISTS.
 *
 * `computeSyncWindow` floors the fetch at the earliest of {COMPETITION_START's month, the current
 * month, the first month that already HOLDS rides}. That third source is derived from the rows
 * the fetch itself writes, so it can only ever widen to a month that already has data -- a month
 * that was never fetched is unreachable by all three, and re-running this script computes the
 * identical window and recovers nothing. That is the bug: with COMPETITION_START in the future
 * (which is what shipped) the floor collapsed onto the first of the current month, every month,
 * forever, and July's board froze at whatever happened to be fetched while July was current.
 *
 * `--since` names the month directly and overrides the union. Omitted, `--remote` lets the SERVER
 * default it to COMPETITION_START's month, which is deliberate: the floor is a fact about the
 * deployed config, and a script defaulting it from its own `.env` would default it from the wrong
 * one -- the same mistake in a new place.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE PER-MONTH TABLE.
 *
 * `+added` is one number for a window spanning many months, so it cannot tell "recovered all
 * eight months" apart from "recovered January and August and missed the six in between". The
 * month-by-month counts can, they come from the same `countedPredicate` the leaderboard uses, and
 * they are the only output of this script worth reading closely.
 */

const ORIGIN_HINT = 'must match a WEB_ORIGIN entry on the server; see server/security/csrf.js';

function usage(message) {
  process.stderr.write(
    `${message ? `${message}\n\n` : ''}Usage: npm run backfill [-- <athleteId>] [options]\n\n` +
      `  <athleteId>       back-fill only this rider; default is every athlete\n` +
      `  --remote          sync production through the admin API instead of a local sqlite file\n` +
      `  --api <url>       API base URL for --remote (default: $API_BASE_URL)\n` +
      `  --token <token>   admin session token for --remote (default: $ADMIN_SESSION_TOKEN)\n` +
      `  --origin <url>    Origin header for --remote (default: $WEB_ORIGIN; ${ORIGIN_HINT})\n` +
      `  --since <YYYY-MM> earliest month to fetch; omit to use the server's COMPETITION_START\n` +
      `  --dry-run         print who would be synced and exit without calling Strava\n\n` +
      `Get the admin token by logging in on the site as an admin and reading\n` +
      `localStorage['bc_token'] in the browser console. It lasts SESSION_TTL_SECONDS.\n`,
  );
  process.exit(1);
}

/* ------------------------------------------------------------------------ argument parsing ---- */

/** Read `--flag value`, tolerating `--flag=value`. Returns null when the flag is absent. */
function optionValue(argv, name) {
  const bare = `--${name}`;
  const prefixed = `${bare}=`;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === bare) {
      const next = argv[i + 1];
      // A following flag is a missing value, not the value: `--since --dry-run` must not silently
      // back-fill from a month called "--dry-run".
      if (next === undefined || next.startsWith('-')) usage(`${bare} needs a value.`);
      return next;
    }
    if (argv[i].startsWith(prefixed)) return argv[i].slice(prefixed.length);
  }
  return null;
}

const VALUE_FLAGS = new Set(['api', 'token', 'origin', 'since']);
const BOOLEAN_FLAGS = new Set(['--remote', '--dry-run', '--help', '-h']);

const argv = process.argv.slice(2).filter((a) => a !== '--');

// Every unrecognized flag is fatal. A typo'd `--sinse 2026-01` would otherwise be dropped on the
// floor and the run would quietly back-fill the default range while reporting success.
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith('-')) continue;
  if (BOOLEAN_FLAGS.has(arg)) continue;
  const name = arg.replace(/^--/, '').split('=')[0];
  if (VALUE_FLAGS.has(name)) {
    // Skip the value when it was given separately, so it is not itself parsed as an argument.
    if (arg === `--${name}`) i += 1;
    continue;
  }
  usage(`Unknown option ${arg}.`);
}

if (argv.includes('--help') || argv.includes('-h')) usage();

const dryRun = argv.includes('--dry-run');
const remote = argv.includes('--remote');
const sinceMonth = optionValue(argv, 'since');

// Positionals only: `--since 2026-01` puts a non-flag token in argv that is NOT an athlete id.
const consumed = new Set();
for (const name of VALUE_FLAGS) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) consumed.add(i + 1);
}
const positional = argv.filter((a, i) => !a.startsWith('-') && !consumed.has(i));
if (positional.length > 1) usage('Expected at most one <athleteId>.');

const only = positional.length === 1 ? Number(positional[0]) : null;
// Validated rather than trusted: `Number('123x')` is NaN, which would match no athlete and make
// the script report "nothing to do" instead of "you typed the id wrong".
if (only !== null && (!Number.isInteger(only) || only <= 0)) {
  usage(`"${positional[0]}" is not a positive integer athlete id.`);
}

if (sinceMonth !== null && !isCalendarMonth(sinceMonth)) {
  usage(`--since must be a calendar month in YYYY-MM form, got "${sinceMonth}".`);
}

/* --------------------------------------------------------------------------------- reporting ---- */

/**
 * Render `[{month, ride_count, meters}]` as an indented table.
 *
 * Meters come off the wire and are converted here rather than server-side: db/leaderboard.js is
 * the only place in the app permitted to turn meters into miles for a response, and a diagnostic
 * route quietly doing it too is how a rounding difference between the two shows up as a bug
 * report about the board.
 */
function monthTable(months, indent = '        ') {
  if (!Array.isArray(months) || months.length === 0) {
    return `${indent}(no counted rides in any month)\n`;
  }
  return months
    .map((m) => {
      const miles = milesFromMeters(Number(m.meters)).toFixed(1);
      const rides = String(m.ride_count).padStart(4);
      return `${indent}${m.month}  ${rides} ride(s)  ${miles.padStart(9)} mi\n`;
    })
    .join('');
}

/** Sum per-athlete month rows into one competition-wide table. */
function mergeMonths(tables) {
  const totals = new Map();
  for (const months of tables) {
    for (const m of months ?? []) {
      const slot = totals.get(m.month) ?? { month: m.month, ride_count: 0, meters: 0 };
      slot.ride_count += Number(m.ride_count);
      slot.meters += Number(m.meters);
      totals.set(m.month, slot);
    }
  }
  return [...totals.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
}

/**
 * Name the months between `first` and `last` that have NO rides at all.
 *
 * The gap is the finding. `activityMonthlyTotals` omits empty months rather than reporting zero,
 * so without this a hole in the middle of the range just looks like a shorter list -- exactly how
 * the original bug stayed invisible.
 */
function missingMonths(months) {
  if (months.length < 2) return [];
  const present = new Set(months.map((m) => m.month));
  const gaps = [];
  let cursor = months[0].month;
  const last = months[months.length - 1].month;
  while (cursor < last) {
    const [y, m] = [Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7))];
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    cursor = next;
    if (cursor <= last && !present.has(cursor)) gaps.push(cursor);
  }
  return gaps;
}

/* ----------------------------------------------------------------------------------- drivers ---- */

/**
 * Both modes expose the same three operations, so the roster loop below is written once.
 *
 *   list()            -> [{id, label, revoked, disconnected}]
 *   sync(id)          -> {activitiesScanned, activitiesAdded, activitiesRemoved, pagesFetched,
 *                         truncated, months, sinceMonth}
 *   close()
 *
 * `sync` throws an object carrying `{code, message, retryAfterSeconds}` so the rate-limit rule in
 * the loop does not have to know whether it is reading an HttpError or a JSON body.
 */

function syncFailure(code, message, retryAfterSeconds = null) {
  const err = new Error(message);
  err.code = code;
  err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

/** Local node:sqlite. Development only -- this is NOT the deployed database. */
async function localDriver() {
  const config = loadConfig(process.env, { loadEnvFile: true });
  const db = openDatabase(config.databasePath);
  await migrate(db);

  /**
   * ONE client for the whole run, and that is load-bearing.
   *
   * The rate-limit gate, the observed-429 block and the single-flight spacer are all
   * per-INSTANCE state. A client per athlete would start each one back at "no headers seen,
   * quota untouched", so the reserve could never engage and the run would walk straight into a
   * 15-minute block partway down the roster -- having already reported success for the riders it
   * got to.
   */
  const strava = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    clientSecret: config.stravaClientSecret,
    redirectUri: config.redirectUri,
  });

  // Defaulted here rather than left null, because unlike the remote path there is no server to
  // default it for us. Same value the admin route uses.
  const floor = sinceMonth ?? config.competitionFirstMonth;

  return {
    banner:
      `Target: LOCAL sqlite file ${config.databasePath}\n` +
      `        This is NOT production. Deployed data lives in Cloudflare D1 and is only\n` +
      `        reachable with --remote. See docs/DEPLOY.md.\n` +
      `Requested floor: ${floor}` +
      `${sinceMonth === null ? ` (from COMPETITION_START=${config.competitionStart})` : ' (--since)'}\n`,

    async list() {
      const rows = await listAthletes(db);
      return rows.map((row) => ({
        id: Number(row.athlete_id),
        label: `${row.display_name || `athlete ${row.athlete_id}`} (${row.athlete_id})`,
        revoked: row.strava_revoked_at !== null && row.strava_revoked_at !== undefined,
        disconnected: row.disconnected_at !== null && row.disconnected_at !== undefined,
      }));
    },

    async sync(id) {
      try {
        // `mode: 'full'` overrides auto, which would otherwise pick 'incremental' for anyone whose
        // last_full_sync_at is under a day old and fetch only from their watermark: exactly the
        // riders this script exists for, since the watermark sits in the current month.
        // `force: true` skips the 60-second cooldown ONLY. The advisory lock still applies.
        const result = await syncAthlete(db, config, strava, id, {
          mode: 'full',
          force: true,
          sinceMonth: floor,
        });
        return {
          ...result,
          // `firstMonth` from the sync, not `floor`: the requested month is clamped to the current
          // month and to SYNC_MAX_MONTHS, and printing the request would claim months that were
          // never asked for.
          fetchedFromMonth: result.firstMonth,
          months: await activityMonthlyTotals(db, config, { athleteId: id }),
        };
      } catch (err) {
        throw syncFailure(
          err?.code ?? 'error',
          err?.message ?? String(err),
          Number(err?.extra?.retry_after_seconds) || null,
        );
      }
    },

    async close() {
      await db.close();
    },
  };
}

/**
 * The deployed Worker, over HTTP. Loads NO config and opens NO database.
 *
 * Skipping `loadConfig` is not just tidiness: it requires STRAVA_CLIENT_SECRET, SESSION_SECRET
 * and TOKEN_ENCRYPTION_KEY, none of which this mode uses, so a checkout with no `.env` could not
 * run a remote backfill at all if it went through there first -- it would die on config
 * validation before printing a single line about the thing it was asked to do.
 */
function remoteDriver() {
  const base = (optionValue(argv, 'api') ?? process.env.API_BASE_URL ?? '').replace(/\/+$/, '');
  const token = optionValue(argv, 'token') ?? process.env.ADMIN_SESSION_TOKEN ?? '';
  const origin = (optionValue(argv, 'origin') ?? process.env.WEB_ORIGIN ?? '').replace(/\/+$/, '');

  if (base === '') usage('--remote needs --api <url> or API_BASE_URL.');
  if (token === '') usage('--remote needs --token <token> or ADMIN_SESSION_TOKEN.');
  if (origin === '') usage(`--remote needs --origin <url> or WEB_ORIGIN (${ORIGIN_HINT}).`);

  /**
   * The three headers `requireCsrf` demands of a mutating request, plus the credential.
   *
   * `Content-Type: application/json` and an allowlisted `Origin` are checked for every caller.
   * The `X-CSRF-Token` double-submit is skipped for a bearer caller -- see the long comment on
   * that branch in server/security/csrf.js -- which is the only reason a non-browser client can
   * POST here at all.
   */
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
    origin,
  };

  async function call(method, path, body = null) {
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === null ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      // A transport failure is terminal for the whole run, not just this rider: DNS or TLS is not
      // going to recover between one athlete and the next.
      throw syncFailure(ERROR_CODES.RATE_LIMITED, `cannot reach ${base}: ${err?.message ?? err}`, 0);
    }

    const text = await res.text();
    let payload = null;
    try {
      payload = text === '' ? null : JSON.parse(text);
    } catch {
      payload = null;
    }

    if (!res.ok) {
      const code = payload?.error ?? `http_${res.status}`;
      const detail = payload?.message ?? (text.slice(0, 200) || res.statusText);
      throw syncFailure(
        code,
        `${res.status} ${code}: ${detail}`,
        Number(payload?.retry_after_seconds) || Number(res.headers.get('retry-after')) || null,
      );
    }
    return payload ?? {};
  }

  return {
    banner:
      `Target: ${base} (production D1, through the admin API)\n` +
      `Requested floor: ${sinceMonth ?? "the server's COMPETITION_START"}\n`,

    async list() {
      const payload = await call('GET', '/api/admin/athletes');
      return (payload.athletes ?? []).map((a) => ({
        id: Number(a.athlete_id),
        label: `${a.display_name || `athlete ${a.athlete_id}`} (${a.athlete_id})`,
        revoked: a.revoked === true,
        disconnected: a.disconnected === true,
      }));
    },

    async sync(id) {
      // `since_month` omitted entirely when --since was not given, so the SERVER defaults it.
      // Sending null would mean something different: "no override, use the union floor".
      const body = { mode: 'full' };
      if (sinceMonth !== null) body.since_month = sinceMonth;

      const payload = await call('POST', `/api/admin/athletes/${id}/sync`, body);
      return {
        activitiesScanned: Number(payload.activities_scanned ?? 0),
        activitiesAdded: Number(payload.activities_added ?? 0),
        activitiesRemoved: Number(payload.activities_removed ?? 0),
        pagesFetched: Number(payload.pages_fetched ?? 0),
        truncated: payload.truncated === true,
        sinceMonth: payload.since_month ?? null,
        fetchedFromMonth: payload.fetched_from_month ?? null,
        months: payload.months ?? [],
      };
    },

    async close() {},
  };
}

/* -------------------------------------------------------------------------------------- run ---- */

/** Riders we cannot sync at all, with the reason to print instead of burning a request. */
function skipReason(athlete) {
  if (athlete.revoked) return 'grant revoked at Strava; needs to reconnect';
  if (athlete.disconnected) return 'disconnected; needs to reconnect';
  return null;
}

const driver = remote ? remoteDriver() : await localDriver();

let synced = 0;
let skipped = 0;
let failed = 0;
let truncatedAny = false;
/** Everyone we never got to, so a rate-limited run says who still needs one. */
const remaining = [];
/** Per-athlete month tables, merged into the closing summary. */
const monthTables = [];
/** Whatever floor was actually applied, read back from the first successful sync. */
let appliedFloor = null;

try {
  const all = await driver.list();
  const athletes = only === null ? all : all.filter((a) => a.id === only);

  if (only !== null && athletes.length === 0) {
    process.stderr.write(`No athlete ${only} found.\n`);
    process.exit(1);
  }
  if (athletes.length === 0) {
    process.stdout.write(`${driver.banner}\nNo athletes to back-fill yet.\n`);
    process.exit(0);
  }

  process.stdout.write(
    `${driver.banner}` +
      `${dryRun ? 'Would back-fill' : 'Back-filling'} ${athletes.length} athlete(s)\n\n`,
  );

  for (const [index, athlete] of athletes.entries()) {
    const skip = skipReason(athlete);
    if (skip !== null) {
      skipped += 1;
      process.stdout.write(`  skip  ${athlete.label} — ${skip}\n`);
      continue;
    }
    if (dryRun) {
      process.stdout.write(`  would sync  ${athlete.label}\n`);
      continue;
    }

    try {
      // Sequential, never Promise.all -- see the single-client note in localDriver, which holds
      // for the remote path too: the Worker's per-isolate client carries the same rate-limit
      // state, and concurrent requests would race it.
      const result = await driver.sync(athlete.id);
      synced += 1;
      if (result.truncated) truncatedAny = true;
      if (appliedFloor === null) appliedFloor = result.fetchedFromMonth;
      monthTables.push(result.months);

      process.stdout.write(
        `  ok    ${athlete.label} — ${result.activitiesScanned} scanned, +${result.activitiesAdded} added, ` +
          `-${result.activitiesRemoved} removed, ${result.pagesFetched} page(s)` +
          `${result.truncated ? ' [TRUNCATED]' : ''}\n` +
          monthTable(result.months),
      );
    } catch (err) {
      // A rate limit is terminal for the whole run, not just this athlete: every later request
      // would hit the same block, so continuing turns one 429 into one per remaining rider.
      if (err?.code === ERROR_CODES.RATE_LIMITED) {
        remaining.push(...athletes.slice(index).map((a) => a.id));
        process.stdout.write(`  stop  ${athlete.label} — ${err.message}\n`);
        break;
      }
      failed += 1;
      process.stdout.write(`  FAIL  ${athlete.label} — ${err?.message ?? err}\n`);
    }
  }

  if (dryRun) {
    process.stdout.write('\nDry run: nothing was fetched and nothing was written.\n');
  } else {
    process.stdout.write(`\nsynced ${synced}, skipped ${skipped}, failed ${failed}\n`);

    if (monthTables.length > 0) {
      const merged = mergeMonths(monthTables);
      process.stdout.write(
        `\nCounted rides per month, all riders (fetched from ${appliedFloor ?? 'unknown'}):\n` +
          monthTable(merged, '  '),
      );

      // Named explicitly when it is not what was asked for. The default floor is
      // COMPETITION_START's month, which for a season that has not begun is in the FUTURE, and a
      // future floor is clamped to the current month -- so "I asked for September and got August"
      // has to be visible or it reads as the fetch silently ignoring the request.
      if (sinceMonth !== null && appliedFloor !== null && appliedFloor !== sinceMonth) {
        process.stdout.write(
          `  Note: --since ${sinceMonth} was clamped to ${appliedFloor}` +
            `${sinceMonth > appliedFloor ? ' (a floor after the current month cannot be fetched)' : ' (SYNC_MAX_MONTHS)'}\n`,
        );
      }

      // The actual verification. A month inside the range with nothing in it is either a month
      // nobody rode or a month the fetch still is not reaching, and only the operator can tell
      // which -- but they cannot tell at all unless it is named.
      const gaps = missingMonths(merged);
      if (gaps.length > 0) {
        process.stdout.write(
          `\nNo counted rides at all in: ${gaps.join(', ')}\n` +
            `  If riders were active in those months, the fetch is still not reaching them.\n` +
            `  Check GET /api/admin/months and the server's COMPETITION_START.\n`,
        );
      }
    }

    if (truncatedAny) {
      process.stdout.write(
        `\nAt least one rider's window exceeded the page cap. Nothing was reconciled for them,\n` +
          `and a bare re-run computes the IDENTICAL window. Go in chunks instead, newest first:\n` +
          `  npm run backfill${remote ? ' -- --remote' : ''} --since <later month>\n`,
      );
    }

    if (remaining.length > 0) {
      process.stdout.write(
        `\n${remaining.length} athlete(s) still need a run, rate limit permitting:\n` +
          `  ${remaining.join(' ')}\n` +
          `Re-run once the block lifts; already-synced riders are idempotent.\n`,
      );
    }
  }

  // Non-zero only for real failures. A rate-limited stop is a normal, expected outcome that a
  // caller should be able to loop on without treating it as a broken script.
  if (failed > 0) process.exitCode = 1;
} finally {
  await driver.close();
}
