/* Sleeper API wrapper.
 * Documented endpoints (api.sleeper.app/v1/...): users, leagues, rosters,
 * matchups, drafts, transactions, players, NFL state, trending players.
 * Projections (api.sleeper.com/projections/...) are NOT part of Sleeper's
 * official docs -- they're a widely-used but unofficial endpoint. We treat
 * them as best-effort and fall back to real recent scoring history (which
 * IS official, via the matchups endpoint's players_points field) if they
 * fail or get blocked.
 */

const SleeperAPI = (() => {
  const BASE = 'https://api.sleeper.app/v1';
  const PROJ_BASE = 'https://api.sleeper.com/projections/nfl';

  async function getJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }

  async function getUser(username) {
    return getJSON(`${BASE}/user/${encodeURIComponent(username)}`);
  }

  async function getUserLeagues(userId, season) {
    return getJSON(`${BASE}/user/${userId}/leagues/nfl/${season}`);
  }

  async function getLeague(leagueId) {
    return getJSON(`${BASE}/league/${leagueId}`);
  }

  async function getRosters(leagueId) {
    return getJSON(`${BASE}/league/${leagueId}/rosters`);
  }

  async function getLeagueUsers(leagueId) {
    return getJSON(`${BASE}/league/${leagueId}/users`);
  }

  async function getMatchups(leagueId, week) {
    return getJSON(`${BASE}/league/${leagueId}/matchups/${week}`);
  }

  async function getTransactions(leagueId, week) {
    return getJSON(`${BASE}/league/${leagueId}/transactions/${week}`);
  }

  async function getNflState() {
    return getJSON(`${BASE}/state/nfl`);
  }

  async function getTrendingAdds(hours = 24, limit = 50) {
    return getJSON(`${BASE}/players/nfl/trending/add?lookback_hours=${hours}&limit=${limit}`);
  }

  // Full player dictionary is ~5000+ entries. We trim aggressively and cache
  // in localStorage for 20 hours (Sleeper recommends calling this endpoint
  // sparingly -- at most once a day per their docs).
  async function getPlayersTrimmed() {
    const cacheKey = 'fcc_players_cache_v1';
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < 20 * 60 * 60 * 1000) {
          return parsed.data;
        }
      } catch (e) { /* fall through to refetch */ }
    }
    const full = await getJSON(`${BASE}/players/nfl`);
    const trimmed = {};
    for (const [id, p] of Object.entries(full)) {
      if (!p) continue;
      trimmed[id] = {
        name: p.full_name || `${p.first_name || ''} ${p.last_name || ''}`.trim() || id,
        pos: p.fantasy_positions && p.fantasy_positions[0] ? p.fantasy_positions[0] : (p.position || 'UNK'),
        team: p.team || 'FA',
        status: p.injury_status || null,
        active: p.active !== false,
      };
    }
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: trimmed }));
    } catch (e) {
      console.warn('Player cache too large for localStorage, continuing without cache.', e);
    }
    return trimmed;
  }

  // Best-effort weekly projections. Returns { [player_id]: statsObject } or
  // null if the endpoint is unavailable (caller should fall back).
  async function getWeeklyProjections(season, week, seasonType = 'regular') {
    const attempts = [
      `${PROJ_BASE}/${season}/${week}?season_type=${seasonType}`,
      `https://api.sleeper.app/projections/nfl/${seasonType}/${season}/${week}`,
    ];
    for (const url of attempts) {
      try {
        const data = await getJSON(url);
        if (Array.isArray(data) && data.length) {
          const byId = {};
          for (const entry of data) {
            if (entry && entry.player_id) byId[entry.player_id] = entry.stats || {};
          }
          return byId;
        }
      } catch (e) {
        console.warn('Projection endpoint failed, trying next fallback:', url, e.message);
      }
    }
    return null;
  }

  // Real recent scoring history from completed weeks, using the official
  // matchups endpoint. Returns { [player_id]: averagePointsOverWindow }.
  async function getRecentAveragePoints(leagueId, throughWeek, windowSize = 3) {
    const weeks = [];
    for (let w = throughWeek - 1; w >= 1 && weeks.length < windowSize; w--) weeks.push(w);
    const totals = {};
    const counts = {};
    for (const w of weeks) {
      try {
        const matchups = await getMatchups(leagueId, w);
        for (const team of matchups) {
          const pts = team.players_points || {};
          for (const [pid, val] of Object.entries(pts)) {
            totals[pid] = (totals[pid] || 0) + val;
            counts[pid] = (counts[pid] || 0) + 1;
          }
        }
      } catch (e) {
        console.warn(`Could not load matchups for week ${w}`, e);
      }
    }
    const avg = {};
    for (const pid of Object.keys(totals)) avg[pid] = totals[pid] / counts[pid];
    return avg;
  }

  // Real per-week stats for every player who actually recorded a stat line
  // that week (Sleeper's undocumented but reliable stats endpoint -- same
  // family as the projections one above, just actuals instead of
  // forecasts). Returns { [player_id]: rawStatsObject }, feedable straight
  // into Scoring.projectedPointsForLeague exactly like projections are.
  //
  // Crucially, a player who didn't play that week (bye, inactive, hadn't
  // been called up yet) simply has no entry here at all -- unlike the
  // matchups endpoint's players_points, which includes a 0 for those weeks
  // too and so can't distinguish "didn't play" from "played and scored
  // zero". That absence is exactly what callers use to exclude
  // not-played weeks from a season average instead of dragging it down
  // with false zeros.
  //
  // Cached per (season, week) in localStorage since a completed week's
  // actual stats are effectively immutable -- no reason to refetch weeks
  // 1-16 on every load as the season goes on. ttlMs defaults to 6 hours
  // (the current season's most recent week can still see late corrections)
  // but callers pulling a fully-finished prior season pass a much longer
  // one, since that data will never change again.
  async function getActualWeeklyStats(season, week, ttlMs = 6 * 60 * 60 * 1000) {
    const cacheKey = `fcc_actual_stats_v1_${season}_${week}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < ttlMs) return parsed.data;
      } catch (e) { /* fall through to refetch */ }
    }
    let byId = {};
    try {
      const data = await getJSON(`https://api.sleeper.com/stats/nfl/${season}/${week}?season_type=regular`);
      if (Array.isArray(data)) {
        for (const entry of data) {
          if (entry && entry.player_id && entry.stats) byId[entry.player_id] = entry.stats;
        }
      }
    } catch (e) {
      console.warn(`Could not load actual stats for week ${week}`, e);
    }
    try {
      localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: byId }));
    } catch (e) {
      console.warn('Actual-stats cache write failed, continuing without cache.', e);
    }
    return byId;
  }

  return {
    getUser, getUserLeagues, getLeague, getRosters, getLeagueUsers,
    getMatchups, getTransactions, getNflState, getTrendingAdds,
    getPlayersTrimmed, getWeeklyProjections, getRecentAveragePoints,
    getActualWeeklyStats,
  };
})();
