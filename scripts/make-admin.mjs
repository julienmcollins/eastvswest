#!/usr/bin/env node
import { loadConfig } from '../server/config.js';
import { openDatabase } from '../server/db/db.js';
import { migrate } from '../server/db/migrate.js';
import { getAthlete, setAdmin } from '../server/db/athletes.js';
import { deleteSessionsForAthlete } from '../server/db/sessions.js';

/**
 * Grant or revoke the admin flag on one athlete.
 *
 *   npm run make-admin -- 12345678
 *   npm run make-admin -- 12345678 --revoke
 *
 * The `--` is npm's, not ours: without it npm eats the arguments. Both forms are accepted
 * here anyway (see the filter below) because typing it wrong is the normal outcome.
 *
 * Why a script rather than an endpoint: the FIRST admin cannot be created through the admin
 * API, because that API requires an admin. ADMIN_BOOTSTRAP_ATHLETE_IDS covers the same gap at
 * login time; this covers it after the fact, without a redeploy.
 */

function usage(message) {
  process.stderr.write(
    `${message ? `${message}\n\n` : ''}Usage: npm run make-admin -- <athleteId> [--revoke]\n\n` +
      `  <athleteId>  the rider's Strava athlete id (the number in their strava.com/athletes/<id> URL)\n` +
      `  --revoke     remove admin instead of granting it, and drop that athlete's sessions\n`,
  );
  process.exit(1);
}

const args = process.argv.slice(2).filter((a) => a !== '--');
const revoke = args.includes('--revoke');
const positional = args.filter((a) => !a.startsWith('-'));

if (positional.length !== 1) usage(positional.length === 0 ? 'Missing <athleteId>.' : 'Expected exactly one <athleteId>.');

const athleteId = Number(positional[0]);
// Validated rather than trusted: `Number('12345678x')` is NaN and would bind as NULL, so the
// UPDATE would match nothing and the script would cheerfully report "no such athlete".
if (!Number.isInteger(athleteId) || athleteId <= 0) usage(`"${positional[0]}" is not a positive integer athlete id.`);

const config = loadConfig(process.env, { loadEnvFile: true });
const db = openDatabase(config.databasePath);

try {
  // The script may be the first thing ever run against a fresh DATABASE_PATH.
  await migrate(db);

  const athlete = await getAthlete(db, athleteId);
  if (!athlete) {
    process.stderr.write(
      `No athlete ${athleteId} in ${config.databasePath}.\n` +
        `They must sign in with Strava at least once before they can be made an admin.\n`,
    );
    process.exit(1);
  }

  const wasAdmin = Number(athlete.is_admin) === 1;
  await setAdmin(db, athleteId, !revoke);

  let sessionsDropped = 0;
  if (revoke) {
    // requireAdmin re-reads the row on every request, so a stale session cannot retain the
    // flag on its own. Dropping the sessions anyway is defense in depth: it guarantees the
    // demoted admin's client re-fetches /api/me rather than rendering admin controls that
    // now 403, which reads as a broken server rather than as a revoked privilege.
    sessionsDropped = await deleteSessionsForAthlete(db, athleteId);
  }

  const name = athlete.display_name || `Athlete ${athleteId}`;
  const verb = revoke ? 'revoked admin from' : 'granted admin to';
  process.stdout.write(
    `${verb} ${name} (${athleteId})${wasAdmin === !revoke ? ' — already in that state, no change' : ''}.\n` +
      (revoke ? `Dropped ${sessionsDropped} active session(s).\n` : ''),
  );
} finally {
  await db.close();
}
