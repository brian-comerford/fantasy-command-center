/* CBS Sports consensus rankings -- a third opinion alongside Sleeper and
 * ESPN, used only as a tiebreaker, never averaged into the point
 * projection.
 *
 * CBS's player-rankings endpoint happens to send permissive CORS headers,
 * so unlike ESPN this needs no proxy. But it only gives an integer
 * positional RANK (e.g. "Josh Allen, QB rank 1"), not a point value --
 * their actual numeric projections endpoint requires an auth token we
 * don't have and 500s on every request. Rank also isn't week-specific
 * (it's their season-long overall board), so there's no honest way to
 * convert it into a weekly points number to average alongside the other
 * two sources. Instead it's used purely as a same-position comparison:
 * "does CBS's board also prefer player A over player B here?"
 */

const CbsAPI = (() => {
  const RANKINGS_URL = 'https://api.cbssports.com/fantasy/players/rankings?SPORT=football&version=3.0&response_format=json';
  const CACHE_KEY = 'fcc_cbs_rankings_v1';
  const CACHE_MS = 6 * 60 * 60 * 1000; // shorter than the player-list caches -- rankings shift with injury news through the week

  async function fetchRankingsByCbsId() {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < CACHE_MS) return parsed.data;
      } catch (e) { /* fall through to refetch */ }
    }
    const res = await fetch(RANKINGS_URL);
    if (!res.ok) throw new Error(`CBS rankings -> HTTP ${res.status}`);
    const json = await res.json();
    const positions = (json.body && json.body.rankings && json.body.rankings.positions) || [];
    const byCbsId = {}; // cbsId -> { pos, rank }
    positions.forEach(posBlock => {
      (posBlock.players || []).forEach(p => {
        byCbsId[String(p.id)] = { pos: posBlock.abbr, rank: p.rank };
      });
    });
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: byCbsId }));
    } catch (e) {
      console.warn('CBS rankings cache too large for localStorage, continuing without cache.', e);
    }
    return byCbsId;
  }

  // Returns { [sleeper_id]: { pos, rank } } for players CBS ranks and the
  // ID crosswalk can match to Sleeper, or {} if unavailable.
  async function getSleeperRanks() {
    const [byCbsId, crosswalk] = await Promise.all([
      fetchRankingsByCbsId(),
      PlayerIdCrosswalk.getMap(),
    ]);
    const out = {};
    for (const [sleeperId, ids] of Object.entries(crosswalk)) {
      const entry = ids.cbsId && byCbsId[ids.cbsId];
      if (entry) out[sleeperId] = entry;
    }
    return out;
  }

  return { getSleeperRanks };
})();
