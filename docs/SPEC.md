Verified on this machine before merging (Node v26.3.0, SQLite 3.53.2): the project directory is **empty** — `.env.example`, `.gitignore`, `.npmrc` do not exist, so Phase 0 authors them. Also confirmed: boolean and `undefined` binds throw, array params throw `Unknown named parameter '0'`, `run()` → `{changes,lastInsertRowid}`, `PRAGMA foreign_keys`=1, `PRAGMA journal_mode=WAL` inside `BEGIN IMMEDIATE` silently returns `delete`, JSON1 present, `db.backup` undefined (module-level only), `globalThis.crypto.timingSafeEqual` undefined, and **`server.listen(0,'127.0.0.1')` fails `EPERM` in this sandbox** — which reshapes the whole test strategy below.

## Architecture

```
.env.example                     Every var below, commented; no real secrets. Does not exist yet — write it.
.gitignore                       .env, *.db, *.db-wal, *.db-shm, node_modules, .DS_Store.
.npmrc                           registry=https://registry.npmjs.org/  (cosmetic; we ship 0 deps).
package.json                     {"type":"module"}, engines node>=26, scripts only. NO dependencies/devDependencies keys at all.
README.md                        Rules page text: which sport types count, manual-ride policy, private-ride badge, Strava attribution.

server/index.js                  ONLY file that calls http.createServer/listen, reads the FS for static, and installs process.on('unhandledRejection'|'uncaughtException'|SIGTERM|SIGINT).
server/app.js                    buildApp({config,db}) -> async (req,res). No listen. Reused verbatim by tests and by the serverless adapter.
server/config.js                 loadConfig(env = process.env): process.loadEnvFile() guarded, validate/coerce/decode every var, freeze. Throws at boot on bad config. ONLY env reader in the tree.
server/contracts.js              Frozen shared constants: TEAMS=['EAST','WEST'], ERROR_CODES, METERS_PER_MILE=1609.344, REQUIRED_SCOPE_ANY=['activity:read_all','activity:read'], API_SCHEMA=1. Imported by server/ AND mirrored by public/ tests.

server/http/router.js            createRouter(); segment match with :params; distinguishes 404 vs 405; GET route also answers HEAD.
server/http/respond.js           HttpError; sendJson (no-store, nosniff, referrer-policy); sendError (FIRST LINE: headersSent/writableEnded guard -> log + res.destroy()); sendRedirect.
server/http/body.js              readJsonBody(req,{limit=65536}): 415 on non-JSON, 413 enforced on the byte stream, writes the 413 response BEFORE req.destroy().
server/http/cookies.js           parseCookies(header)->Map; serializeCookie(name,value,opts).
server/http/cors.js              corsHeaders(req,config) from an allowlist (empty => {}), always Vary: Origin[, Authorization, Cookie]; OPTIONS /api/* preflight branch. Inert today.
server/http/static.js            createStaticHandler(publicDir): GET/HEAD, traversal-proof, extension allowlist, ETag, CSP+X-Frame-Options on HTML, 404 for extensioned misses. Deleted at deploy time.

server/db/db.js                  THE adapter. openDatabase(config) (pragmas here, OUTSIDE any tx, asserted); all/get/run/batch — ALL async, positional ? only, one statement per call.
server/db/schema.sql             Canonical DDL (mirror of 001_init.sql, for reading/reset only).
server/migrations/001_init.sql   Ordered plain SQL, no PRAGMAs. wrangler-d1-compatible.
server/db/migrate.js             migrate(db): PRAGMA user_version -> apply pending files in one batch -> bump.
server/db/athletes.js            upsertAthleteFromStrava, getAthlete, claimTeam (atomic), adminSetTeam, setAdmin, listAthletes, markRevoked, clearRevoked.
server/db/tokens.js              saveTokens (token_version CAS), loadTokens, deleteTokens. ONLY module that calls encrypt/decrypt.
server/db/activities.js          upsertActivities(db,athleteId,rows) via batch, reconcileDeletions(db,athleteId,window,seenIds), listAthleteActivities, purgeAthleteActivities.
server/db/sessions.js            insert, findByRawId (selects last_seen_at), touch, deleteOne, deleteForAthlete, purgeExpired.
server/db/oauthStates.js         insert({stateHash,nonceHash,expiresAt,returnTo}), consume(stateHash) via DELETE..RETURNING, purgeExpired, hardCap.
server/db/syncState.js           get, acquireLock(ttl), releaseLock, recordOk, recordError, advanceWatermark, sweepStaleLocks.
server/db/leaderboard.js         teamTotals, riderTotals, dailySeries. ONLY place meters->miles happens.

server/security/crypto.js        AES-256-GCM encryptSecret/decryptSecret, "v1.iv.ct.tag". Random 12-byte IV, 16-byte tag, no IV parameter.
server/security/hash.js          sha256b64u(str), hmacB64u(key,str) — the only node:crypto hash surface (single file to port to WebCrypto).
server/security/oauthState.js    createOAuthState (HMAC + nonce cookie + DB row), verifyAndConsumeOAuthState (length-check then timingSafeEqual, nonce match, atomic consume), safeReturnTo via new URL().
server/security/sessionStore.js  createSession -> raw 32-byte token (returned once); resolveSession(rawId) by SHA-256 hash; revoke.
server/security/csrf.js          issueCsrfCookie, requireCsrf(ctx): double-submit bc_csrf vs X-CSRF-Token + Origin allowlist + application/json.
server/security/guards.js        requireSession, requireTeamChosen, requireAdmin, requireNotRevoked.
server/security/redact.js        redact(obj) — strips access_token/refresh_token/client_secret/code/cookie/authorization/state.

server/strava/client.js          createStravaClient(opts) — pure HTTP. No env, no node:sqlite, no process.*. fetchImpl/now injected. Error classes, rate-limit gate, single-flight spacer.
server/strava/map.js             Pure: normalizeActivity, isCountedSportType, computeSyncWindow, parseRateLimitHeaders, localDateOf, nextQuarterHourMs, nextUtcMidnightMs, toBindable.
server/strava/authUrl.js         buildAuthorizeUrl(config,{state,approvalPrompt}), redirectUri(config) = API_BASE_URL + '/api/auth/strava/callback'.
server/strava/tokenService.js    getValidAccessToken(db,cfg,athleteId): in-process single-flight Map + DB token_version CAS; withAuth(fn) retries one 401.
server/strava/sync.js            syncAthlete(db,cfg,strava,athleteId,{mode,force}) — the ONLY module that knows both DB and Strava.

server/routes/index.js           buildRoutes({config,db,strava}) — registers everything below; applies requireCsrf to every mutating route and requireAdmin to the /api/admin/* prefix in one place.
server/routes/health.js          GET /api/health, GET /api/health/strava (admin).
server/routes/auth.js            login, reconnect, callback, logout.
server/routes/me.js              GET /api/me, POST /api/me/team, POST /api/me/sync, POST /api/me/disconnect, DELETE /api/me.
server/routes/leaderboard.js     GET /api/leaderboard, GET /api/riders/:athleteId/activities.
server/routes/admin.js           GET /api/admin/athletes, POST /api/admin/athletes/:id/team, POST /api/admin/athletes/:id/admin, POST /api/admin/athletes/:id/sync (the backfill), GET /api/admin/months, POST /api/admin/activities/:id/approve.

server/lib/units.js              metersToMiles, round1.
server/lib/dates.js              todayInCompetitionTz(cfg), resolveWindow(cfg,query) clamped to the configured window, epochSeconds, isoUtcNow.
server/lib/log.js                One-line JSON logs through redact(). Never logs bodies, headers, or forms.

scripts/keygen.mjs               Prints SESSION_SECRET + TOKEN_ENCRYPTION_KEY to stdout only.
scripts/make-admin.mjs           npm run make-admin -- <athleteId> [--revoke]; revoke also drops sessions.
scripts/reset-db.mjs             Dev-only drop + re-migrate, requires --yes.
scripts/strava-probe.mjs         REAL-Strava one-shot prober: prints rate-limit headers, per_page=200 acceptance, before/after field semantics, refresh rotation, deauthorize shape. Resolves the whole unverified ledger.

test/helpers/inject.js           injectRequest(handler,{method,url,headers,body}) over stream.PassThrough — the PRIMARY harness; needs no sockets (listen() is EPERM here).
test/helpers/fakeStrava.js       createFakeStrava(opts) -> { fetchImpl, requests, tokens, expireAccessToken, revokeAthlete, setRateLimit, queue429, queue500 }. In-process fetch double, NOT an http server. Optional .listen() mode that self-skips on EPERM.
test/helpers/testDb.js           freshDb(): openDatabase(':memory:') + migrate + seed helpers.
test/fixtures/activities.json    The adversarial fixture set (§Verification).
test/fixtures/leaderboard.sample.json  Pinned GET /api/leaderboard payload — the frozen contract public/ is built against.
test/*.test.js                   map, client, sync, crypto, oauthState, session, body, static, router, leaderboard, guards, e2e.

public/index.html                Static shell + <template> rows + <dialog> picker + <meta http-equiv="Content-Security-Policy">. ALL paths relative. Module imports carry ?v=N.
public/styles.css                color-scheme: light dark; custom-property theme; split bar; tabular-nums.
public/config.js                 THE migration seam: location.hostname -> API_BASE ("" = same origin).
public/api.js                    The ONLY place fetch() is called. Attaches X-CSRF-Token, credentials:'include', and Authorization when a token exists. ApiError.
public/format.js                 miles, int, pct, relTime, dateRange, safeAvatar (total function), safeHref.
public/render.js                 The ONLY module that touches the DOM.
public/app.js                    Boot, state, event wiring.
public/404.html                  Copy of index.html (Pages has no SPA fallback).
public/.nojekyll                 Insurance only if Pages source is ever flipped to branch mode; the Actions artifact path does not run Jekyll.
public/assets/                   Official Strava Connect + "Powered by Strava" SVGs (self-hosted, unmodified), favicon.svg, avatar-fallback.svg.

.github/workflows/pages.yml      WRITTEN. Gates on `npm test` + index/404 parity, then publishes public/. Runbook: docs/DEPLOY.md.
wrangler.toml.example            Template for the Workers+D1 API host. Copy to wrangler.toml; secrets go via `wrangler secret put`.
```

