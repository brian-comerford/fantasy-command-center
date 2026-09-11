/* App state, wiring, and rendering. Vanilla JS, no build step, so this can
 * be pushed straight to GitHub Pages as-is. */

const PROJECTION_MODE_KEY = 'fcc_projection_mode_v1';

const state = {
  username: null,
  userId: null,
  leagues: [],           // [{ id, name }]
  activeLeagueId: null,
  leagueData: {},         // leagueId -> { league, rosters, users, myRoster, playerMeta, valuation, agreement, week, season, projSource, rosteredIds, trendingIds }
  candidateLeagues: [],   // during setup, leagues found for the username
  selectedCandidates: new Set(),
  workerProxyUrl: null,
  trade: { opponentRosterId: null, sideA: new Set(), sideB: new Set() },
  // 'sleeper' or 'blend' -- which projection the Lineup tab's two rosters
  // (yours and this week's opponent) and their totals are shown/scored
  // against. Sleeper's own number is still what every recommendation
  // elsewhere in the app (swaps, waivers, trades) is built on regardless
  // of this toggle -- see effectiveValuation.
  projectionMode: (() => {
    try { return localStorage.getItem(PROJECTION_MODE_KEY) === 'blend' ? 'blend' : 'sleeper'; } catch (e) { return 'sleeper'; }
  })(),
};

const STORAGE_KEY = 'fcc_setup_v1';

function el(id) { return document.getElementById(id); }
function showLoading(text) { el('loadingText').textContent = text; el('loadingOverlay').classList.remove('hidden'); }
function hideLoading() { el('loadingOverlay').classList.add('hidden'); }

function loadSavedSetup() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) { return null; }
}

function saveSetup() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    username: state.username,
    userId: state.userId,
    leagues: state.leagues,
    workerProxyUrl: state.workerProxyUrl,
  }));
}

/* ---------------- Setup flow ---------------- */

function initSetup() {
  el('findLeaguesBtn').addEventListener('click', onFindLeagues);
  el('manualEntryToggle').addEventListener('click', () => {
    el('manualEntry').classList.toggle('hidden');
  });
  el('addManualLeagueBtn').addEventListener('click', onAddManualLeague);
  el('saveSetupBtn').addEventListener('click', onSaveSetup);
  el('settingsBtn').addEventListener('click', () => {
    el('workerProxyInput').value = state.workerProxyUrl || '';
    renderSelectedLeagues();
    el('setupPanel').classList.remove('hidden');
    el('dashboard').classList.add('hidden');
  });
}

async function onFindLeagues() {
  const username = el('usernameInput').value.trim();
  if (!username) return;
  showLoading('Looking up your Sleeper account…');
  try {
    const user = await SleeperAPI.getUser(username);
    if (!user || !user.user_id) throw new Error('User not found');
    state.username = username;
    state.userId = user.user_id;
    const nflState = await SleeperAPI.getNflState();
    const season = nflState.league_season || nflState.season;
    const leagues = await SleeperAPI.getUserLeagues(user.user_id, season);
    state.candidateLeagues = leagues;
    renderLeagueChecklist();
  } catch (e) {
    alert(`Couldn't find that Sleeper user: ${e.message}`);
  } finally {
    hideLoading();
  }
}

function renderLeagueChecklist() {
  const container = el('leagueChecklist');
  container.innerHTML = '';
  if (!state.candidateLeagues.length) {
    container.innerHTML = '<p class="muted">No leagues found for this season on that account.</p>';
    return;
  }
  state.candidateLeagues.forEach(lg => {
    const row = document.createElement('label');
    row.className = 'league-check-item';
    row.innerHTML = `<input type="checkbox" data-id="${lg.league_id}" data-name="${lg.name}"> ${lg.name}`;
    row.querySelector('input').addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      const name = e.target.dataset.name;
      if (e.target.checked) addSelectedLeague(id, name);
      else removeSelectedLeague(id);
    });
    container.appendChild(row);
  });
}

function addSelectedLeague(id, name) {
  if (state.leagues.find(l => l.id === id)) return;
  state.leagues.push({ id, name });
  renderSelectedLeagues();
}

function removeSelectedLeague(id) {
  state.leagues = state.leagues.filter(l => l.id !== id);
  renderSelectedLeagues();
}

function renderSelectedLeagues() {
  const container = el('selectedLeagues');
  container.innerHTML = '';
  state.leagues.forEach(lg => {
    const chip = document.createElement('div');
    chip.className = 'selected-league-chip';
    chip.innerHTML = `<span>${lg.name}</span>`;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'link-btn';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => removeSelectedLeague(lg.id));
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  });
  el('saveSetupBtn').classList.toggle('hidden', state.leagues.length === 0);
}

async function onAddManualLeague() {
  const id = el('manualLeagueId').value.trim();
  if (!id) return;
  showLoading('Fetching league…');
  try {
    const league = await SleeperAPI.getLeague(id);
    if (!league || !league.league_id) throw new Error('League not found');
    addSelectedLeague(league.league_id, league.name);
    el('manualLeagueId').value = '';
  } catch (e) {
    alert(`Couldn't load that league ID: ${e.message}`);
  } finally {
    hideLoading();
  }
}

function onSaveSetup() {
  state.workerProxyUrl = el('workerProxyInput').value.trim() || null;
  saveSetup();
  el('setupPanel').classList.add('hidden');
  el('dashboard').classList.remove('hidden');
  bootDashboard();
}

/* ---------------- Dashboard boot ---------------- */

async function bootDashboard() {
  renderLeagueTabs();
  if (!state.activeLeagueId && state.leagues.length) state.activeLeagueId = state.leagues[0].id;
  await ensureLeagueLoaded(state.activeLeagueId);
  renderActiveTabContent();
}

function renderLeagueTabs() {
  const nav = el('leagueTabs');
  nav.innerHTML = '';
  state.leagues.forEach(lg => {
    const btn = document.createElement('button');
    btn.className = 'league-tab-btn' + (lg.id === state.activeLeagueId ? ' active' : '');
    btn.textContent = lg.name;
    btn.addEventListener('click', async () => {
      state.activeLeagueId = lg.id;
      renderLeagueTabs();
      showLoading(`Loading ${lg.name}…`);
      await ensureLeagueLoaded(lg.id);
      hideLoading();
      renderActiveTabContent();
    });
    nav.appendChild(btn);
  });
}

async function ensureLeagueLoaded(leagueId, forceRefresh = false) {
  if (state.leagueData[leagueId] && !forceRefresh) return;
  showLoading('Pulling rosters and projections…');
  try {
    await loadLeagueData(leagueId);
  } catch (e) {
    console.error(e);
    el('statusLine').textContent = `Error loading league data: ${e.message}`;
  } finally {
    hideLoading();
  }
}

