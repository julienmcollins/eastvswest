# public/assets — Strava brand assets

## STOP: two of these files are PLACEHOLDERS. Replace them before any public deployment.

| File | Status | What it must become |
|---|---|---|
| `btn-strava-connect.svg` | **PLACEHOLDER — hand-authored** | The official **"Connect with Strava"** button asset, downloaded unmodified from <https://developers.strava.com/guidelines/> |
| `powered-by-strava.svg` | **PLACEHOLDER — hand-authored** | The official **"Powered by Strava"** logo, downloaded unmodified from <https://developers.strava.com/guidelines/> |
| `avatar-fallback.svg` | ours, fine as-is | Local fallback for a photo-less athlete. Not a Strava asset. |
| `favicon.svg` | ours, fine as-is | Site icon. Not a Strava asset. |

The two placeholders were hand-authored because the network to `developers.strava.com`
is blocked in the environment this project was built in. They use the correct Strava
orange (`#FC5200`) and approximately the correct proportions so that layout, sizing and
clear-space work is not wasted, **but they are not the official artwork and shipping them
publicly is a breach of the Strava API Agreement.**

### Replacement procedure

1. Open <https://developers.strava.com/guidelines/> and download the brand asset pack.
2. Overwrite `btn-strava-connect.svg` and `powered-by-strava.svg` with the official files,
   **byte-for-byte unmodified**. Do not re-export, re-colour, re-trace, or minify them.
3. Check the rendered sizes in `styles.css` against the minimum size and clear-space rules
   in the guidelines, and adjust only the CSS — never the asset.
4. Delete this warning section and the corresponding comment block in `index.html`.

### Rules that survive the replacement

- **The "Connect with Strava" button must not be restyled or recoloured.** No CSS
  `filter`, no `background`, no border-radius override, no swapping the wordmark, no
  translating the text. `styles.css` therefore only ever sets its box size and hover
  opacity, and the button is an `<img>` so no stylesheet can reach inside it.
- **"Powered by Strava" must be visible without interaction** on any view that shows
  Strava data. In this app it lives in the page footer of the leaderboard view, rendered
  on first paint — never behind a tab, an accordion, a hover, or a scroll-triggered
  reveal.
- Every rider deep-links back to their Strava profile
  (`https://www.strava.com/athletes/<id>`), `target="_blank" rel="noopener noreferrer"`.
- Strava data is never used to train machine-learning models.
