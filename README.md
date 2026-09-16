# Command Center — a roster desk for your 3 Sleeper leagues

A static, client-side web app (no server, no build step) that pulls live
data from Sleeper's public API for all three of your leagues and helps you:

- **Lineup** — see your actual current starting lineup for the week (not a
  hypothetical one), the specific bench-for-starter swaps worth making to
  reach the mathematically optimal lineup, and an **Injury watch** panel
  flagging any rostered player carrying a Sleeper injury tag, each with
  the best replacement available from your bench and the waiver wire.
  Once a player's game for the week is over, their projection on this tab
  flips to their real score — green if they beat it, red if they fell
  short — and the total at the top updates to match. Your current
  matchup opponent's total and starting lineup get the same treatment
  right alongside yours, so you can see how the week's actually shaking
  out on both sides, not just yours. A **lineup lock heads-up** flags it
  when one of your starters kicks off earlier than the rest of the week
  (almost always Thursday night), and an **upcoming bye weeks** list at
  the bottom keeps every rostered player's bye in view before it catches
  you short-handed.
- **Waivers** — free agents who project higher than your weakest player
  at the same position, with "trending add" flags, prioritized by real
  **team need**: how your own players at each position rank against every
  player rostered league-wide, not just against your own weakest guy
  there (every roster has one of those regardless of how deep it actually
  is). A separate **best value** board ranks the strongest free agents on
  the wire by value over replacement, independent of your own roster.
