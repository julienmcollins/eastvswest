-- bike-comp initial schema.
--
-- NO PRAGMAs in this file. Verified on this machine: a PRAGMA issued inside a
-- transaction is silently ignored (`PRAGMA journal_mode=WAL` returned 'delete').
-- Migrations run inside a transaction, so pragmas live only in openDatabase().
--
-- All timestamps are supplied by JS -- ISO-8601 UTC TEXT, or unix-second INTEGER where
-- noted -- so behaviour is identical on node:sqlite and on D1 later, and tests are
-- deterministic rather than dependent on SQLite's clock.
--
-- STRICT tables everywhere: they reject a value of the wrong storage class instead of
-- coercing it, which is what turns "we bound a boolean" into an immediate error.

CREATE TABLE athletes (
  -- MUST be the PK, not merely UNIQUE: every child table references this column, and a
  -- non-PK, non-unique parent column raises "foreign key mismatch" at INSERT time.
  strava_athlete_id INTEGER PRIMARY KEY,
  username          TEXT,
  firstname         TEXT    NOT NULL DEFAULT '',
  lastname          TEXT    NOT NULL DEFAULT '',
  display_name      TEXT    NOT NULL DEFAULT '',
  -- Absolute https: URL or NULL. Strava returns the bare relative string
  -- 'avatar/athlete/large.png' for photo-less athletes; the server normalizes anything
  -- not starting with https:// to NULL rather than shipping a broken src.
  avatar_url        TEXT,
  team              TEXT             CHECK (team IS NULL OR team IN ('EAST','WEST')),
  is_admin          INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1)),
  -- Comma-separated, exactly as Strava returned it on the callback. The consent screen
  -- lets riders uncheck individual scopes, so this is the authoritative record of what
  -- we actually got -- not what we asked for.
  granted_scope     TEXT    NOT NULL DEFAULT '',
  team_locked_at    TEXT,
  -- Non-NULL => the rider revoked access at Strava. Drives the reconnect badge. We keep
  -- their row, team, and history so their total freezes instead of vanishing mid-race.
  strava_revoked_at INTEGER,
  disconnected_at   INTEGER,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_athletes_team ON athletes (team) WHERE team IS NOT NULL;

CREATE TABLE oauth_tokens (
  athlete_id        INTEGER PRIMARY KEY
                    REFERENCES athletes(strava_athlete_id) ON DELETE CASCADE,
  access_token_enc  TEXT    NOT NULL,           -- "v1.<iv>.<ct>.<tag>"
  refresh_token_enc TEXT    NOT NULL,
  -- Compare-and-swap guard for concurrent refreshes.
  --
  -- NEVER compare the ciphertext instead. AES-GCM uses a fresh random IV per seal, so
  -- re-encrypting the same refresh token yields different bytes every time: a
  -- `WHERE refresh_token_enc = ?` predicate would match zero rows on every refresh,
  -- silently discard each newly rotated token, and lock out every athlete permanently.
  token_version     INTEGER NOT NULL DEFAULT 0,
  expires_at        INTEGER NOT NULL,           -- Strava's expires_at, unix seconds UTC
  scope             TEXT    NOT NULL DEFAULT '',
  token_type        TEXT    NOT NULL DEFAULT 'Bearer',
  updated_at        TEXT    NOT NULL
) STRICT;