async function loadLeagueData(leagueId) {
  const [league, rosters, users, nflState, playerMeta, trendingAdds, cbsRanks] = await Promise.all([
    SleeperAPI.getLeague(leagueId),
    SleeperAPI.getRosters(leagueId),
    SleeperAPI.getLeagueUsers(leagueId),
    SleeperAPI.getNflState(),
    SleeperAPI.getPlayersTrimmed(),
    SleeperAPI.getTrendingAdds().catch(() => []),
    CbsAPI.getSleeperRanks().catch(e => { console.warn('CBS rankings unavailable, continuing without that signal.', e); return {}; }),
  ]);

  const season = league.season;
  const week = nflState.display_week || nflState.week || 1;

  const myRoster = rosters.find(r => r.owner_id === state.userId) || rosters[0];

  let sleeperValuation = {};
  let projSource = 'projection';
  const [projections, matchups] = await Promise.all([
    SleeperAPI.getWeeklyProjections(season, week).catch(() => null),
    SleeperAPI.getMatchups(leagueId, week).catch(() => []),
  ]);
  if (projections && Object.keys(projections).length) {
    sleeperValuation = Scoring.projectedPointsForLeague(projections, league.scoring_settings || {});
  } else {
    projSource = 'recent-average';
    sleeperValuation = await SleeperAPI.getRecentAveragePoints(leagueId, week, 3);
  }

  // This week's opponent, for the "opponent's total" callout on the
  // Lineup tab -- null if the matchup fetch failed or this roster has no
  // pairing this week (a bye, in an odd-sized league). Their starters
  // come straight from the matchup entry, same shape as myRoster.starters,
  // so they can run through Optimizer.currentLineup exactly like our own.
  let opponent = null;
  const myMatchup = matchups.find(t => t.roster_id === myRoster.roster_id);
  if (myMatchup && myMatchup.matchup_id != null) {
    const oppMatchup = matchups.find(t => t.matchup_id === myMatchup.matchup_id && t.roster_id !== myRoster.roster_id);
    if (oppMatchup) {
      const oppRoster = rosters.find(r => r.roster_id === oppMatchup.roster_id);
      const oppUser = oppRoster ? users.find(u => u.user_id === oppRoster.owner_id) : null;
      opponent = {
        name: oppUser ? (oppUser.metadata?.team_name || oppUser.display_name) : `Team ${oppMatchup.roster_id}`,
        starters: oppMatchup.starters || [],
        players: oppRoster ? (oppRoster.players || []) : [],
      };
    }
  }

  // ESPN and FFToday projections are optional second/third opinions (see
  // espn-api.js and fftoday-api.js) -- only pulled in when the projection
  // source is live projections (not the recent-average fallback, which
  // isn't really comparable) and only for players each of them actually
  // projects (QB/RB/WR/TE for both -- K/DEF scoring differs too much
  // between providers, or FFToday just doesn't have a real projection for
  // them at all, to translate meaningfully).
  //
  // `valuation` -- the number this entire app ranks, sorts, and totals
  // off -- stays Sleeper's own projection always, never the blended
  // average. These are Sleeper leagues, so Sleeper's own number is the
  // one that actually determines real scoring; the other sources' opinions
  // are useful context, not a replacement. The blended average is still
  // computed across however many sources actually have data for a given
  // player, kept in `blendedValuation`, shown as a small secondary note
  // next to the main number wherever the agreement badge already appears
  // -- informational only, nothing here reads it for a decision.
  let valuation = sleeperValuation;
  let blendedValuation = {};
  let agreement = {};
  let usedEspn = false;
  let usedFFToday = false;
  if (projSource === 'projection' && state.workerProxyUrl) {
    const blendSources = [{ name: 'Sleeper', points: sleeperValuation }];
    try {
      const espnStats = await EspnAPI.getWeeklyProjections(state.workerProxyUrl, season, week);
      if (espnStats && Object.keys(espnStats).length) {
        blendSources.push({ name: 'ESPN', points: Scoring.projectedPointsForLeague(espnStats, league.scoring_settings || {}) });
        usedEspn = true;
      }
    } catch (e) {
      console.warn('ESPN proxy unavailable, continuing without it.', e);
    }
    try {
      const fftodayStats = await FFTodayAPI.getWeeklyProjections(state.workerProxyUrl, season, week, playerMeta);
      if (fftodayStats && Object.keys(fftodayStats).length) {
        blendSources.push({ name: 'FFToday', points: Scoring.projectedPointsForLeague(fftodayStats, league.scoring_settings || {}) });
        usedFFToday = true;
      }
    } catch (e) {
      console.warn('FFToday proxy unavailable, continuing without it.', e);
    }
    if (blendSources.length > 1) {
      const blend = Scoring.blendValuations(blendSources);
      blendedValuation = blend.blended;
      agreement = blend.agreement;
    }
  }

  // Actual scoring history, for comparison against the projection above --
  // each player's most recently completed game plus a season average that
  // only counts weeks they actually played (see getActualWeeklyStats).
  //
  // This is per-player, not gated by whether the whole week is over: it
  // includes the current, possibly-in-progress week, so a player whose
  // game already happened (e.g. Thursday night) shows that result right
  // away rather than waiting for Sunday/Monday's games to finish too. The
  // current week's fetch uses a short cache TTL for exactly that reason --
  // its data can still change over the course of the week -- while
  // earlier, fully-settled weeks use the normal long TTL.
  let lastWeekPoints = {};
  let seasonAvgPoints = {};
  let seasonGamesPlayed = {};
  // This week's actual points specifically, keyed by player -- distinct
  // from lastWeekPoints above, which can reach back to an earlier week for
  // a player who hasn't played yet this week. Used to swap a starter's
  // projection for their real score, live, as soon as their game ends.
  let currentWeekActualPoints = {};
  const CURRENT_WEEK_TTL_MS = 15 * 60 * 1000;
  try {
    const weekNumbers = Array.from({ length: week }, (_, i) => i + 1);
    const weekStatsList = await Promise.all(
      weekNumbers.map(w => SleeperAPI.getActualWeeklyStats(season, w, w === week ? CURRENT_WEEK_TTL_MS : undefined))
    );

    const currentWeekStats = weekStatsList[weekStatsList.length - 1];
    currentWeekActualPoints = Scoring.projectedPointsForLeague(currentWeekStats, league.scoring_settings || {});

    const sums = {};
    for (let i = weekStatsList.length - 1; i >= 0; i--) {
      const weekPoints = Scoring.projectedPointsForLeague(weekStatsList[i], league.scoring_settings || {});
      for (const [pid, pts] of Object.entries(weekPoints)) {
        if (!(pid in lastWeekPoints)) lastWeekPoints[pid] = pts;
        sums[pid] = (sums[pid] || 0) + pts;
        seasonGamesPlayed[pid] = (seasonGamesPlayed[pid] || 0) + 1;
      }
    }
    for (const pid of Object.keys(sums)) {
      seasonAvgPoints[pid] = Math.round((sums[pid] / seasonGamesPlayed[pid]) * 100) / 100;
    }
  } catch (e) {
    console.warn('Could not compute actual-performance history, continuing without it.', e);
  }

  // DVP (defense vs. position) and per-player usage-trend tracking -- see
  // trends.js. Both need at least one fully-completed week of stats
  // league-wide, so only weeks 1..week-1 (never the current, possibly
  // still-in-progress week -- same reasoning the Stats tab's season
  // summary uses). getActualWeeklyStatsRaw is a cache hit here for any
  // week the actual-performance-history block above already fetched --
  // same cache key, just keeping the opponent/team fields that reduction
  // discards.
  let dvp = {};
  let usageTrends = {};
  let teamOpponentThisWeek = {};
  let teamDateThisWeek = {};
  try {
    const completedWeekNumbers = Array.from({ length: week - 1 }, (_, i) => i + 1);
    const completedWeekEntries = await Promise.all(
      completedWeekNumbers.map(w => SleeperAPI.getActualWeeklyStatsRaw(season, w))
    );
    dvp = Trends.computeDvp(completedWeekEntries, playerMeta, league.scoring_settings || {});

    const gamesByPlayer = {};
    completedWeekEntries.forEach((entries, i) => {
      entries.forEach(entry => {
        if (!entry.stats.off_snp) return; // only games they actually took an offensive snap in
        if (!gamesByPlayer[entry.player_id]) gamesByPlayer[entry.player_id] = [];
        gamesByPlayer[entry.player_id].push({ week: completedWeekNumbers[i], stats: entry.stats });
      });
    });
    for (const [pid, games] of Object.entries(gamesByPlayer)) {
      const trend = Trends.computeUsageTrend(games);
      if (trend && trend.direction !== 'steady') usageTrends[pid] = trend;
    }
  } catch (e) {
    console.warn('Could not compute DVP/usage trends, continuing without them.', e);
  }

  // This week's opponent (and game date) per NFL team -- opponent backs
  // the DVP matchup badges above, date backs the lineup-lock reminder.
  // Read off the current week's projections (already fetched above) since
  // every entry there carries team/opponent/date; if that endpoint's down
  // this week, fall back to whatever's in actual stats for players who've
  // already played -- same team, same opponent/date all week.
  try {
    const projRaw = await SleeperAPI.getWeeklyProjectionsRaw(season, week);
    teamOpponentThisWeek = Trends.buildTeamOpponentMap(projRaw, playerMeta);
    teamDateThisWeek = Trends.buildTeamDateMap(projRaw);
    if (!Object.keys(teamOpponentThisWeek).length) {
      const actualRaw = await SleeperAPI.getActualWeeklyStatsRaw(season, week, CURRENT_WEEK_TTL_MS);
      teamOpponentThisWeek = Trends.buildTeamOpponentMap(actualRaw, playerMeta);
      teamDateThisWeek = Trends.buildTeamDateMap(actualRaw);
    }
  } catch (e) {
    console.warn("Could not determine this week's matchups for DVP badges, continuing without them.", e);
  }

  // Fallback to last season's actuals, but only for players this season's
  // data above didn't cover at all yet -- almost always just "hasn't
  // played their Week 1 game yet". Only worth fetching early in the
  // season; by a couple weeks in, essentially everyone relevant has
  // current-season data and this pool would just go unused every load.
  let priorLastWeekPoints = {};
  let priorSeasonAvgPoints = {};
  let priorSeasonGamesPlayed = {};
  let priorSeasonYear = null;
  if (week <= 2) {
    try {
      const PRIOR_SEASON_TTL_MS = 30 * 24 * 60 * 60 * 1000;
      const NFL_REGULAR_SEASON_WEEKS = 18;
      priorSeasonYear = Number(season) - 1;
      const priorWeekNumbers = Array.from({ length: NFL_REGULAR_SEASON_WEEKS }, (_, i) => i + 1);
      const priorWeekStatsList = await Promise.all(
        priorWeekNumbers.map(w => SleeperAPI.getActualWeeklyStats(String(priorSeasonYear), w, PRIOR_SEASON_TTL_MS))
      );

      const sums = {};
      for (let i = priorWeekStatsList.length - 1; i >= 0; i--) {
        const weekPoints = Scoring.projectedPointsForLeague(priorWeekStatsList[i], league.scoring_settings || {});
        for (const [pid, pts] of Object.entries(weekPoints)) {
          if (!(pid in priorLastWeekPoints)) priorLastWeekPoints[pid] = pts;
          sums[pid] = (sums[pid] || 0) + pts;
          priorSeasonGamesPlayed[pid] = (priorSeasonGamesPlayed[pid] || 0) + 1;
        }
      }
      for (const pid of Object.keys(sums)) {
        priorSeasonAvgPoints[pid] = Math.round((sums[pid] / priorSeasonGamesPlayed[pid]) * 100) / 100;
      }
    } catch (e) {
      console.warn("Could not load last season's actuals as a stand-in, continuing without it.", e);
    }
  }

  const rosteredIds = [];
  rosters.forEach(r => (r.players || []).forEach(pid => rosteredIds.push(pid)));
  const trendingIds = new Set((trendingAdds || []).map(t => t.player_id));
  const usedCbs = Object.keys(cbsRanks).length > 0;

  state.leagueData[leagueId] = {
    league, rosters, users, myRoster, playerMeta, valuation, blendedValuation, agreement, cbsRanks,
    lastWeekPoints, seasonAvgPoints, seasonGamesPlayed, currentWeekActualPoints,
    priorLastWeekPoints, priorSeasonAvgPoints, priorSeasonGamesPlayed, priorSeasonYear,
    week, season, projSource, rosteredIds, trendingIds, opponent,
    dvp, usageTrends, teamOpponentThisWeek, teamDateThisWeek,
  };

  const cbsNote = usedCbs ? ', with CBS\'s consensus rank as a tiebreaker' : '';
  const blendedSourceNames = [usedEspn ? 'ESPN' : null, usedFFToday ? 'FFToday' : null].filter(Boolean);
  el('weekReadout').textContent = `${league.season} · Week ${week}`;
  el('statusLine').textContent = projSource !== 'projection'
    ? `Live projections weren't available this time, so rankings use each player's actual scoring average over their last 3 games instead.`
    : blendedSourceNames.length
      ? `Using Sleeper's own projections${cbsNote}, scored to ${league.name}'s own settings -- with ${blendedSourceNames.join(' + ')}'s blended average shown for reference next to Strong/Mixed/Split.`
      : `Using live weekly projections${cbsNote}, scored to ${league.name}'s own settings.`;
  lastRefreshedAt = Date.now();
}

