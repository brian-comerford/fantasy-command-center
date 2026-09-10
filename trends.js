/* Two decision-making signals built entirely from data the app already
 * pulls (each played week's actual stats, see SleeperAPI.getActualWeeklyStatsRaw)
 * -- no new API surface, just a deeper look at the same numbers:
 *
 * 1. DVP ("defense vs. position") -- how many fantasy points each NFL
 *    team has allowed per game to QB/RB/WR/TE this season, ranked against
 *    the other 31 teams. Flags a player's upcoming matchup as a Good or
 *    Tough one when their opponent is near either end of that ranking.
 *
 * 2. Usage trend -- a skill player's touches (targets + rush attempts) in
 *    their most recent game vs. their average over the games before that,
 *    as a leading indicator: a role that's expanding or shrinking often
 *    predicts next week's score better than last week's box score alone.
 *
 * Both are season-long-accumulating: DVP needs at least one fully-played
 * week league-wide, and a usage trend needs at least two played games for
 * that specific player, so neither has anything to show in the first
 * week or two of a season -- that's real "not enough data yet", not a
 * bug, and it stops applying as the season goes on.
 */

const Trends = (() => {
  const SKILL_POSITIONS = ['QB', 'RB', 'WR', 'TE'];

  function ordinal(n) {
    const rem100 = n % 100;
    if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
    switch (n % 10) {
      case 1: return `${n}st`;
      case 2: return `${n}nd`;
      case 3: return `${n}rd`;
      default: return `${n}th`;
    }
  }

  // weeklyEntries: array of raw-entry arrays, one per completed week (see
  // SleeperAPI.getActualWeeklyStatsRaw), oldest first. Each raw entry is
  // { player_id, stats, opponent, team }.
  //
  // Returns { [teamAbbr]: { [pos]: { avgPts, rank, outOf, games, tier } } }
  // -- rank 1 allows the MOST points to that position (softest matchup),
  // outOf allows the fewest (toughest). tier is 'good' for the top third
  // of teams, 'tough' for the bottom third, null for the unremarkable
  // middle (not worth calling out either way).
  function computeDvp(weeklyEntries, playerMeta, scoringSettings) {
    const totals = {}; // team -> pos -> { pts, games }

    weeklyEntries.forEach(entries => {
      // Fold this one week's points allowed per (team, position) first,
      // then add ONE game to that team/position's count -- entries are
      // per-player, so a defense that faced three WRs in a game must
      // still only count as having played one game against WRs, not three.
      const weekPts = {}; // team -> pos -> pts this week
      entries.forEach(entry => {
        if (!entry.opponent) return;
        const meta = playerMeta[entry.player_id];
        const pos = meta ? meta.pos : null;
        if (!pos || !SKILL_POSITIONS.includes(pos)) return;
        const pts = Scoring.pointsFromStats(entry.stats, scoringSettings) || 0;
        if (!weekPts[entry.opponent]) weekPts[entry.opponent] = {};
        weekPts[entry.opponent][pos] = (weekPts[entry.opponent][pos] || 0) + pts;
      });
      for (const [team, byPos] of Object.entries(weekPts)) {
        if (!totals[team]) totals[team] = {};
        for (const [pos, pts] of Object.entries(byPos)) {
          if (!totals[team][pos]) totals[team][pos] = { pts: 0, games: 0 };
          totals[team][pos].pts += pts;
          totals[team][pos].games += 1;
        }
      }
    });

    const rowsByPos = {}; // pos -> [{ team, avgPts, games }]
    for (const [team, byPos] of Object.entries(totals)) {
      for (const [pos, { pts, games }] of Object.entries(byPos)) {
        if (!rowsByPos[pos]) rowsByPos[pos] = [];
        rowsByPos[pos].push({ team, avgPts: games ? pts / games : 0, games });
      }
    }

    const dvp = {};
    for (const [pos, rows] of Object.entries(rowsByPos)) {
      rows.sort((a, b) => b.avgPts - a.avgPts);
      const n = rows.length;
      const tierSize = Math.ceil(n / 3);
      rows.forEach((row, i) => {
        const rank = i + 1;
        const tier = rank <= tierSize ? 'good' : rank > n - tierSize ? 'tough' : null;
        if (!dvp[row.team]) dvp[row.team] = {};
        dvp[row.team][pos] = {
          avgPts: Math.round(row.avgPts * 100) / 100,
          rank, outOf: n, tier, games: row.games,
        };
      });
    }
    return dvp;
  }

  // { [team]: opponentTeam } for one week, built from the raw entries
  // fetched for it (either projections or actual stats -- same shape).
  // Every player on a team faces the same opponent that week, so this
  // just needs one entry per team, not per player.
  function buildTeamOpponentMap(entries, playerMeta) {
    const map = {};
    (entries || []).forEach(entry => {
      const team = entry.team || (playerMeta[entry.player_id] && playerMeta[entry.player_id].team);
      if (team && entry.opponent && !map[team]) map[team] = entry.opponent;
    });
    return map;
  }

  // playerWeeklyEntries: this one player's raw entries across played weeks
  // (oldest first), already filtered by the caller to games they actually
  // took an offensive snap in. Returns null if there aren't at least two
  // such games to compare, or an object describing the trend:
  // { direction: 'up'|'down'|'steady', lastTouches, priorAvgTouches,
  //   lastSnapShare, priorAvgSnapShare, lastWeek, gamesConsidered }
  //
  // "Touches" (targets + rush attempts) drives the up/down call -- it's
  // the single most fantasy-relevant usage number and applies the same
  // way across RB/WR/TE. Snap share rides along for the tooltip as
  // supporting context (a role can shift on snaps before it shows up in
  // touches, or vice versa) but doesn't change the verdict on its own.
  function computeUsageTrend(playerWeeklyEntries) {
    if (playerWeeklyEntries.length < 2) return null;

    const toGame = (entry) => {
      const s = entry.stats;
      const offSnp = s.off_snp || 0;
      const tmOffSnp = s.tm_off_snp || 0;
      return {
        week: entry.week,
        touches: (s.rec_tgt || 0) + (s.rush_att || 0),
        snapShare: tmOffSnp ? offSnp / tmOffSnp : null,
      };
    };

    const games = playerWeeklyEntries.map(toGame);
    const last = games[games.length - 1];
    const prior = games.slice(0, -1);
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;

    const priorAvgTouches = avg(prior.map(g => g.touches));
    const priorSnapShares = prior.map(g => g.snapShare).filter(v => v != null);
    const priorAvgSnapShare = priorSnapShares.length ? avg(priorSnapShares) : null;

    // A flat +/-20% relative move isn't enough on its own for players who
    // only see a couple of touches a game -- also require at least a
    // 1-touch absolute swing, so e.g. 1 touch -> 0 doesn't read as a
    // dramatic "down" the way 8 -> 6.4 shouldn't either.
    let direction = 'steady';
    if (last.touches >= priorAvgTouches * 1.2 + 1) direction = 'up';
    else if (last.touches <= Math.max(0, priorAvgTouches * 0.8 - 1)) direction = 'down';

    return {
      direction,
      lastTouches: Math.round(last.touches * 10) / 10,
      priorAvgTouches: Math.round(priorAvgTouches * 10) / 10,
      lastSnapShare: last.snapShare,
      priorAvgSnapShare,
      lastWeek: last.week,
      gamesConsidered: games.length,
    };
  }

  return { ordinal, computeDvp, buildTeamOpponentMap, computeUsageTrend };
})();
