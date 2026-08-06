# Going live: a step-by-step walkthrough

This is the **guided** version, in plain language, written to be followed top to bottom.

For the reference material — every variable, every trade-off, the full verification battery —
see [`DEPLOY.md`](DEPLOY.md). This doc points at it where the detail matters.

**Route this doc covers:** the free one. No custom domain, no DNS, no registrar. Your site ends
up at `https://<user>.github.io/<repo>/` and your API at
`https://<worker>.<account>.workers.dev`. `DEPLOY.md` calls this **shape B**.

If you later buy a domain, switching is one command — see [Switching to a custom
domain](#switching-to-a-custom-domain-later) at the bottom.

---

## The big picture

The app is two halves, and they have to live in two different places:

| Half | What it does | Where it lives | Cost |
|---|---|---|---|
| The **face** | The page people look at — buttons, colours, the leaderboard table | GitHub Pages | Free |
| The **brain** | Talks to Strava, remembers who is logged in, adds up the miles | Cloudflare Workers + D1 | Free |

The split is forced: GitHub Pages only hands out files that never change, like a photocopier. It
cannot *think*. The brain half has to think, so it goes to Cloudflare.

**The wrinkle with skipping a domain.** The two halves end up at addresses that look unrelated to
a browser — `github.io` and `workers.dev`. Browsers are suspicious of that. Normally a site
proves who you are with a cookie, but Safari flatly refuses to let two unrelated-looking
addresses share one. So instead the app hands the browser a **ticket** it keeps in a pocket
called `localStorage`. That works. It is slightly less safe than a cookie, and
[the trade-off](#the-one-trade-off-you-are-accepting) is spelled out at the bottom — read it
before you invite anyone else in.

---

## Before you start

You need:

- **Node 26 or newer** (`node --version`). The project has zero npm dependencies.
- **A Strava API application** — <https://www.strava.com/settings/api>. You should already have
  one from local development; its Client ID and Client Secret are what you will need.
- **A GitHub account** with this repo pushed to it.
- **A free Cloudflare account** — step 1 below.

Everything is run from the repository root.

---

## Step 1 — Cloudflare account, and find your subdomain

Do this **first**. The script in step 2 has to know your Cloudflare address, and getting it right
now saves a redo.

1. Sign up free at <https://dash.cloudflare.com>.
2. Go to **Workers & Pages**.
3. Find your **subdomain** — a word Cloudflare assigned to your account. Write it down.

> **Why this matters.** Your API's address will be `<worker-name>.<subdomain>.workers.dev`. That
> address gets baked into `public/config.js`, the page's Content-Security-Policy, and
> `API_BASE_URL`. Changing it later means re-running step 2 with `--force`.
>
> The subdomain is **per Cloudflare account** and has nothing to do with your GitHub username,
> even though they are often the same word. Check, don't assume.

## Step 2 — Run the setup script

Look before you leap:

```bash
node scripts/deploy-setup.mjs --default-hosts --dry-run
```

`--dry-run` shows what it *would* change and writes nothing. Check that the API address it prints
matches the subdomain from step 1. Then run it for real:

```bash
node scripts/deploy-setup.mjs --default-hosts
```

If the subdomain was different from the guess, say so:

```bash
node scripts/deploy-setup.mjs --default-hosts --workers-subdomain YOUR-REAL-SUBDOMAIN
```

The script works out your GitHub user, repo name, and sub-path from your `origin` git remote.
Override any of it with `--github-user`, `--repo`, `--worker-name`, `--web-base-path`.

**What it changes:**

| File | Why |
|---|---|
| `public/config.js` | Tells the face half where the brain half lives |
| `public/index.html` + `public/404.html` | Widens the page's security policy to allow talking to it |
| `wrangler.toml` | Created — Cloudflare's configuration |
| `public/CNAME` | **Deleted** if present. A CNAME naming a domain you are not serving from makes Pages serve *nothing at all* |

> ### ⚠️ Copy the two secrets it prints
>
> At the end the script prints a fresh `SESSION_SECRET` and `TOKEN_ENCRYPTION_KEY`. **Paste them
> into a note now.** They are not written to any file, and re-running the script prints different
> ones. You need them in step 6.
>
> Once riders have signed in, changing `TOKEN_ENCRYPTION_KEY` forces every one of them to
> reconnect to Strava.

The script also prints a "still to do" checklist. It is the same ground as steps 3–8 here.

## Step 3 — Check the tests, then push

```bash
npm test
git add -A
git commit -m "Configure deploy for GitHub Pages and workers.dev hosts"
git push
```

The `npm test` is not ceremony — the suite contains a `DEPLOY GUARD` test that fails if
`public/config.js` and the page's security policy disagree about the API address. That
disagreement is otherwise invisible: the browser silently refuses every request with no error
status to look at. The GitHub Actions workflow runs the same suite and refuses to publish if it
fails.

## Step 4 — Turn on GitHub Pages

On GitHub: **your repo → Settings → Pages**.

1. Set **Source** to **GitHub Actions**.
2. Leave **Custom domain** empty. That is the whole point of this route — a domain there breaks
   it.

**Do this before, or immediately after, the push in step 3.** Two reasons, and both produce
confusing symptoms:

- While Source is **Deploy from a branch** (the default), Pages runs Jekyll over the repository
  *root* and publishes `README.md` as your homepage. It never looks inside `public/`. So an
  un-switched repo shows you the README and looks like the app is broken when nothing has
  deployed at all.
- The workflow's final step needs Pages to already be in GitHub Actions mode. If it runs first it
  fails at the deploy step. Re-run it from the **Actions** tab → *Deploy public/ to GitHub Pages*
  → **Run workflow** (the workflow has `workflow_dispatch` for exactly this).

HTTPS is automatic on `github.io`, so there is no "Enforce HTTPS" box to wait for.

## Step 5 — Look at your site

Give it two or three minutes, then open:

```
https://<your-user>.github.io/<your-repo>/
```

You should see the page. **"Connect with Strava" will not work yet** — the brain half does not
exist. That is correct at this stage, not a mistake.

## Step 6 — Install Cloudflare's tool and set up the database

```bash
npm install --save-dev wrangler
npx wrangler login
```

> **If the install fails with a 401:** this machine's npm is pointed at an internal registry whose
> saved password has expired. This project ships its own `.npmrc` pointing at the public registry,
> which should sidestep it. If it does not, that is the thing to fix first — the error will say so.

Create the database. The first command prints a long `database_id`; **paste it into
`wrangler.toml`** where it says `REPLACE_WITH_THE_ID_FROM_wrangler_d1_create`:

```bash
npx wrangler d1 create bike-comp
npx wrangler d1 migrations apply bike-comp --remote
```

The second command builds the tables from `server/migrations/`.

> If it says **"no migrations folder found / no migrations present at …/migrations"**, your
> `wrangler.toml` is missing `migrations_dir = "server/migrations"` inside the
> `[[d1_databases]]` block. wrangler looks for `./migrations` next to `wrangler.toml` by default,
> and this project keeps them under `server/`. Regenerate with
> `node scripts/deploy-setup.mjs --default-hosts --force`, or just add the line by hand — then
> re-paste your `database_id`, because `--force` rewrites the file.

Now hand over the three secrets. Each command prompts you to paste a value:

```bash
npx wrangler secret put STRAVA_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

The first is from your Strava app settings. The other two are from the note you made in step 2.

> Pasted at the prompt, never as a command argument — an argument would land in your shell
> history. These three are the only values that never go in `wrangler.toml`, because that file is
> committed to git.

## Step 7 — Tell Strava where to send people

At <https://www.strava.com/settings/api>, set **Authorization Callback Domain** to your API host
and nothing else:

```
<worker>.<account>.workers.dev
```

No `https://`, no slash, no path. Strava matches on the domain alone.

> If that field only accepts one domain and you still want local development to work, make a
> **second** Strava app for `localhost` and put its credentials in your local `.env`.

## Step 8 — Deploy the brain

```bash
npx wrangler deploy
```

Then check it answers:

```bash
curl -s https://<worker>.<account>.workers.dev/api/health
```

You want `{"ok":true,"schema":2,...}`.

If this is where things break, that is not a surprise — see
[If something goes wrong](#if-something-goes-wrong).

## Step 9 — Check it actually works

Open your site and walk through it in this order. Each step proves a different thing, so do them
in sequence rather than skipping to the end.

1. **Open the browser console.** No security-policy complaints about your API address → step 2's
   edits landed.
2. **Click Connect, approve on Strava.** You should land back on your site, signed in.
3. **Reload the page. Still signed in?** This is the important one. It proves the ticket handoff
   worked. If you are signed out here, the ticket never arrived — see below.
4. **Check the address bar.** No `#token=...` left in it. The app reads it once and scrubs it.
5. **Pick a team, then hit Refresh.** Miles should appear. A `403` here means the ticket is not
   being accepted on writes.
6. **Switch months** in the picker.
7. **Open a deep link** — `https://<user>.github.io/<repo>/anything`. The app should render.

The full curl-level battery, including the cross-origin preflight check, is in
[`DEPLOY.md` § 3](DEPLOY.md).

---

## If something goes wrong

`npx wrangler tail` streams your Worker's logs live. Almost every answer is there.

| Symptom | Most likely cause |
|---|---|
| **Site shows this repo's README** instead of the app | Pages is set to **Deploy from a branch**, not **GitHub Actions**. In branch mode Jekyll builds the repo *root* and turns `README.md` into the homepage; it never looks in `public/`. Fix step 4. Also check the workflow is actually pushed: `git ls-files .github/` must not be empty |
| Site 404s after switching Source to GitHub Actions | The workflow has not run yet, or its deploy step failed while Pages was still in branch mode. Actions tab → *Deploy public/ to GitHub Pages* → **Run workflow** |
| Site loads, "Connect" does nothing, console complains about the API address | `public/config.js` and the page's security policy disagree. Re-run step 2, then `npm test` |
| `curl /api/health` returns Cloudflare **Error 1101** | The Worker crashed on startup. `npx wrangler tail` and redeploy — usually a missing secret or a `database_id` still set to the placeholder |
| Health works, but signing in returns a Strava error | Callback Domain in step 7 does not exactly match your API host |
| Signed in, but **reload signs you out** | The `#token=` handoff is not happening. Check `AUTH_TOKEN_IN_FRAGMENT = "true"` in `wrangler.toml`, then redeploy |
| Everything works until you **pick a team**, then `403 csrf_failed` | The request is not carrying its ticket. Check the browser is sending `Authorization: Bearer …` on that POST |
| Login redirects you to a GitHub **404 page** | `WEB_BASE_PATH` is wrong. It must be `/<your-repo>`, with no trailing slash |
| Worker returns `500` on every route | Config rejected at boot. `npx wrangler tail` names the variable |
| `wrangler d1 migrations apply` says **no migrations present at `<root>/migrations`** | `migrations_dir = "server/migrations"` is missing from the `[[d1_databases]]` block in `wrangler.toml` |

> **Worth knowing:** the D1 and Worker adapters are covered by 29 tests here, but they have
> **never run against real Cloudflare infrastructure** — no test on your machine can prove
> Cloudflare's crypto behaves the way the token encryption needs. Step 8 is genuinely the first
> real test. If something breaks, this is the likeliest place.

---

## The one trade-off you are accepting

The "ticket in a pocket" from the top. That pocket belongs to the **whole address**
`<user>.github.io` — not to this project.

So **any other project you ever publish to GitHub Pages on that account can read a signed-in
rider's ticket**, including yours as an admin. Not a hypothetical: `localStorage` is keyed per
origin with no path component, so a vendored third-party script in some unrelated project you put
up two years from now is inside the same pocket.

Tickets expire after 12 hours to limit the damage. That bounds it; it does not fix it.

Right now, with one project on that account, there is nothing to worry about. **The risk appears
silently the day you publish a second thing and forget about this.**

### Switching to a custom domain later

A domain (~$10/year) is the actual fix: both halves land on related addresses, cookies work
normally, and none of the above applies. Switching is one command plus DNS:

```bash
node scripts/deploy-setup.mjs --web-host www.yourdomain.com --api-host api.yourdomain.com --force
```

Then follow **shape A** in [`DEPLOY.md`](DEPLOY.md) — it adds a DNS step and a Pages custom-domain
step, and drops the ticket business entirely.

Starting free and switching later is a perfectly reasonable plan. Just make the choice knowingly.

---

## Still outstanding, unrelated to hosting

**The Strava logos are placeholders.** `public/assets/btn-strava-connect.svg` and
`powered-by-strava.svg` were drawn by hand. Publishing them breaks the Strava API Agreement.

Before you share the site with anyone, download the official artwork from
<https://developers.strava.com/guidelines/> and replace both files byte-for-byte. Do not restyle,
recolour, re-trace, or reword the button — that is also a condition of the agreement. See
`public/assets/README.md`.

This is a licence obligation, not a nice-to-have. It is the one item on this page that has
consequences outside your own project.
