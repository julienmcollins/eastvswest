import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/db.js';
import { migrate, schemaVersion } from './db/migrate.js';
import { purgeExpiredSessions } from './db/sessions.js';
import { purgeExpiredStates } from './db/oauthStates.js';
import { buildRoutes } from './routes/index.js';
import { createStravaClient } from './strava/client.js';
import { sweepStaleSyncLocks } from './strava/sync.js';
import { epochSeconds } from './lib/dates.js';
import { log } from './lib/log.js';

/**
 * The process. This is the ONLY file that opens a socket, reads the filesystem for static
 * assets, or installs process-level handlers.
 *
 * Everything else is a pure function of its dependencies, which is what lets the entire test
 * suite drive `buildApp()` directly through `injectRequest` -- necessary here, because
 * `server.listen(0,'127.0.0.1')` fails with EPERM in this development sandbox. When this file
 * is deleted at deploy time (Pages serves public/, a Worker owns the request), nothing above
 * it changes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

/** How long a graceful shutdown waits for in-flight requests before forcing the socket shut. */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * Adapt server/lib/log.js to the shape strava/client.js expects.
 *
 * The client calls `logger.debug({event, method, host, pathname, status, ...})` -- one object,
 * no message string -- because its logging contract is "named scalars only, so no call site
 * can slip a form body or a token into a line". Our logger is `(msg, fields)`, so without
 * this adapter every Strava request would log the string "[object Object]" and drop every
 * field. `debug` maps to `info`: there is no level filter here by design.
 */
const stravaLogger = {
  debug: ({ event, ...fields }) => log.info(event ?? 'strava', fields),
  info: ({ event, ...fields }) => log.info(event ?? 'strava', fields),
  warn: ({ event, ...fields }) => log.warn(event ?? 'strava', fields),
  error: ({ event, ...fields }) => log.error(event ?? 'strava', fields),
};

