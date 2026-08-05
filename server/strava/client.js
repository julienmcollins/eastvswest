import { STRAVA_MAX_PAGES, STRAVA_PAGE_SIZE } from '../contracts.js';
import { maxStartEpoch, nextQuarterHourMs, nextUtcMidnightMs, parseRateLimitHeaders } from './map.js';

/**
 * Pure-HTTP Strava client.
 *
 * Structural rules this file exists to hold, and which a reviewer should re-check on
 * every change:
 *
 *  1. NO `process.env`, NO `node:sqlite`, NO `node:*` import at all. `apiBase`,
 *     `oauthBase`, `clientId`, `clientSecret`, `redirectUri`, `fetchImpl` and `now` are
 *     injected. That is the entire reason this module can be lifted onto a Cloudflare
 *     Worker without edits, and the reason the test double is a `fetchImpl` rather than
 *     an HTTP server (`listen()` is EPERM in this sandbox anyway).
 *
 *  2. The request path NEVER hands the form body, the request headers, or an access
 *     token to the logger, and never stores any of them on an error. The obvious
 *     implementation logs the failed request on a token-endpoint 400 -- which writes
 *     STRAVA_CLIENT_SECRET and a live refresh token to stdout on precisely the code path
 *     whose output is most likely to be pasted into a bug report. Log lines carry only
 *     {method, host, pathname, status, attempt, rateLimitUsage}, composed by #logRequest
 *     from named arguments so no call site can widen them.
 *
 *  3. The HTTP handler is never slept for a rate limit. A 429 records a block until the
 *     next bucket boundary and throws; the user sees "rate limited, try again at 14:45
 *     UTC". Sleep-and-retry is only for 5xx/network, only on GET, and never for
 *     POST /oauth/token -- a retried authorization code is a burnt single-use code.
 */

/** Requests held back from the quota so a concurrent sync can still refresh a token. */
const RESERVE = 5;

/**
 * Pre-first-response limits. Conservative on purpose: some apps get 200/2000, but
 * assuming the larger allocation before any header has confirmed it would spend a quota
 * we may not have. [UNVERIFIED] which allocation this app actually has -- resolved by
 * scripts/strava-probe.mjs, and irrelevant once the first response's headers land.
 */
const DEFAULT_SHORT_LIMIT = 100;
const DEFAULT_DAILY_LIMIT = 1000;

/** per_page fallback target when 200 is rejected. */
const MIN_PAGE_SIZE = 100;

/** Retries for an idempotent GET that failed with 5xx or a transport error. */
const MAX_GET_RETRIES = 2;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Base error. Note what is NOT here: no `body`, no `form`, no `headers`, no token.
 *
 * `toJSON()` returns a fixed field list rather than spreading `this`, so a future field
 * cannot leak into a serialized log line by accident, and `JSON.stringify(err)` is safe
 * to put in a bug report even for an OAuth failure.
 */
export class StravaError extends Error {
  constructor(message, { status = null, code = 'strava_error', path = '', retryable = false, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'StravaError';
    this.status = status;
    this.code = code;
    this.path = path;
    this.retryable = retryable;
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      status: this.status,
      code: this.code,
      path: this.path,
      retryable: this.retryable,
    };
  }
}

/** 401/403, or a token endpoint rejecting a code. The grant may still be alive. */
export class StravaAuthError extends StravaError {
  constructor(message, opts = {}) {
    super(message, { code: 'strava_auth', ...opts });
    this.name = 'StravaAuthError';
  }
}

/** The athlete revoked us (or the refresh token is permanently dead). Requires re-consent. */
export class StravaGrantRevokedError extends StravaError {
  constructor(message, opts = {}) {
    super(message, { code: 'strava_revoked', ...opts });
    this.name = 'StravaGrantRevokedError';
  }
}

