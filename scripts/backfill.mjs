#!/usr/bin/env node
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { listAthletes } from '../server/db/athletes.js';
import { createStravaClient } from '../server/strava/client.js';
import { syncAthlete } from '../server/strava/sync.js';
import { ERROR_CODES } from '../server/contracts.js';

/**
 * Force a full re-sync of every athlete, right now.
 *
 *   npm run backfill
 *   npm run backfill -- 12345678        # one athlete
 *   npm run backfill -- --dry-run       # list who WOULD be synced, spend no quota
 *
 * NOT a recovery mechanism, and it used to be one. `computeSyncWindow` floored the fetch at the
 * first of the current month whenever COMPETITION_START was in the future, so earlier months were
 * never downloaded -- and its floor could only widen to a month that ALREADY held rides, so a month
 * missed once stayed missed however many times this ran. Sync now asks Strava for every month by
 * name (`computeSyncMonths`), so an ordinary `POST /api/me/sync` fills in old months on its own and
 * there is nothing left for a backfill to recover.
 *
 * What it is still good for: doing that immediately for the whole roster instead of waiting for
 * each rider to press Refresh, and reporting the per-athlete `+added` column while it does.
 *
 * IT WRITES TO THE LOCAL DATABASE. `openDatabase(config.databasePath)` is node:sqlite; a
 * deployment runs on Cloudflare D1, reachable only through server/worker.js. Against production
 * this script finds no athletes and exits 0 -- there, a rider pressing Refresh is what syncs.
 */

function usage(message) {
  process.stderr.write(
    `${message ? `${message}\n\n` : ''}Usage: npm run backfill [-- <athleteId>] [--dry-run]\n\n` +
      `  <athleteId>  back-fill only this rider; default is every athlete\n` +
      `  --dry-run    print who would be synced and exit without calling Strava\n`,
  );
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const dryRun = args.includes('--dry-run');
const positional = args.filter((a) => !a.startsWith('-'));
if (positional.length > 1) usage('Expected at most one <athleteId>.');

const only = positional.length === 1 ? Number(positional[0]) : null;
// Validated rather than trusted: `Number('123x')` is NaN, which would match no athlete and make
// the script report "nothing to do" instead of "you typed the id wrong".
if (only !== null && (!Number.isInteger(only) || only <= 0)) {
  usage(`"${positional[0]}" is not a positive integer athlete id.`);
}

const config = loadConfig(process.env, { loadEnvFile: true });
const db = openDatabase(config.databasePath);

/**
 * ONE client for the whole run, and that is load-bearing.
 *
 * The rate-limit gate, the observed-429 block and the single-flight spacer are all per-INSTANCE
 * state. A client per athlete would start each one back at "no headers seen, quota untouched",
 * so the reserve could never engage and the run would walk straight into a 15-minute block
 * partway down the roster -- having already reported success for the riders it got to.
 */
const strava = createStravaClient({
  apiBase: config.stravaApiBase,
  oauthBase: config.stravaOauthBase,
  clientId: config.stravaClientId,
  clientSecret: config.stravaClientSecret,
  redirectUri: config.redirectUri,
});

/** Riders we cannot sync at all, with the reason to print instead of burning a request. */
function skipReason(athlete) {
  if (athlete.strava_revoked_at !== null) return 'grant revoked at Strava; needs to reconnect';
  if (athlete.disconnected_at !== null) return 'disconnected; needs to reconnect';
  return null;
}

let synced = 0;
let skipped = 0;
let failed = 0;
/** Everyone we never got to, so a rate-limited run says who still needs one. */
const remaining = [];

try {
  await migrate(db);

  const all = await listAthletes(db);
  const athletes = only === null ? all : all.filter((a) => Number(a.athlete_id) === only);

  if (only !== null && athletes.length === 0) {
    process.stderr.write(`No athlete ${only} in ${config.databasePath}.\n`);
    process.exit(1);
  }
  if (athletes.length === 0) {
    process.stdout.write('No athletes to back-fill yet.\n');
    process.exit(0);
  }

  process.stdout.write(
    `${dryRun ? 'Would back-fill' : 'Back-filling'} ${athletes.length} athlete(s) from ${config.databasePath}\n` +
      `fetch floor: ${config.competitionFirstMonth} (COMPETITION_START=${config.competitionStart}), widened per athlete by stored data\n\n`,
  );

  for (const [index, athlete] of athletes.entries()) {
    const id = Number(athlete.athlete_id);
    const label = `${athlete.display_name || `athlete ${id}`} (${id})`;

    const skip = skipReason(athlete);
    if (skip !== null) {
      skipped += 1;
      process.stdout.write(`  skip  ${label} — ${skip}\n`);
      continue;
    }
    if (dryRun) {
      process.stdout.write(`  would sync  ${label}\n`);
      continue;
    }

    try {
      // Sequential, never Promise.all -- see the single-client note above.
      //
      // `mode: 'full'` overrides auto, which would otherwise pick 'incremental' for anyone
      // whose last_full_sync_at is under a day old and fetch only from their watermark: exactly
      // the riders this script exists for, since the watermark sits in the current month.
      // `force: true` skips the 60-second cooldown ONLY. The advisory lock still applies, so a
      // rider clicking Refresh at the same moment gets a clean 409 rather than a double sync.
      const result = await syncAthlete(db, config, strava, id, { mode: 'full', force: true });
      synced += 1;
      process.stdout.write(
        `  ok    ${label} — ${result.activitiesScanned} scanned, +${result.activitiesAdded} added, ` +
          `-${result.activitiesRemoved} removed, ${result.pagesFetched} page(s)` +
          `${result.truncated ? ' [TRUNCATED — run again]' : ''}\n`,
      );
    } catch (err) {
      // A rate limit is terminal for the whole run, not just this athlete: every later request
      // would hit the same block, so continuing turns one 429 into one per remaining rider.
      if (err?.code === ERROR_CODES.RATE_LIMITED) {
        remaining.push(...athletes.slice(index).map((a) => Number(a.athlete_id)));
        process.stdout.write(`  stop  ${label} — ${err.message}\n`);
        break;
      }
      failed += 1;
      process.stdout.write(`  FAIL  ${label} — ${err?.message ?? err}\n`);
    }
  }

  if (dryRun) {
    process.stdout.write('\nDry run: nothing was fetched and nothing was written.\n');
  } else {
    process.stdout.write(`\nsynced ${synced}, skipped ${skipped}, failed ${failed}\n`);
    if (remaining.length > 0) {
      process.stdout.write(
        `\n${remaining.length} athlete(s) still need a run, rate limit permitting:\n` +
          `  ${remaining.join(' ')}\n` +
          `Re-run \`npm run backfill\` once the block lifts; already-synced riders are idempotent.\n`,
      );
    }
  }

  // Non-zero only for real failures. A rate-limited stop is a normal, expected outcome that a
  // caller should be able to loop on without treating it as a broken script.
  if (failed > 0) process.exitCode = 1;
} finally {
  await db.close();
}
