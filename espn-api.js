/* ESPN Fantasy projections, pulled through a small CORS proxy the user hosts
 * themselves (a Cloudflare Worker -- see worker/espn-proxy.js). ESPN's public
 * player-projections endpoint works fine over plain HTTPS but doesn't send
 * CORS headers, so a browser can't read the response directly without one.
 *
 * This is entirely optional: if no proxy URL is configured (or it's
 * unreachable), the app just runs on Sleeper's projections alone, same as
 * before this existed.
 *
 * ESPN's raw player stats are keyed by internal numeric IDs (documented in
 * the open-source espn-api project's PLAYER_STATS_MAP). This file translates
 * only the subset that maps cleanly onto Sleeper's own scoring_settings key
 * names, and only for QB/RB/WR/TE -- kicker and defense scoring differ
 * enough between the two providers (distance-bucketed field goals,
 * points-allowed tiers, etc.) that a naive translation would be more
 * misleading than useful, so K/DEF valuations stay Sleeper-only.
 */

const EspnAPI = (() => {
  const ESPN_STAT_TO_SLEEPER_KEY = {
    0: 'pass_att', 1: 'pass_cmp', 3: 'pass_yd', 4: 'pass_td',
    19: 'pass_2pt', 20: 'pass_int',
    23: 'rush_att', 24: 'rush_yd', 25: 'rush_td', 26: 'rush_2pt',
    41: 'rec', 42: 'rec_yd', 43: 'rec_td', 44: 'rec_2pt', 58: 'rec_tgt',
    68: 'fum', 72: 'fum_lost',
  };

  // Community-maintained ID crosswalk (mfl/sleeper/espn/yahoo/etc IDs for the
  // same players). Static file, refreshed regularly upstream, CORS-open.
  const CROSSWALK_URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
  const CROSSWALK_CACHE_KEY = 'fcc_espn_crosswalk_v1';

  function parseCrosswalkCsv(text) {
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const sleeperIdx = header.indexOf('sleeper_id');
    const espnIdx = header.indexOf('espn_id');
    const map = {}; // sleeper_id -> espn_id
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split(',');
      const sleeperId = cols[sleeperIdx];
      const espnId = cols[espnIdx];
      if (sleeperId && espnId) map[sleeperId] = espnId;
    }
    return map;
  }

  async function getSleeperToEspnMap() {
    const cached = localStorage.getItem(CROSSWALK_CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < 20 * 60 * 60 * 1000) return parsed.data;
      } catch (e) { /* fall through to refetch */ }
    }
    const res = await fetch(CROSSWALK_URL);
    if (!res.ok) throw new Error(`Player ID crosswalk -> HTTP ${res.status}`);
    const text = await res.text();
    const map = parseCrosswalkCsv(text);
    try {
      localStorage.setItem(CROSSWALK_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: map }));
    } catch (e) {
      console.warn('ID crosswalk too large for localStorage, continuing without cache.', e);
    }
    return map;
  }

  // Returns { [sleeper_id]: statsObject } using Sleeper's own stat key names,
  // for QB/RB/WR/TE only, or null if the proxy isn't configured/reachable.
  async function getWeeklyProjections(proxyBaseUrl, season, week) {
    if (!proxyBaseUrl) return null;
    const url = `${proxyBaseUrl.replace(/\/$/, '')}/?season=${season}&week=${week}`;
    const [espnPlayers, sleeperToEspn] = await Promise.all([
      fetch(url).then(r => { if (!r.ok) throw new Error(`ESPN proxy -> HTTP ${r.status}`); return r.json(); }),
      getSleeperToEspnMap(),
    ]);

    const espnToSleeper = {};
    for (const [sleeperId, espnId] of Object.entries(sleeperToEspn)) espnToSleeper[espnId] = sleeperId;

    const out = {};
    for (const player of espnPlayers) {
      const sleeperId = espnToSleeper[String(player.id)];
      if (!sleeperId) continue;
      const entry = (player.stats || []).find(s =>
        s.scoringPeriodId === week && s.seasonId === Number(season) &&
        s.statSourceId === 1 && s.statSplitTypeId === 1
      );
      if (!entry || !entry.stats) continue;
      const stats = {};
      for (const [espnKey, sleeperKey] of Object.entries(ESPN_STAT_TO_SLEEPER_KEY)) {
        const val = entry.stats[espnKey];
        if (typeof val === 'number') stats[sleeperKey] = val;
      }
      if (Object.keys(stats).length) out[sleeperId] = stats;
    }
    return out;
  }

  return { getWeeklyProjections, getSleeperToEspnMap };
})();
