# Deploying

## Read this first: GitHub Pages cannot host this app

Pages is **static hosting**. It serves `public/` and runs nothing. It cannot run `server/` —
that is Node, `node:sqlite`, OAuth, sessions and cookies. So a Pages deploy publishes the
**frontend only**, and the site is non-functional until an API is running elsewhere.

`node scripts/deploy-setup.mjs` applies every mechanical edit on this page and prints what is
left. It supports both shapes below; run it with `--dry-run` first to see the diff.

**If you want a guided walk rather than a reference, start with
[`GOING-LIVE.md`](GOING-LIVE.md)** — the same ground in order, in plain language, for the free
hosting route (shape B). This page is what it points back to for detail.

---

## Pick a shape first. This decision changes how sessions work.

### A. Custom domain — recommended

```
  www.example.com     ->  GitHub Pages, serving public/          (frontend)
  api.example.com     ->  Cloudflare Worker + D1, serving /api/* (the app)
```

```bash
node scripts/deploy-setup.mjs --web-host www.example.com --api-host api.example.com
```

Both hosts sit on **one registrable domain**, so the session cookie stays first-party:
`HttpOnly; Secure; SameSite=Lax` and nothing else changes. This is the only shape where the
session credential is unreadable by page script.

### B. Default hosts — no domain, no DNS

```
  <user>.github.io/<repo>/            ->  GitHub Pages, serving public/
  <worker>.<account>.workers.dev      ->  Cloudflare Worker + D1, serving /api/*
```

```bash
node scripts/deploy-setup.mjs --default-hosts
```

`github.io` and `workers.dev` are **different registrable domains**. That is not a
configuration gap you can close — it is browser policy:

- `bc_sid` and `bc_csrf` both become **third-party cookies**. Safari's ITP blocks them
  unconditionally, Chrome and Firefox partition them. `SameSite=None; Partitioned` does not
  fix it. Left alone, OAuth appears to succeed and every later `/api/*` is anonymous, with no
  CORS error and no 4xx to point at.
- So this shape runs with **`AUTH_TOKEN_IN_FRAGMENT=true`**: the OAuth callback redirects to
  `…#token=<session token>`, `public/app.js` reads the fragment once and stores the token in
  `localStorage`, and `public/api.js` sends it as `Authorization: Bearer`. All three pieces
  already existed; the callback emitting the fragment is what the flag turns on.
- `requireCsrf` **skips the double-submit token** for a bearer-authenticated caller, because
  the CSRF cookie is equally blocked. That is safe for a specific reason: a bearer token is
  attached only by our own script reading origin-scoped `localStorage`, never ambiently by the
  browser, and `credentialFrom` *prefers* the bearer header — so a request carrying
  `Authorization: Bearer <garbage>` plus the victim's cookies resolves to **no session** rather
  than falling back to the cookie. The `Content-Type: application/json` and Origin-allowlist
  legs still apply. See the long comment in `server/security/csrf.js`.
- Sessions are shortened to **12 hours** (`SESSION_TTL_SECONDS=43200`). `server/config.js`
  refuses to boot with `AUTH_TOKEN_IN_FRAGMENT=true` and a TTL above 24 h.

**What you are accepting.** `localStorage` is keyed per **origin**, with no path component. On
`<user>.github.io`, *every other project that account has ever published* — including a
vendored third-party toy — can read `bc_token` and act as any rider who has signed in, admin
included. The 12-hour TTL bounds that; it does not remove it. If the account publishes only
this project the exposure is small, and it grows silently the day you publish a second thing.
Shape A is the actual fix.

### The sub-path, if you use shape B

A repo named `<user>.github.io` is a **user site** served at the domain root. Any other repo is
a **project site** served from `<user>.github.io/<repo>/`, and the origin root is GitHub's own
404 page. So a project site also needs:

```
WEB_BASE_PATH = "/<repo>"
```

`WEB_ORIGIN` cannot carry it. An `Origin` header is scheme + host + port with **no path**, so a
path there would match no real browser Origin and silently empty the CORS allowlist — at which
point every mutating request 403s on the Origin leg of `requireCsrf`. The two stay separate:
`WEB_ORIGIN` is compared against Origin headers, `WEB_BASE_PATH` is what the post-OAuth
redirect and `safeReturnTo` prepend. `safeReturnTo` also **confines `return_to` to the
sub-path**, so a freshly authenticated rider — with `#token=` still in the URL — cannot be
redirected into another project on the same origin.

`deploy-setup.mjs` derives all of this from your `origin` remote; override with `--github-user`,
`--repo`, `--worker-name`, `--workers-subdomain`, `--web-base-path`.

---