// Confidence markup for a suggested swap: a Strong/Mixed/Split pill based on
// how close Sleeper and ESPN's numbers are for the incoming player (omitted
// if only one of them has data), plus a separate CBS tiebreaker tag when
// CBS's same-position consensus rank also has an opinion on this exact
// A small muted "how have they actually been doing" line for a player:
// last week's real score and their season average (excluding weeks they
// didn't play), to compare against the projection shown alongside it.
// Returns '' before any week has been completed, or for a player with no
// actual-scoring history yet (e.g. just added from waivers).
// A player's live point value for the lineup grid: their actual score once
// their game for the current week has been played, falling back to the
// projection otherwise. Distinct from recentFormLine's "last week" number,
// which is about performance history, not swapping in the number shown
// next to this week's own projection.
function livePlayerPoints(playerId, projectedPts, data) {
  const actual = data.currentWeekActualPoints ? data.currentWeekActualPoints[playerId] : undefined;
  if (typeof actual !== 'number') return { pts: projectedPts, isActual: false, colorClass: '' };
  const colorClass = actual > projectedPts + 0.01 ? 'pts-over' : actual < projectedPts - 0.01 ? 'pts-under' : '';
  return { pts: actual, isActual: true, colorClass };
}

function recentFormLine(playerId, data) {
  // Current-season data takes priority whenever it exists for this player
  // at all -- even just one game so far -- since it's updated per-player
  // as soon as their own game concludes (see loadLeagueData). Only a
  // player with nothing yet this season (hasn't played their first game)
  // falls back to last season's numbers instead of showing nothing.
  const hasCurrent = data.lastWeekPoints && Object.prototype.hasOwnProperty.call(data.lastWeekPoints, playerId);
  const prior = !hasCurrent;
  const last = hasCurrent ? data.lastWeekPoints[playerId] : (data.priorLastWeekPoints ? data.priorLastWeekPoints[playerId] : undefined);
  const avg = hasCurrent ? data.seasonAvgPoints[playerId] : (data.priorSeasonAvgPoints ? data.priorSeasonAvgPoints[playerId] : undefined);
  const games = hasCurrent ? data.seasonGamesPlayed[playerId] : (data.priorSeasonGamesPlayed ? data.priorSeasonGamesPlayed[playerId] : 0);
  if (typeof last !== 'number' && typeof avg !== 'number') return '';
  const parts = [];
  if (typeof last === 'number') parts.push(prior ? `${data.priorSeasonYear} last game ${last.toFixed(1)}` : `Last game ${last.toFixed(1)}`);
  if (typeof avg === 'number') {
    const label = prior ? `${data.priorSeasonYear} avg` : 'Season avg';
    parts.push(`${label} ${avg.toFixed(1)}${games ? ` (${games} gm${games === 1 ? '' : 's'})` : ''}`);
  }
  return `<span class="recent-form">${parts.join(' · ')}</span>`;
}

// Strong/Mixed/Split for one specific player -- how closely Sleeper and
// ESPN's own numbers agree on THEM, independent of who they're being
// compared against. Not a head-to-head signal (that's the CBS tag below),
// so it's equally valid to show on either side of a swap/waiver
// comparison, each with its own tooltip of that player's own source
// numbers. '' if ESPN blending isn't on, or this player only has one
// source (e.g. K/DEF, which ESPN blending skips entirely).
function agreementBadge(playerId, data) {
  const info = data.agreement && data.agreement[playerId];
  if (!info || info.level === 'single-source') return '';
  const label = info.level === 'strong' ? 'Strong' : info.level === 'moderate' ? 'Mixed' : 'Split';
  const tooltip = info.sources.map(s => `${s.name}: ${s.pts.toFixed(1)}`).join(' · ');
  return `<span class="agreement-badge level-${info.level}" title="${tooltip}">${label}</span>`;
}

// CBS's consensus rank as a third-opinion tiebreaker between two specific
// players -- unlike the agreement badge above, this genuinely is a
// head-to-head comparison, so it's only shown once, attached to the
// incoming/recommended side. CBS only gives a rank, not a point value, so
// it never affects the numbers above -- it's shown purely as "does a
// third source agree".
function cbsAgreementTag(incomingId, outgoingId, data) {
  const cbs = data.cbsRanks || {};
  const incomingRank = cbs[incomingId];
  const outgoingRank = outgoingId ? cbs[outgoingId] : null;
  if (!incomingRank || !outgoingRank || incomingRank.pos !== outgoingRank.pos) return '';
  const agrees = incomingRank.rank < outgoingRank.rank;
  const tooltip = `CBS ${incomingRank.pos} rank: #${incomingRank.rank} vs #${outgoingRank.rank}`;
  return ` <span class="cbs-tag ${agrees ? 'agree' : 'disagree'}" title="${tooltip}">${agrees ? 'CBS agrees' : 'CBS disagrees'}</span>`;
}

// The incoming/recommended player's full badge set: their own Strong/
// Mixed/Split plus the head-to-head CBS tag against whoever they'd
// replace. The outgoing/current player only gets their own
// agreementBadge (called directly at each call site) since the CBS tag
// isn't meaningful attached to that side too -- it'd just repeat the same
// comparison.
function confidenceBadges(incomingId, outgoingId, data) {
  return agreementBadge(incomingId, data) + cbsAgreementTag(incomingId, outgoingId, data);
}

// Small, de-emphasized note giving the ESPN/Sleeper blended average next
// to the main projection, wherever the agreement badge already applies.
// Purely informational -- the main pts shown everywhere in this app is
// always Sleeper's own projection (see loadLeagueData), since these are
// Sleeper leagues and that's the number that actually determines real
// scoring; this is just a reference point for how ESPN's own number
// would have shifted the average. '' if ESPN blending isn't on for this
// player.
function blendNote(playerId, data) {
  const blended = data.blendedValuation && data.blendedValuation[playerId];
  if (typeof blended !== 'number') return '';
  return `<span class="blend-note">(blend ${blended.toFixed(1)})</span>`;
}

// The valuation dict the Lineup tab's two roster grids (and their totals)
// actually display/score against -- Sleeper's own projection, or the
// Sleeper/ESPN blend for whoever has one, per the projection-mode toggle.
// A player blending doesn't cover (K/DEF, or no ESPN data this week)
// falls back to their Sleeper number in blend mode too, same as the
// blend note being absent for them elsewhere. This is purely a display
// toggle -- every recommendation elsewhere in the app (swaps, waivers,
// trades) is always built on plain Sleeper valuation regardless of it.
function effectiveValuation(data) {
  if (state.projectionMode !== 'blend' || !data.blendedValuation) return data.valuation;
  return { ...data.valuation, ...data.blendedValuation };
}

function hasBlendData(data) {
  return Boolean(data.blendedValuation && Object.keys(data.blendedValuation).length);
}

function initProjectionToggle() {
  document.querySelectorAll('#projectionToggle .toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.mode === state.projectionMode) return;
      state.projectionMode = btn.dataset.mode;
      try { localStorage.setItem(PROJECTION_MODE_KEY, state.projectionMode); } catch (e) { /* ignore */ }
      const data = state.leagueData[state.activeLeagueId];
      if (data) renderLineupTab(data);
    });
  });
}

function renderProjectionToggle(data) {
  const wrap = el('projectionToggle');
  wrap.classList.toggle('hidden', !hasBlendData(data));
  wrap.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.projectionMode);
  });
}