/** Quota exhausted -- either observed (429) or pre-emptively refused before sending. */
export class StravaRateLimitError extends StravaError {
  constructor(message, { retryAfterMs = 0, resetAt = null, bucket = 'short', ...opts } = {}) {
    super(message, { code: 'rate_limited', retryable: true, ...opts });
    this.name = 'StravaRateLimitError';
    this.retryAfterMs = retryAfterMs;
    /** ISO-8601 instant the block lifts. This is what the user is shown. */
    this.resetAt = resetAt;
    /** 'short' (15 min), 'daily', or 'local' for our own pre-emptive gate. */
    this.bucket = bucket;
  }

  toJSON() {
    return { ...super.toJSON(), retryAfterMs: this.retryAfterMs, resetAt: this.resetAt, bucket: this.bucket };
  }
}

/**
 * Neither `activity:read_all` nor `activity:read` was granted.
 *
 * Carries what WAS granted so the UI can say what to re-consent to. Thrown only when
 * neither is present: read-only-public is a perfectly countable rider.
 */
export class StravaScopeError extends StravaError {
  constructor(message, { granted = '', required = [], ...opts } = {}) {
    super(message, { code: 'insufficient_scope', ...opts });
    this.name = 'StravaScopeError';
    this.granted = granted;
    this.required = required;
  }

  toJSON() {
    return { ...super.toJSON(), granted: this.granted, required: this.required };
  }
}

/** DNS/TLS/timeout/socket -- we never learned whether Strava processed the request. */
export class StravaNetworkError extends StravaError {
  constructor(message, opts = {}) {
    super(message, { code: 'strava_unavailable', retryable: true, ...opts });
    this.name = 'StravaNetworkError';
  }
}