## Blocking prerequisite: the Strava brand assets

`public/assets/btn-strava-connect.svg` and `powered-by-strava.svg` are **hand-authored
placeholders**, created because `developers.strava.com` was unreachable from the build
machine. Shipping them publicly **breaches the Strava API Agreement.**

Before the site is public, replace both with the official artwork from
<https://developers.strava.com/guidelines/>, byte-for-byte unmodified. The official button
must never be restyled, recoloured, re-exported, re-traced, resized below the documented
minimum, or reworded. It is an `<img>` precisely so no stylesheet can reach inside it, and
`styles.css` only ever sets its box size — keep it that way. See `public/assets/README.md`.

Swapping in the real button also removes the text-clipping workaround currently in the
placeholder's `textLength`/`lengthAdjust` attributes.

---

## 1. Frontend: GitHub Pages

`.github/workflows/pages.yml` is committed and does the work. It gates on `npm test` and on
`cmp public/index.html public/404.html` before publishing, so a broken frontend contract
fails *before* anything goes live.

1. **Repo Settings → Pages → Source = GitHub Actions.** Without this the workflow uploads an
   artifact that is never served.
2. **Custom domain:**
   - *Shape A:* Settings → Pages → Custom domain → `www.example.com`. `deploy-setup.mjs`
     writes `public/CNAME`; commit it.
   - *Shape B:* **leave it empty**, and make sure no `public/CNAME` exists. A `CNAME` naming a
     domain you are not serving from makes Pages serve **nothing at all** — not the old site,
     not a 404 with a hint. `deploy-setup.mjs --default-hosts` deletes it if it finds one.
3. **DNS at your registrar** — shape A only: `CNAME www -> <your-github-user>.github.io`. For
   an apex domain you need `A`/`ALIAS` records to GitHub's Pages IPs instead — check GitHub's
   current documented addresses, they change. Shape B needs no DNS at all.
4. **Enforce HTTPS** — shape A only. Wait for it to become available in the Pages settings,
   then enable it; the session cookie is `Secure`. On `github.io` HTTPS is already automatic.
5. The action versions in the workflow (`checkout@v4`, `configure-pages@v5`,
   `upload-pages-artifact@v3`, `deploy-pages@v4`) were pinned without network access to
   verify they are current — **[UNVERIFIED]**, bump if Actions warns about a deprecated
   version.

### The one frontend edit

In `public/config.js`, uncomment the production entry and set both halves:

```js
  'www.example.com': 'https://api.example.com',
```

The key is a **hostname**, so it is the same on a project site as on a user site — the
sub-path never appears here.

Then widen `connect-src` in the `<meta>` CSP of **both** `public/index.html` **and**
`public/404.html`:

```
  connect-src 'self' https://api.example.com;
```

These two must change in the **same commit**. `test/frontend-contract.test.js` has a
`DEPLOY GUARD` test that fails if they disagree, because the failure mode otherwise is
silent: a missing `connect-src` entry rejects every fetch with a console CSP violation and no
HTTP status to look at.

`404.html` must stay byte-for-byte identical to `index.html` (`cp public/index.html
public/404.html`). Pages has no SPA fallback, so 404.html is all a deep link ever gets.

Every path in `index.html` is relative and must stay that way — the artifact root *is*
`public/`, so a root-absolute `/assets/…` 404s under a project-site subpath. The test suite
asserts this.

---

## 2. API: Cloudflare Workers + D1

Five decisions were paid for up front so this is a small port, not a rewrite: every
`server/db/*` method is already `async`, `batch()` already replaces interactive transactions,
all crypto sits in two files, every endpoint is already under `/api/*`, and
`public/config.js` + `api.js` already isolate the API origin.

**The port is written.** Four files, and nothing above them changed:

1. **`server/db/d1.js`** — the D1 adapter, exposing the same interface as `server/db/db.js`
   over `D1PreparedStatement` and `D1.batch`. It handles the three renames that would otherwise
   be silent: `first()` gives `null` where node:sqlite gives `undefined`, writes report
   `meta.changes`/`meta.last_row_id` rather than `changes`/`lastInsertRowid`, and D1 signals some
   failures as `{success:false}` instead of rejecting — read as an empty result set, a failed
   write looks exactly like a sync that stored nothing.
2. **`server/worker.js`** — the `export default { fetch }` entry, plus the adapter that presents
   Node's `(req, res)` over a fetch `Request`/`Response`. Deliberately NOT a modified
   `server/index.js`: that file runs `await main()` at module scope, so a Worker pointed at it
   would bind a socket and read the filesystem during startup. Keeping them separate also
   leaves `npm start` working.