CREATE TABLE activities (
  -- Strava's own id, so the upsert below is naturally idempotent: re-syncing can never
  -- double-count a ride.
  strava_activity_id          INTEGER PRIMARY KEY,
  athlete_id                  INTEGER NOT NULL
                              REFERENCES athletes(strava_athlete_id) ON DELETE CASCADE,
  name                        TEXT    NOT NULL DEFAULT '',
  -- THE filter field. Not the legacy `type`: an EMountainBikeRide reports type="Ride",
  -- so a filter keyed on `type` counts e-bikes as pedal rides.
  sport_type                  TEXT    NOT NULL,
  legacy_type                 TEXT,                  -- raw.type, kept for forensics only
  sport_type_source           TEXT    NOT NULL DEFAULT 'sport_type'
                              CHECK (sport_type_source IN ('sport_type','type')),
  distance_meters             REAL    NOT NULL DEFAULT 0 CHECK (distance_meters >= 0),
  moving_time_seconds         INTEGER NOT NULL DEFAULT 0 CHECK (moving_time_seconds >= 0),
  elapsed_time_seconds        INTEGER NOT NULL DEFAULT 0,
  total_elevation_gain_meters REAL    NOT NULL DEFAULT 0,
  start_date_utc              TEXT    NOT NULL,       -- the true UTC instant
  start_epoch                 INTEGER NOT NULL,       -- Date.parse(start_date_utc)/1000
  -- LOCAL WALL CLOCK carrying a misleading trailing Z. Strava sends the rider's local
  -- time formatted as if it were UTC. Never pass this to new Date() and expect an
  -- instant; it is only ever used as a string.
  start_date_local            TEXT    NOT NULL,
  -- The competition's unit of judgement: each coast is scored on its own local calendar
  -- day, which is the fair reading of a cross-timezone race.
  local_date                  TEXT    GENERATED ALWAYS AS (substr(start_date_local,1,10)) STORED,
  timezone                    TEXT,
  is_private                  INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0,1)),
  is_manual                   INTEGER NOT NULL DEFAULT 0 CHECK (is_manual  IN (0,1)),
  manual_approved             INTEGER NOT NULL DEFAULT 0 CHECK (manual_approved IN (0,1)),
  is_trainer                  INTEGER NOT NULL DEFAULT 0 CHECK (is_trainer IN (0,1)),
  -- Soft delete from full-sync reconciliation. Without it, a rider's deleted 340-mile
  -- GPS-glitch ride keeps counting for their team for the rest of the competition.
  deleted_at                  INTEGER,
  synced_at                   TEXT    NOT NULL
) STRICT;

CREATE INDEX idx_activities_leaderboard    ON activities (local_date, sport_type, athlete_id);
CREATE INDEX idx_activities_athlete_date   ON activities (athlete_id, local_date DESC);
CREATE INDEX idx_activities_athlete_epoch  ON activities (athlete_id, start_epoch);

CREATE TABLE sessions (
  -- sha256(raw token), base64url. The raw token is returned to the browser exactly once
  -- and never stored, so a database leak yields no usable session credentials. A PK
  -- lookup on a 256-bit digest is also why no constant-time compare is needed here.
  session_id_hash TEXT    PRIMARY KEY,
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
  state_hash TEXT    PRIMARY KEY,             -- sha256(state)
  -- sha256 of the nonce in the HttpOnly bc_oauth cookie: this is what BINDS the state to
  -- the browser that started the flow.
  --
  -- Signing and single-use alone do not stop login CSRF. An attacker completes Strava
  -- consent themselves, then mails the victim the resulting genuine code+state link; the
  -- victim's browser follows it and gets a session bound to the ATTACKER's athlete id.
  -- Requiring a matching cookie nonce is what closes that.
  nonce_hash TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  return_to  TEXT    NOT NULL DEFAULT '/'
) STRICT;

CREATE INDEX idx_oauth_states_expires ON oauth_states (expires_at);

CREATE TABLE sync_state (
  athlete_id          INTEGER PRIMARY KEY
                      REFERENCES athletes(strava_athlete_id) ON DELETE CASCADE,
  -- max(start_epoch) ever persisted. A FAST PATH ONLY -- never the sole sync strategy.
  -- A ride uploaded late, a Garmin sync failure, a rider flipping an old ride to public,
  -- or a distance correction all have a start_date older than this and would be missed
  -- forever, because /athlete/activities offers no `modified_after`.
  watermark_epoch     INTEGER NOT NULL DEFAULT 0,
  last_full_sync_at   INTEGER,
  last_sync_started   INTEGER,
  last_sync_finished  INTEGER,
  lock_expires_at     INTEGER,                 -- NULL or past => unlocked (self-healing)
  last_status         TEXT    NOT NULL DEFAULT 'never'
                      CHECK (last_status IN ('never','running','ok','error')),
  last_error          TEXT,
  activities_upserted INTEGER NOT NULL DEFAULT 0,
  pages_fetched       INTEGER NOT NULL DEFAULT 0,
  truncated           INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0,1))
) STRICT;