async function main() {
  // Config is validated and frozen before anything else exists. A bad SESSION_SECRET must
  // stop the process here, not at some rider's first login three hours from now.
  const config = loadConfig(process.env, { loadEnvFile: true });

  const db = openDatabase(config.databasePath);
  const migration = await migrate(db);
  log.info('database ready', {
    path: config.databasePath,
    schema_version: schemaVersion(db),
    migrations_applied: migration.applied,
  });

  const strava = createStravaClient({
    apiBase: config.stravaApiBase,
    oauthBase: config.stravaOauthBase,
    clientId: config.stravaClientId,
    // The secret's ONLY consumer. It reaches no other module, no response, and no log line.
    clientSecret: config.stravaClientSecret,
    redirectUri: config.redirectUri,
    logger: stravaLogger,
  });

  // --- Startup sweeps. ---
  //
  // None of these is a security boundary -- expiry is enforced on every lookup, and a stale
  // sync lock self-heals on its TTL. They are here so a restart cleans up after the crash
  // that probably caused it: without the lock sweep, an athlete whose sync was killed
  // mid-flight gets 409 sync_in_progress until the TTL passes with nothing to point at.
  const nowEpoch = epochSeconds();
  const [sessionsPurged, statesPurged, locksHealed] = await Promise.all([
    purgeExpiredSessions(db, nowEpoch),
    purgeExpiredStates(db, nowEpoch),
    sweepStaleSyncLocks(db),
  ]);
  log.info('startup sweep', {
    sessions_purged: sessionsPurged,
    oauth_states_purged: statesPurged,
    stale_sync_locks_healed: locksHealed,
  });

  const routes = buildRoutes({ config, db, strava });
  const app = buildApp({ config, db, routes, publicDir: PUBLIC_DIR });

  const server = createServer(app);

  // A request that never finishes its headers holds a socket open indefinitely; both of these
  // are Node defaults in newer versions, set explicitly so a version bump cannot silently
  // remove them.
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;

  installProcessHandlers({ server, db });

  await new Promise((resolve, reject) => {
    // `listen` reports a bind failure BOTH ways depending on the failure: asynchronously via
    // the 'error' event for EADDRINUSE, and by throwing synchronously for EPERM (which is
    // what a sandboxed or unprivileged environment produces). The Promise executor turns the
    // synchronous throw into a rejection, so one catch below covers both.
    server.once('error', reject);
    server.listen(config.port, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  log.info('listening', {
    url: `http://localhost:${port}`,
    app_base_url: config.appBaseUrl,
    api_base_url: config.apiBaseUrl,
    web_origin: config.webOrigin,
    redirect_uri: config.redirectUri,
    node_env: config.nodeEnv,
    // Printed at boot because it is the single most common misconfiguration: the competition
    // window silently excluding every ride anyone has done.
    competition: `${config.competitionStart} .. ${config.competitionEnd} (${config.competitionTz})`,
    allowed_sport_types: config.allowedSportTypes,
    manual_rides_counted: config.countManualActivities,
    routes: routes.list().length,
  });
}

/**
 * Process-level safety nets and graceful shutdown.
 *
 * `unhandledRejection` is not decoration here. server/http/respond.js documents the exact way
 * this codebase produces one: a client aborting a large download makes `pipeline` reject after
 * headers are already sent. sendError guards that case, but the handler exists so the NEXT
 * such path logs a diagnosable line instead of killing the process with a bare stack.
 */
function installProcessHandlers({ server, db }) {
  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal: one dropped promise must not take every other rider's session with
    // it. It goes through log.error -> redact(), so a rejection carrying a token stays out of
    // the output.
    log.error('unhandledRejection', {
      error_name: reason?.name ?? 'UnhandledRejection',
      error_message: reason?.message ?? String(reason),
      stack: typeof reason?.stack === 'string' ? reason.stack : undefined,
    });
  });

  process.on('uncaughtException', (err) => {
    // FATAL, deliberately, and the asymmetry with unhandledRejection is the point: after an
    // uncaught throw the process state is unknown, and continuing to serve requests from a
    // half-broken interpreter is worse than exiting and being restarted.
    log.error('uncaughtException -- exiting', {
      error_name: err?.name,
      error_message: err?.message,
      stack: err?.stack,
    });
    shutdown({ server, db, code: 1, signal: 'uncaughtException' });
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => shutdown({ server, db, code: 0, signal }));
  }
}

let shuttingDown = false;

/**
 * Stop accepting connections, let in-flight requests finish, close the database.
 *
 * The database close matters more than it looks: WAL mode leaves `-wal` and `-shm` files, and
 * a clean close checkpoints them. Killing the process instead is recoverable but leaves the
 * next start reading a journal it did not have to.
 */
function shutdown({ server, db, code, signal }) {
  // A second SIGINT (an impatient double Ctrl-C) must not start a second close and race the
  // first one's callbacks.
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });

  const timer = setTimeout(() => {
    log.warn('shutdown grace period expired; forcing exit', { signal });
    process.exit(code);
  }, SHUTDOWN_GRACE_MS);
  // Otherwise this timer alone keeps the event loop alive for the full grace period even
  // after everything else has closed.
  timer.unref();

  server.close(async () => {
    try {
      await db.close();
    } catch (err) {
      log.error('database close failed', { error_message: err?.message });
    }
    clearTimeout(timer);
    process.exit(code);
  });
}

try {
  await main();
} catch (err) {
  // A startup failure is fatal and exits non-zero: a half-started process is not something to
  // serve requests from, and a supervisor needs the exit code to know not to keep it.
  //
  // This catch also keeps the cause READABLE. Without it, a bad SESSION_SECRET or an EPERM
  // bind surfaces as a top-level-await rejection reported through the uncaughtException path,
  // whose "exiting" line buries the one fact that matters.
  log.error('startup failed', {
    error_name: err?.name,
    error_message: err?.message,
    // `error_code`, not `code`: redact() strips a key called `code` (an OAuth authorization
    // code must never be logged), which would print "[redacted]" where EPERM belongs.
    error_code: err?.code === undefined ? undefined : String(err.code),
    stack: err?.stack,
  });
  process.exit(1);
}
