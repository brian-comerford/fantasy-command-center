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

async function ensureLeagueLoaded(leagueId) {
  if (state.leagueData[leagueId]) return;
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
  // last week's real total plus a season average that only counts weeks a
  // player actually played (see getActualWeeklyStats). Nothing to show
  // yet in Week 1, before any week has been completed.
  let lastWeekPoints = {};
  let seasonAvgPoints = {};
  let seasonGamesPlayed = {};
  const lastCompletedWeek = week - 1;
  if (lastCompletedWeek >= 1) {
    try {
      const weekNumbers = Array.from({ length: lastCompletedWeek }, (_, i) => i + 1);
      const weekStatsList = await Promise.all(weekNumbers.map(w => SleeperAPI.getActualWeeklyStats(season, w)));

      const lastWeekStats = weekStatsList[weekStatsList.length - 1];
      lastWeekPoints = Scoring.projectedPointsForLeague(lastWeekStats, league.scoring_settings || {});

      const sums = {};
      weekStatsList.forEach(weekStats => {
        const weekPoints = Scoring.projectedPointsForLeague(weekStats, league.scoring_settings || {});
        for (const [pid, pts] of Object.entries(weekPoints)) {
          sums[pid] = (sums[pid] || 0) + pts;
          seasonGamesPlayed[pid] = (seasonGamesPlayed[pid] || 0) + 1;
        }
      });
      for (const pid of Object.keys(sums)) {
        seasonAvgPoints[pid] = Math.round((sums[pid] / seasonGamesPlayed[pid]) * 100) / 100;
      }
    } catch (e) {
      console.warn('Could not compute actual-performance history, continuing without it.', e);
    }
  }

  const rosteredIds = [];
  rosters.forEach(r => (r.players || []).forEach(pid => rosteredIds.push(pid)));
  const trendingIds = new Set((trendingAdds || []).map(t => t.player_id));
  const usedCbs = Object.keys(cbsRanks).length > 0;

  state.leagueData[leagueId] = {
    league, rosters, users, myRoster, playerMeta, valuation, agreement, cbsRanks,
    lastWeekPoints, seasonAvgPoints, seasonGamesPlayed,
    week, season, projSource, rosteredIds, trendingIds,
  };

  const cbsNote = usedCbs ? ', with CBS\'s consensus rank as a tiebreaker' : '';
  el('weekReadout').textContent = `${league.season} · Week ${week}`;
  el('statusLine').textContent = projSource !== 'projection'
    ? `Live projections weren't available this time, so rankings use each player's actual scoring average over their last 3 games instead.`
    : usedEspn
      ? `Blending Sleeper + ESPN projections${cbsNote}, scored to ${league.name}'s own settings.`
      : `Using live weekly projections${cbsNote}, scored to ${league.name}'s own settings.`;
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
function recentFormLine(playerId, data) {
  const last = data.lastWeekPoints ? data.lastWeekPoints[playerId] : undefined;
  const avg = data.seasonAvgPoints ? data.seasonAvgPoints[playerId] : undefined;
  const games = data.seasonGamesPlayed ? data.seasonGamesPlayed[playerId] : 0;
  if (typeof last !== 'number' && typeof avg !== 'number') return '';
  const parts = [];
  if (typeof last === 'number') parts.push(`Last wk ${last.toFixed(1)}`);
  if (typeof avg === 'number') parts.push(`Season avg ${avg.toFixed(1)}${games ? ` (${games} gm${games === 1 ? '' : 's'})` : ''}`);
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

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('hidden'));
      btn.classList.add('active');
      el(`${btn.dataset.tab}Tab`).classList.remove('hidden');
    });
  });
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

  el('heroTotal').textContent = optimal.totalPts.toFixed(1);

  const swapsList = el('swapsList');
  swapsList.innerHTML = '';
  if (!swaps.length) {
    swapsList.innerHTML = '<div class="no-swaps">Your current starters already match the optimal lineup. No changes suggested.</div>';
  } else {
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
    const row = document.createElement('div');
    row.className = 'lineup-row' + (!a.id ? ' empty-slot' : '');
    row.innerHTML = `
      <span class="slot-tag">${a.slot}</span>
      <div class="lineup-player-cell">
        <span>${meta ? `${meta.name} · ${meta.pos} ${meta.team}${meta.status ? ` (${meta.status})` : ''}` : 'No eligible player'}</span>
        ${meta ? recentFormLine(a.id, data) : ''}
      </div>
      <span class="pts">${a.id ? a.pts.toFixed(1) : '--'}</span>
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
      const row = document.createElement('div');
      row.className = 'lineup-row';
      row.innerHTML = `
        <span class="slot-tag">BN</span>
        <div class="lineup-player-cell">
          <span>${meta.name} · ${meta.pos} ${meta.team}${meta.status ? ` (${meta.status})` : ''}</span>
          ${recentFormLine(p.id, data)}
        </div>
        <span class="pts">${p.pts.toFixed(1)}</span>
      `;
      grid.appendChild(row);
    });
  }
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

/* ---------------- Boot ---------------- */

(function init() {
  initSetup();
  initTabs();
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