3. **`server/db/bind.js`** — the parameter-binding rules, extracted so `d1.js` can share them
   without importing `db.js`. This one is not cosmetic: `activities.js` imported `placeholders`
   from `db.js` for a *string helper*, and `db.js` imports `node:sqlite`, which does not exist on
   Workers — one unnecessary import made the whole route tree unloadable.
4. **`server/app.js`** — reaches `http/static.js` (the only module needing `node:fs`) through a
   lazy `import()` instead of a top-level one, so a Worker never loads it. `loadConfig` also
   dropped its `node:fs` import, and `lib/log.js` falls back to `console.*` where
   `process.stdout` is absent.

`test/worker-compat.test.js` walks the static import graph from `server/worker.js` and fails on
any Node builtin outside `node:crypto`. That guard is the point — on Node every one of these
modules imports fine, so the failure would otherwise only appear on a real deploy, as a Worker
that dies during module evaluation with the cause visible only in `wrangler tail`.

`loadConfig(env)` takes the Worker's `env` binding directly; `server/config.js` was already the
only module that reads the environment. Migrations are applied out of band with
`wrangler d1 migrations apply`, which is why `server/db/migrate.js` — and its `node:fs` reads of
`server/migrations/` — never reaches the Worker either. That command needs
`migrations_dir = "server/migrations"` inside the `[[d1_databases]]` block: wrangler defaults it
to `./migrations` beside `wrangler.toml` and otherwise fails with "no migrations present at
`<root>/migrations`", naming a folder that was never there.

**Still Node-only, on purpose:** `server/index.js`, `server/db/db.js`, `server/db/migrate.js`,
`server/http/static.js`. Keep them: they are what `npm start` and the test suite run on.

Two Workers limitations to design around, both already accounted for:

- The in-process single-flight refresh mutex **evaporates per isolate**. The `token_version`
  CAS in `server/db/tokens.js` is what actually protects concurrent token refresh; the mutex
  is only an optimisation.
- Any post-response work needs `ctx.waitUntil()`. Nothing depends on a fire-and-forget sync,
  which is why the OAuth callback deliberately does not sync.

`wrangler.toml.example` is a starting point — copy to `wrangler.toml` and fill in the IDs, or
let `deploy-setup.mjs` generate it.

### Worker configuration

Non-secret vars:

```
API_BASE_URL           = https://api.example.com     # builds redirect_uri; must match Strava's callback domain
WEB_ORIGIN             = https://www.example.com     # post-OAuth redirect target and the sole CORS allowlist entry
APP_BASE_URL           = https://www.example.com
WEB_BASE_PATH          =                             # "/<repo>" on a Pages project site, else empty
AUTH_TOKEN_IN_FRAGMENT = false                       # true ONLY on the cross-site shape B
NODE_ENV               = production                  # flips the session cookie to Secure
COMPETITION_START / COMPETITION_END / COMPETITION_TZ
ALLOWED_SPORT_TYPES / COUNT_MANUAL_ACTIVITIES
ADMIN_BOOTSTRAP_ATHLETE_IDS
SESSION_TTL_SECONDS                                  # must be <= 86400 when the flag above is true
```

Routing — **pick one**, and note that `workers_dev` is a top-level TOML key, so it must sit
above every `[table]` in `wrangler.toml` or it silently becomes a key inside `[[d1_databases]]`
and the Worker gets no hostname:

```toml
# Shape A
[[routes]]
pattern = "api.example.com/*"
custom_domain = true

# Shape B
workers_dev = true
```

The Worker `name` is the first label of the workers.dev hostname. `<account>` is your
Cloudflare **workers.dev subdomain** (Workers & Pages → your account → Subdomain), which need
not match your GitHub username — confirm it before deploying, because the API host is baked
into `public/config.js`, the CSP, and `API_BASE_URL`.

Secrets via `wrangler secret put` — **never** in `wrangler.toml`, which is committed:

```
STRAVA_CLIENT_SECRET
SESSION_SECRET            # >=32 bytes base64  (npm run keygen)
TOKEN_ENCRYPTION_KEY      # exactly 32 bytes base64
```

`NODE_ENV=production` is load-bearing: it is what makes the session and CSRF cookies
`Secure`. `server/config.js` gates that on config, never on `X-Forwarded-Proto`, because a
client controls that header and could otherwise downgrade the cookie.

**CORS needs no code change.** `server/http/cors.js` is written complete and shipped inert;
it goes live purely from `WEB_ORIGIN` ≠ `API_BASE_URL`, including the preflight branch,
`Allow-Credentials`, `Vary`, and `Access-Control-Expose-Headers: Retry-After`.

### Strava app settings