// "Good matchup" / "Tough matchup" against this player's actual NFL
// opponent this week, based on how many fantasy points that defense has
// allowed to this position all season (see Trends.computeDvp). Only shows
// up for the top/bottom third of the 32 teams at that position -- an
// unremarkable middle-of-the-pack matchup isn't worth a badge, same
// judgment call as the CBS agree/disagree tag above. '' if there's no DVP
// data yet (early season), no scheduled opponent, or this player's
// position isn't tracked (K/DEF).
function matchupBadge(playerId, data) {
  const meta = data.playerMeta[playerId];
  if (!meta) return '';
  const opponent = (data.teamOpponentThisWeek || {})[meta.team];
  const row = opponent && data.dvp && data.dvp[opponent] && data.dvp[opponent][meta.pos];
  if (!row || !row.tier) return '';
  const label = row.tier === 'good' ? 'Good matchup' : 'Tough matchup';
  const tooltip = `${opponent} allow the ${Trends.ordinal(row.rank)}-most points to ${meta.pos}s this season ` +
    `(${row.avgPts.toFixed(1)}/gm over ${row.games} gm${row.games === 1 ? '' : 's'}), out of ${row.outOf} teams.`;
  return `<span class="matchup-badge ${row.tier}" title="${tooltip}">${label}</span>`;
}

// "Usage ↑" / "Usage ↓" when this player's touches (targets + rush
// attempts) in their most recent game are meaningfully above or below
// their average over the games before that (see Trends.computeUsageTrend)
// -- a leading indicator a box score alone won't show. '' for a steady
// role, or a player without at least two played games yet this season.
function usageTrendBadge(playerId, data) {
  const trend = (data.usageTrends || {})[playerId];
  if (!trend) return '';
  const arrow = trend.direction === 'up' ? '↑' : '↓';
  const cls = trend.direction === 'up' ? 'up' : 'down';
  const snapPart = trend.lastSnapShare != null
    ? `, ${Math.round(trend.lastSnapShare * 100)}% snaps`
    : '';
  const priorSnapPart = trend.priorAvgSnapShare != null
    ? ` (${Math.round(trend.priorAvgSnapShare * 100)}% snaps avg before that)`
    : '';
  const tooltip = `Week ${trend.lastWeek}: ${trend.lastTouches} touches${snapPart}, vs ${trend.priorAvgTouches}/gm ` +
    `average over the ${trend.gamesConsidered - 1} game${trend.gamesConsidered - 1 === 1 ? '' : 's'} before that${priorSnapPart}.`;
  return `<span class="usage-badge ${cls}" title="${tooltip}">Usage ${arrow}</span>`;
}

/* ---------------- Ask Claude ---------------- */

// Markup for the on-demand research button, or '' if no Worker proxy is
// configured (same graceful-degradation pattern as ESPN/CBS: the feature
// just doesn't appear rather than erroring).
function askClaudeMarkup() {
  if (!state.workerProxyUrl) return '';
  return `
    <div class="ask-claude-wrap">
      <button type="button" class="ask-claude-btn">Ask Claude</button>
      <div class="ask-claude-result hidden"></div>
      <div class="ask-claude-projections hidden"></div>
      <div class="ask-claude-meta hidden"></div>
    </div>
  `;
}