## Pre-flight verifications

Already run on this machine — do not re-litigate: `node:sqlite` exports `{DatabaseSync,StatementSync,Session,constants,backup}`; `sqlite_version()=3.53.2`; `PRAGMA foreign_keys`=1 by default; `run()` returns plain-number `{changes,lastInsertRowid}`; JSON1 present; `process.loadEnvFile`, `AbortSignal.timeout`, `crypto.hash` all functions.

| # | Claim to confirm | Exact check | Fallback if it fails |
|---|---|---|---|
| 1 | Boolean/undefined binds throw (**VERIFIED**: "Provided value cannot be bound to SQLite parameter N") | `node -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(':memory:');d.exec('create table t(a integer) strict');try{d.prepare('insert into t values(?)').run(true)}catch(e){console.log(e.message)}"` | None needed — `toBindable()` in `strava/map.js` asserts every value is `null\|number\|bigint\|string` and is called by every repository write. |
| 2 | Array args are named params, not positional (**VERIFIED**: `Unknown named parameter '0'`) | `...prepare('select ?').all([1])` | Always `stmt.all(...params)`. The `db.js` adapter takes `params: unknown[]` and spreads internally, so no call site can get this wrong. |
| 3 | PRAGMA inside a transaction is a silent no-op (**VERIFIED**: returns `delete`) | `db.exec('BEGIN IMMEDIATE'); db.prepare('PRAGMA journal_mode=WAL').get()` | Pragmas live ONLY in `openDatabase()`, outside any tx, and the result is asserted: `if (jm!=='wal' && !isMemory) throw`. `schema.sql`/`001_init.sql` contain zero PRAGMAs. |
| 4 | `db.backup` is not a method (**VERIFIED** `undefined`; module export is) | `node -e "const s=require('node:sqlite');console.log(typeof new s.DatabaseSync(':memory:').backup, typeof s.backup)"` | Backup script uses module-level `backup(sourceDb, path)`. |
| 5 | **`listen(0)` is EPERM in this sandbox (VERIFIED)** | `node -e "require('http').createServer(()=>{}).listen(0,'127.0.0.1').on('error',e=>console.log(e.code))"` | Already applied: the primary harness is `injectRequest()` and the Strava double is a `fetchImpl`, not a server. Socket-based e2e lives in one file that does `try{await listen()}catch(e){if(e.code==='EPERM')return t.skip(...)}`. |
| 6 | `globalThis.crypto.timingSafeEqual` absent (**VERIFIED** `undefined`) | `node -e "console.log(typeof globalThis.crypto.timingSafeEqual)"` | Confirms the decision to use `node:crypto` (isolated to `security/crypto.js` + `security/hash.js`) instead of the frontend design's "WebCrypto only" rule. **I overrule that rule:** hashing session ids to a PK lookup removes any need for constant-time compare, and two-file isolation buys the same portability. |
| 7 | GENERATED STORED column in a STRICT table | `create table a(s text not null, d text generated always as (substr(s,1,10)) stored) strict;` then insert `'2026-07-04T08:00:00Z'` and select `d` | If rejected: drop the generated column, compute `local_date` in `normalizeActivity` and bind it explicitly. Nothing else changes. |
| 8 | `DELETE ... RETURNING` is atomic single-use | `delete from oauth_states where state_hash=? returning return_to` twice; second `get()` must be `undefined` | If unsupported: `SELECT` + `DELETE` inside `BEGIN IMMEDIATE` and check `res.changes===1`. |
| 9 | **Strava: everything.** Rate limits (100/1000 vs 200/2000), whether `per_page=200` is accepted, whether `before`/`after` compare `start_date` or `start_date_local`, whether `refresh_token` rotates, `POST /oauth/deauthorize` shape, presence of `X-ReadRateLimit-*` and `Retry-After`, whether the callback-domain field takes one domain. **Network to developers.strava.com is blocked here — all of it is knowledge, not docs.** | `node scripts/strava-probe.mjs` against a real Strava app, before Step 12. It prints every response header, requests one page at `per_page=200` and one at `100`, refreshes twice printing whether the refresh token changed, and posts a known UTC+13-edge query with `after` set both to the UTC and the local interpretation. | The code is already written so every answer is safe: limits come from headers with a conservative `{short:100,daily:1000}` pre-first-response default; a 400 on `per_page=200` falls back to 100; the fetch window is padded ±86400 s which is correct under **both** `before`/`after` interpretations (|UTC offset| ≤ 14 h < 24 h); the returned `refresh_token` is persisted unconditionally; deauthorize sends both bearer header and form field and treats 401 as success. |
| 10 | Strava brand obligations (button asset must not be restyled, "Powered by Strava" on every data view, minimum logo size/clear space, deep-link back to athletes/activities, no ML-training use) | Read the Brand Guidelines + API Agreement pages once network is available; diff against the checklist | These are contractual, not technical. Ship the official unmodified SVGs from day one; the only thing a doc check can change is sizing. |

## Data model

```sql
-- server/migrations/001_init.sql
-- NO PRAGMAs in this file: verified that a PRAGMA inside a transaction is silently
-- ignored (journal_mode came back 'delete'). Pragmas live only in openDatabase().
-- All timestamps are supplied by JS (ISO-8601 UTC TEXT, or unix-second INTEGER where noted)
-- so behaviour is identical on node:sqlite and D1 and tests are deterministic.

CREATE TABLE athletes (
  strava_athlete_id INTEGER PRIMARY KEY,          -- FK parent MUST be the PK, else
                                                  -- "foreign key mismatch" at INSERT time.
  username          TEXT,
  firstname         TEXT    NOT NULL DEFAULT '',
  lastname          TEXT    NOT NULL DEFAULT '',
  display_name      TEXT    NOT NULL DEFAULT '',
  avatar_url        TEXT,                         -- absolute https: URL or NULL. Server-normalized.
  team              TEXT             CHECK (team IS NULL OR team IN ('EAST','WEST')),
  is_admin          INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  granted_scope     TEXT    NOT NULL DEFAULT '',  -- csv exactly as Strava returned it
  team_locked_at    TEXT,
  strava_revoked_at INTEGER,                      -- unix s; non-NULL => reconnect badge
  disconnected_at   INTEGER,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_athletes_team ON athletes (team) WHERE team IS NOT NULL;

CREATE TABLE oauth_tokens (
  athlete_id        INTEGER PRIMARY KEY
                    REFERENCES athletes(strava_athlete_id) ON DELETE CASCADE,
  access_token_enc  TEXT    NOT NULL,             -- "v1.<iv>.<ct>.<tag>"
  refresh_token_enc TEXT    NOT NULL,
  token_version     INTEGER NOT NULL DEFAULT 0,   -- CAS guard. NEVER compare GCM ciphertext:
                                                  -- a random IV makes it differ every seal.
  expires_at        INTEGER NOT NULL,             -- Strava expires_at, unix seconds UTC
  scope             TEXT    NOT NULL DEFAULT '',
  token_type        TEXT    NOT NULL DEFAULT 'Bearer',
  updated_at        TEXT    NOT NULL
) STRICT;

CREATE TABLE activities (
  strava_activity_id          INTEGER PRIMARY KEY,   -- Strava id => upsert is idempotent
  athlete_id                  INTEGER NOT NULL
                              REFERENCES athletes(strava_athlete_id) ON DELETE CASCADE,
  name                        TEXT    NOT NULL DEFAULT '',
  sport_type                  TEXT    NOT NULL,      -- the filter field
  legacy_type                 TEXT,                  -- raw.type, forensics only
  sport_type_source           TEXT    NOT NULL DEFAULT 'sport_type'
                              CHECK (sport_type_source IN ('sport_type','type')),
  distance_meters             REAL    NOT NULL DEFAULT 0 CHECK (distance_meters >= 0),
  moving_time_seconds         INTEGER NOT NULL DEFAULT 0 CHECK (moving_time_seconds >= 0),
  elapsed_time_seconds        INTEGER NOT NULL DEFAULT 0,
  total_elevation_gain_meters REAL    NOT NULL DEFAULT 0,
  start_date_utc              TEXT    NOT NULL,       -- true UTC instant
  start_epoch                 INTEGER NOT NULL,       -- Date.parse(start_date_utc)/1000
  start_date_local            TEXT    NOT NULL,       -- LOCAL WALL CLOCK with a bogus Z. Never new Date() this.
  local_date                  TEXT    GENERATED ALWAYS AS (substr(start_date_local,1,10)) STORED,
  timezone                    TEXT,
  is_private                  INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0,1)),
  is_manual                   INTEGER NOT NULL DEFAULT 0 CHECK (is_manual  IN (0,1)),
  manual_approved             INTEGER NOT NULL DEFAULT 0 CHECK (manual_approved IN (0,1)),
  is_trainer                  INTEGER NOT NULL DEFAULT 0 CHECK (is_trainer IN (0,1)),
  deleted_at                  INTEGER,                -- soft delete from reconciliation
  synced_at                   TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_activities_leaderboard ON activities (local_date, sport_type, athlete_id);
CREATE INDEX idx_activities_athlete_date ON activities (athlete_id, local_date DESC);
CREATE INDEX idx_activities_athlete_epoch ON activities (athlete_id, start_epoch);

CREATE TABLE sessions (
  session_id_hash TEXT    PRIMARY KEY,             -- sha256(raw token), base64url. Raw never stored.
  athlete_id      INTEGER NOT NULL
                  REFERENCES athletes(strava_athlete_id) ON DELETE CASCADE,
  created_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  last_seen_at    INTEGER NOT NULL,
  user_agent      TEXT    NOT NULL DEFAULT ''
) STRICT;

CREATE INDEX idx_sessions_athlete ON sessions (athlete_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE oauth_states (
  state_hash TEXT    PRIMARY KEY,                  -- sha256(state)
  nonce_hash TEXT    NOT NULL,                     -- sha256(bc_oauth cookie nonce) -- BROWSER BINDING
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  return_to  TEXT    NOT NULL DEFAULT '/'
) STRICT;

CREATE INDEX idx_oauth_states_expires ON oauth_states (expires_at);

CREATE TABLE sync_state (
  athlete_id          INTEGER PRIMARY KEY
                      REFERENCES athletes(strava_athlete_id) ON DELETE CASCADE,
  watermark_epoch     INTEGER NOT NULL DEFAULT 0,  -- max(start_epoch) ever persisted. Fast path only.
  last_full_sync_at   INTEGER,                     -- full-window reconciliation; watermark alone is NOT correct
  last_sync_started   INTEGER,
  last_sync_finished  INTEGER,
  lock_expires_at     INTEGER,                     -- stale-lock self-heal; NULL/past => unlocked
  last_status         TEXT    NOT NULL DEFAULT 'never'
                      CHECK (last_status IN ('never','running','ok','error')),
  last_error          TEXT,
  activities_upserted INTEGER NOT NULL DEFAULT 0,
  pages_fetched       INTEGER NOT NULL DEFAULT 0,
  truncated           INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1))
) STRICT;
```

