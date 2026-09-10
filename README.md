# Command Center — a roster desk for your 3 Sleeper leagues

A static, client-side web app (no server, no build step) that pulls live
data from Sleeper's public API for all three of your leagues and helps you:

- **Lineup** — see your mathematically optimal starting lineup for the
  current week, the specific bench-for-starter swaps worth making, and an
  **Injury watch** panel flagging any rostered player carrying a Sleeper
  injury tag, each with the best replacement available from your bench and
  the waiver wire.
- **Waivers** — free agents who project higher than your weakest player
  at the same position, with "trending add" flags.
- **Trade** — pick players from your roster and an opponent's, and see the
  projected value on each side.

Optionally, it can also: blend in a second, independent projection source
(ESPN) and flag how much the two agree; and put an "Ask Claude" research
button on each swap/waiver suggestion. See
[Optional: a Cloudflare Worker unlocks two more features](#optional-a-cloudflare-worker-unlocks-two-more-features)
below.

## Running it

Just open `index.html` in a browser, or better, host it (see below) since
some browsers restrict cross-origin fetches from local `file://` pages.

On first load you'll enter your Sleeper username, it'll list every league
you're in for the current season, and you check off the three you want
tracked (or paste league IDs directly — find one in a league's Sleeper URL,
the long number after `/leagues/`).

Nothing is sent anywhere except directly to Sleeper's own API — there's no
backend, no analytics, no accounts. (If you turn on either of the two
optional features below, requests also go through a small proxy you host
yourself, and from there to ESPN's public API and/or your own Anthropic
account — still no third-party analytics.)

## Hosting on GitHub Pages

1. Create a new repo and push this folder's contents to it (`index.html`,
   `styles.css`, and the `.js` files, all at the repo root — the `worker/`
   folder isn't part of the site itself, see below).
2. In the repo, go to **Settings → Pages**, set the source to your default
   branch, root folder.
3. GitHub gives you a URL like `https://yourname.github.io/reponame/` —
   that's your app, reachable from your phone too.

**After every deploy**, bump the `?v=N` query string on every local file
reference in `index.html` (the CSS, the logo, and each `.js` file) by one.
GitHub Pages doesn't force visitors' browsers to refetch changed files on
its own, so without this a returning visitor can keep seeing old code or
styles indefinitely after you've pushed an update — bumping the version
number changes the URL, which forces a fresh fetch.

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
- Every player's projection is shown alongside two real numbers for
  comparison: their actual score for their **most recently completed
  game**, and their **season average** so far. Both update per-player as
  soon as that player's own game concludes -- a Thursday-night player
  shows fresh numbers by Friday, without waiting for Sunday and Monday's
  games to finish the rest of the week. The average only counts weeks they
  actually played -- a bye week or a game missed to injury doesn't drag it
  down with a false zero, unlike simply averaging whatever a matchup shows
  for that week (which can't tell "didn't play" apart from "played and
  scored zero").
  Early in the season, before a given player has played their first game
  yet, these numbers fall back to **last season's** actuals instead of
  showing nothing -- their most recent game with recorded stats last
  season (not necessarily Week 18, if their season ended earlier) and
  their full season average, labeled with the year so it's never mistaken
  for a current-season number. One honest caveat: a handful of star
  players on teams that had already locked their playoff seeding get
  benched for Week 18, last season's last week, so "last game" can show a
  misleadingly low number for them specifically in that fallback -- that's
  real data (they were active but barely played), not a bug, and it stops
  mattering the moment that player's first game of the new season is in
  the books.
- Reopening the app refreshes its data, including on mobile when the
  browser just resumes a backgrounded tab rather than truly reloading the
  page (the normal way "reopening" works on a phone) -- it listens for the
  tab becoming visible again or being restored from the browser's
  back-forward cache, and refetches if it's been at least a minute since
  the last load, so it doesn't refetch on every brief glance.

## Injury watch

The Lineup tab flags every rostered player carrying a Sleeper injury/status
tag (Questionable, Doubtful, Out, IR, Sus, ...) -- starters first -- with
the body part if Sleeper has it, and the single best replacement available
both from your own bench and from the waiver wire. The bench suggestion
isn't just "the next guy at the same position": it re-runs the full lineup
optimizer with that player pulled out of the pool and reads off whoever
actually gets assigned their vacated slot, so it accounts for ripple
effects across your other flex slots rather than a naive same-position
swap. If neither your bench nor the waiver wire has anything clearly
better, it says so rather than guessing.

This is deliberately separate from the swap suggestions above it: a
"Questionable" tag posted early in the week often hasn't dragged a
player's own projection down yet, so a point-based swap suggestion might
not fire even though this is exactly the situation you'd want a backup
plan for. Each flagged player also gets the same optional "Ask Claude"
research button as swap/waiver suggestions, digging into practice
reports and beat-reporter updates that Sleeper's bare status tag doesn't
carry.

## A third opinion: CBS's consensus rank

Alongside Sleeper's projections, the app always pulls in CBS Sports'
consensus rankings too — no setup needed, since CBS's rankings endpoint
(unlike ESPN's) happens to allow direct cross-origin reads. CBS only
publishes an integer rank per position (e.g. "Ja'Marr Chase, WR #1"), not a
point value, and it's their season-long overall board rather than a
week-specific number — so it's never averaged into the point projection.
Instead, swap and waiver suggestions get a **"CBS agrees" / "CBS disagrees"**
tag when CBS's board has an opinion on that exact same-position comparison,
as a third-opinion tiebreaker alongside the Sleeper/ESPN agreement badge
below.

## Optional: a Cloudflare Worker unlocks two more features

Both of these are off unless you set them up, and the app works exactly as
before if you skip this section entirely. They share one small proxy
([`worker/proxy.js`](worker/proxy.js)) you deploy for free on
[Cloudflare Workers](https://workers.cloudflare.com/):

1. Create a free Cloudflare account, then **Workers & Pages → Create →
   Create Worker**, paste in the contents of `worker/proxy.js`, and deploy.
   Cloudflare gives you a URL like `https://your-worker.your-name.workers.dev`.
2. In the app's **Setup** screen, paste that URL into "Worker proxy URL
   (optional)" and save. This alone turns on ESPN blending (below); Ask
   Claude also needs the API key step under its own heading.

### Blending in ESPN's projections

By default the app ranks players using Sleeper's own projections alone
(plus CBS's rank-based tiebreaker above). This blends in ESPN's independent
projections too — the two get averaged per player, and swap/waiver
suggestions get a badge showing how much the sources agree (**Strong** /
**Mixed** / **Split**), so a suggestion both sources like looks different
from one that's a coin flip.

This only covers QB/RB/WR/TE — kicker and defense scoring differ enough
between the two providers (distance-bucketed field goals, points-allowed
tiers) that translating one into the other would be more misleading than
useful, so K/DEF valuations always stay Sleeper-only regardless of this
setting.

The proxy itself does no filtering or parsing — ESPN's endpoint ignores
every documented filter param and always returns its full player database
(30-40MB), which would blow past a free Worker's per-request CPU budget to
parse server-side. Instead the proxy just streams that response straight
through with CORS headers added, and the browser does the parsing/filtering
client-side (where a payload that size is trivial), caching the result the
same way it already caches Sleeper's player list.

### "Ask Claude" — on-demand research on a suggestion

Once the Worker above is deployed, each swap and waiver suggestion can show
an **Ask Claude** button. Clicking it sends Claude (with live web search
turned on) a question about that specific matchup — current injury status,
snap counts, matchup difficulty, beat-reporter buzz — and shows the answer
right on the card. Nothing runs automatically; it's a real, billed request
only when you click. Answers are cached in your browser per suggestion
(same league, week, and player pair) -- coming back and clicking again
shows the same answer for free instead of spending tokens again, with an
"Ask again" option if you want a fresh, newly-researched one.

This needs its own one-time setup, separate from the Worker deployment
above:

1. Create an [Anthropic](https://console.anthropic.com/) account, add
   billing, and generate an API key.
2. On your Cloudflare Worker: **Settings → Variables and Secrets → Add →
   type "Secret"**, name it exactly `ANTHROPIC_API_KEY`, and paste in the
   key. It's never sent to or visible from the browser — only the Worker
   holds it.

If that secret isn't set, `/claude-assist` just returns an error and the
button shows "Couldn't get an answer" rather than breaking anything else.
Each click costs a few cents on your Anthropic account (model:
`claude-opus-5`, capped at a short answer with up to 6 searches) — see
`worker/proxy.js` if you'd rather point it at a cheaper model.

**Checking what's actually deployed:** visiting the bare Worker URL in a
browser (`GET /`) returns a small JSON status page — a version number
(bumped on every edit to `worker/proxy.js`) and whether it sees your
`ANTHROPIC_API_KEY` secret. Editing the file locally or even committing it
to this repo doesn't change what Cloudflare is running — only pasting it
into the dashboard and clicking Deploy does — so this is the fast way to
confirm a redeploy actually took.

## Structure

```
index.html               shell + markup
styles.css                design system
sleeper-api.js            all Sleeper API calls + caching
player-id-crosswalk.js    maps Sleeper/ESPN/CBS IDs for the same players
espn-api.js               optional ESPN projections (see above)
cbs-api.js                CBS consensus rank, used as a tiebreaker (see above)
claude-assist.js          optional "Ask Claude" research button (see above)
scoring.js                raw stats -> fantasy points, per league's own rules; blends multiple sources
optimizer.js              lineup optimizer, waiver gap-finder, trade comparison
app.js                    state, wiring, rendering
worker/proxy.js           Cloudflare Worker for the two optional features above -- not part of the deployed site
```

Everything the site itself needs is plain JS/CSS/HTML — no npm install, no
framework, so it's easy to open up and tweak (e.g. change the waiver list
length, adjust the recent-average window from 3 weeks to something else,
add IDP slot support if one of your leagues uses defensive players).