- **Trade** — scans every other roster in your league for a bench player
  who'd clearly upgrade one of your own starters (their own team already
  starts someone better at that position, so it's a plausible ask), plus
  the manual builder: pick players from your roster and an opponent's, and
  see the projected value on each side. See
  [Trade targets across the league](#trade-targets-across-the-league)
  below.
- **Stats** — once Sleeper has posted real stats for a week, your actual
  score against what your starting lineup was projected to score, plus a
  season roll-up: record, points per week, best/worst week, and how often
  you've outscored your own projection. See
  [Stats: how your team's actually doing](#stats-how-your-teams-actually-doing)
  below.

Every player across Lineup, Waivers, and their opponent's lineup can also
carry a **Good matchup**/**Tough matchup** badge (how their actual
opponent's defense has performed against their position all season) and a
**Usage ↑**/**Usage ↓** badge (their touches trending up or down over
their last few games) -- both computed from real box scores, no setup
needed. See
[Matchup and usage-trend badges](#matchup-and-usage-trend-badges) below.

Optionally, it can also: pull in second/third, independent projection
sources (ESPN and FFToday) as reference points and flag how much they
agree with Sleeper's own number; and put an "Ask Claude" research button
on each swap/waiver suggestion and on the trade analyzer. See
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
- **A finished week's projection is a stale pre-game guess, and Sleeper
  can take a day or two to roll its own projections forward** once a
  week's games are actually over. The Lineup tab already sidesteps this
  for your own starters (their shown number flips to their real score as
  soon as their game ends, see "Live scoring" above), but a free agent or
  a trade target isn't anyone's starter, so it has no equivalent unless
  this app does it too. It does: on the **Waivers** and **Trade** tabs
  specifically, any player whose game for the week is already over is
  valued by their real score instead of that week's pre-game projection,
  self-correcting the moment Sleeper's own projections move on to the
  next week. Same root cause, same self-correcting fix on the **Stats**
  tab: a fully-played week folds into the season summary based on real
  NFL game dates, not on whether Sleeper has gotten around to calling it
  a past week yet.
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

## Live scoring on the lineup tab

**Your current lineup** shows each starter's projection right up
until their own game for the week ends -- at that point the number swaps
to their real score instead, colored green if it beat the projection or
red if it fell short (a game still in progress, or not yet started, keeps
showing the plain projection with no color). This is per-player, the same
way the recent-form line above is: a Thursday-night starter shows their
real score by Friday morning without waiting on the rest of the week's
games to finish. The **Projected starting total** at the top of the tab
follows suit, summing real scores in for whichever starters have already
played and projections for the rest -- and relabels itself **Live starting
total** the moment at least one starter's real score is factored in.

**This week's opponent** gets the exact same treatment, shown right next
to your own total and lineup: their current starting lineup (not a
hypothetical one either), each player's projection swapping to their real
score and coloring green/red the moment their game ends, and a total that
relabels itself from projected to live the same way yours does. It's
hidden entirely if there's no opponent this week (a bye in an odd-sized
league).

## Lineup lock and bye weeks

Two smaller, always-on pieces on the Lineup tab, both about not getting
caught out by the calendar rather than about who to start:

**Lineup lock heads-up** looks at your current starters who haven't
played yet this week and flags whoever's kicking off earliest — almost
always a Thursday-nighter buried in an otherwise Sunday-heavy lineup,
easy to forget about while you're still finalizing everyone else. It
only considers starters still to play, so once that Thursday game is
underway the reminder naturally moves on to the next-earliest kickoff
among what's left, and disappears once your whole lineup has played.

**Upcoming bye weeks** lists every rostered player — starters and bench
alike — by which week their NFL team sits out, for the current week and
beyond, so a bye doesn't surprise you the week it hits; you've got a
heads-up to work the waiver wire or a trade first instead. Sleeper
doesn't publish a bye-week schedule directly, so this is worked out from
a full season's worth of weekly projections instead: a bye week's
entries for that team still exist, just with no opponent and no real
projection, which is enough to tell it apart from every other week.
That's an 18-week fetch the first time it's needed each session, cached
for two weeks after that (the NFL doesn't reshuffle its own schedule
mid-season) and shared across all three of your leagues, so it only
happens once, not once per league.

Each week also gets checked for a real lineup gap, not just a bye: it
compares your full roster's best possible lineup against that same
lineup with the week's bye players pulled out, slot for slot. A week
where that actually leaves a starting slot with nobody left eligible for
it gets flagged in red, naming the slot -- "No eligible RB available this
week." A slot the roster was already thin at regardless of anyone's bye
doesn't count; only a slot that would've been filled at full strength and
genuinely can't be anymore triggers it.

For a flagged single-position slot (QB/RB/WR/TE/K/DEF), two ways to fix
it come with the warning: a **1-for-1 swap** -- drop the gapped player
outright for a free agent at that position who isn't themselves on bye
that week -- or a **temp fill-in** -- keep the gapped player, temporarily
cut your least valuable bench spot to open a roster space for that same
free agent, and reverse both moves once the bye week's past. Neither
happens automatically; this app is read-only against your roster, so
both are suggestions to act on yourself in Sleeper, each with the same
Ask Claude research button as any other suggestion in the app. A
FLEX-type gap (several positions' worth of bench out at once) is rare
and ambiguous enough about which single position to fix that it's
flagged without a suggested swap.

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

## Stats: how your team's actually doing

The **Stats** tab tracks your team's real performance, separate from the
forward-looking projections everywhere else in the app. It's built
straight from Sleeper's own matchup data — no setup needed, works the
same as the always-on CBS rank above.

A week shows up here once Sleeper has posted real stats for it at all
(usually by Thursday night's game), with your actual score next to what
your actual starting lineup for that week was projected to score going
in — not today's lineup, whatever you actually had in. The current week
specifically is marked **Live**: it updates as your players finish their
games, same as the Lineup tab, but it's left out of the season summary
above the table until the week is actually over, since a game or two left
to play can still swing a live score by a lot. "Actually over" is judged
from real NFL game dates, not from Sleeper's own idea of the current
week -- which can lag a day or two behind the games themselves finishing
-- so a fully-played week folds into the season summary right away
instead of waiting on Sleeper to catch up.

The season cards roll up every finished week: your record, average points
per week, best and worst week, and how often — and by how much, on
average — you've outscored your own week's projection. Diffs and results
are colored the same green/red convention as the rest of the app: green
when you beat the number, red when you fell short.

## Matchup and usage-trend badges

Two more signals, shown as badges next to a player's name on the Lineup
(both yours and your opponent's), Waivers, and Trade tabs — both computed
entirely from real box scores the app is already pulling in, so they're
always on, no setup needed. Neither has anything to show in the first
week or so of a season; that's real "not enough data yet", not a bug,
and it stops applying as the season goes on.

**Good matchup / Tough matchup** — how many fantasy points a player's
actual opponent this week has allowed to their position, all season,
scored to your own league's settings. Every game any position has played
against an NFL team gets rolled into that team's average, and every team
gets ranked 1-32 against the other 31 at that position. **Good matchup**
means that defense is in the top third of the league at allowing points
to that position; **Tough matchup** means the bottom third. The
unremarkable middle third gets no badge — same judgment call as the CBS
agree/disagree tag, only a real signal is worth calling out. Needs at
least one fully-completed week of stats league-wide before it can rank
anything.

**Usage ↑ / Usage ↓** — a player's touches (targets plus rush attempts)
in their most recent game, compared against their own average over the
games before that this season. A role that's expanding or shrinking
often predicts next week's score better than last week's box score
alone, which is exactly what this is meant to surface before it shows up
in the point totals. Only flags a real swing (roughly a 20% move, and at
least one extra touch, in either direction) — a steady role gets no
badge. Needs at least two of that specific player's own games this
season to have anything to compare.

Hover (or tap, on mobile) either badge to see the actual numbers behind
it — the defense's exact rank and points-per-game for the matchup badge,
the specific touches and snap share for the usage badge.

## Trade targets across the league

The Trade tab's manual builder (pick players from your roster and one
opponent's, see the value on each side) needs you to already have a
specific trade in mind. Above it, **Trade targets across the league**
finds one for you: it checks every other roster's bench — not just the
opponent you happen to have selected — for a player who'd clearly upgrade
one of your own current starters.

"Clearly upgrade" and "available" both come from the same lineup math the
rest of the app already runs: a bench player only shows up here if their
own team's mathematically optimal lineup doesn't have a starting spot for
them either, meaning that team already starts someone at least as good at
that position — this is what makes them a plausible ask rather than that
team's best player at the position. The projected gain has to clear a
real bar (2+ points) over your weakest starter there, so a marginal
same-ish player doesn't clutter the list. Kickers and defenses are left
out entirely; nobody trades for those.

Each card names the other team, shows your starter next to their bench
player and the gain, and has a **Build this trade** button that jumps
straight into the manual builder below with both players already picked
— a starting point to adjust (add more players, change the target) rather
than a take-it-or-leave-it offer. It deliberately doesn't try to guess
what you should send back beyond that one starter: figuring out what the
other manager would actually accept is a judgment call CBS ranks and box
scores can't make for you — that's what the builder and the Ask Claude
button on each card are for.

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

### Blending in ESPN and FFToday's projections

The app always ranks, sorts, and totals players using Sleeper's own
projections — since these are Sleeper leagues, that's the number that
actually determines real scoring, so it's never averaged away with
another source. This setting pulls in ESPN's and FFToday's independent
projections too, purely as second/third opinions: swap/waiver suggestions
get a badge showing how much the sources that have data for a given
player agree with each other (**Strong** / **Mixed** / **Split**), plus a
small, de-emphasized "(blend N)" next to the projection showing what
their average would have been — informational only, never what the app
itself decides anything from.

The Lineup tab's "Your current lineup" and "This week's opponent"
grids (and their totals) can also be switched to show the blend
outright, via a **Sleeper / Blend** toggle that appears once blend data's
available for the week — useful for eyeballing the two side by side.
It's scoped to just those two grids: swap suggestions, waiver targets,
and trade values are always built on plain Sleeper valuation no matter
which mode the toggle is in, and a player who's already played is shown
by their real score either way — only the projection for someone who
hasn't played yet changes with the toggle.

Both only cover QB/RB/WR/TE. ESPN's kicker and defense scoring differs
enough from Sleeper's (distance-bucketed field goals, points-allowed
tiers) that translating one into the other would be more misleading than
useful; FFToday's kicker projection isn't distance-bucketed either, and
it has no real defense projections at all (a rank only, no point value,
so there's nothing to blend). K/DEF valuations always stay Sleeper-only
regardless of this setting.

The ESPN proxy does no filtering or parsing — its endpoint ignores every
documented filter param and always returns its full player database
(30-40MB), which would blow past a free Worker's per-request CPU budget to
parse server-side. Instead the proxy just streams that response straight
through with CORS headers added, and the browser does the parsing/filtering
client-side (where a payload that size is trivial), caching the result the
same way it already caches Sleeper's player list.

FFToday has no JSON API at all — just server-rendered HTML tables, one
page per position (QB/RB/WR/TE). The proxy streams each page through the
same way; the browser parses the actual `<table>` out of it and reads off
each player's raw stat line (completions, yards, TDs, etc.), which gets
scored to your league's own settings exactly like Sleeper's and ESPN's
numbers, rather than trusting FFToday's own displayed point total (which
uses FFToday's own scoring assumptions, not necessarily yours). FFToday
has no player-ID system to match against Sleeper's, so players are
matched by name + team instead — normalized on both sides to absorb
punctuation, accents, and suffixes (Jr./III/etc.), but inherently a
little fuzzier than ESPN's ID-based match; a player who genuinely doesn't
match just doesn't get an FFToday number rather than a wrong one. Since
it's screen-scraped rather than a documented API, it's also the more
fragile of the two sources — a redesign on FFToday's end could break it
until noticed and fixed, unlike ESPN's stable JSON shape.

### "Ask Claude" — on-demand research on a suggestion

Once the Worker above is deployed, each swap and waiver suggestion, and the
trade analyzer's result once you've picked players on both sides, can show
an **Ask Claude** button. Clicking it sends Claude (with live web search
turned on) a question about that specific matchup or trade — current
injury status, snap counts, matchup difficulty, beat-reporter buzz — and
shows the answer right on the card. Nothing runs automatically; it's a
real, billed request only when you click. Answers are cached in your
browser per suggestion (same league, week, and player pair -- or same set
of players on each side, for a trade) -- coming back and clicking again
shows the same answer for free instead of spending tokens again, with an
"Ask again" option if you want a fresh, newly-researched one.

For swap suggestions specifically, Claude is also asked to give its own
point projection for each player based on what it found in its research --
shown as a couple of small gold chips under the answer (e.g. "Claude:
Player Name 14.5 pts"), separate from Sleeper/ESPN/CBS above. This is
Claude's own research-informed guess, not blended into the app's actual
rankings anywhere -- it's there to sanity-check the suggestion against,
not to replace the projection the swap was actually built on.

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
Each click costs roughly a cent or two on your Anthropic account (model:
`claude-sonnet-5`, capped at a short answer with up to 6 searches) — see
`worker/proxy.js` if you'd rather trade speed/cost for more nuance
(`claude-opus-5`) or go faster/cheaper still (`claude-haiku-4-5-20251001`).

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
fftoday-api.js            optional FFToday projections (see above)
cbs-api.js                CBS consensus rank, used as a tiebreaker (see above)
claude-assist.js          optional "Ask Claude" research button (see above)
scoring.js                raw stats -> fantasy points, per league's own rules; blends multiple sources
optimizer.js              lineup optimizer, waiver gap-finder, trade comparison
stats.js                  season/weekly actual-vs-projected performance (see above)
trends.js                 DVP and usage-trend badges (see above)
app.js                    state, wiring, rendering
worker/proxy.js           Cloudflare Worker for the two optional features above -- not part of the deployed site
```

Everything the site itself needs is plain JS/CSS/HTML — no npm install, no
framework, so it's easy to open up and tweak (e.g. change the waiver list
length, adjust the recent-average window from 3 weeks to something else,
add IDP slot support if one of your leagues uses defensive players).
