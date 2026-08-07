# East vs West — Strava Mileage Leaderboard

A mileage competition between two teams, **East** and **West**. Riders sign in with their own
Strava account, the site pulls their rides from the Strava API, and the leaderboard shows which
coast has ridden further, plus a ranked list of individual riders.

**Zero runtime dependencies.** Everything comes from the Node standard library — `node:sqlite`,
`node:http`, `node:crypto`, global `fetch`, `node:test`. There is no `node_modules`, no bundler,
and no build step. Requires **Node 26+**.

---

## The rules

**What counts.** Bike rides only, by Strava `sport_type`:

| Counts | Does not count |
| --- | --- |
| `Ride` | `EBikeRide`, `EMountainBikeRide` (motor assist) |
| `GravelRide` | `Run`, `Walk`, `Swim`, everything else |
| `MountainBikeRide` | Manually-entered rides, unless an admin approves them |
| `VirtualRide` (Zwift and other trainers count) | Rides outside the competition window |

Configurable via `ALLOWED_SPORT_TYPES`. Note the filter is on `sport_type`, not Strava's legacy
`type` field — an `EMountainBikeRide` reports `type: "Ride"`, so filtering on `type` would let
e-bikes onto the board.

**The window.** A ride counts if the calendar date of its `start_date_local` falls within
`[COMPETITION_START, COMPETITION_END]`, inclusive at both ends. Each coast is judged on its own
local calendar day, which is the fair reading of a cross-timezone race: a 6 a.m. ride in Boston
and a 6 a.m. ride in San Francisco land on the same competition day even though they are nine
hours apart in real time.

**Manual rides.** Excluded by default. A manual entry's distance is free text with no device
behind it and no upper bound, so counting them automatically means whoever notices first wins.
They are still recorded and appear in an admin approval list.

**Private rides.** They count toward totals but are never itemized publicly. A rider who
unchecks "private activities" on Strava's consent screen stays fully functional — their public
rides count and their row gets a "public rides only" badge. It is never a lockout.

**Teams.** You pick East or West once, on your first sign-in. After that only an admin can move
you, so nobody can hop to the winning side in the last week.

**Rankings.** Riders with a team but no counted rides appear on the board with 0 miles and no
rank number (an em-dash). At the start of a competition everyone is tied at zero, and a numeric
rank there would just be signup order dressed up as a ranking. Ties break by ride count, then
name, then athlete id.

**Leaving.** `Disconnect` revokes our access at Strava and ends your session, keeping your team
and history so team totals stay consistent. If you revoke access from Strava's own settings
page instead, your total freezes where it was and your row shows a "reconnect" badge rather than
vanishing mid-race.

---

## Setup

```bash
npm run setup
```

That prompts for your Strava Client ID and Client Secret, generates the two local secrets,
asks for your competition dates, writes `.env`, and offers to start the server. Nothing to
install — there are no dependencies.

Before you run it, open <https://www.strava.com/settings/api> and create (or open) an
application. The only setting that matters for local use is:

> **Authorization Callback Domain** = `localhost`

Just the word `localhost` — no `http://`, no port, no path. Strava matches on the domain, so
getting this wrong is the single most common reason the Connect button fails.

The script is safe to re-run: it keeps whatever is already set and never rotates
`TOKEN_ENCRYPTION_KEY`, because changing that key makes every stored Strava token
undecryptable and forces every rider to reconnect.

```bash
npm run setup -- --no-start        # write .env, don't launch
npm run setup -- --reconfigure     # re-prompt for values already set
npm start                          # once .env exists
```

Then open <http://localhost:3000> and click **Connect with Strava**.

<details>
<summary>Doing it by hand instead</summary>

```bash
cp .env.example .env
npm run keygen        # prints SESSION_SECRET and TOKEN_ENCRYPTION_KEY -- paste them in
# add STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET, set COMPETITION_START / COMPETITION_END
npm start
```

</details>

To grant yourself admin, either answer the athlete-ID prompt during setup, or afterwards:

```bash
npm run make-admin -- 12345678
```

Your athlete ID is the number in your Strava profile URL.

