# Command Center — a roster desk for your 3 Sleeper leagues

A static, client-side web app (no server, no build step) that pulls live
data from Sleeper's public API for all three of your leagues and helps you:

- **Lineup** — see your mathematically optimal starting lineup for the
  current week, and the specific bench-for-starter swaps worth making.
- **Waivers** — free agents who project higher than your weakest player
  at the same position, with "trending add" flags.
- **Trade** — pick players from your roster and an opponent's, and see the
  projected value on each side.

Optionally, it can blend in a second, independent projection source (ESPN)
alongside Sleeper's and flag how much the two agree — see
[Optional: blending in ESPN's projections](#optional-blending-in-espns-projections) below.

## Running it

Just open `index.html` in a browser, or better, host it (see below) since
some browsers restrict cross-origin fetches from local `file://` pages.

On first load you'll enter your Sleeper username, it'll list every league
you're in for the current season, and you check off the three you want
tracked (or paste league IDs directly — find one in a league's Sleeper URL,
the long number after `/leagues/`).

Nothing is sent anywhere except directly to Sleeper's own API — there's no
backend, no analytics, no accounts. (If you turn on the optional ESPN
blending below, projection requests also go through a small proxy you host
yourself, and from there to ESPN's public API — still no third-party
analytics or accounts involved.)

## Hosting on GitHub Pages

1. Create a new repo and push this folder's contents to it (`index.html`,
   `styles.css`, and the `.js` files, all at the repo root — the `worker/`
   folder isn't part of the site itself, see below).
2. In the repo, go to **Settings → Pages**, set the source to your default
   branch, root folder.
3. GitHub gives you a URL like `https://yourname.github.io/reponame/` —
   that's your app, reachable from your phone too.

## Honest notes on data reliability

- **Rosters, matchups, users, and league settings** come from Sleeper's
  official, documented API (`docs.sleeper.com`) and are reliable.
- **Weekly projections** come from an endpoint Sleeper's own web app uses
  internally but doesn't officially document or guarantee. It usually
  works fine, but if Sleeper ever changes or blocks it, the app
  automatically falls back to ranking players by their **actual scoring
  average over their last 3 games** (pulled from the official matchups
  data) instead of a forward-looking projection. The status line under the
  tab bar always tells you which one you're looking at.
- The lineup optimizer uses a greedy assignment (fill the most
  restrictive slots — QB, RB, WR, TE, K, DEF — first, then FLEX/SUPERFLEX
  slots with whoever's left). This matches the optimal lineup in the vast
  majority of real rosters, but in rare edge cases with several overlapping
  flex slots it can be a fraction of a point off true optimal.
- Points are calculated using **each league's own scoring settings**
  (custom TD values, PPR/half-PPR/standard, TE premium, etc.) rather than
  a generic PPR assumption, so the numbers should match what your league
  actually pays out.

## Optional: blending in ESPN's projections

By default the app ranks players using Sleeper's own projections alone. You
can optionally blend in ESPN's independent projections too — the two get
averaged per player, and swap/waiver suggestions get a badge showing how
much the sources agree (**Strong** / **Mixed** / **Split**), so a suggestion
both sources like looks different from one that's a coin flip.

This only covers QB/RB/WR/TE — kicker and defense scoring differ enough
between the two providers (distance-bucketed field goals, points-allowed
tiers) that translating one into the other would be more misleading than
useful, so K/DEF valuations always stay Sleeper-only regardless of this
setting.

It's off unless you set it up, and the app works exactly as before if you
skip this section entirely:

1. ESPN's projections endpoint doesn't send the CORS headers a browser
   needs to read it directly, so it has to go through a small proxy. Create
   a free [Cloudflare Workers](https://workers.cloudflare.com/) account,
   then **Workers & Pages → Create → Create Worker**, paste in the contents
   of [`worker/espn-proxy.js`](worker/espn-proxy.js), and deploy. Cloudflare
   gives you a URL like `https://your-worker.your-name.workers.dev`.
2. In the app's **Setup** screen, paste that URL into "ESPN proxy URL
   (optional)" and save.

The proxy itself does no filtering or parsing — ESPN's endpoint ignores
every documented filter param and always returns its full player database
(30-40MB), which would blow past a free Worker's per-request CPU budget to
parse server-side. Instead the proxy just streams that response straight
through with CORS headers added, and the browser does the parsing/filtering
client-side (where a payload that size is trivial), caching the result the
same way it already caches Sleeper's player list.

## Structure

```
index.html            shell + markup
styles.css             design system
sleeper-api.js         all Sleeper API calls + caching
espn-api.js             optional ESPN projections + player-ID crosswalk (see above)
scoring.js              raw stats -> fantasy points, per league's own rules; blends multiple sources
optimizer.js            lineup optimizer, waiver gap-finder, trade comparison
app.js                  state, wiring, rendering
worker/espn-proxy.js    Cloudflare Worker for the optional ESPN blending -- not part of the deployed site
```

Everything the site itself needs is plain JS/CSS/HTML — no npm install, no
framework, so it's easy to open up and tweak (e.g. change the waiver list
length, adjust the recent-average window from 3 weeks to something else,
add IDP slot support if one of your leagues uses defensive players).