At <https://www.strava.com/settings/api>, set **Authorization Callback Domain** to the API
host — `api.example.com`, or `<worker>.<account>.workers.dev` — the domain only, no scheme, no
port, no path. Strava matches on domain.

If that field accepts only one domain, keep a **second Strava app** for `localhost` so local
dev keeps working, and put its credentials in your local `.env`.

---

## 3. Verify, in this order

Against the API host:

```bash
curl -s https://api.example.com/api/health                     # {"ok":true,"schema":2,...}
curl -s https://api.example.com/api/leaderboard | head -c 200  # competition + teams
curl -sI https://api.example.com/api/me | grep -i vary          # Vary: Origin, Authorization, Cookie
```

Preflight actually works (this is what breaks first on a domain mistake):

```bash
curl -si -X OPTIONS https://api.example.com/api/me/sync \
  -H 'Origin: https://www.example.com' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type,x-csrf-token' \
  | grep -i 'access-control-'
# Expect Allow-Origin echoing www.example.com exactly (never *), Allow-Credentials: true,
# Allow-Headers including Content-Type, Authorization, X-CSRF-Token.
```

Then in a browser at the frontend URL (`https://www.example.com`, or
`https://<user>.github.io/<repo>/`):

1. Console shows **no CSP violation** for the API host → the lockstep edit is right.
2. Click Connect, complete Strava consent, land back signed in.
3. Reload. **Still signed in.**
   - *Shape A:* this proves the cookie is not being blocked as third-party. If you are signed
     out here, the two hosts are not on one registrable domain; fix that rather than reaching
     for `SameSite=None`.
   - *Shape B:* this proves the `#token=` handoff landed in `localStorage`. If you are signed
     out, check that the callback's `Location` actually carried `#token=` — that means
     `AUTH_TOKEN_IN_FRAGMENT` did not reach the Worker.
4. **Shape B only:** confirm the URL bar has no `#token=` left in it after the page settles
   (`consumeAuthFragment` scrubs it with one `history.replaceState`), and that the redirect
   landed on `/<repo>/` rather than the origin root.
5. Hit Refresh, confirm miles appear, and switch months in the picker. This is the check that
   catches a broken CSRF path: a 403 `csrf_failed` here on shape B means the bearer exemption
   is not being reached.
6. Load a deep link (`https://<host>/<repo>/anything`) → 404.html renders the app.

---

## Known gaps

- **The D1 and Worker adapters have never run against real Cloudflare infrastructure.** They
  are covered by `test/worker-d1.test.js` against a D1 double that reproduces D1's return
  shapes, and by a static import guard — but no test here can prove workerd's `node:crypto`
  implements `createCipheriv('aes-256-gcm')` and `timingSafeEqual` the way `security/crypto.js`
  needs. The first `wrangler deploy` is the real test; `curl /api/health` then a full sign-in is
  the sequence that exercises it.

  The first deploy found exactly one bug of this class, and it is worth knowing the shape of it
  because the next one will look the same. `server/strava/client.js` defaulted `fetchImpl` to
  `globalThis.fetch` **unbound**, then called it as `this.#fetch(...)`. undici ignores the
  receiver; workerd's `fetch` validates it and throws `TypeError: Illegal invocation`
  synchronously. So D1-only routes (`/api/health`, `/api/leaderboard`, `/api/me`) were all 200
  while every sign-in died 42 ms in with `strava.transport_error status=null` and
  `oauth callback rejected reason=exchange_failed:strava_unavailable` — a failure that reads
  exactly like Strava being down. The default is now bound, and the transport log line carries
  `errorName`/`errorMessage` so the next one names itself in `wrangler tail` instead of
  presenting as an outage. `test/strava-client.test.js` reproduces workerd's receiver check on
  Node with a receiver-sensitive `globalThis.fetch`.
- **No `CNAME` is committed**, deliberately — see step 2.
- **Brand assets are still placeholders.** See the top of this file; this one is contractual.
- **Shape B shares `localStorage` with every other project on `<user>.github.io`.** Bounded by
  the 12 h session TTL, not removed by it. See "What you are accepting" above.
- **`COMPETITION_START` decides which months get downloaded.** A full sync asks Strava for every
  month from `COMPETITION_START`'s month up to the current one, one request each, so backdating it
  is all it takes to have older months filled in — no separate step. But a `COMPETITION_START` in
  the **future** leaves only the current month in that list, and then months before this one are
  never downloaded at all. Set it to when the competition actually began. Editing `wrangler.toml`
  takes effect only after `wrangler deploy`; check with
  `curl -s "$API/api/leaderboard" | jq '.competition.first_month'`.
- **Action versions are `[UNVERIFIED]`** — pinned without network access.