### Optional: resolve the Strava API unknowns

This project was built without network access to Strava's documentation, so a handful of API
details are marked `[UNVERIFIED]` in the source. `scripts/strava-probe.mjs` answers them against
a real app — rate-limit headers, whether `per_page=200` is accepted, whether refresh tokens
rotate, and the exact semantics of the `before`/`after` filters:

```bash
npm run probe
```

The code is written to be correct under either reading of each open question, so this is
confirmation rather than a prerequisite.

---

## Tests

```bash
npm test
```

Everything runs offline against an in-process fake Strava and an in-memory database — no
sockets, no network, no fixtures to refresh. (`node --test test/` does not work on Node 26; the
`test` script uses the glob form.)

To regenerate the activity fixture after editing its generator:

```bash
node test/fixtures/build-activities.mjs
```

---

## Layout

```
public/     Static frontend. Plain HTML/CSS/ES modules, no build step.
            Talks only to /api/* -- this directory deploys to GitHub Pages unchanged.
server/     The API. The only place the Strava client secret exists.
  config.js   The only module that reads the environment.
  contracts.js Frozen constants shared across the whole tree.
  db/         SQLite repositories. Every method async, so the D1 port stays small.
  security/   Token encryption, sessions, OAuth state, CSRF.
  strava/     API client (pure HTTP), mapping, token refresh, sync.
  routes/     HTTP surface.
scripts/    keygen, make-admin, reset-db, strava-probe.
test/       node:test suites plus the fake Strava and frozen contract fixtures.
docs/SPEC.md  The full design spec, including every rejected alternative and why.
docs/GOING-LIVE.md  Step-by-step walkthrough for putting this online, in plain language.
docs/DEPLOY.md      The deploy reference: every variable, both hosting shapes, verification.
```

## Security notes

Strava tokens are encrypted at rest with AES-256-GCM. Session tokens are stored only as SHA-256
digests, so a leaked database file yields no usable credentials. The OAuth `state` is signed,
single-use, expiring, **and bound to the browser that started the flow** via an HttpOnly nonce
cookie — signing alone does not stop login CSRF. Full checklist in `docs/SPEC.md`.

The client secret never reaches the browser and is never logged; a test asserts a sentinel secret
appears in no response body and no log line.

## Deploying

**Start here: [`docs/GOING-LIVE.md`](docs/GOING-LIVE.md)** — a step-by-step walkthrough, in plain
language, for the free hosting route. [`docs/DEPLOY.md`](docs/DEPLOY.md) is the reference behind
it, and `node scripts/deploy-setup.mjs --dry-run` shows you every edit before it makes one.

`public/` deploys to GitHub Pages unchanged. The API needs a host that can hold a secret;
Cloudflare Workers + D1 is the target, and the port is written — `server/db/d1.js` and
`server/worker.js`, with `server/index.js` still there for `npm start`.

There are two supported shapes, and the choice changes how sessions work:

- **One registrable domain** (`www.example.com` + `api.example.com`) — recommended. The session
  cookie stays first-party and nothing else changes. This is the only shape where the session
  credential is unreadable by page script.
- **The free hosts** (`user.github.io` + `<worker>.<account>.workers.dev`). These are different
  registrable domains, so the session cookie becomes third-party: Safari's ITP blocks it outright
  and Chrome partitions it. Not a configuration gap — browser policy. This shape therefore runs
  with `AUTH_TOKEN_IN_FRAGMENT=true`, handing the session token over in the callback's URL
  fragment for `localStorage`, with sessions shortened to 12 h. It works, and it costs you
  something real: `localStorage` is keyed per origin, so every other project published on that
  `github.io` account can read the token. `docs/GOING-LIVE.md` spells the trade-off out.

## Strava attribution

The "Connect with Strava" button and "Powered by Strava" logo in `public/assets/` are
**hand-authored placeholders**. Replace them with the official assets from
<https://developers.strava.com/guidelines/> before any public deployment, and do not restyle or
recolour the button — both are conditions of the Strava API Agreement. See
`public/assets/README.md`.