/** `setTimeout` rather than node:timers/promises: this file must not import node:*. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

class StravaClient {
  #apiBase;
  #oauthBase;
  #clientId;
  #clientSecret;
  #redirectUri;
  #fetch;
  #now;
  #logger;
  #timeoutMs;
  #minSpacingMs;
  #retryBaseMs;
  #sleep;

  /** Conservative until the first response teaches us otherwise (see DEFAULT_* above). */
  #limits = { short: DEFAULT_SHORT_LIMIT, daily: DEFAULT_DAILY_LIMIT, readShort: DEFAULT_SHORT_LIMIT, readDaily: DEFAULT_DAILY_LIMIT };
  #usage = { short: 0, daily: 0, readShort: 0, readDaily: 0 };
  #headersSeen = false;

  /** Reactive 429 block. Milliseconds on the injected clock; 0 means "not blocked". */
  #blockedUntilMs = 0;
  #blockedBucket = null;

  /** Remembered per_page rejection, so one 400 does not cost a retry on every page. */
  #pageSizeCap = null;

  #lastRequestAtMs = 0;

  constructor({
    apiBase,
    oauthBase,
    clientId,
    clientSecret,
    redirectUri,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    logger = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    /** Single-flight spacer: never hammer Strava back-to-back. Tests set 0. */
    minRequestSpacingMs = 100,
    /** Backoff base for the 5xx/network retry. Tests set 1 to stay fast. */
    retryBaseMs = 250,
    sleepImpl = sleep,
  } = {}) {
    if (!apiBase || !oauthBase) throw new TypeError('createStravaClient: apiBase and oauthBase are required.');
    if (typeof fetchImpl !== 'function') throw new TypeError('createStravaClient: fetchImpl is not a function.');

    // Trailing slashes are stripped once here so `${base}${pathname}` never doubles up.
    this.#apiBase = String(apiBase).replace(/\/+$/, '');
    this.#oauthBase = String(oauthBase).replace(/\/+$/, '');
    this.#clientId = clientId === undefined || clientId === null ? null : String(clientId);
    this.#clientSecret = clientSecret === undefined || clientSecret === null ? null : String(clientSecret);
    this.#redirectUri = redirectUri ?? null;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#logger = logger;
    this.#timeoutMs = timeoutMs;
    this.#minSpacingMs = minRequestSpacingMs;
    this.#retryBaseMs = retryBaseMs;
    this.#sleep = sleepImpl;
  }

  /**
   * The redirect_uri this client was built with.
   *
   * Exposed rather than used: [UNVERIFIED] whether Strava's POST /oauth/token wants
   * `redirect_uri` echoed back (the RFC says yes for public clients, Strava's own docs
   * list only client_id/client_secret/code/grant_type). It is deliberately NOT sent,
   * because sending a value Strava does not expect is a 400 on the login path, while
   * omitting one it does not check costs nothing. The probe script settles it.
   */
  get redirectUri() {
    return this.#redirectUri;
  }

  /**
   * A snapshot for GET /api/health/strava and for the sync response.
   *
   * Deliberately a flat copy: handing out the live objects would let a route mutate the
   * gate, and the gate is the only thing standing between a double-clicked Refresh and a
   * 15-minute lockout for every rider.
   */
  get rateLimit() {
    const blocked = this.#blockedUntilMs > this.#now();
    return Object.freeze({
      shortUsage: this.#usage.short,
      shortLimit: this.#limits.short,
      dailyUsage: this.#usage.daily,
      dailyLimit: this.#limits.daily,
      readShortUsage: this.#usage.readShort,
      readShortLimit: this.#limits.readShort,
      readDailyUsage: this.#usage.readDaily,
      readDailyLimit: this.#limits.readDaily,
      reserve: RESERVE,
      headersSeen: this.#headersSeen,
      blocked,
      blockedUntilMs: blocked ? this.#blockedUntilMs : 0,
      blockedUntil: blocked ? new Date(this.#blockedUntilMs).toISOString() : null,
      bucket: blocked ? this.#blockedBucket : null,
      pageSizeCap: this.#pageSizeCap,
    });
  }

  // ---------------------------------------------------------------- OAuth

  /**
   * Trade an authorization code for tokens. NEVER retried at any layer: the code is
   * single-use, so a retry after an ambiguous failure guarantees a hard 400 and turns a
   * transient blip into a failed login the rider cannot retry either.
   */
  async exchangeCode(code) {
    if (typeof code !== 'string' || code === '') throw new TypeError('exchangeCode: code is required.');
    const data = await this.#request({
      method: 'POST',
      base: 'oauth',
      pathname: '/token',
      form: {
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        code,
        grant_type: 'authorization_code',
      },
    });
    return this.#tokenResponse(data, '/oauth/token');
  }

  /** Exchange a refresh token. Also never retried -- see exchangeCode. */
  async refreshTokens(refreshToken) {
    if (typeof refreshToken !== 'string' || refreshToken === '') {
      throw new TypeError('refreshTokens: refreshToken is required.');
    }
    const data = await this.#request({
      method: 'POST',
      base: 'oauth',
      pathname: '/token',
      form: {
        client_id: this.#clientId,
        client_secret: this.#clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      },
    });
    return this.#tokenResponse(data, '/oauth/token');
  }

  /**
   * Revoke our grant.
   *
   * Sends the token BOTH as a bearer header and as an `access_token` form field:
   * [UNVERIFIED] which one Strava actually reads, and sending both is free. A 401 is
   * reported as success -- it means the grant is already gone, which is the state the
   * caller asked for, and treating it as an error makes "Disconnect" un-completable for
   * exactly the athletes who already revoked us in Strava's own settings page.
   */
  async deauthorize(accessToken) {
    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new TypeError('deauthorize: accessToken is required.');
    }
    try {
      const data = await this.#request({
        method: 'POST',
        base: 'oauth',
        pathname: '/deauthorize',
        accessToken,
        form: { access_token: accessToken },
      });
      // [UNVERIFIED] documented shape is {"access_token":"..."}; we assert nothing about it.
      return { ok: true, alreadyRevoked: false, echoed: isRecord(data) };
    } catch (err) {
      if (err instanceof StravaError && (err.status === 401 || err instanceof StravaGrantRevokedError)) {
        return { ok: true, alreadyRevoked: true, echoed: false };
      }
      throw err;
    }
  }

  /**
   * Normalize a token response without ever logging or storing it.
   *
   * `expires_at` is preferred over `expires_in` because it is absolute: computing it from
   * `expires_in` plus our own clock silently shortens or extends every token's life by
   * whatever the host clock skew is.
   */
  #tokenResponse(data, path) {
    if (!isRecord(data) || typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string') {
      // No body, no field dump: if the shape is wrong, saying so is all we can safely say.
      throw new StravaAuthError('Strava token response did not contain access_token and refresh_token.', {
        status: 200,
        path,
      });
    }
    const nowSeconds = Math.floor(this.#now() / 1000);
    const expiresAt = Number.isFinite(data.expires_at)
      ? Math.floor(data.expires_at)
      : nowSeconds + (Number.isFinite(data.expires_in) ? Math.floor(data.expires_in) : 0);

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
      expiresIn: Number.isFinite(data.expires_in) ? Math.floor(data.expires_in) : Math.max(0, expiresAt - nowSeconds),
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      // [UNVERIFIED] whether the token response carries `scope`. The callback's ?scope=
      // query param is the authoritative source either way, so this is a bonus, not a
      // dependency.
      scope: typeof data.scope === 'string' ? data.scope : null,
      athlete: isRecord(data.athlete) ? data.athlete : null,
    };
  }

  // ---------------------------------------------------------------- API

  async getAthlete(accessToken) {
    return this.#request({ method: 'GET', base: 'api', pathname: '/athlete', accessToken });
  }

  /**
   * One page of GET /athlete/activities.
   *
   * @param {{accessToken:string, after?:number, before?:number, page?:number, perPage?:number}} opts
   * @returns {Promise<object[]>}
   */
  async listActivities({ accessToken, after = null, before = null, page = 1, perPage = STRAVA_PAGE_SIZE } = {}) {
    const query = { page: String(page), per_page: String(perPage) };
    // Strava wants unix seconds. Omitted entirely when null: sending `after=` (empty)
    // has an undefined meaning and is not the same as not filtering.
    if (Number.isFinite(after)) query.after = String(Math.floor(after));
    if (Number.isFinite(before)) query.before = String(Math.floor(before));

    const data = await this.#request({ method: 'GET', base: 'api', pathname: '/athlete/activities', query, accessToken });
    if (!Array.isArray(data)) {
      // An object here would be read as a zero-length page, i.e. "pagination finished",
      // and the sync would report success having fetched nothing.
      throw new StravaError('Strava returned a non-array activity page.', {
        status: 200,
        code: 'strava_bad_shape',
        path: '/athlete/activities',
      });
    }
    return data;
  }

  /**
   * Page through activities, yielding {page, perPage, activities}.
   *
   * Termination is a SHORT page (`length < per_page`), which is the only signal Strava
   * gives; the STRAVA_MAX_PAGES backstop exists so a bug in that comparison cannot spin
   * against a rate-limited API forever. When the backstop trips the run is `truncated`
   * and the caller must not advance the watermark or reconcile deletions -- an
   * incomplete page set looks exactly like "the athlete deleted 3000 rides".
   *
   * The generator's RETURN value carries the summary, so a caller driving `.next()`
   * manually (fetchAllActivities) gets `truncated` without a side-channel object.
   */
  async *iterateActivities({ accessToken, after = null, before = null, perPage = STRAVA_PAGE_SIZE, maxPages = STRAVA_MAX_PAGES } = {}) {
    let size = Math.min(Math.max(1, perPage), STRAVA_PAGE_SIZE);
    if (this.#pageSizeCap !== null) size = Math.min(size, this.#pageSizeCap);

    restart: for (;;) {
      let pages = 0;
      let watermark = 0;
      let total = 0;

      for (let page = 1; page <= maxPages; page += 1) {
        let batch;
        try {
          batch = await this.listActivities({ accessToken, after, before, page, perPage: size });
        } catch (err) {
          // [UNVERIFIED] whether per_page=200 is accepted. If it is not, Strava answers
          // 400; drop to 100 and restart from page 1 (page numbers mean different rides
          // at a different page size, so continuing in place would skip records).
          // Only on the first page: after a yield the caller already has rows, and
          // restarting would hand it duplicates.
          if (err instanceof StravaError && err.status === 400 && size > MIN_PAGE_SIZE && pages === 0) {
            this.#pageSizeCap = MIN_PAGE_SIZE;
            size = MIN_PAGE_SIZE;
            continue restart;
          }
          throw err;
        }

        pages += 1;
        total += batch.length;
        watermark = maxStartEpoch(batch, watermark);
        yield { page, perPage: size, activities: batch };

        if (batch.length < size) {
          return { pages, perPage: size, truncated: false, maxStartEpoch: watermark, total };
        }
      }

      return { pages, perPage: size, truncated: true, maxStartEpoch: watermark, total };
    }
  }

  /**
   * Every activity in the window, plus the flags the sync needs to decide what it may do.
   *
   * On failure mid-pagination the error carries a non-enumerable `partial` with the pages
   * already fetched, so the caller can persist them (upserts are idempotent) while
   * explicitly NOT advancing the watermark and NOT reconciling deletions. Non-enumerable
   * so a log line that stringifies the error does not dump 200 rides.
   */
  async fetchAllActivities(opts = {}) {
    const activities = [];
    let pages = 0;
    let perPage = null;
    let watermark = 0;

    const iterator = this.iterateActivities(opts);
    for (;;) {
      let step;
      try {
        step = await iterator.next();
      } catch (err) {
        Object.defineProperty(err, 'partial', {
          value: Object.freeze({ activities, pages, perPage, maxStartEpoch: watermark, truncated: true }),
          enumerable: false,
          configurable: true,
          writable: false,
        });
        throw err;
      }

      if (step.done) {
        const summary = step.value ?? {};
        return {
          activities,
          pages,
          perPage: perPage ?? summary.perPage ?? null,
          truncated: Boolean(summary.truncated),
          /** Math.max over EVERY page, never a positional element. See map.maxStartEpoch. */
          maxStartEpoch: watermark,
          partial: false,
        };
      }

      pages += 1;
      perPage = step.value.perPage;
      for (const raw of step.value.activities) activities.push(raw);
      watermark = maxStartEpoch(step.value.activities, watermark);
    }
  }

  // ---------------------------------------------------------------- internals

  #url(base, pathname, query) {
    const root = base === 'oauth' ? this.#oauthBase : this.#apiBase;
    const url = new URL(`${root}${pathname}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    return url;
  }

  /**
   * Replace any known secret with a marker.
   *
   * Belt and braces on top of "never put request data in an error": Strava echoes field
   * NAMES in its error bodies, but if it ever echoed a value, this is what keeps the
   * client secret out of a message the moment before it reaches a log.
   */
  #scrub(text, extra = []) {
    if (typeof text !== 'string' || text === '') return text;
    let out = text;
    for (const secret of [this.#clientSecret, ...extra]) {
      if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('[redacted]');
    }
    return out;
  }

  /**
   * The ONLY place a log line about a request is produced.
   *
   * Takes named scalars, never an object to spread, so there is no syntactic way for a
   * caller to slip `form`, `headers`, or a token into a log line.
   */
  #logRequest(level, event, { method, host, pathname, status = null, attempt = 1 }) {
    const logger = this.#logger;
    if (!logger) return;
    const fn = typeof logger[level] === 'function' ? logger[level] : logger.info;
    if (typeof fn !== 'function') return;
    fn.call(logger, {
      event,
      method,
      host,
      pathname,
      status,
      attempt,
      rateLimitUsage: `${this.#usage.short}/${this.#limits.short},${this.#usage.daily}/${this.#limits.daily}`,
    });
  }

  /** Absorb whatever rate-limit headers a response happened to carry. */
  #observeRateLimit(headers) {
    const parsed = parseRateLimitHeaders(headers);
    if (parsed.shortLimit !== null) this.#limits.short = parsed.shortLimit;
    if (parsed.dailyLimit !== null) this.#limits.daily = parsed.dailyLimit;
    if (parsed.readShortLimit !== null) this.#limits.readShort = parsed.readShortLimit;
    if (parsed.readDailyLimit !== null) this.#limits.readDaily = parsed.readDailyLimit;
    if (parsed.shortUsage !== null) this.#usage.short = parsed.shortUsage;
    if (parsed.dailyUsage !== null) this.#usage.daily = parsed.dailyUsage;
    if (parsed.readShortUsage !== null) this.#usage.readShort = parsed.readShortUsage;
    if (parsed.readDailyUsage !== null) this.#usage.readDaily = parsed.readDailyUsage;
    if (parsed.headersSeen) this.#headersSeen = true;
    return parsed;
  }

  #rateLimitError(message, { bucket, untilMs, path, status = null }) {
    const nowMs = this.#now();
    return new StravaRateLimitError(message, {
      status,
      path,
      bucket,
      retryAfterMs: Math.max(0, untilMs - nowMs),
      resetAt: new Date(untilMs).toISOString(),
    });
  }

  /**
   * The pre-emptive gate. Throws WITHOUT sending.
   *
   * Two jobs. (1) Honour an observed 429 block -- retrying inside the block is how one
   * 429 becomes fifteen minutes of them. (2) Stop RESERVE requests short of the limit, so
   * there is always headroom for a token refresh; running the read quota to exactly zero
   * means the next login cannot refresh and the rider is locked out until the bucket rolls.
   *
   * Deliberately does NOT set #blockedUntilMs: the reserve is a guess about our own
   * usage, and persisting a block from a guess would extend an outage we invented.
   */
  #assertQuotaAvailable(method, pathname) {
    const nowMs = this.#now();
    if (this.#blockedUntilMs > nowMs) {
      throw this.#rateLimitError('Strava rate limit in effect; not sending.', {
        bucket: this.#blockedBucket ?? 'short',
        untilMs: this.#blockedUntilMs,
        path: pathname,
      });
    }

    const buckets = [
      ['short', this.#usage.short, this.#limits.short, nextQuarterHourMs(nowMs)],
      ['daily', this.#usage.daily, this.#limits.daily, nextUtcMidnightMs(nowMs)],
    ];
    if (method === 'GET') {
      // The read buckets only constrain read endpoints, so a full read quota must not
      // block a token refresh.
      buckets.push(['short', this.#usage.readShort, this.#limits.readShort, nextQuarterHourMs(nowMs)]);
      buckets.push(['daily', this.#usage.readDaily, this.#limits.readDaily, nextUtcMidnightMs(nowMs)]);
    }

    for (const [bucket, usage, limit, untilMs] of buckets) {
      if (Number.isFinite(usage) && Number.isFinite(limit) && usage >= limit - RESERVE) {
        throw this.#rateLimitError(`Strava ${bucket} rate limit nearly exhausted (${usage}/${limit}); not sending.`, {
          bucket: 'local',
          untilMs,
          path: pathname,
        });
      }
    }
  }

  /** Minimum gap between outbound requests -- the single-flight spacer. */
  async #space() {
    if (this.#minSpacingMs <= 0) return;
    const gap = this.#minSpacingMs - (this.#now() - this.#lastRequestAtMs);
    if (gap > 0) await this.#sleep(gap);
    this.#lastRequestAtMs = this.#now();
  }

  /**
   * Classify a non-2xx response into a typed error.
   *
   * The parsed body is READ here to classify and then discarded: `field`/`code` from
   * Strava's `errors[]` are server-authored names (e.g. "refresh_token"/"invalid"), which
   * is what distinguishes "this code is spent" from "this grant is dead". Nothing from
   * the REQUEST is ever consulted, so the client secret cannot appear in the result.
   */
  #classify({ status, pathname, isOauth, parsed, isRefresh }) {
    const first = isRecord(parsed) && Array.isArray(parsed.errors) && isRecord(parsed.errors[0]) ? parsed.errors[0] : null;
    const field = typeof first?.field === 'string' ? this.#scrub(first.field) : null;
    const errCode = typeof first?.code === 'string' ? this.#scrub(first.code) : null;
    const detail = field || errCode ? ` (${field ?? '?'}: ${errCode ?? '?'})` : '';
    const where = isOauth ? 'Strava OAuth' : 'Strava API';

    if (status === 401) {
      return new StravaAuthError(`${where} rejected the credentials (401)${detail}.`, { status, path: pathname });
    }
    if (status === 403) {
      return new StravaAuthError(`${where} forbade the request (403)${detail}.`, {
        status,
        path: pathname,
        code: 'strava_forbidden',
      });
    }
    if (status === 404) {
      return new StravaError(`${where} returned 404 for ${pathname}.`, { status, path: pathname, code: 'strava_not_found' });
    }
    if (status >= 500) {
      return new StravaError(`${where} returned ${status} for ${pathname}.`, {
        status,
        path: pathname,
        code: 'strava_unavailable',
        retryable: true,
      });
    }
    if (status === 400 && isRefresh) {
      // A refresh token Strava calls invalid means the athlete revoked us (or the token
      // was rotated away). This is the only signal we get -- there is no revocation
      // webhook we listen to -- so it must be distinguishable from a generic 400.
      const looksRevoked = field === 'refresh_token'
        || (typeof first?.resource === 'string' && first.resource.toLowerCase() === 'refreshtoken');
      if (looksRevoked) {
        return new StravaGrantRevokedError(`Strava refused the refresh token (400)${detail}; the grant is gone.`, {
          status,
          path: pathname,
        });
      }
    }
    if (status === 400 && isOauth) {
      return new StravaAuthError(`${where} rejected the token request (400)${detail}.`, { status, path: pathname });
    }
    return new StravaError(`${where} returned ${status} for ${pathname}${detail}.`, {
      status,
      path: pathname,
      code: 'strava_bad_request',
    });
  }

  /**
   * Perform one Strava request, with retries, the rate-limit gate, and the logging rules.
   *
   * @param {{method:string, base:'api'|'oauth', pathname:string, query?:object,
   *          form?:object, accessToken?:string}} spec
   */
  async #request({ method, base, pathname, query = null, form = null, accessToken = null }) {
    const url = this.#url(base, pathname, query);
    const host = url.host;
    // url.pathname, never url.href: the href carries the query string, and a query string
    // is exactly the kind of thing that grows a token in it two refactors from now.
    const logPath = url.pathname;
    const isOauth = base === 'oauth';
    const isRefresh = isOauth && pathname === '/token' && form?.grant_type === 'refresh_token';

    // GETs are idempotent, so they may be retried. A POST /oauth/token must not be:
    // an authorization code is single-use and a retry burns it.
    const retriesAllowed = method === 'GET' ? MAX_GET_RETRIES : 0;

    this.#assertQuotaAvailable(method, logPath);

    let lastError = null;
    for (let attempt = 1; attempt <= retriesAllowed + 1; attempt += 1) {
      await this.#space();

      const headers = { Accept: 'application/json' };
      if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
      let body;
      if (form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null) params.set(k, String(v));
        body = params.toString();
      }

      let response;
      try {
        response = await this.#fetch(url.toString(), {
          method,
          headers,
          body,
          // AbortSignal.timeout is global in Node >=18 and on Workers; a hung socket
          // otherwise holds the request handler open until the client gives up.
          signal: AbortSignal.timeout(this.#timeoutMs),
        });
      } catch (cause) {
        // `cause` is attached but never logged: DNS/TLS errors are safe, yet undici
        // wraps the original request in some of them and we do not audit that.
        lastError = new StravaNetworkError(`Strava request failed in transport for ${logPath}.`, {
          path: logPath,
          cause,
        });
        this.#logRequest('warn', 'strava.transport_error', { method, host, pathname: logPath, attempt });
        if (attempt <= retriesAllowed) {
          await this.#sleep(this.#backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      const parsed = await this.#readJson(response);
      const limits = this.#observeRateLimit(response.headers);

      if (response.ok) {
        this.#logRequest('debug', 'strava.ok', { method, host, pathname: logPath, status: response.status, attempt });
        return parsed;
      }

      if (response.status === 429) {
        // Reactive block. Which bucket is exhausted decides how long: the 15-minute
        // bucket rolls at :00/:15/:30/:45, the daily one at 00:00 UTC. Guessing "short"
        // when the daily quota is gone produces four failed retries an hour, all day.
        const dailyExhausted = Number.isFinite(limits.dailyUsage)
          && Number.isFinite(limits.dailyLimit)
          && limits.dailyUsage >= limits.dailyLimit;
        const bucket = dailyExhausted ? 'daily' : 'short';
        const nowMs = this.#now();
        let untilMs = bucket === 'daily' ? nextUtcMidnightMs(nowMs) : nextQuarterHourMs(nowMs);
        // [UNVERIFIED] whether Strava sends Retry-After. If it does and it points past
        // our computed boundary, believe Strava -- it knows about penalties we do not.
        if (limits.retryAfterSeconds !== null) {
          untilMs = Math.max(untilMs, nowMs + limits.retryAfterSeconds * 1000);
        }
        this.#blockedUntilMs = untilMs;
        this.#blockedBucket = bucket;
        this.#logRequest('warn', 'strava.rate_limited', { method, host, pathname: logPath, status: 429, attempt });
        // No retry, and above all no sleep: the block is surfaced to the user as a time.
        throw this.#rateLimitError(`Strava ${bucket} rate limit hit (429).`, {
          bucket,
          untilMs,
          path: logPath,
          status: 429,
        });
      }

      const err = this.#classify({ status: response.status, pathname: logPath, isOauth, parsed, isRefresh });
      this.#logRequest(response.status >= 500 ? 'warn' : 'error', 'strava.error', {
        method,
        host,
        pathname: logPath,
        status: response.status,
        attempt,
      });

      if (err.retryable && attempt <= retriesAllowed) {
        lastError = err;
        await this.#sleep(this.#backoffMs(attempt));
        continue;
      }
      throw err;
    }

    /* c8 ignore next -- the loop always returns or throws; this is a guard against a future edit. */
    throw lastError ?? new StravaError(`Strava request to ${logPath} exhausted its attempts.`, { path: logPath });
  }

  /** Exponential backoff with full jitter, so two riders retrying never sync up. */
  #backoffMs(attempt) {
    const base = this.#retryBaseMs * 2 ** (attempt - 1);
    return base + Math.floor(Math.random() * base);
  }

  /**
   * Read a response body as JSON, tolerating anything.
   *
   * A 502 from a proxy in front of Strava is HTML, and a `res.json()` that throws there
   * would replace a useful "Strava returned 502" with an opaque SyntaxError -- and, worse,
   * a SyntaxError whose message contains a chunk of the body.
   */
  async #readJson(response) {
    let text;
    try {
      text = await response.text();
    } catch {
      return null;
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
}

/**
 * Build a Strava client. Every dependency is injected; see the class notes above for the
 * three structural rules that make this module portable and safe to log around.
 */
export function createStravaClient(options = {}) {
  return new StravaClient(options);
}
