/* FFToday weekly projections, pulled through the same CORS proxy pattern
 * used for ESPN (see worker/proxy.js) -- FFToday's pages work fine over
 * plain HTTPS but send no CORS headers, so a browser can't read them
 * directly without one.
 *
 * Unlike ESPN, FFToday has no numeric player-ID crosswalk to lean on --
 * it's server-rendered HTML tables, not a JSON API with player IDs at all.
 * Players are matched by name + team against Sleeper's own player list
 * instead. That's inherently fuzzier than an ID lookup (suffixes, accents,
 * punctuation), so both sides are normalized aggressively to compensate;
 * anyone who still doesn't match is just silently skipped rather than
 * guessed at.
 *
 * Entirely optional, same as ESPN: if the proxy isn't configured or
 * unreachable, the app runs on whatever other sources it already has.
 *
 * Only QB/RB/WR/TE -- FFToday's kicker page isn't distance-bucketed and it
 * has no real defense projections at all (rank-only, not a stat
 * breakdown), so both stay out of the blend for the same reason ESPN's
 * blending already excludes K/DEF.
 */

const FFTodayAPI = (() => {
  const POS_IDS = { QB: 10, RB: 20, WR: 30, TE: 40 };

  // A handful of well-known team-code spellings that differ between sites.
  // Sleeper and FFToday agree on nearly everything else.
  const TEAM_ALIASES = { JAC: 'JAX', WSH: 'WAS', LA: 'LAR' };

  // Combining diacritical marks (U+0300-U+036F) after normalize('NFD')
  // splits an accented letter into base + mark -- built from numeric code
  // points rather than a literal character class so no actual combining
  // character has to sit in this file (those are exactly the kind of
  // bytes that get silently mangled by a non-UTF-8-safe editor or
  // terminal somewhere along the way).
  const COMBINING_MARKS = new RegExp(
    `[${String.fromCharCode(0x0300)}-${String.fromCharCode(0x036f)}]`, 'g'
  );

  function normalizeName(name) {
    return (name || '')
      .toLowerCase()
      .normalize('NFD').replace(COMBINING_MARKS, '') // strip accents
      .replace(/[^a-z0-9 ]/g, '') // strip punctuation/hyphens
      .replace(/\s+(jr|sr|ii|iii|iv)$/, '') // strip common suffixes
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeTeam(team) {
    const t = (team || '').toUpperCase().trim();
    return TEAM_ALIASES[t] || t;
  }

  // Parses one position's projections page into [{ name, team, ...rawStats }]
  // using Sleeper's own stat key names. Anchored on finding a header row
  // that contains a "Player" cell rather than a fixed table index or row
  // count, since FFToday's page has several unrelated layout tables above
  // the data table and the exact row count shifts with bye weeks.
  function parseTable(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tables = Array.from(doc.querySelectorAll('table'));
    for (const table of tables) {
      const rows = Array.from(table.rows);
      // The "Player" header cell also embeds a "Sort First/Last" control in
      // its own text, so it's a prefix match, not an exact one.
      const headerRowIdx = rows.findIndex(r => Array.from(r.cells).some(c => c.textContent.trim().startsWith('Player')));
      if (headerRowIdx === -1) continue;

      const headerCells = Array.from(rows[headerRowIdx].cells).map(c => c.textContent.trim());
      // QB's table has a Passing section (Comp/Att/Yard/TD/INT) before
      // Rushing; RB/WR/TE only have Rushing then Receiving. "Comp" only
      // appears on the QB layout, so it's a reliable way to tell them apart.
      const isQB = headerCells.includes('Comp');

      const players = [];
      for (const row of rows.slice(headerRowIdx + 1)) {
        const cells = Array.from(row.cells).map(c => c.textContent.trim());
        if (cells.length < headerCells.length) continue; // stray non-data row
        const name = cells[1];
        const team = cells[2];
        if (!name || !team) continue;
        const num = (i) => parseFloat(cells[i]) || 0;
        if (isQB) {
          // [Chg, Player, Team, Opp, Comp, Att, Yard, TD, INT, Att, Yard, TD, FPts]
          players.push({
            name, team,
            pass_cmp: num(4), pass_att: num(5), pass_yd: num(6), pass_td: num(7), pass_int: num(8),
            rush_att: num(9), rush_yd: num(10), rush_td: num(11),
          });
        } else {
          // [Chg, Player, Team, Opp, Att, Yard, TD, Rec, Yard, TD, FPts]
          players.push({
            name, team,
            rush_att: num(4), rush_yd: num(5), rush_td: num(6),
            rec: num(7), rec_yd: num(8), rec_td: num(9),
          });
        }
      }
      return players;
    }
    return [];
  }

  // Returns { [sleeper_id]: statsObject } using Sleeper's own stat key
  // names, for QB/RB/WR/TE only, or null if the proxy isn't
  // configured. A single position's page failing (rate limit, layout
  // change) doesn't sink the other three -- it's just skipped.
  async function getWeeklyProjections(proxyBaseUrl, season, week, playerMeta) {
    if (!proxyBaseUrl) return null;

    const nameTeamToSleeperId = {};
    for (const [id, meta] of Object.entries(playerMeta)) {
      if (!['QB', 'RB', 'WR', 'TE'].includes(meta.pos)) continue;
      const key = `${normalizeName(meta.name)}|${normalizeTeam(meta.team)}`;
      nameTeamToSleeperId[key] = id;
    }

    const out = {};
    for (const [pos, posId] of Object.entries(POS_IDS)) {
      let html;
      try {
        const url = `${proxyBaseUrl.replace(/\/$/, '')}/fftoday-proxy?season=${season}&week=${week}&posId=${posId}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`FFToday proxy -> HTTP ${res.status}`);
        html = await res.text();
      } catch (e) {
        console.warn(`FFToday: could not load ${pos} projections, continuing without them.`, e);
        continue;
      }
      for (const p of parseTable(html)) {
        const key = `${normalizeName(p.name)}|${normalizeTeam(p.team)}`;
        const sleeperId = nameTeamToSleeperId[key];
        if (!sleeperId) continue;
        const { name, team, ...stats } = p;
        out[sleeperId] = stats;
      }
    }
    return out;
  }

  return { getWeeklyProjections };
})();
