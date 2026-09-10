/* Shared player-ID crosswalk: Sleeper's IDs don't match ESPN's or CBS's, so
 * anything that blends in an outside source needs a lookup table between
 * them. This pulls a community-maintained one (mfl/sleeper/espn/cbs/yahoo/
 * etc IDs for the same players), a static CSV hosted on GitHub that's kept
 * up to date upstream and happens to allow direct cross-origin reads.
 */

const PlayerIdCrosswalk = (() => {
  const URL = 'https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv';
  const CACHE_KEY = 'fcc_player_id_crosswalk_v2';
  const CACHE_MS = 20 * 60 * 60 * 1000;

  function parse(text) {
    const lines = text.split('\n');
    const header = lines[0].split(',');
    const sleeperIdx = header.indexOf('sleeper_id');
    const espnIdx = header.indexOf('espn_id');
    const cbsIdx = header.indexOf('cbs_id');
    const map = {}; // sleeper_id -> { espnId, cbsId }
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      const cols = line.split(',');
      const sleeperId = cols[sleeperIdx];
      if (!sleeperId) continue;
      map[sleeperId] = {
        espnId: cols[espnIdx] || null,
        cbsId: cols[cbsIdx] || null,
      };
    }
    return map;
  }

  // Returns { [sleeper_id]: { espnId, cbsId } }
  async function getMap() {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (Date.now() - parsed.ts < CACHE_MS) return parsed.data;
      } catch (e) { /* fall through to refetch */ }
    }
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Player ID crosswalk -> HTTP ${res.status}`);
    const text = await res.text();
    const map = parse(text);
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: map }));
    } catch (e) {
      console.warn('ID crosswalk too large for localStorage, continuing without cache.', e);
    }
    return map;
  }

  return { getMap };
})();