function relativeTime(ts) {
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Wires the click handler for a card's "Ask Claude" button (a no-op if the
// card has none, i.e. no proxy configured). questionFn is called lazily on
// click, not up front, since building it can reference data not needed
// unless the button is actually used.
//
// First click shows a cached answer for this exact suggestion instantly
// and for free if one exists (button starts labeled accordingly); only a
// genuinely new question, or an explicit "Ask again", spends tokens.
function wireAskClaudeButton(card, cacheKey, questionFn) {
  const btn = card.querySelector('.ask-claude-btn');
  if (!btn) return;
  const resultEl = card.querySelector('.ask-claude-result');
  const projEl = card.querySelector('.ask-claude-projections');
  const metaEl = card.querySelector('.ask-claude-meta');

  // answer is { text, projections, ts? } -- projections is Claude's own
  // optional per-player point estimate (only buildSwapQuestion asks for
  // one right now), rendered as its own row of chips rather than buried in
  // the prose. null/empty just means this question didn't ask for one.
  function showAnswer(answer) {
    resultEl.classList.remove('hidden');
    resultEl.textContent = answer.text;
    projEl.innerHTML = '';
    if (answer.projections && answer.projections.length) {
      answer.projections.forEach(p => {
        const chip = document.createElement('span');
        chip.className = 'proj-chip';
        chip.textContent = `Claude: ${p.name} ${p.points.toFixed(1)} pts`;
        projEl.appendChild(chip);
      });
      projEl.classList.remove('hidden');
    } else {
      projEl.classList.add('hidden');
    }
  }

  const cached = ClaudeAssist.getCached(cacheKey);
  if (cached) btn.textContent = "Show Claude's answer";

  btn.addEventListener('click', async () => {
    const alreadyShown = btn.dataset.shown === '1';
    if (!alreadyShown) {
      const existing = ClaudeAssist.getCached(cacheKey);
      if (existing) {
        showAnswer(existing);
        metaEl.classList.remove('hidden');
        metaEl.textContent = `Cached answer from ${relativeTime(existing.ts)} -- no new query sent. Click "Ask again" for a fresh (billed) one.`;
        btn.textContent = 'Ask again (new query)';
        btn.dataset.shown = '1';
        return;
      }
    }

    btn.disabled = true;
    btn.textContent = 'Researching…';
    resultEl.classList.remove('hidden');
    resultEl.textContent = '';
    projEl.classList.add('hidden');
    metaEl.classList.add('hidden');
    metaEl.textContent = '';
    try {
      const answer = await ClaudeAssist.ask(state.workerProxyUrl, questionFn());
      ClaudeAssist.setCached(cacheKey, answer);
      showAnswer(answer);
      btn.textContent = 'Ask again (new query)';
      btn.dataset.shown = '1';
    } catch (e) {
      resultEl.textContent = `Couldn't get an answer: ${e.message}`;
      btn.textContent = 'Try again';
    } finally {
      btn.disabled = false;
    }
  });
}

/* ---------------- Tab switching ---------------- */

// Shared by the real tab-strip buttons and the topbar's Info/logo buttons,
// which reach a tab panel without being part of the tab-strip itself --
// querySelector just finds nothing for a tabName with no matching
// .tab-btn (Info), so no tab-strip button is left looking falsely active.
function switchToTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
  const btn = document.querySelector(`.tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.classList.add('active');
  el(`${tabName}Tab`).classList.remove('hidden');
  if (tabName === 'stats') loadAndRenderStatsTab();
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
  });
  el('infoBtn').addEventListener('click', () => switchToTab('info'));
  el('brandHome').addEventListener('click', () => switchToTab('lineup'));
}

// The agreement-badge (Strong/Mixed/Split), cbs-tag (CBS agrees/
// disagrees), matchup-badge (Good/Tough matchup), and usage-badge (Usage
// up/down) badges all carry their detail numbers in a `title` attribute,
// which only ever shows on hover -- nothing on a touch screen. Tapping one
// now shows the same text in a small popover instead, which works
// identically on mobile and desktop (a click does the same thing there,
// alongside the hover that still works too). One shared popover element
// repositioned per tap, rather than inserting new elements next to each
// badge, since these badges sit inline inside player-name text where a
// dropped-in block element would break the line layout.
function initBadgeTapTooltips() {
  const tooltip = document.createElement('div');
  tooltip.className = 'badge-tooltip hidden';
  document.body.appendChild(tooltip);
  let openBadge = null;

  function hideTooltip() {
    tooltip.classList.add('hidden');
    openBadge = null;
  }

  document.addEventListener('click', (e) => {
    const badge = e.target.closest('.agreement-badge, .cbs-tag, .matchup-badge, .usage-badge');
    if (!badge) {
      hideTooltip();
      return;
    }
    e.stopPropagation();
    if (openBadge === badge) {
      hideTooltip();
      return;
    }
    const text = badge.getAttribute('title');
    if (!text) return;

    openBadge = badge;
    tooltip.textContent = text;
    tooltip.classList.remove('hidden');
    const rect = badge.getBoundingClientRect();
    tooltip.style.top = `${rect.bottom + 6}px`;
    tooltip.style.left = `${rect.left}px`;
    // Clamp after render so we know the tooltip's actual width.
    requestAnimationFrame(() => {
      const maxLeft = window.innerWidth - tooltip.offsetWidth - 8;
      if (rect.left > maxLeft) tooltip.style.left = `${Math.max(8, maxLeft)}px`;
    });
  });

  // A stale position (badge moved out from under a position:fixed
  // tooltip) is worse than just closing it.
  window.addEventListener('scroll', hideTooltip, true);
  window.addEventListener('resize', hideTooltip);
}

function renderActiveTabContent() {
  const data = state.leagueData[state.activeLeagueId];
  if (!data) return;
  renderLineupTab(data);
  renderWaiversTab(data);
  renderTradeSetup(data);
  renderTradeScan(data);
  // Stats is fetched lazily (it walks every played week's matchups and
  // projections, more calls than the other tabs need) -- only refresh it
  // here if it's the tab actually on screen; switchToTab covers the case
  // where the user opens it directly.
  if (!el('statsTab').classList.contains('hidden')) loadAndRenderStatsTab();
}

/* ---------------- Lineup tab ---------------- */

function playerLabel(meta) {
  if (!meta) return 'Empty';
  const statusTag = meta.status ? ` (${meta.status})` : '';
  return `${meta.name}${statusTag} — ${meta.pos} ${meta.team}`;
}

function renderLineupTab(data) {
  const { league, myRoster, playerMeta, valuation } = data;
  if (!myRoster) {
    el('statusLine').textContent = "Couldn't find your roster in this league (owner_id mismatch).";
    return;
  }
  const { swaps } = Optimizer.suggestedSwaps(
    league.roster_positions,
    myRoster.starters || [],
    myRoster.players || [],
    playerMeta,
    valuation
  );
  // The two roster grids and their totals are the only things the
  // projection-mode toggle affects -- swaps above stay on plain Sleeper
  // valuation, since that's still what every recommendation in this app
  // is built on regardless of the toggle.
  const projValuation = effectiveValuation(data);
  const current = Optimizer.currentLineup(
    league.roster_positions,
    myRoster.starters || [],
    myRoster.players || [],
    playerMeta,
    projValuation
  );

  renderProjectionToggle(data);

  let liveTotal = 0;
  let anyActual = false;
  current.assignments.forEach(a => {
    if (!a.id) return;
    const live = livePlayerPoints(a.id, a.pts, data);
    liveTotal += live.pts;
    if (live.isActual) anyActual = true;
  });
  const blendSuffix = state.projectionMode === 'blend' ? ' (blend)' : '';
  el('heroTotal').textContent = liveTotal.toFixed(1);
  el('heroLabel').textContent = (anyActual ? 'Live starting total' : 'Projected starting total') + blendSuffix;

  renderLockReminder(data);
  renderInjuryWatch(data);

  const swapsList = el('swapsList');
  swapsList.innerHTML = '';
  el('swapsHeading').classList.toggle('hidden', !swaps.length);
  if (swaps.length) {
    swaps.forEach(s => {
      const card = document.createElement('div');
      card.className = 'swap-card';
      card.innerHTML = `
        <span class="swap-slot">${s.slot}</span>
        <div class="player-chip">
          <span class="name">${s.starterPlayer ? s.starterPlayer.name : 'Empty slot'} ${s.starterPlayer ? `${agreementBadge(s.starterPlayer.id, data)} ${matchupBadge(s.starterPlayer.id, data)} ${usageTrendBadge(s.starterPlayer.id, data)}` : ''}</span>
          <span class="meta">${s.starterPlayer ? `${s.starterPlayer.pos} ${s.starterPlayer.team} · ${s.starterPlayer.pts.toFixed(1)} pts ${blendNote(s.starterPlayer.id, data)}` : ''}</span>
          ${s.starterPlayer ? recentFormLine(s.starterPlayer.id, data) : ''}
        </div>
        <span class="swap-arrow">→</span>
        <div class="player-chip">
          <span class="name">${s.benchPlayer.name} ${confidenceBadges(s.benchPlayer.id, s.starterPlayer ? s.starterPlayer.id : null, data)} ${matchupBadge(s.benchPlayer.id, data)} ${usageTrendBadge(s.benchPlayer.id, data)}</span>
          <span class="meta">${s.benchPlayer.pos} ${s.benchPlayer.team} · ${s.benchPlayer.pts.toFixed(1)} pts ${blendNote(s.benchPlayer.id, data)}</span>
          ${recentFormLine(s.benchPlayer.id, data)}
        </div>
        <span class="swap-gain">+${s.gain.toFixed(1)}</span>
        ${askClaudeMarkup()}
      `;
      const swapCacheKey = ClaudeAssist.cacheKeyFor({
        type: 'swap', leagueId: data.league.league_id, season: data.season, week: data.week,
        aId: s.benchPlayer.id, bId: s.starterPlayer ? s.starterPlayer.id : null,
      });
      wireAskClaudeButton(card, swapCacheKey, () => ClaudeAssist.buildSwapQuestion({
        league: data.league.name, week: data.week, season: data.season,
        incoming: s.benchPlayer, outgoing: s.starterPlayer, slot: s.slot,
      }));
      swapsList.appendChild(card);
    });
  }

  const grid = el('lineupGrid');
  grid.innerHTML = '';
  current.assignments.forEach(a => {
    const meta = a.id ? playerMeta[a.id] : null;
    const live = a.id ? livePlayerPoints(a.id, a.pts, data) : null;
    const row = document.createElement('div');
    row.className = 'lineup-row' + (!a.id ? ' empty-slot' : '');
    row.innerHTML = `
      <span class="slot-tag">${a.slot}</span>
      <div class="lineup-player-cell">
        <span>${meta ? `${meta.name} · ${meta.pos} ${meta.team}${meta.status ? ` (${meta.status})` : ''}` : 'No eligible player'} ${meta ? `${matchupBadge(a.id, data)} ${usageTrendBadge(a.id, data)}` : ''}</span>
        ${meta ? recentFormLine(a.id, data) : ''}
      </div>
      <span class="pts${live && live.colorClass ? ` ${live.colorClass}` : ''}">${live ? live.pts.toFixed(1) : '--'}</span>
    `;
    grid.appendChild(row);
  });

  if (current.bench.length) {
    const heading = document.createElement('div');
    heading.className = 'bench-heading';
    heading.textContent = 'Bench';
    grid.appendChild(heading);
    current.bench.forEach(p => {
      const meta = playerMeta[p.id];
      const live = livePlayerPoints(p.id, p.pts, data);
      const row = document.createElement('div');
      row.className = 'lineup-row';
      row.innerHTML = `
        <span class="slot-tag">BN</span>
        <div class="lineup-player-cell">
          <span>${meta.name} · ${meta.pos} ${meta.team}${meta.status ? ` (${meta.status})` : ''} ${matchupBadge(p.id, data)} ${usageTrendBadge(p.id, data)}</span>
          ${recentFormLine(p.id, data)}
        </div>
        <span class="pts${live.colorClass ? ` ${live.colorClass}` : ''}">${live.pts.toFixed(1)}</span>
      `;
      grid.appendChild(row);
    });
  }

  renderOpponentLineup(data);
  loadAndRenderByePlanner(data);
}

function formatGameDate(dateStr) {
  // Parsed as local midnight, not UTC, so "today" comparisons below line up
  // with the reader's own calendar rather than shifting a day depending on
  // timezone.
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// A heads-up for the one lock most likely to catch someone out: a starter
// with an earlier kickoff than the rest of the week's slate (almost always
// Thursday night). Looks only at CURRENT starters who haven't played yet
// (livePlayerPoints/currentWeekActualPoints already tells us who has), so
// once Thursday's games are done this naturally moves on to whoever's
// earliest among what's left -- no separate "is it still Thursday" check
// needed. Only fires when that earliest kickoff is a genuine minority --
// a couple of Thursday/Friday starters ahead of an otherwise Sunday
// lineup -- not every single week just to announce "your team plays
// Sunday", which is the normal case and not worth a callout.
function renderLockReminder(data) {
  const { myRoster, playerMeta, teamDateThisWeek } = data;
  const el_ = el('lockReminder');
  if (!myRoster || !teamDateThisWeek) {
    el_.classList.add('hidden');
    return;
  }

  const upcoming = (myRoster.starters || [])
    .filter(id => id && id !== '0' && playerMeta[id] && !(id in (data.currentWeekActualPoints || {})))
    .map(id => {
      const meta = playerMeta[id];
      const dateStr = teamDateThisWeek[meta.team];
      return dateStr ? { id, ...meta, date: formatGameDate(dateStr) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);

  if (!upcoming.length) {
    el_.classList.add('hidden');
    return;
  }

  const earliest = upcoming[0];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  const daysAway = Math.round((earliest.date - today) / dayMs);
  if (daysAway < 0) {
    el_.classList.add('hidden');
    return;
  }

  const sameDay = upcoming.filter(p => p.date.getTime() === earliest.date.getTime());
  if (sameDay.length >= upcoming.length / 2) {
    // The earliest date covers half or more of what's left to play --
    // that's just the normal slate, not an early outlier worth flagging.
    el_.classList.add('hidden');
    return;
  }

  const dayLabel = earliest.date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const whenPhrase = daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`;
  const names = sameDay.map(p => `${p.name} (${p.pos} ${p.team})`).join(', ');
  const verb = sameDay.length === 1 ? 'kicks off' : 'kick off';

  el_.classList.remove('hidden');
  el_.innerHTML = `<strong>Lineup lock heads-up:</strong> ${names} ${verb} ${dayLabel} -- ${whenPhrase}, ahead of the rest of your lineup. Double check that slot before then.`;
}

// Season-wide bye-week schedule, cached once per season at the state level
// (not per league -- the NFL schedule is the same across all of them) so
// switching leagues doesn't refetch it. See Trends.computeByeWeeks for how
// it's actually derived; this just owns the caching and the 18-week fetch.
const NFL_REGULAR_SEASON_WEEKS = 18;
const BYE_SCHEDULE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

async function ensureByeWeeksLoaded(season) {
  if (state.byeWeeks && state.byeWeeks.season === season) return state.byeWeeks.data;
  const weekNumbers = Array.from({ length: NFL_REGULAR_SEASON_WEEKS }, (_, i) => i + 1);
  const entriesByWeekList = await Promise.all(
    weekNumbers.map(w => SleeperAPI.getWeeklyProjectionsRaw(season, w, 'regular', BYE_SCHEDULE_TTL_MS))
  );
  const entriesByWeek = {};
  weekNumbers.forEach((w, i) => { entriesByWeek[w] = entriesByWeekList[i]; });
  const data = Trends.computeByeWeeks(entriesByWeek);
  state.byeWeeks = { season, data };
  return data;
}

// Every player on the roster (starters and bench alike -- a bye affects
// who you can even start, not just who's currently starting), grouped by
// which week they're off, current/future weeks only. Lazy and cached at
// the state level (see ensureByeWeeksLoaded) since it's an 18-week fetch
// the first time -- cheap after that, for the rest of the session.
//
// Each week also gets checked for an actual lineup gap (see
// Optimizer.findByeGaps): a required slot that only that week's bye
// leaves unfillable, not a spot the roster was already thin at
// regardless of anyone's bye. A week with a real gap gets a red-flagged
// warning naming the slot, ahead of the normal "this week or next" gold
// highlight.
async function loadAndRenderByePlanner(data) {
  const leagueId = state.activeLeagueId;
  const heading = el('byePlannerHeading');
  const list = el('byePlannerList');
  if (!data.myRoster) {
    heading.classList.add('hidden');
    list.innerHTML = '';
    return;
  }

  let byeWeeks;
  try {
    byeWeeks = await ensureByeWeeksLoaded(data.season);
  } catch (e) {
    console.warn('Could not load the bye-week schedule, continuing without the planner.', e);
    heading.classList.add('hidden');
    list.innerHTML = '';
    return;
  }
  // The league/tab may have changed while this was in flight.
  if (state.activeLeagueId !== leagueId) return;

  const byWeek = {};
  (data.myRoster.players || []).forEach(id => {
    const meta = data.playerMeta[id];
    if (!meta) return;
    const bye = byeWeeks[meta.team];
    if (!bye || bye < data.week) return;
    if (!byWeek[bye]) byWeek[bye] = [];
    byWeek[bye].push({ id, ...meta });
  });

  const weeksSorted = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
  heading.classList.toggle('hidden', !weeksSorted.length);
  list.innerHTML = '';
  if (!weeksSorted.length) return;

  weeksSorted.forEach(w => {
    const players = byWeek[w].sort((a, b) => a.name.localeCompare(b.name));
    const gaps = Optimizer.findByeGaps(
      data.league.roster_positions, data.myRoster.players || [], data.playerMeta, players.map(p => p.id)
    );
    const row = document.createElement('div');
    row.className = 'bye-week-row' + (gaps.length ? ' gap' : w - data.week <= 1 ? ' soon' : '');

    let warning = '';
    const fixes = [];
    if (gaps.length) {
      warning = `<div class="bye-gap-warning">No eligible ${gaps.join(' or ')} available this week -- consider a waiver add before then.</div>`;
      gaps.forEach(slot => {
        const fix = Optimizer.suggestByeGapFix(
          slot, w, data.myRoster, data.playerMeta, data.valuation, data.rosteredIds, byeWeeks
        );
        if (fix) fixes.push(fix);
      });
    }

    // Two ways to actually fix a flagged gap: swap the gapped player
    // outright, or keep them and temporarily cut your worst bench player
    // to open a spot for the same free agent just for that one week (you'd
    // reverse both moves after -- this app doesn't make roster moves for
    // you). Each gets the same Ask Claude research button as any other
    // suggestion, scoped to the 1-for-1 framing.
    const fixesHtml = fixes.map((fix, i) => {
      const dropNames = fix.oneForOneDrop.map(p => p.name).join(' and ') || 'that slot';
      const addLabel = `${fix.waiverAdd.name} (${fix.waiverAdd.pos} ${fix.waiverAdd.team}, ${fix.waiverAdd.pts.toFixed(1)} pts)`;
      const oneForOne = `<div class="injury-replacement-option"><span class="label">1-for-1 swap</span> Drop ${dropNames} -- add ${addLabel}</div>`;
      const tempFix = fix.tempDrop
        ? `<div class="injury-replacement-option"><span class="label">Temp fill-in</span> Drop ${fix.tempDrop.name} for Week ${w} only -- add ${addLabel}, then reverse both moves after</div>`
        : '';
      return `<div class="bye-fix-options" data-fix-index="${i}">${oneForOne}${tempFix}${askClaudeMarkup()}</div>`;
    }).join('');

    row.innerHTML = `
      <span class="week-label">Week ${w}</span>
      <div class="content">
        <span class="players">${players.map(p => `${p.name} (${p.pos} ${p.team})`).join(', ')}</span>
        ${warning}
        ${fixesHtml}
      </div>
    `;

    row.querySelectorAll('.bye-fix-options').forEach(fixEl => {
      const fix = fixes[Number(fixEl.dataset.fixIndex)];
      const dropForQuestion = fix.oneForOneDrop[0] || fix.tempDrop;
      const cacheKey = ClaudeAssist.cacheKeyFor({
        type: 'waiver', leagueId: data.league.league_id, season: data.season, week: w,
        aId: fix.waiverAdd.id, bId: dropForQuestion ? dropForQuestion.id : '',
      });
      wireAskClaudeButton(fixEl, cacheKey, () => ClaudeAssist.buildWaiverQuestion({
        league: data.league.name, week: w, season: data.season,
        add: fix.waiverAdd, drop: dropForQuestion,
      }));
    });

    list.appendChild(row);
  });
}

// "Epstein Islanders" -> "Epstein Islanders'", "Sacko Reague" -> "Sacko
// Reague's" -- team names are free text, and plenty of them end in "s".
function possessive(name) {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

// This week's opponent -- their live total (same "projected until they've
// actually played" logic as the hero total above, with the same
// green/red-over-projection coloring per player) alongside a read-only
// breakdown of their starters. Hidden entirely if there's no opponent
// this week (a bye in an odd-sized league, or the matchup fetch failed).
function renderOpponentLineup(data) {
  const { league, playerMeta, opponent } = data;
  const heroBlock = el('opponentHeroBlock');
  const heading = el('opponentHeading');
  const grid = el('opponentGrid');

  if (!opponent) {
    heroBlock.classList.add('hidden');
    heading.classList.add('hidden');
    grid.innerHTML = '';
    return;
  }

  const oppLineup = Optimizer.currentLineup(
    league.roster_positions, opponent.starters, opponent.players, playerMeta, effectiveValuation(data)
  );

  let oppLiveTotal = 0;
  let oppAnyActual = false;
  oppLineup.assignments.forEach(a => {
    if (!a.id) return;
    const live = livePlayerPoints(a.id, a.pts, data);
    oppLiveTotal += live.pts;
    if (live.isActual) oppAnyActual = true;
  });

  const blendSuffix = state.projectionMode === 'blend' ? ' (blend)' : '';
  heroBlock.classList.remove('hidden');
  el('oppHeroLabel').textContent = `${possessive(opponent.name)} ${oppAnyActual ? 'live' : 'projected'} total${blendSuffix}`;
  el('oppHeroTotal').textContent = oppLiveTotal.toFixed(1);

  heading.classList.remove('hidden');
  heading.textContent = `This week's opponent: ${opponent.name}`;

  grid.innerHTML = '';
  oppLineup.assignments.forEach(a => {
    const meta = a.id ? playerMeta[a.id] : null;
    const live = a.id ? livePlayerPoints(a.id, a.pts, data) : null;
    const row = document.createElement('div');
    row.className = 'lineup-row' + (!a.id ? ' empty-slot' : '');
    row.innerHTML = `
      <span class="slot-tag">${a.slot}</span>
      <div class="lineup-player-cell">
        <span>${meta ? `${meta.name} · ${meta.pos} ${meta.team}${meta.status ? ` (${meta.status})` : ''}` : 'No eligible player'} ${meta ? `${matchupBadge(a.id, data)} ${usageTrendBadge(a.id, data)}` : ''}</span>
      </div>
      <span class="pts${live && live.colorClass ? ` ${live.colorClass}` : ''}">${live ? live.pts.toFixed(1) : '--'}</span>
    `;
    grid.appendChild(row);
  });
}

// Every rostered player carrying a Sleeper injury/status tag (Questionable,
// Doubtful, Out, IR, Sus, ...), starters first, each with the single best
// replacement available from the bench and separately from the waiver wire
// (see Optimizer.injuryReplacements for how those are found). This is
// deliberately independent of the swap suggestions above it: a
// "Questionable" tag posted early in the week often hasn't dragged a
// player's own projection down yet, so a point-based swap suggestion might
// not fire even though this is exactly the situation someone would want a
// backup plan for.
function renderInjuryWatch(data) {
  const { league, myRoster, playerMeta, valuation, rosteredIds, trendingIds } = data;
  const container = el('injuryWatch');
  container.innerHTML = '';
  if (!myRoster) return;

  const starters = new Set(myRoster.starters || []);
  const flagged = (myRoster.players || [])
    .filter(id => playerMeta[id] && playerMeta[id].status)
    .map(id => ({ id, ...playerMeta[id], pts: valuation[id] ?? 0, isStarter: starters.has(id) }))
    .sort((a, b) => Number(b.isStarter) - Number(a.isStarter) || b.pts - a.pts);

  if (!flagged.length) return;

  const heading = document.createElement('h2');
  heading.className = 'section-heading';
  heading.textContent = 'Injury watch';
  container.appendChild(heading);

  const list = document.createElement('div');
  list.className = 'injury-watch-list';

  flagged.forEach(p => {
    const { benchReplacement, waiverReplacement } = Optimizer.injuryReplacements(
      p.id, league.roster_positions, myRoster.starters || [], myRoster.players || [],
      playerMeta, valuation, rosteredIds, trendingIds
    );

    const bodyPart = p.injuryBodyPart ? ` (${p.injuryBodyPart})` : '';
    const options = [];
    if (benchReplacement) {
      options.push(`<div class="injury-replacement-option"><span class="label">Bench option</span> ${benchReplacement.name} · ${benchReplacement.pos} ${benchReplacement.team} · ${benchReplacement.pts.toFixed(1)} pts</div>`);
    }
    if (waiverReplacement) {
      options.push(`<div class="injury-replacement-option"><span class="label">Waiver option</span> ${waiverReplacement.name} ${waiverReplacement.trending ? '<span class="trending-badge">Trending</span>' : ''} · ${waiverReplacement.pos} ${waiverReplacement.team} · ${waiverReplacement.pts.toFixed(1)} pts</div>`);
    }
    if (!options.length) {
      options.push('<div class="injury-replacement-option muted">No clearly better replacement found on your bench or the waiver wire.</div>');
    }

    const card = document.createElement('div');
    card.className = 'injury-card';
    card.innerHTML = `
      <div class="player-chip">
        <span class="name">${p.name} <span class="injury-status-badge">${p.status}${bodyPart}</span></span>
        <span class="meta">${p.pos} ${p.team} · ${p.isStarter ? 'Starting' : 'Bench'} · ${p.pts.toFixed(1)} pts</span>
      </div>
      <div class="injury-replacements">${options.join('')}</div>
      ${askClaudeMarkup()}
    `;
    const cacheKey = ClaudeAssist.cacheKeyFor({
      type: 'injury', leagueId: league.league_id, season: data.season, week: data.week,
      aId: p.id, bId: null,
    });
    wireAskClaudeButton(card, cacheKey, () => ClaudeAssist.buildInjuryQuestion({
      league: league.name, week: data.week, season: data.season,
      player: p, injuryLabel: p.status, benchReplacement, waiverReplacement,
    }));
    list.appendChild(card);
  });

  container.appendChild(list);
}

/* ---------------- Waivers tab ---------------- */

function renderWaiversTab(data) {
  const { myRoster, playerMeta, valuation, rosteredIds, trendingIds } = data;
  if (!myRoster) return;
  const suggestions = Optimizer.waiverTargets(
    myRoster.players || [],
    playerMeta,
    valuation,
    rosteredIds,
    trendingIds,
    25
  );

  const list = el('waiverList');
  list.innerHTML = '';
  if (!suggestions.length) {
    list.innerHTML = '<p class="muted">No free agents currently outproject your roster at their position.</p>';
    return;
  }
  suggestions.forEach(s => {
    const card = document.createElement('div');
    card.className = 'waiver-card';
    card.innerHTML = `
      <div class="player-chip">
        <span class="name">${s.add.name} ${s.add.trending ? '<span class="trending-badge">Trending</span>' : ''} ${confidenceBadges(s.add.id, s.considerDropping.id, data)} ${matchupBadge(s.add.id, data)} ${usageTrendBadge(s.add.id, data)}</span>
        <span class="meta">${s.add.pos} ${s.add.team} · ${s.add.pts.toFixed(1)} pts ${blendNote(s.add.id, data)}</span>
        ${recentFormLine(s.add.id, data)}
      </div>
      <span class="swap-arrow">could replace</span>
      <div class="player-chip">
        <span class="name">${s.considerDropping.name} ${agreementBadge(s.considerDropping.id, data)} ${matchupBadge(s.considerDropping.id, data)} ${usageTrendBadge(s.considerDropping.id, data)}</span>
        <span class="meta">${s.considerDropping.pos} ${s.considerDropping.team} · ${s.considerDropping.pts.toFixed(1)} pts ${blendNote(s.considerDropping.id, data)}</span>
        ${recentFormLine(s.considerDropping.id, data)}
      </div>
      <span class="waiver-edge">+${s.edge.toFixed(1)}</span>
      ${askClaudeMarkup()}
    `;
    const waiverCacheKey = ClaudeAssist.cacheKeyFor({
      type: 'waiver', leagueId: data.league.league_id, season: data.season, week: data.week,
      aId: s.add.id, bId: s.considerDropping.id,
    });
    wireAskClaudeButton(card, waiverCacheKey, () => ClaudeAssist.buildWaiverQuestion({
      league: data.league.name, week: data.week, season: data.season,
      add: s.add, drop: s.considerDropping,
    }));
    list.appendChild(card);
  });
}

/* ---------------- Trade tab ---------------- */

function teamNameForRoster(rosterId, rosters, users) {
  const roster = rosters.find(r => r.roster_id === rosterId);
  if (!roster) return `Team ${rosterId}`;
  const user = users.find(u => u.user_id === roster.owner_id);
  return user ? (user.metadata?.team_name || user.display_name) : `Team ${rosterId}`;
}

// League-wide trade scan: bench players on other rosters that would
// clearly upgrade one of your own starters (see Optimizer.leagueTradeScan
// for how "clearly" and "available" are defined). Each card can jump
// straight into the manual trade builder below, pre-loaded with that
// target and the starter it'd replace, so this is a starting point for
// the builder rather than a dead end.
function renderTradeScan(data) {
  const { myRoster, rosters, users, league, playerMeta, valuation } = data;
  const heading = el('tradeScanHeading');
  const intro = el('tradeScanIntro');
  const list = el('tradeScanList');
  list.innerHTML = '';
  if (!myRoster) {
    heading.classList.add('hidden');
    intro.classList.add('hidden');
    return;
  }

  const opportunities = Optimizer.leagueTradeScan(
    myRoster.roster_id, rosters, playerMeta, valuation, league.roster_positions
  );

  heading.classList.toggle('hidden', !opportunities.length);
  intro.classList.toggle('hidden', !opportunities.length);
  if (!opportunities.length) return;

  opportunities.forEach(o => {
    const oppName = teamNameForRoster(o.opponentRosterId, rosters, users);
    const card = document.createElement('div');
    card.className = 'swap-card';
    card.innerHTML = `
      <span class="swap-slot">${oppName}</span>
      <div class="player-chip">
        <span class="name">${o.myPlayer.name}</span>
        <span class="meta">${o.myPlayer.pos} ${o.myPlayer.team} · ${o.myPlayer.pts.toFixed(1)} pts</span>
        ${recentFormLine(o.myPlayer.id, data)}
      </div>
      <span class="swap-arrow">→</span>
      <div class="player-chip">
        <span class="name">${o.targetPlayer.name} ${matchupBadge(o.targetPlayer.id, data)} ${usageTrendBadge(o.targetPlayer.id, data)}</span>
        <span class="meta">${o.targetPlayer.pos} ${o.targetPlayer.team} · ${o.targetPlayer.pts.toFixed(1)} pts</span>
        ${recentFormLine(o.targetPlayer.id, data)}
      </div>
      <span class="swap-gain">+${o.edge.toFixed(1)}</span>
      <button type="button" class="secondary-btn build-trade-btn">Build this trade</button>
      ${askClaudeMarkup()}
    `;

    card.querySelector('.build-trade-btn').addEventListener('click', () => {
      el('tradeOpponentSelect').value = String(o.opponentRosterId);
      state.trade.sideA = new Set([o.myPlayer.id]);
      state.trade.sideB = new Set([o.targetPlayer.id]);
      renderTradePools(data);
      document.querySelector('.trade-builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });

    const scanCacheKey = ClaudeAssist.cacheKeyFor({
      type: 'trade', leagueId: league.league_id, season: data.season, week: data.week,
      aId: o.myPlayer.id, bId: o.targetPlayer.id,
    });
    wireAskClaudeButton(card, scanCacheKey, () => ClaudeAssist.buildTradeQuestion({
      league: league.name, week: data.week, season: data.season,
      give: [o.myPlayer], receive: [o.targetPlayer],
    }));
    list.appendChild(card);
  });
}

function renderTradeSetup(data) {
  const { myRoster, rosters, users, playerMeta } = data;
  if (!myRoster) return;

  state.trade.sideA = new Set();
  state.trade.sideB = new Set();

  const opponentSelect = el('tradeOpponentSelect');
  opponentSelect.innerHTML = '';
  rosters.filter(r => r.roster_id !== myRoster.roster_id).forEach(r => {
    const user = users.find(u => u.user_id === r.owner_id);
    const opt = document.createElement('option');
    opt.value = r.roster_id;
    opt.textContent = user ? (user.metadata?.team_name || user.display_name) : `Team ${r.roster_id}`;
    opponentSelect.appendChild(opt);
  });
  opponentSelect.onchange = () => renderTradePools(data);
  state.trade.opponentRosterId = rosters.find(r => r.roster_id !== myRoster.roster_id)?.roster_id ?? null;

  renderTradePools(data);
}

function renderPool(containerId, playerIds, playerMeta, valuation, side) {
  const container = el(containerId);
  container.innerHTML = '';
  playerIds
    .map(id => ({ id, ...playerMeta[id], pts: valuation[id] ?? 0 }))
    .sort((a, b) => b.pts - a.pts)
    .forEach(p => {
      const item = document.createElement('div');
      item.className = 'pool-item' + (state.trade[side].has(p.id) ? ' selected' : '');
      item.innerHTML = `<span>${p.name} · ${p.pos} ${p.team}</span><span>${p.pts.toFixed(1)}</span>`;
      item.addEventListener('click', () => {
        if (state.trade[side].has(p.id)) state.trade[side].delete(p.id);
        else state.trade[side].add(p.id);
        renderPool(containerId, playerIds, playerMeta, valuation, side);
        renderTradeResult();
      });
      container.appendChild(item);
    });
}

function renderTradePools(data) {
  const { myRoster, rosters, playerMeta, valuation } = data;
  renderPool('tradeSideAPool', myRoster.players || [], playerMeta, valuation, 'sideA');
  const opponent = rosters.find(r => r.roster_id === Number(el('tradeOpponentSelect').value));
  renderPool('tradeSideBPool', opponent ? (opponent.players || []) : [], playerMeta, valuation, 'sideB');
  renderTradeResult();
}

function renderTradeResult() {
  const data = state.leagueData[state.activeLeagueId];
  const { playerMeta, valuation } = data;
  const result = Optimizer.tradeSummary(
    Array.from(state.trade.sideA),
    Array.from(state.trade.sideB),
    playerMeta,
    valuation
  );
  const container = el('tradeResult');
  if (!result.a.players.length && !result.b.players.length) {
    container.innerHTML = '';
    return;
  }
  const verdict = Math.abs(result.diff) < 1
    ? 'Roughly even value.'
    : result.diff > 0
      ? `Your side gives up ${result.diff.toFixed(1)} more projected points than it receives.`
      : `Your side receives ${Math.abs(result.diff).toFixed(1)} more projected points than it gives up.`;

  container.innerHTML = `
    <div class="trade-result-side">
      <h3>You send</h3>
      <div class="total">${result.a.total.toFixed(1)}</div>
      ${result.a.players.map(p => `<div class="meta">${p.name} — ${p.pts.toFixed(1)}</div>`).join('')}
    </div>
    <div class="trade-result-side">
      <h3>You receive</h3>
      <div class="total">${result.b.total.toFixed(1)}</div>
      ${result.b.players.map(p => `<div class="meta">${p.name} — ${p.pts.toFixed(1)}</div>`).join('')}
    </div>
    <div class="trade-verdict">${verdict}</div>
    ${askClaudeMarkup()}
  `;

  const tradeCacheKey = ClaudeAssist.cacheKeyFor({
    type: 'trade', leagueId: data.league.league_id, season: data.season, week: data.week,
    aId: result.a.players.map(p => p.id).sort().join(','),
    bId: result.b.players.map(p => p.id).sort().join(','),
  });
  wireAskClaudeButton(container, tradeCacheKey, () => ClaudeAssist.buildTradeQuestion({
    league: data.league.name, week: data.week, season: data.season,
    give: result.a.players, receive: result.b.players,
  }));
}

/* ---------------- Stats tab ---------------- */

// Walks every week Sleeper has actual stats for, comparing my team's real
// score to what its actual starting lineup was projected to score. This is
// heavier than the other tabs (a matchups + projections fetch per played
// week) so it's loaded lazily -- only when the tab is actually opened --
// and cached in-memory per league for the rest of the session, keyed off
// the current week so a new week's results show up on the next visit.
async function loadAndRenderStatsTab() {
  const leagueId = state.activeLeagueId;
  const data = state.leagueData[leagueId];
  const summaryEl = el('statsSummary');
  const weeklyEl = el('statsWeekly');
  if (!data || !data.myRoster) return;

  // Cached results are reused across tab visits within the same week --
  // except when the most recent week is still in progress, since that
  // week's score can keep changing as more of its games finish, so it's
  // worth a fresh fetch each time the tab is revisited rather than
  // freezing on whatever it showed first.
  const cache = data.statsCache;
  const cacheIsStale = !cache || cache.week !== data.week || (cache.weeks.length && cache.weeks[cache.weeks.length - 1].inProgress);
  if (!cacheIsStale) {
    renderStatsResults(cache);
    return;
  }

  summaryEl.innerHTML = '<p class="muted">Loading season stats…</p>';
  weeklyEl.innerHTML = '';
  try {
    const weeks = await Stats.loadWeeklyPerformance(
      leagueId, data.myRoster, data.rosters, data.users, data.league, data.week, data.season
    );
    // The league/tab may have changed while this was in flight -- don't
    // paint stale results over whatever's actually on screen now.
    if (state.activeLeagueId !== leagueId || el('statsTab').classList.contains('hidden')) return;
    const summary = Stats.summarize(weeks);
    data.statsCache = { week: data.week, weeks, summary };
    renderStatsResults(data.statsCache);
  } catch (e) {
    if (state.activeLeagueId !== leagueId) return;
    summaryEl.innerHTML = `<p class="muted">Couldn't load season stats: ${e.message}</p>`;
  }
}

function renderStatsResults({ weeks, summary }) {
  const summaryEl = el('statsSummary');
  const weeklyEl = el('statsWeekly');

  if (!weeks.length) {
    summaryEl.innerHTML = '<p class="muted">No games played yet this season -- check back once Week 1 kicks off.</p>';
    weeklyEl.innerHTML = '';
    return;
  }

  const diffClass = (d) => (d == null ? '' : d > 0.05 ? 'stat-positive' : d < -0.05 ? 'stat-negative' : '');

  if (!summary) {
    summaryEl.innerHTML = '<p class="muted">Season stats will appear here once this week wraps up -- the live score below will keep updating as your players finish their games.</p>';
  } else {
    const diffCard = summary.avgDiff != null
      ? `<div class="stat-card">
          <span class="stat-label">Vs. projection</span>
          <span class="stat-value ${diffClass(summary.avgDiff)}">${summary.avgDiff > 0 ? '+' : ''}${summary.avgDiff.toFixed(1)}/wk</span>
          <span class="stat-sub">Beat it ${summary.beatProjection} of ${summary.projectionWeeks} weeks</span>
        </div>`
      : '';

    summaryEl.innerHTML = `
      <div class="stat-card">
        <span class="stat-label">Record</span>
        <span class="stat-value">${summary.record}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Avg points/week</span>
        <span class="stat-value">${summary.avgFor.toFixed(1)}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Best week</span>
        <span class="stat-value">${summary.best.myActual.toFixed(1)}</span>
        <span class="stat-sub">Week ${summary.best.week}</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Worst week</span>
        <span class="stat-value">${summary.worst.myActual.toFixed(1)}</span>
        <span class="stat-sub">Week ${summary.worst.week}</span>
      </div>
      ${diffCard}
    `;
  }

  const table = document.createElement('div');
  table.className = 'stats-table';
  table.innerHTML = `
    <div class="stats-row stats-header">
      <span>Wk</span><span>Opponent</span><span>Result</span><span>Score</span><span>Projected</span><span>Diff</span>
    </div>
  `;
  weeks.slice().reverse().forEach(w => {
    const resultClass = w.inProgress ? '' : w.result === 'W' ? 'stats-win' : w.result === 'L' ? 'stats-loss' : '';
    const resultText = w.result
      ? `${w.inProgress ? 'Live · ' : ''}${w.result} ${w.oppActual.toFixed(1)}`
      : (w.inProgress ? 'Live' : '--');
    const row = document.createElement('div');
    row.className = 'stats-row';
    row.innerHTML = `
      <span>${w.week}</span>
      <span>${w.opponentName || 'Bye'}</span>
      <span class="${resultClass}">${resultText}</span>
      <span>${w.myActual.toFixed(1)}</span>
      <span>${w.myProjected != null ? w.myProjected.toFixed(1) : '--'}</span>
      <span class="${diffClass(w.diff)}">${w.diff != null ? `${w.diff > 0 ? '+' : ''}${w.diff.toFixed(1)}` : '--'}</span>
    `;
    table.appendChild(row);
  });
  weeklyEl.innerHTML = '';
  weeklyEl.appendChild(table);
}

/* ---------------- Refresh on reopen ---------------- */

// A page reload naturally re-fetches everything (state.leagueData starts
// empty every time this script runs). But on mobile, "reopening the app"
// usually isn't a reload at all -- the browser just resumes a backgrounded
// tab exactly where it left off, same JS state, same stale data, with no
// signal to refetch unless something asks for one. visibilitychange
// (tab brought back to the foreground) and pageshow with `persisted: true`
// (restored from the back-forward cache -- the mechanism behind a
// suspended mobile tab resuming) are that signal. Debounced so rapid
// app-switching doesn't refetch on every glance.
let lastRefreshedAt = Date.now();
const MIN_REFRESH_INTERVAL_MS = 60 * 1000;

async function refreshActiveLeagueIfDue() {
  if (!state.activeLeagueId || el('dashboard').classList.contains('hidden')) return;
  if (Date.now() - lastRefreshedAt < MIN_REFRESH_INTERVAL_MS) return;
  lastRefreshedAt = Date.now();
  await ensureLeagueLoaded(state.activeLeagueId, true);
  renderActiveTabContent();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshActiveLeagueIfDue();
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) refreshActiveLeagueIfDue();
});

/* ---------------- Boot ---------------- */

(function init() {
  initSetup();
  initTabs();
  initBadgeTapTooltips();
  initProjectionToggle();
  const saved = loadSavedSetup();
  if (saved && saved.leagues && saved.leagues.length) {
    state.username = saved.username;
    state.userId = saved.userId;
    state.leagues = saved.leagues;
    // Falls back to the old field name (pre-rename) so anyone who'd already
    // configured this doesn't silently lose it -- gets saved under the new
    // name next time they hit Save.
    state.workerProxyUrl = saved.workerProxyUrl || saved.espnProxyUrl || null;
    el('setupPanel').classList.add('hidden');
    el('dashboard').classList.remove('hidden');
    bootDashboard();
  }
})();