**Activity upsert** (one statement, positional `?` only, `athlete_id` intentionally in the SET so a re-owned row self-heals but never a generated column):

```sql
INSERT INTO activities (
  strava_activity_id, athlete_id, name, sport_type, legacy_type, sport_type_source,
  distance_meters, moving_time_seconds, elapsed_time_seconds, total_elevation_gain_meters,
  start_date_utc, start_epoch, start_date_local, timezone,
  is_private, is_manual, is_trainer, deleted_at, synced_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?)
ON CONFLICT(strava_activity_id) DO UPDATE SET
  name=excluded.name, sport_type=excluded.sport_type, legacy_type=excluded.legacy_type,
  sport_type_source=excluded.sport_type_source, distance_meters=excluded.distance_meters,
  moving_time_seconds=excluded.moving_time_seconds, elapsed_time_seconds=excluded.elapsed_time_seconds,
  total_elevation_gain_meters=excluded.total_elevation_gain_meters,
  start_date_utc=excluded.start_date_utc, start_epoch=excluded.start_epoch,
  start_date_local=excluded.start_date_local, timezone=excluded.timezone,
  is_private=excluded.is_private, is_manual=excluded.is_manual, is_trainer=excluded.is_trainer,
  deleted_at=NULL, synced_at=excluded.synced_at;
```

**Deletion reconciliation** — only after a fully successful, untruncated **full-mode** fetch, inside the same batch, `?` count built from `seenIds.length`:

```sql
UPDATE activities SET deleted_at = ?
 WHERE athlete_id = ? AND start_epoch >= ? AND start_epoch < ?
   AND deleted_at IS NULL
   AND strava_activity_id NOT IN (/* N placeholders */);
```

**Token CAS** (`res.changes === 0` ⇒ another worker rotated; re-read and use theirs):

```sql
UPDATE oauth_tokens
   SET access_token_enc=?, refresh_token_enc=?, expires_at=?, scope=?, token_type=?,
       token_version=token_version+1, updated_at=?
 WHERE athlete_id=? AND token_version=?;
```

**Atomic one-time team claim** (`get()` returning `undefined` ⇒ 409; defeats the double-click race):

```sql
UPDATE athletes SET team=?, team_locked_at=?, updated_at=?
 WHERE strava_athlete_id=? AND team IS NULL RETURNING team;
```

**Counted-activity predicate** — reused verbatim by every aggregate. `$sports` is N placeholders from `config.allowedSportTypes.length`; `?countManual` is 0/1 from `COUNT_MANUAL_ACTIVITIES`:

```sql
ac.deleted_at IS NULL
AND ac.local_date >= ? AND ac.local_date <= ?
AND ac.sport_type IN ($sports)
AND (ac.is_manual = 0 OR ? = 1 OR ac.manual_approved = 1)
```

**Team totals** — driven from `athletes` with the filter in the ON clause (a WHERE on the right table silently re-narrows a LEFT JOIN to an inner join and makes a zero-mile team vanish):

```sql
SELECT ath.team AS team,
       COALESCE(SUM(ac.distance_meters),0)        AS total_meters,
       COUNT(ac.strava_activity_id)               AS ride_count,
       COUNT(DISTINCT ath.strava_athlete_id)      AS rider_count,
       COALESCE(SUM(ac.moving_time_seconds),0)    AS moving_seconds
  FROM athletes ath
  LEFT JOIN activities ac
    ON ac.athlete_id = ath.strava_athlete_id
   AND ac.deleted_at IS NULL
   AND ac.local_date >= ? AND ac.local_date <= ?
   AND ac.sport_type IN ($sports)
   AND (ac.is_manual = 0 OR ? = 1 OR ac.manual_approved = 1)
 WHERE ath.team IN ('EAST','WEST')
 GROUP BY ath.team
 ORDER BY total_meters DESC, ath.team ASC;
```

**Rider totals**:

```sql
SELECT ath.strava_athlete_id                      AS athlete_id,
       ath.display_name, ath.avatar_url, ath.team,
       ath.granted_scope, ath.strava_revoked_at,
       COALESCE(SUM(ac.distance_meters),0)        AS meters,
       COUNT(ac.strava_activity_id)               AS ride_count,
       COALESCE(MAX(ac.distance_meters),0)        AS longest_meters,
       COALESCE(SUM(ac.moving_time_seconds),0)    AS moving_seconds
  FROM athletes ath
  LEFT JOIN activities ac
    ON ac.athlete_id = ath.strava_athlete_id
   AND ac.deleted_at IS NULL
   AND ac.local_date >= ? AND ac.local_date <= ?
   AND ac.sport_type IN ($sports)
   AND (ac.is_manual = 0 OR ? = 1 OR ac.manual_approved = 1)
 WHERE ath.team IN ('EAST','WEST')
 GROUP BY ath.strava_athlete_id
 ORDER BY meters DESC, ride_count DESC, ath.display_name ASC, ath.strava_athlete_id ASC;
```

Rounding rule: SQL returns **meters**; `metersToMiles` + `round1` happen once in `db/leaderboard.js` when shaping the response. Never `ROUND()` per activity, never sum rounded values, never store miles. Team/grand totals derive from raw meters, so the split bar always adds to the headline. Both team rows are seeded to zero in JS before merging query results — belt and braces against a team with no members at all.

## API contract

