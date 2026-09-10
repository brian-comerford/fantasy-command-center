/* App state, wiring, and rendering. Vanilla JS, no build step, so this can
 * be pushed straight to GitHub Pages as-is. */

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
  const projections = await SleeperAPI.getWeeklyProjections(season, week).catch(() => null);
  if (projections && Object.keys(projections).length) {
    sleeperValuation = Scoring.projectedPointsForLeague(projections, league.scoring_settings || {});
  } else {
    projSource = 'recent-average';
    sleeperValuation = await SleeperAPI.getRecentAveragePoints(leagueId, week, 3);
  }

  // ESPN projections are an optional second opinion (see espn-api.js) --
  // only blended in when the projection source is live projections (not the
  // recent-average fallback, which isn't really comparable) and only for
  // players ESPN actually projects (QB/RB/WR/TE).
  let valuation = sleeperValuation;
  let agreement = {};
  let usedEspn = false;
  if (projSource === 'projection' && state.workerProxyUrl) {
    try {
      const espnStats = await EspnAPI.getWeeklyProjections(state.workerProxyUrl, season, week);
      if (espnStats && Object.keys(espnStats).length) {
        const espnValuation = Scoring.projectedPointsForLeague(espnStats, league.scoring_settings || {});
        const blend = Scoring.blendValuations([
          { name: 'Sleeper', points: sleeperValuation },
          { name: 'ESPN', points: espnValuation },
        ]);
        valuation = blend.blended;
        agreement = blend.agreement;
        usedEspn = true;
      }
    } catch (e) {
      console.warn('ESPN proxy unavailable, continuing on Sleeper alone.', e);
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
    league, rosters, users, myRoster, playerMeta, valuation, agreement, cbsRanks,
    lastWeekPoints, seasonAvgPoints, seasonGamesPlayed, currentWeekActualPoints,
    priorLastWeekPoints, priorSeasonAvgPoints, priorSeasonGamesPlayed, priorSeasonYear,
    week, season, projSource, rosteredIds, trendingIds,
  };

  const cbsNote = usedCbs ? ', with CBS\'s consensus rank as a tiebreaker' : '';
  el('weekReadout').textContent = `${league.season} · Week ${week}`;
  el('statusLine').textContent = projSource !== 'projection'
    ? `Live projections weren't available this time, so rankings use each player's actual scoring average over their last 3 games instead.`
    : usedEspn
      ? `Blending Sleeper + ESPN projections${cbsNote}, scored to ${league.name}'s own settings.`
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

// swap. CBS only gives a rank, not a point value, so it never affects the
// numbers above -- it's shown purely as "does a third source agree".
function confidenceBadges(incomingId, outgoingId, data) {
  let html = '';

  const info = data.agreement && data.agreement[incomingId];
  if (info && info.level !== 'single-source') {
    const label = info.level === 'strong' ? 'Strong' : info.level === 'moderate' ? 'Mixed' : 'Split';
    const tooltip = info.sources.map(s => `${s.name}: ${s.pts.toFixed(1)}`).join(' · ');
    html += `<span class="agreement-badge level-${info.level}" title="${tooltip}">${label}</span>`;
  }

  const cbs = data.cbsRanks || {};
  const incomingRank = cbs[incomingId];
  const outgoingRank = outgoingId ? cbs[outgoingId] : null;
  if (incomingRank && outgoingRank && incomingRank.pos === outgoingRank.pos) {
    const agrees = incomingRank.rank < outgoingRank.rank;
    const tooltip = `CBS ${incomingRank.pos} rank: #${incomingRank.rank} vs #${outgoingRank.rank}`;
    html += ` <span class="cbs-tag ${agrees ? 'agree' : 'disagree'}" title="${tooltip}">${agrees ? 'CBS agrees' : 'CBS disagrees'}</span>`;
  }

  return html;
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
  const metaEl = card.querySelector('.ask-claude-meta');

  const cached = ClaudeAssist.getCached(cacheKey);
  if (cached) btn.textContent = "Show Claude's answer";

  btn.addEventListener('click', async () => {
    const alreadyShown = btn.dataset.shown === '1';
    if (!alreadyShown) {
      const existing = ClaudeAssist.getCached(cacheKey);
      if (existing) {
        resultEl.classList.remove('hidden');
        resultEl.textContent = existing.text;
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
    metaEl.classList.add('hidden');
    metaEl.textContent = '';
    try {
      const text = await ClaudeAssist.ask(state.workerProxyUrl, questionFn());
      ClaudeAssist.setCached(cacheKey, text);
      resultEl.textContent = text;
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
}

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchToTab(btn.dataset.tab));
  });
  el('infoBtn').addEventListener('click', () => switchToTab('info'));
  el('brandHome').addEventListener('click', () => switchToTab('lineup'));
}

// The agreement-badge (Strong/Mixed/Split) and cbs-tag (CBS agrees/
// disagrees) badges carry their detail numbers in a `title` attribute,
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
    const badge = e.target.closest('.agreement-badge, .cbs-tag');
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
  const { optimal, swaps } = Optimizer.suggestedSwaps(
    league.roster_positions,
    myRoster.starters || [],
    myRoster.players || [],
    playerMeta,
    valuation
  );

  let liveTotal = 0;
  let anyActual = false;
  optimal.assignments.forEach(a => {
    if (!a.id) return;
    const live = livePlayerPoints(a.id, a.pts, data);
    liveTotal += live.pts;
    if (live.isActual) anyActual = true;
  });
  el('heroTotal').textContent = liveTotal.toFixed(1);
  el('heroLabel').textContent = anyActual ? 'Live starting total' : 'Projected starting total';

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
          <span class="name">${s.starterPlayer ? s.starterPlayer.name : 'Empty slot'}</span>
          <span class="meta">${s.starterPlayer ? `${s.starterPlayer.pos} ${s.starterPlayer.team} · ${s.starterPlayer.pts.toFixed(1)} pts` : ''}</span>
          ${s.starterPlayer ? recentFormLine(s.starterPlayer.id, data) : ''}
        </div>
        <span class="swap-arrow">→</span>
        <div class="player-chip">
          <span class="name">${s.benchPlayer.name} ${confidenceBadges(s.benchPlayer.id, s.starterPlayer ? s.starterPlayer.id : null, data)}</span>
          <span class="meta">${s.benchPlayer.pos} ${s.benchPlayer.team} · ${s.benchPlayer.pts.toFixed(1)} pts</span>
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
  optimal.assignments.forEach(a => {
    const meta = a.id ? playerMeta[a.id] : null;
    const live = a.id ? livePlayerPoints(a.id, a.pts, data) : null;
    const row = document.createElement('div');
    row.className = 'lineup-row' + (!a.id ? ' empty-slot' : '');
    row.innerHTML = `
      <span class="slot-tag">${a.slot}</span>
      <div class="lineup-player-cell">
        <span>${meta ? `${meta.name} · ${meta.pos} ${meta.team}${meta.status ? ` (${meta.status})` : ''}` : 'No eligible player'}</span>
        ${meta ? recentFormLine(a.id, data) : ''}
      </div>
      <span class="pts${live && live.colorClass ? ` ${live.colorClass}` : ''}">${live ? live.pts.toFixed(1) : '--'}</span>
    `;
    grid.appendChild(row);
  });

  if (optimal.bench.length) {
    const heading = document.createElement('div');
    heading.className = 'bench-heading';
    heading.textContent = 'Bench';
    grid.appendChild(heading);
    optimal.bench.forEach(p => {
      const meta = playerMeta[p.id];
      const live = livePlayerPoints(p.id, p.pts, data);
      const row = document.createElement('div');
      row.className = 'lineup-row';
      row.innerHTML = `
        <span class="slot-tag">BN</span>
        <div class="lineup-player-cell">
          <span>${meta.name} · ${meta.pos} ${meta.team}${meta.status ? ` (${meta.status})` : ''}</span>
          ${recentFormLine(p.id, data)}
        </div>
        <span class="pts${live.colorClass ? ` ${live.colorClass}` : ''}">${live.pts.toFixed(1)}</span>
      `;
      grid.appendChild(row);
    });
  }
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
        <span class="name">${s.add.name} ${s.add.trending ? '<span class="trending-badge">Trending</span>' : ''} ${confidenceBadges(s.add.id, s.considerDropping.id, data)}</span>
        <span class="meta">${s.add.pos} ${s.add.team} · ${s.add.pts.toFixed(1)} pts</span>
        ${recentFormLine(s.add.id, data)}
      </div>
      <span class="swap-arrow">could replace</span>
      <div class="player-chip">
        <span class="name">${s.considerDropping.name}</span>
        <span class="meta">${s.considerDropping.pos} ${s.considerDropping.team} · ${s.considerDropping.pts.toFixed(1)} pts</span>
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
  `;
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