Conventions binding on both halves:
- Everything server-side is under `/api/*` — including OAuth — so the deploy split is one routing rule with no exception list. Unknown `/api/*` → **JSON** 404, never HTML (otherwise a fetch typo surfaces as `Unexpected token '<'`).
- All responses: `application/json; charset=utf-8`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`. `/api/me` and `/api/leaderboard` also send `Vary: Origin, Authorization, Cookie`.
- Error body is flat: `{"error":"snake_case_code","message":"...", ...extra}`. Non-`HttpError` throws become `{"error":"internal"}` with the stack going only to the server log.
- Teams are the literals `"EAST"` / `"WEST"` in the DB **and** on the wire; `label` carries the display string. No case translation anywhere.
- Distances are Numbers in **miles**, already rounded to 1 dp by the server. The client never divides by 1609.344.
- Timestamps ISO-8601 UTC with `Z`; calendar dates `YYYY-MM-DD`.
- **CSRF (column "CSRF")**: mutating routes require all three of `Content-Type: application/json`, an `Origin` in the allowlist, and `X-CSRF-Token` matching the non-HttpOnly `bc_csrf` cookie (compared length-first then `timingSafeEqual`). Applied uniformly now, not at migration time, because it shapes `public/api.js`.
- Session resolution: `resolveSession(req)` checks `Authorization: Bearer <t>` first, then the `bc_sid` cookie; both hash to the same `sessions` row.

| Method | Path | Auth | CSRF | Request | Success response | Codes |
|---|---|---|---|---|---|---|
| GET | `/api/health` | none | – | – | `{"ok":true,"schema":1,"time":"…Z"}` | 200 |
| GET | `/api/health/strava` | session+admin | – | – | `{"rateLimit":{…},"apiBase":"…","scope":["activity:read_all"]}` — never tokens | 200,401,403 |
| GET | `/api/auth/strava/login` | none | – | top-level **navigation** only (`location.assign`, never `fetch` — a fetch to a cross-origin 302 CORS-fails) | `302` to Strava; `Set-Cookie: bc_oauth=<nonce>; HttpOnly; Secure(prod); SameSite=Lax; Path=/api/auth; Max-Age=600`; `Cache-Control: no-store` | 302 |
| GET | `/api/auth/strava/reconnect` | none | – | same, `approval_prompt=force` | `302` | 302 |
| GET | `/api/auth/strava/callback` | `bc_oauth` cookie | – | `?code&scope&state` or `?error=access_denied` | `302` to `WEB_ORIGIN + returnTo`; new `bc_sid` + `bc_csrf` cookies; `bc_oauth` cleared on **every** outcome | 302 always. Failures 302 to `…/#error=<denied\|oauth_failed\|state_expired\|scope>` — never JSON, the user is in a browser |
| POST | `/api/auth/logout` | optional | yes | – | `204`, deletes the sessions row for whichever credential matched, `bc_sid`/`bc_csrf` `Max-Age=0` | 204 always (idempotent) |
| GET | `/api/me` | optional | – | – | `{"authenticated":bool,"rider":{athlete_id,display_name,avatar_url,profile_url,team,needs_team,is_admin,scope:"read_all"\|"read",private_rides_counted:bool,revoked:bool,last_synced_at},"competition":{start,end,state,days_remaining,timezone},"server_time","schema":1}` | **200 when logged out** (`rider:null`) |
| GET | `/api/leaderboard` | optional | – | `?start=&end=` clamped to the configured window | see below | 200 always (empty state = zeroed teams, `riders:[]`), 500 |
| POST | `/api/me/team` | required | yes | `{"team":"EAST"}` | `{"ok":true,"team":"EAST","rider":{…}}` | 200 (also on re-POSTing the same team — double-click safe), 400 `invalid_team`, 401, 409 `team_already_set` (+`"team"`) |
| POST | `/api/me/sync` | required | yes | `{}` or `{"mode":"incremental"\|"full"}` (default: `full` if `now-last_full_sync_at>86400`, else `incremental`) | `{"ok":true,"mode","synced_at","activities_scanned","activities_counted","activities_added","activities_removed","pages_fetched","truncated",` `"miles":412.8,"leaderboard":{…identical to GET /api/leaderboard…}}` | 200, 401, 403 `insufficient_scope` (+`reauth_url`), 403 `strava_revoked` (+`reauth_url`), 409 `sync_in_progress` (+`retry_after_seconds`), 429 `rate_limited` (+`retry_after_seconds`,`scope:"local"\|"strava"`, `Retry-After` header, `Access-Control-Expose-Headers: Retry-After`), 502 `strava_unavailable` |
| POST | `/api/me/disconnect` | required | yes | `{}` | `{"ok":true}` — deauthorizes at Strava (401 treated as success), nulls tokens, keeps athlete row + team + activities, kills the session | 200, 401 |
| DELETE | `/api/me` | required | yes | `?purge=1` | `{"ok":true,"activities_deleted":n}` — reserved; implement in Step 16 | 200, 401 |
| GET | `/api/riders/:athleteId/activities` | required | – | `?start=&end=` | `{"activities":[{strava_activity_id,name,sport_type,miles,moving_seconds,local_date,is_manual,manual_approved,is_trainer,counted,strava_url}]}` — no lat/lng, no polylines (we never store them) | 200, 401, 404 |
| GET | `/api/admin/athletes` | session+admin | – | – | `{"athletes":[{athlete_id,display_name,team,is_admin,granted_scope,revoked,last_synced_at,pending_manual:n}]}` | 200, 401, 403 |
| POST | `/api/admin/athletes/:athleteId/team` | session+admin | yes | `{"team":"WEST"}` | `{"ok":true}` — also `deleteSessionsForAthlete` | 200, 400, 401, 403, 404 |
| POST | `/api/admin/athletes/:athleteId/admin` | session+admin | yes | `{"is_admin":false}` | `{"ok":true}` — revocation drops that athlete's sessions | 200, 401, 403, 404 |
| POST | `/api/admin/activities/:activityId/approve` | session+admin | yes | `{"approved":true}` | `{"ok":true}` — flips `manual_approved` | 200, 401, 403, 404 |
| POST | `/api/admin/athletes/:athleteId/sync` | session+admin | yes | `{}` or `{"mode":"full"\|"incremental","since_month":"2026-01"\|null}` (defaults: `mode:"full"`, `since_month` = `COMPETITION_START`'s month; an explicit `null` means "no override, use the union floor") | `{"ok":true,"athlete_id","display_name","mode","since_month","fetched_from_month","synced_at","activities_scanned","activities_added","activities_removed","pages_fetched","truncated","months":[{month,ride_count,meters}]}` — the backfill. `since_month` overrides the fetch floor outright, which is the only way to reach a month holding no rides yet; `fetched_from_month` is the floor after clamping to the current month and to `SYNC_MAX_MONTHS`. `months` is the per-month evidence, scoped to this rider. | 200, 400, 401, 403, 404, 409 `sync_in_progress`, 429 `rate_limited`, 502 `strava_unavailable` |
| GET | `/api/admin/months` | session+admin | – | – | `{"today","current_month","first_month","last_month","competition_first_month","competition_last_month","months":[{month,ride_count,meters}]}` — spends no Strava quota. `competition_first_month` beside `first_month` is the diagnostic that separates "the sync is broken" from "`COMPETITION_START` is too late". | 200, 401, 403 |
| OPTIONS | `/api/*` | none | – | preflight | `204` + `Access-Control-Allow-Origin` (exact echo from allowlist, never `*`), `-Allow-Credentials: true`, `-Allow-Methods: GET,POST,DELETE,OPTIONS`, `-Allow-Headers: Content-Type, Authorization, X-CSRF-Token`, `-Max-Age: 86400`, `Vary: Origin, Access-Control-Request-Headers` | 204 |

Body limit on every mutating route: **64 KiB**, enforced against the byte stream (a lying `Content-Length` is the attack). Over-limit ⇒ the 413 JSON is written **first**, then `req.destroy()` — destroying the socket first means the client sees `ECONNRESET`, not a diagnosable error.

`GET /api/leaderboard` payload (the single call the page renders from; **this exact object is embedded in the `/api/me/sync` response**, so Refresh is one round trip):

```json
{ "schema": 1,
  "competition": { "start":"2026-06-01","end":"2026-08-31","state":"open","days_remaining":27,
                   "timezone":"UTC","allowed_sport_types":["Ride","GravelRide","MountainBikeRide","VirtualRide"],
                   "manual_rides_counted": false },
  "units": { "distance":"mi" },
  "teams": [ { "team":"EAST","label":"East","miles":1423.7,"ride_count":88,"rider_count":6,"share":0.542 },
             { "team":"WEST","label":"West","miles":1202.4,"ride_count":75,"rider_count":5,"share":0.458 } ],
  "totals": { "miles":2626.1,"ride_count":163,"rider_count":11 },
  "leader": { "team":"EAST","margin_miles":221.3 },
  "riders": [ { "rank":1,"athlete_id":12345678,"display_name":"Julien C.","avatar_url":null,
                "profile_url":"https://www.strava.com/athletes/12345678","team":"EAST",
                "miles":412.8,"ride_count":19,"longest_ride_miles":78.2,
                "private_rides_counted":true,"revoked":false,
                "last_synced_at":"2026-08-04T18:22:01Z","is_you":true } ],
  "sync": { "last_synced_at":"2026-08-04T18:22:01Z","riders_never_synced":2 },
  "generated_at":"2026-08-04T19:52:00Z" }
```

Contract invariants that exist to keep the client dumb — changing any of them rewrites `render.js`:
- `teams` is **always exactly two entries in fixed EAST-then-WEST order**, even at zero miles.
- `share` is precomputed (both `0.5` when `totals.miles === 0`).
- `leader` is `null` on an exact tie; `margin_miles ≥ 0`.
- Riders with a team and zero counted rides **are included** with `miles: 0` and **`rank: null`** (rendered as an em-dash). Zero-mile ties are the *common* case at competition start, so a numeric rank there would be signup-order dressed up as a ranking. Riders who never picked a team are excluded entirely.
- Ordering is contractual: `miles DESC, ride_count DESC, display_name ASC, athlete_id ASC`.
- `avatar_url` and `profile_url` are **absolute `https:` URLs or `null`**, enforced server-side at write time. Strava returns the bare relative string `avatar/athlete/large.png` for photo-less athletes; the server stores `NULL` for anything not starting with `https://`.
- `is_you` is server-set from the session.
- `sync.last_synced_at` is `null` if nobody has ever synced → drives the empty state.

### The month picker

**Every calendar month is its own competition.** There is no season with one winner, only a series of independent monthly races that the reader picks between with `?month=YYYY-MM`, accepted by `/api/leaderboard`, `/api/me` and `/api/riders/:id/activities`. `competition.state` and `days_remaining` are facts about the **selected month** (`closed` = already ended, `open` = the current month, `upcoming` = not begun), not about a configured window.

**Which months are selectable** is a UNION, computed per request by `monthBounds` (`server/lib/dates.js`) from bounds loaded by `selectableMonthBounds` (`server/db/activities.js`):

1. every month holding a ride the board **would count** — the shared `countedPredicate` with its date test opened up, so a month is offered exactly when a ride in it would appear. Sync stores everything it fetches regardless of the window and the fetch window is padded a day at each end, so rides genuinely land outside `COMPETITION_START..END`;
2. the **current month** in `COMPETITION_TZ` — the only month that can be `open`;
3. the `COMPETITION_START..COMPETITION_END` months — a floor, so a configured season is never *narrower* than before.

The response reports a **contiguous** run from the earliest to the latest of that union, because `prev_month`/`next_month` step one month at a time and a hole would be a dead end no client-side arithmetic could anticipate. Months inside the run with no rides render as an empty board, which is the state every month is in on its first day anyway. The run is capped at `MAX_PICKER_MONTHS` (120, in `server/contracts.js`, mirrored in `public/config.js`) by discarding the **oldest** months; if the newest end is itself more than a cap's worth of months in the future — a `COMPETITION_END=2260-12-31` typo — the future end gives way instead, because "the current month is always selectable" outranks "trim the oldest first".

Gating the range on one configured season was a leftover of the single-race model, and it failed concretely: a one-month `COMPETITION_START=2026-09-01`/`COMPETITION_END=2026-09-30` made exactly one month selectable, so the client hid the entire control and the feature looked unimplemented.

`COMPETITION_START`/`COMPETITION_END` keep three jobs and stay **required and validated exactly as before**, so no existing `.env` stops booting: they are the Strava fetch window (`computeSyncWindow` — the one decision that spends rate limit), the floor of the selectable range, and the clamp on the **default** month. The default is deliberately *not* just "the current month": a September-only competition viewed in August would otherwise open on August, a board guaranteed empty because those rides are never fetched, captioned "open, 27 days to go" beside zero miles — which reads as a broken sync rather than a race that has not started.

Client side (`public/render.js`): `shapeMonthPicker` renders the control whenever the server offered **at least one** month. It deliberately does **not** hide itself on a single-month range — hiding is indistinguishable from the feature not existing, which is how it got reported missing; a lone option with two dead arrows is honest about a one-month deployment. Only a payload carrying no months at all hides it. A well-formed `?month=` outside the range is **clamped** (a malformed one is a `400`, and an empty value means "absent"), and the response always echoes the month it actually resolved to as `competition.month` so the `<select>` corrects itself instead of displaying a month the board is not showing.

## Implementation steps

### Phase 0 — pin the seams (SERIAL, one agent, must complete before any fan-out)

**1. Repo skeleton + config surface.** Files: `package.json`, `.gitignore`, `.npmrc`, `.env.example`, `README.md`, `server/config.js`, `server/contracts.js`, `server/lib/units.js`, `server/lib/dates.js`, `scripts/keygen.mjs`.
`.env.example` carries every briefed name plus four flagged additions and one dead one:
`PORT NODE_ENV APP_BASE_URL` **`API_BASE_URL`**(new, defaults to `APP_BASE_URL`; builds `redirect_uri`) **`WEB_ORIGIN`**(new, defaults to `APP_BASE_URL`; post-OAuth redirect target + CORS allowlist) `DATABASE_PATH STRAVA_CLIENT_ID STRAVA_CLIENT_SECRET` `STRAVA_WEBHOOK_VERIFY_TOKEN`(**dead — decision #5 bans webhooks; implement no route, an unauthenticated hub-challenge echo is free attack surface**) `STRAVA_API_BASE=https://www.strava.com/api/v3` `STRAVA_OAUTH_BASE=https://www.strava.com/oauth` (both **include the path prefix** so the test double is a pure origin swap) `SESSION_SECRET TOKEN_ENCRYPTION_KEY COMPETITION_START COMPETITION_END` **`COMPETITION_TZ=UTC`**(new; the only source of "today", `state`, `days_remaining` — without it those flip when the host timezone changes from your Mac to a UTC Worker) `ALLOWED_SPORT_TYPES=Ride,GravelRide,MountainBikeRide,VirtualRide` **`COUNT_MANUAL_ACTIVITIES=false`**(new) `ADMIN_BOOTSTRAP_ATHLETE_IDS`.
`loadConfig` decodes `SESSION_SECRET` (≥32 bytes) and `TOKEN_ENCRYPTION_KEY` (exactly 32 bytes) from base64 and **refuses to boot otherwise** — catches a truncated paste at startup rather than at first login. **Verify:** `npm run keygen` prints two vars; a 31-byte key makes `loadConfig` throw; `node --test test/config.test.js` asserts `STRAVA_API_BASE`/`STRAVA_OAUTH_BASE`/`COMPETITION_TZ` overrides are honored.

**2. Schema + async DB adapter + migrations.** Files: `server/migrations/001_init.sql`, `server/db/schema.sql`, `server/db/db.js`, `server/db/migrate.js`, `test/helpers/testDb.js`, `test/db-adapter.test.js`.
The adapter is `{ all, get, run, batch }`, **every method `async` even though `node:sqlite` is synchronous** — this is the single highest-leverage decision here; retrofitting `await` through the whole call graph is ~80% of a D1 port. `batch([[sql,params],…])` maps to `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` today and to `D1.batch` later; there is no `withTransaction(fn)` taking a sync callback anywhere. Positional `?` only, one statement per call, pragmas only in `openDatabase()` outside any transaction with the `journal_mode` result asserted. `run()` returns `{changes,lastInsertRowid}` — **`changes()` is not a callable JS binding** (`db.changes()` does not exist; the SQLite scalar function does, which is why the mistake reads plausibly). **Verify:** `node --test test/db-adapter.test.js` — migrate `:memory:` twice (idempotent), `user_version` bumps once, a `batch` that throws leaves zero rows, `PRAGMA journal_mode` is `wal` on a file DB, a 31-char boolean/undefined bind is rejected by `toBindable` before reaching SQLite, and a realistic `15000000001` activity id round-trips exactly.

**3. Frozen contract fixtures.** Files: `test/fixtures/leaderboard.sample.json`, `test/fixtures/me.sample.json`, `test/fixtures/activities.json`, `test/helpers/inject.js`.
`activities.json` must contain, at minimum: `Ride`; `GravelRide` with `type:"Ride"`; `MountainBikeRide`; `VirtualRide` with `trainer:true`; `EBikeRide` (excluded); **`EMountainBikeRide` with `type:"Ride"` — the canary a `type`-based filter would wrongly count**; `Run`; one on `COMPETITION_START-1d` (out); one each on `START` and `END` (both in, bounds inclusive); one on `END+1d` (out); **a Pacific/Auckland (UTC+13) activity at the window edge whose `start_date` and `start_date_local` fall on different calendar dates**; one `private:true`; one `manual:true`; one with `timezone` and `type` both **absent** (proves the `?? null` coalescing — `undefined` cannot be bound); one with `distance` absent (must throw, not write `NaN`); and 201 in-window padding rides to force multi-page pagination and short-page termination. Distances chosen for exact assertions: `1609.344 m → 1.0 mi`, `16093.44 m → 10.0 mi`. `inject.js` is `injectRequest(handler,{method,url,headers,body})` over `PassThrough` — **the primary harness, because `listen(0)` is EPERM in this sandbox.** **Verify:** `injectRequest` against a two-line echo handler returns status/headers/parsed body.

### Phase 1 — FAN-OUT (5 agents in parallel; each owns disjoint files and depends only on Phase 0)

**Group A — HTTP kernel.** Files: `server/http/{router,respond,body,cookies,cors,static}.js`, `server/lib/log.js`, `server/security/redact.js`, `server/app.js`, `test/{router,body,static,respond}.test.js`.
`sendError`'s **first line** is `if (res.headersSent || res.writableEnded) { log.error(err); res.destroy(); return; }` — without it, a client aborting a large image makes `pipeline` reject after headers are sent, `writeHead` throws `ERR_HTTP_HEADERS_SENT`, and the unhandled rejection takes the process down. `pipeline` gets its own catch swallowing `ERR_STREAM_PREMATURE_CLOSE`/`EPIPE`/`ECONNRESET`. Static: `path.resolve` + `abs.startsWith(root + path.sep)` (the separator is what stops a `public-secrets` sibling), NUL rejection, extension allowlist, **404 for any missing path that has a file extension**; the index fallback serves only extension-less paths (and `public/404.html` mirrors it, since Pages has no SPA fallback). HTML responses carry `Content-Security-Policy` and `X-Frame-Options: DENY`. `cors.js` ships complete-but-inert with `Vary` baked in. **Verify:** `node --test test/router.test.js test/body.test.js test/static.test.js` — 404-vs-405 distinction; 413 with a lying `Content-Length: 10` returns a **readable JSON 413** (not `ECONNRESET`); 415 on `text/plain`; 400 on a top-level array; and the traversal battery `/../server/config.js`, `/%2e%2e%2fserver%2fconfig.js`, `/..%252f..%252f.env`, `/%00`, `/\evil.com`, `/public-secrets/x` all rejected.

**Group B — repositories + leaderboard.** Files: `server/db/{athletes,tokens,activities,sessions,oauthStates,syncState,leaderboard}.js`, `test/{leaderboard,activities-upsert}.test.js`. All async, all `?` placeholders built from `array.length` — **never a hardcoded `IN (?,?,?,?)`**, which breaks silently the moment `ALLOWED_SPORT_TYPES` has 3 or 5 entries. `sessions.findByRawId` **must SELECT `last_seen_at`** (omitting it makes `now - undefined > 300` be `NaN > 300` → `false`, freezing the column forever with no error). **Verify:** `node --test test/leaderboard.test.js` against a fixture with 3 athletes where only EAST has rides → **WEST still returns a row at 0.0**; a zero-ride rider appears with `miles:0, rank:null`; a `Run`, an out-of-window ride, a soft-deleted ride, a `manual` ride, and a teamless athlete's 50 km are all excluded; the UTC+13 00:30-local ride counts on its local date; 100 rides of exactly 1609.344 m sum to `100.0` not `99.9`; and `ALLOWED_SPORT_TYPES` with 2 and with 5 entries both work.

**Group C — Strava client (pure) + the fake.** Files: `server/strava/{client,map,authUrl}.js`, `test/helpers/fakeStrava.js`, `test/{strava-map,strava-client}.test.js`, `scripts/strava-probe.mjs`.
`client.js` reads **no** `process.env` at module scope and imports nothing from `node:sqlite`; `apiBase`, `oauthBase`, `redirectUri`, `fetchImpl`, `now` are all injected. Errors: `StravaError` (+`.status .code .path .retryable`, and a `toJSON()` that omits `body`), `StravaAuthError`, `StravaGrantRevokedError`, `StravaRateLimitError` (+`.retryAfterMs .resetAt .bucket`), `StravaScopeError` (+`.granted .required`), `StravaNetworkError`. Surface: `buildAuthorizeUrl`, `assertScope`, `get rateLimit`, `exchangeCode`, `refreshTokens`, `deauthorize`, `getAthlete`, `listActivities`, `iterateActivities`, `fetchAllActivities`.
Non-negotiables in this module: **(a) `#request` never passes `form`, request headers, or `accessToken` to the logger or into any error field** — log only `{method,host,pathname,status,attempt,rateLimitUsage}`, because the obvious implementation writes `STRAVA_CLIENT_SECRET` and a live refresh token to stdout on every token-endpoint 400, which is exactly the path most likely to be pasted into a bug report. **(b)** `assertScope` accepts `activity:read_all` **OR** `activity:read` and returns which — hard-requiring `read_all` turns a privacy preference into a permanent lockout for a rider whose public rides are perfectly countable. **(c)** The watermark is `Math.max` over **every** `start_epoch` seen across all pages, never `arr[0]`/`arr.at(-1)`, so the undocumented ascending-when-`after`-is-set ordering is irrelevant. **(d)** `nextQuarterHourMs = (now) => Math.floor(now/QUARTER)*QUARTER + QUARTER + 1000` — `Math.ceil` is a no-op on an exact boundary and produces `blockedUntil === now`, i.e. a tight 429 burn loop. **(e)** Rate limits are read from `X-RateLimit-*` and `X-ReadRateLimit-*` (tolerating absence), with a conservative `{short:100,daily:1000}` pre-first-response default and a `RESERVE=5` pre-emptive gate that throws **without sending**; on 429 the handler is **never slept** — the block surfaces as "Rate limited, try again at 14:45 UTC". Sleep-retry only 5xx/network, GETs only, max 2, jittered; never retry `POST /oauth/token`. (f) `normalizeActivity` emits `1`/`0` for booleans and `?? null` for every nullable (`timezone`, `legacy_type`) and `?? ''` for `name` — **booleans and `undefined` both throw at bind time** (verified), and pure map tests will never catch it.
`fakeStrava.js` is an **in-process `fetchImpl(Request)→Response`, not an http server** (`listen` is EPERM here), with an optional `.listen()` mode that self-skips. It defaults `rotateRefreshToken: true`, has `?deny=1` and `?grant=read` knobs on authorize, replays a consumed code as `400 AuthorizationCode invalid`, returns **ascending order when `after` is present and descending otherwise**, honours `per_page` (cap 200), emits both rate-header pairs, has `queue429`/`queue500` for mid-pagination failure, and 404s + logs anything unexpected so a stray call fails loudly. **Verify:** `node --test test/strava-map.test.js test/strava-client.test.js` — full pagination over the 201-ride fixture terminates on the short page; a mid-pagination 500 retries twice then throws; a 429 sets `blockedUntil` to the next quarter hour and the *next* call throws pre-emptively without a request; `?grant=read` yields `scope:'read'` not an error while `?grant=` (neither activity scope) throws `StravaScopeError`; and **a client built with `clientSecret:'SENTINEL_SECRET'` driving a token-endpoint 400 leaves the sentinel in zero logger calls and nowhere in `JSON.stringify(err)`.**

**Group D — frontend.** Files: all of `public/`, `test/frontend-contract.test.js`. Built entirely against `test/fixtures/leaderboard.sample.json` — no server needed. Fixes that must be in the first version: boot destructures the settled wrappers (`const [meR,lbR] = await Promise.allSettled(...); state.me = meR.status==='fulfilled' ? meR.value : null;` — branching on `me.authenticated` off a raw settled result is `undefined`, so the mandatory picker never opens and the rider is silently excluded from the board); the fragment is parsed **once** into a `URLSearchParams` and `token`/`error` both read before a single `history.replaceState` (otherwise `#error=access_denied` is stripped before the banner reads it, and OAuth failure is a silent no-op); `#pick-team` is dropped from the contract entirely — `needs_team` from `/api/me` is the authoritative trigger; `safeAvatar`/`safeHref` are **total** functions (`try{new URL(u)}catch{return FALLBACK}` — `new URL('avatar/athlete/large.png')` throws, and one photo-less rider inside `riders.map(rowFor)` blanks the whole roster); the `<dialog>` listens for **`close` and reopens** while `needs_team` (preventing `cancel` is unreliable without history-action user activation — two Escs dismiss it) plus a persistent "Pick your team" masthead button so the modal is never the only path; `logout()` clears `localStorage` in a `finally` so a 502 still logs you out locally; 409 `sync_in_progress` arms a bounded 2 s/15 s poll then un-pends the button with a message (otherwise the spinner never clears); `rank:null` renders an em-dash; module imports carry `?v=N` bumped per contract change, and a `schema` mismatch shows a "Reload to update" banner. `textContent` only — never `innerHTML` — is a **security** control, not a style rule. **Verify:** open `public/index.html` from disk with `api.js` swapped for a fixture stub; assert the roster renders 11 rows including zero-mile riders, the split bar sums to the headline total, and a rejected `/api/me` still renders the leaderboard.

**Group E — security primitives.** Files: `server/security/{crypto,hash,oauthState,sessionStore,csrf,guards}.js`, `test/{crypto,oauthState,session,csrf}.test.js`. Depends only on the Phase-0 adapter interface (use `testDb.js`). `crypto.js`: AES-256-GCM, random 12-byte IV **generated inside** `encryptSecret` with no parameter to supply one, 16-byte tag stored, explicit `authTagLength` on both sides, `v1.` prefix for rotation. Session tokens are `randomBytes(32)` base64url, stored **only as SHA-256** — a PK lookup on a 256-bit digest also removes any need for `timingSafeEqual`, which closes the WebCrypto portability gap. **`timingSafeEqual` throws on unequal lengths** — always compare lengths first (and never "fix" that by switching to `===`). `safeReturnTo` **resolves rather than pattern-matches**: `const u=new URL(v, cfg.webOrigin); return (u.origin===cfg.webOrigin && !/[\\\x00-\x1f]/.test(v)) ? u.pathname+u.search : '/'` — the `startsWith('/') && !startsWith('//')` form lets `/\evil.com` through, and browsers normalize the backslash into a protocol-relative redirect. **Verify:** `node --test test/crypto.test.js test/oauthState.test.js test/session.test.js test/csrf.test.js` — two seals of the same plaintext differ (IV freshness); a flipped ciphertext byte, a flipped tag byte, a truncated envelope, a 31-byte key, and a `v2.` prefix all throw; state round-trips, and tampered-sig / tampered-exp / expired / **second-consume** / **wrong-nonce-cookie** all reject; `resolveSession` with `last_seen_at` backdated 400 s **advances the column**; and `safeReturnTo` normalizes `//evil.com`, `https://evil.com`, `javascript:alert(1)`, `/\evil.com`, `/\\evil.com`, `/%09/evil.com`, `/..//evil.com`, and a CRLF payload all to `/`.

### Phase 2 — integration (SERIAL; the seams are now fixed)

**4. Token service.** Files: `server/strava/tokenService.js`, `test/tokenService.test.js`. Proactive refresh at `expires_at - 300 <= now`; **in-process single-flight `Map<athleteId, Promise>`** so a double-clicked Refresh plus a login sync don't both present the same refresh token (the loser gets a rotated-away token and the DB ends up holding a superseded one — an unrecoverable, cause-less lockout); re-read the row after acquiring the slot and return early if someone else already rotated; persist the returned `refresh_token` **unconditionally, every time, never "only if changed"**; the persist is the `token_version` CAS above, and `res.changes === 0` means re-read and use theirs. On refresh `400 RefreshToken invalid`, re-read once and retry with the stored token before declaring the grant dead. **Never hold a transaction across the `fetch`.** **Verify:** two concurrent `getValidAccessToken` calls against the rotating fake produce **one** token POST and both resolve to the same access token; a `400` marks `strava_revoked_at` and throws `StravaGrantRevokedError`; the persisted `refresh_token_enc` decrypts to the *new* value.

**5. Sync service.** Files: `server/strava/sync.js`, `test/sync.test.js`. Sequence: acquire `sync_state` lock (respecting `lock_expires_at`; a startup sweep flips stale `running` rows to `error`) → cooldown check (60 s) → `getValidAccessToken` → `getAthlete` (upsert name/avatar, normalizing a non-`https:` avatar to `NULL`) → `computeSyncWindow` → `fetchAllActivities` → normalize all (**store everything, filter at query time** — dropping non-bike rides at fetch time makes any future `ALLOWED_SPORT_TYPES` change require a full resync against a rate-limited API) → one `batch` of upserts (+ deletion reconciliation in **full** mode only, strictly gated on `!truncated && no error`) → advance watermark/`last_full_sync_at` **only** on a complete untruncated run.
`computeSyncWindow` pads **±86400 s on both ends** — justified as covering **both** possible `before`/`after` semantics (`|UTC offset| ≤ 14 h < 24 h`), *not* as a consequence of the unverified "filters on `start_date` UTC" claim. `mode:'incremental'` uses the watermark; `mode:'full'` ignores it and rescans `[START-1d, min(now,END)+1d]`. **A watermark alone is provably wrong for a competition**: a bikepacking trip uploaded a week late, a Garmin sync failure, a rider flipping a 3-week-old ride from "Only You" to "Everyone", or a distance correction all have a `start_date` older than the watermark and would be missed forever; `/athlete/activities` has no `modified_after`. Full mode is ~2–4 requests for a 90-day season, well inside budget. Deletion reconciliation is equally load-bearing: without it a rider's deleted 340-mile GPS-glitch ride counts for their team for the rest of the competition. **Verify:** `node --test test/sync.test.js` against a real `:memory:` DB (the **only** place the boolean/`undefined` bind bugs surface) — fixture #4 (`trainer:true`) and #12 (`private:true`) upsert cleanly; the fixture with `timezone`/`type` absent round-trips as SQL NULLs; two syncs leave `COUNT(*)` unchanged; an edited distance updates in place and recomputes `local_date`; a `queue500` mid-pagination persists earlier rows and **leaves the watermark unmoved**; a full-mode sync with one id removed from the fake soft-deletes exactly that row; a truncated run soft-deletes nothing.

**6. Routes + wiring.** Files: `server/routes/*.js`, `server/index.js`, `test/routes-*.test.js`. `requireCsrf` and `requireAdmin` are applied **once each**, at the router level, for the mutating set and the `/api/admin/*` prefix — a per-handler check is how one gets missed. The callback sequence is exact: clear `bc_oauth` on **every** exit path → length-check then `timingSafeEqual` the state → match the cookie nonce hash against the row → atomic consume → handle `error=access_denied` (302 `#error=denied`) → `assertScope` on the callback's `scope` param (**authoritative — Strava's consent screen lets the user uncheck individual scopes**; store `granted_scope`, and 302 `#error=scope` only when neither activity scope was granted) → `exchangeCode` → upsert athlete (match on `athlete.id`, the stable identity, so team and history reattach and the one-time picker does **not** reappear) → apply `ADMIN_BOOTSTRAP_ATHLETE_IDS` (**grant-only, never revoke**) → seal tokens → **delete any inbound session, then mint a brand-new `randomBytes(32)` session id** (fixation defense) → set `bc_sid` + `bc_csrf` → 302. **No sync in the callback**: awaited it turns a rate-limit error into a failed login and blanks the tab for seconds; fire-and-forget it is silently killed on Workers/Netlify without `ctx.waitUntil()`, so new riders land on a permanently empty board with nothing logged. `public/` calls `POST /api/me/sync` once after login; the 60 s cooldown makes that safe and idempotent. `server/index.js` installs `process.on('unhandledRejection')` and runs the startup sweeps (`purgeExpiredSessions`, `purgeExpiredStates`, stale-lock reset). **Verify:** `node --test test/routes-auth.test.js` via `injectRequest` — login sets `bc_oauth` and inserts a state row; the callback issues a session and a *different* id than any inbound cookie; replaying the same state → the `#error=state_expired` redirect; the same state with a *different* browser's cookie → rejected (this is the login-CSRF case HMAC+single-use alone does **not** close); `?error=access_denied` → `#error=denied`; a POST without `X-CSRF-Token` → 403; with a foreign `Origin` → 403; `POST /api/me/team` twice concurrently → exactly one 200 and one 409.

**7. E2E.** Files: `test/e2e.test.js`. `injectRequest` + `:memory:` DB + `fakeStrava.fetchImpl` — no sockets. Full script in Verification below.

**8. Scripts + polish.** Files: `scripts/{make-admin,reset-db}.mjs`, `README.md` rules page, `server/routes/admin.js` manual-approval endpoint, `DELETE /api/me?purge=1`. **Verify:** `npm run make-admin -- <id>` flips the flag and reports the display name; `--revoke` also drops that athlete's sessions.

## Security checklist

| Item | Enforced where |
|---|---|
| `STRAVA_CLIENT_SECRET` never reaches the browser | Read only in `server/config.js`, used only in `server/strava/client.js`. No `/api/config` endpoint exists. E2E asserts the sentinel secret appears in no response body and no log line. |
| OAuth `state`: unguessable, signed, expiring, single-use, **and bound to the browser** | `security/oauthState.js` — HMAC(`SESSION_SECRET`) + `randomBytes(32)` nonce in an HttpOnly `bc_oauth` cookie whose SHA-256 is stored in `oauth_states.nonce_hash` + `DELETE…RETURNING`. **Without the cookie leg there is no login-CSRF protection at all**: the attacker completes consent themselves and mails the victim a genuine `code`+`state`, and the victim's browser gets a session bound to the attacker's athlete id. |
| `timingSafeEqual` length pre-check | `oauthState.js`, `csrf.js` — it throws `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH` on mismatch; the length compare leaks nothing. |
| Strava tokens encrypted at rest | `security/crypto.js`, called only from `db/tokens.js`. E2E asserts `access_token_enc` starts with `v1.` and contains no plaintext. `.gitignore` lists `.env`, `*.db`, `*.db-wal`, `*.db-shm`. Honest scope: this defends a leaked/committed DB file, not a live-server compromise. |
| GCM IV freshness / auth tag kept | No IV parameter exists; `randomBytes(12)` inside `encryptSecret`; tag in the envelope; `setAuthTag` before `final()`. Tests assert two seals differ and any tamper throws. |
| GCM ciphertext is **never** a comparison key | `oauth_tokens.token_version` CAS. Re-sealing the same plaintext yields different bytes, so a ciphertext predicate would never match, `changes` would always be 0, every refresh would discard the fresh token, and the next one would 400 — locking out every athlete. |
| Session tokens hashed at rest, expiry enforced server-side | `sessions.session_id_hash` = SHA-256; `expires_at` checked in the lookup, not just the cookie `Max-Age`. |
| Session fixation | New `randomBytes(32)` id on every successful callback; any inbound session deleted first. |
| Logout actually invalidates | `POST /api/auth/logout` deletes the row for **whichever credential matched** (bearer or cookie) and clears cookies; the client clears `localStorage` in a `finally`. Clearing only the cookie leaves the bearer path alive and logout visibly fails. |
| Cookie attributes | `bc_sid`: `HttpOnly; SameSite=Lax; Path=/; Secure` when `NODE_ENV==='production'` — never gated on the spoofable `X-Forwarded-Proto`. `Lax` (not `Strict`) is required or the cookie is withheld on the OAuth callback navigation. `bc_oauth`: same plus `Path=/api/auth`, `Max-Age=600`. `bc_csrf`: readable by JS by design. |
| CSRF on every state-changing route | `security/csrf.js` at the router level: double-submit `bc_csrf`/`X-CSRF-Token` + `Origin` allowlist + `application/json`. Uniform across `/api/me/team`, `/api/me/sync`, `/api/me/disconnect`, `DELETE /api/me`, `/api/auth/logout`, all `/api/admin/*`. Built now because the migration removes `SameSite`'s protection from all of them at once, and because it changes the `public/` fetch wrapper. |
| No mutating GETs except the OAuth initiator | `GET /api/auth/strava/login` writes a state row by necessity (it must be a top-level navigation). Bounded by: purge-on-write, a hard row cap, a 600 s TTL, and `Cache-Control: no-store` so prefetchers don't burn states. |
| Open redirect | `safeReturnTo` resolves via `new URL` and compares `origin`, applied on **write and read**; `redirect_uri` is a server-side constant from `API_BASE_URL`, never echoed from a request param (without PKCE nothing else blunts redirect injection). |
| SQL injection | `db/*` is the only place SQL executes; placeholders generated from `array.length`; zero string concatenation of values. |
| Path traversal | `http/static.js` — resolve + `root + path.sep` prefix + NUL rejection + extension allowlist + `nosniff`. Test battery includes double-encoding and the sibling-directory escape. |
| Request body DoS | `http/body.js` 64 KiB cap on the stream; response written before `req.destroy()`. |
| Identity never comes from the client | Only `ctx.session.athleteId`. No handler reads an athlete id from body/query outside `requireAdmin`-gated `/api/admin/*`. |
| One-time team pick | Single atomic `UPDATE … WHERE team IS NULL RETURNING team`; `undefined` ⇒ 409. A read-then-write lets two concurrent POSTs both win. |
| Privilege changes don't linger | Admin team change / admin revocation calls `deleteSessionsForAthlete`. |
| Rate-limit abuse | Layered: 60 s per-athlete DB cooldown (survives serverless) → in-process single-flight with a 100 ms spacer → pre-emptive header-derived gate with `RESERVE=5` → reactive 429 block to the next quarter hour or UTC midnight. The HTTP handler is never slept. |
| Secrets never logged | Everything through `lib/log.js` → `redact()`; `strava/client.js` structurally cannot pass `form`/headers/`accessToken` to the logger; `StravaError.toJSON()` omits `body` on OAuth paths. Asserted with a sentinel secret. |
| No info disclosure | `sendError` exposes only `HttpError.message` when `expose`; everything else is `{"error":"internal"}`. Stacks to the server log only. |
| API responses uncacheable | `Cache-Control: no-store` in `sendJson`; `Vary: Origin, Authorization, Cookie` on the credential-dependent `/api/me` and `/api/leaderboard`. |
| Privacy of ride data | Leaderboard returns aggregates + display name + avatar only. Per-activity detail requires a session and contains no lat/lng or polylines — we never store them. `private:true` rides count toward totals but are never itemized publicly. |
| Anti-cheat on manual rides | `manual` rides are **excluded by default** (`COUNT_MANUAL_ACTIVITIES=false`) and surfaced in an admin approval list. A manual distance is free text with no device and no upper bound; counting them by default means the first person to notice wins. |
| XSS → token theft | `textContent` only, never `innerHTML`; `safeAvatar`/`safeHref` require `https:`; **`<meta http-equiv="Content-Security-Policy">` in `index.html` from day one** (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' https://*.cloudfront.net; connect-src 'self'; base-uri 'none'; form-action 'none'`) plus a real CSP header locally. Meta CSP cannot express `frame-ancestors`/`report-uri`; accept that (no state-changing GETs) or move behind a host that sets headers. The exact Strava avatar CDN host is `[UNVERIFIED]` — record it on the first real login and narrow, or store `NULL` and serve the local fallback. |
| No webhook attack surface | No `/api/webhook` route exists. `STRAVA_WEBHOOK_VERIFY_TOKEN` stays documented-but-unread. |
| Strava agreement compliance | Official unmodified Connect + "Powered by Strava" SVGs self-hosted in `public/assets/`, attribution visible without interaction, every rider deep-links to `https://www.strava.com/athletes/<id>`, no "look up any Strava user" feature (structurally: every rider on the board authorized this app themselves). |

## Verification

**Unit + integration, offline, no sockets:** `npm test` → `node --test test/`. Everything above runs through `injectRequest` and `fakeStrava.fetchImpl`, so it works in this sandbox where `listen(0)` is EPERM. The one socket-based file (`test/e2e.socket.test.js`, optional) begins `try { await listen() } catch (e) { if (e.code === 'EPERM') return t.skip('sandbox denies listen') }` — verify the harness can bind *before* writing assertions against it.

**The load-bearing E2E script** (`test/e2e.test.js`, `:memory:` DB + fake Strava + `ADMIN_BOOTSTRAP_ATHLETE_IDS=1`, `COMPETITION_START=2026-06-01`, `COMPETITION_END=2026-08-31`):

1. `GET /api/auth/strava/login` → 302 with `state` in the query, a `bc_oauth` cookie, and one `oauth_states` row.
2. `GET /api/auth/strava/callback?code=good&state=…` with that cookie → 302 to `WEB_ORIGIN`, `Set-Cookie: bc_sid` asserted to contain `HttpOnly` and `SameSite=Lax`, plus `bc_csrf`.
3. Replay the same state → `#error=state_expired`. Replay it **with a different `bc_oauth` cookie** → also rejected.
4. `GET /api/me` → `authenticated:true`, `team:null`, `needs_team:true`.
5. `POST /api/me/team {"team":"EAST"}` → 200; a second POST with `"WEST"` → 409; re-POSTing `"EAST"` → 200. A POST missing `X-CSRF-Token` → 403.
6. `POST /api/me/sync` → 2 pages fetched from the fake; the `Run`, `EBikeRide`, `EMountainBikeRide`, `manual`, `START-1d` and `END+1d` fixtures excluded; the UTC+13 edge ride and the `START`/`END` boundary rides **included**; the `private` ride included; the malformed record rejected without writing `NaN`.
7. `GET /api/leaderboard` → EAST miles equals a hand-computed constant; **WEST present at 0.0**; zero-mile riders present with `rank:null`; `teams[0].team === 'EAST'`; `share` values sum to 1.
8. `POST /api/me/sync` again immediately → 429 `{scope:'local'}` with `retry_after_seconds`. With the cooldown cleared → activity count unchanged (idempotent).
9. `SELECT access_token_enc FROM oauth_tokens` → starts with `v1.`, contains no plaintext token, and decrypts to the fake's value. **One line, catches the highest-consequence regression in the system.**
10. `fake.expireAccessToken()` → next sync refreshes once and succeeds; the stored `refresh_token_enc` decrypts to the *rotated* value and `token_version` incremented.
11. `fake.revokeAthlete()` → sync returns 403 `strava_revoked`; `strava_revoked_at` set; **the athlete row, team, and all activities survive** and the rider still appears on the board with a reconnect badge and a frozen total.
12. Full-mode sync after removing one id from the fake → exactly that row soft-deleted and dropped from the totals. With `queue500` mid-pagination → nothing soft-deleted and the watermark unmoved.
13. `POST /api/auth/logout` → 204, the sessions row is gone, `GET /api/me` → 200 `authenticated:false`.
14. Log capture across the whole run contains zero occurrences of `SENTINEL_SECRET`, the refresh token, or the session token.

**Real-Strava smoke test** (order matters — do (a) and (b) before writing anything that depends on the unverified ledger):
(a) Create a Strava app; set Authorization Callback Domain to `localhost`. **`[UNVERIFIED]` whether the field accepts one domain or several — if one, you need two Strava apps (dev + prod) from day one.** Note your app's actual rate-limit allocation from its settings page. (b) `npm run keygen`, fill `.env`, then `node scripts/strava-probe.mjs` and record: the exact `X-RateLimit-*`/`X-ReadRateLimit-*` values, whether `per_page=200` is accepted, whether a second refresh returns a different `refresh_token`, the `POST /oauth/deauthorize` response shape, and whether the UTC+13-edge query is captured under the `start_date` or `start_date_local` interpretation of `after`. (c) `npm start`, open `http://localhost:3000`, click Connect with Strava, **uncheck nothing**, confirm the team picker blocks, pick a team, confirm the board fills and the "Powered by Strava" mark is visible without interaction. (d) Repeat with the private-activities box **unchecked** → session still works, `scope:"read"`, and the rider shows a "private rides not counted" badge rather than being locked out. (e) Click Refresh twice fast → the second is a countdown, not an error. (f) Revoke access in Strava settings → next Refresh shows the reconnect prompt and the rider's total freezes without vanishing. (g) `POST /api/me/disconnect` twice → both succeed (401 from Strava is treated as success).

## Deferred to deploy time

Nothing below forces a rewrite, because five decisions were paid for up front: **every `server/db/*` method is already `async`** (D1 is async-only; retrofitting `await` through guards/routes/session/sync is the bulk of a port), **`batch()` already replaces interactive transactions** (D1 has no `BEGIN`), **all crypto sits in two files**, **every server endpoint is already under `/api/*`** (one routing rule, no exception list), and **`public/config.js` + `api.js` already isolate the API origin and both credential schemes**.

1. **Domain strategy — decide before migrating, not during.** Two supported shapes, and `scripts/deploy-setup.mjs` configures either. **(A, recommended)** One registrable domain: `public/` on `www.example.com` (Pages custom domain via `public/CNAME`) and the API on `api.example.com`. This is the only design that keeps the session cookie `HttpOnly; Secure; SameSite=Lax` working unchanged, and the only one where the session credential is unreadable by page script. **(B)** The default hosts, `user.github.io` + `<worker>.<account>.workers.dev`, which both critiques rejected and which is genuinely broken by default browser policy rather than by a config gap: the session cookie becomes a third-party cookie that Safari's ITP blocks unconditionally and Chrome/Firefox partition, so OAuth succeeds and every subsequent `/api/*` is anonymous with no CORS error and no 4xx to debug. `SameSite=None; Partitioned` does not fix it. Shape B is therefore only viable together with item 5's bearer path, and it carries a cost that does not go away: `localStorage` is keyed per-origin with no path component, so on `user.github.io` any other project that account ever published — including a vendored third-party toy — can read the bearer token and impersonate any rider, including an admin. A Pages **project** site also needs `WEB_BASE_PATH=/<repo>`, because it is served from `user.github.io/<repo>/` and the origin root is GitHub's 404; that value cannot be folded into `WEB_ORIGIN`, since an `Origin` header carries no path and a path there would empty the CORS allowlist and 403 every mutating request.

2. **Config split.** `API_BASE_URL` = the Worker origin (builds `redirect_uri`, must match Strava's callback-domain field). `WEB_ORIGIN` = the Pages origin (post-OAuth redirect target and the sole CORS allowlist entry). Both already exist and both already default to `APP_BASE_URL`, so today's single-origin dev is unaffected. Update the Strava app's Authorization Callback Domain; keep a second Strava app for `localhost` if the field takes only one domain.
3. **CORS goes live.** `corsHeaders()` starts echoing the exact allowlisted origin (never `*` — the browser rejects `*` with credentials), `Access-Control-Allow-Credentials: true`, `Vary: Origin`, and the `OPTIONS /api/*` branch with `Allow-Headers: Content-Type, Authorization, X-CSRF-Token` and `Max-Age: 86400`. Correction to a claim in the frontend design: **every** `/api/*` request preflights once `Authorization` is attached, not just the JSON POSTs — `Authorization` is not a safelisted request header. `Retry-After` needs `Access-Control-Expose-Headers` (which is why the 429 body also carries `retry_after_seconds`). `/api/auth/strava/*` needs no CORS — those are navigations.
4. **CSP `connect-src`** must be widened to the API origin in lockstep with `public/config.js`. Same commit, or the site silently stops talking to its own API.
5. **Bearer path — implemented, off by default (`AUTH_TOKEN_IN_FRAGMENT`).** Required by shape A? No. Required by shape B? Yes, absolutely. When on, the callback 302s to `…#token=<opaque>` (fragment, never a query param — fragments never reach server, proxy, or CDN logs); `adoptTokenFromHash()` in `public/app.js` and the bearer branch of `resolveSession` do the rest. Two consequences that are easy to miss and both handled: **(a)** `bc_csrf` is blocked cross-site exactly like `bc_sid`, so `requireCsrf` skips the double-submit leg for a bearer-authenticated caller — safe because a bearer token is attached only by our own script from origin-scoped `localStorage` rather than ambiently by the browser, and because `credentialFrom` *prefers* the bearer header, so `Authorization: Bearer <garbage>` plus the victim's cookies resolves to no session instead of falling back to the cookie. The content-type and Origin-allowlist legs still apply. Without this exemption every POST 403s `token_absent` on a deploy that otherwise looks healthy. **(b)** `server/config.js` refuses to boot with this flag and `SESSION_TTL_SECONDS > 86400`, because a 30-day token in `localStorage` is not the same risk as a 30-day `HttpOnly` cookie. Admin actions are still not gated behind re-auth — that remains open.

6. **Cloudflare Workers + D1 — DONE.** `server/db/d1.js` maps `all/get/run` onto `D1PreparedStatement` and `batch` onto `D1.batch`, normalizing the three differences that fail silently rather than loudly (`first()` → `null` vs `undefined`, `meta.last_row_id` vs `lastInsertRowid`, and `{success:false}` instead of a rejection — the last of which reads as an empty result set, i.e. a sync that stored nothing). `server/worker.js` is the `export default { fetch }` entry plus a `Request`→`(req,res)` adapter over the existing HTTP kernel, rather than a rewrite of two dozen security-relevant `writeHead`/`end` call sites. `loadConfig(env)` takes the Worker `env` binding. **The non-obvious cost was import hygiene, not the driver:** `server/db/activities.js` imported `placeholders` from `db.js` purely for a string helper, and `db.js` imports `node:sqlite`, which Workers lack entirely — so one gratuitous import made the whole route tree unloadable. `server/db/bind.js` breaks that edge and `test/worker-compat.test.js` walks the static graph to stop it growing back. Turso/libSQL over its plain-`fetch` HTTP API remains the host-agnostic escape hatch. **Two known limitations, both already accounted for:** the in-process single-flight refresh mutex evaporates per isolate — the `token_version` CAS is what actually protects you there; and any post-response work must go through `ctx.waitUntil()`, which is why nothing depends on a fire-and-forget sync (the adapter accepts `ctx` and deliberately does not use it).

7. **`server/http/static.js` and `server/index.js`'s listen path are NOT deleted** — the plan said delete them, and keeping them is better: they are what `npm start` and the whole test suite run on, and `test/http-kernel.test.js` has a traversal battery against the static handler. Instead they are kept OFF the Worker's import path — `server/app.js` reaches `static.js` through a lazy `import()` that only fires when `publicDir` is set, which a Worker never does. Same outcome for the Worker (no `node:fs`), no loss of local development. `public/404.html` is added and is a byte-for-byte copy of `index.html`.

8. **Pages workflow** — `.github/workflows/pages.yml`, `on: push[main] paths: public/**`, `permissions: {contents: read, pages: write, id-token: write}`, `concurrency: pages`, steps `actions/checkout` → `actions/configure-pages` → `actions/upload-pages-artifact` with `path: public` → `actions/deploy-pages`. Repo Settings → Pages → Source = **GitHub Actions**. Pin action major versions to whatever is current at migration time (`[UNVERIFIED]`). Because `path: public`, the artifact root **is** `public/` — which is why every path in `index.html` is relative from day one; a root-absolute `/assets/…` 404s under a project-site subpath. `.nojekyll` is inert on this path (the Jekyll build runs only in branch-deploy mode) — keep it purely as insurance.