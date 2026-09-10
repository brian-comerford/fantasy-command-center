/* Season and week-by-week performance stats: how my team's actual score
 * compared to its projection each week, plus season-long record and
 * scoring totals. Pulls straight from Sleeper's own matchups endpoint for
 * actual scores (already computed to the league's own settings, same as
 * what Sleeper shows) and the weekly projections endpoint (same one used
 * for the Lineup tab) for what that week's actual starters were expected
 * to score.
 *
 * A week only appears once Sleeper has posted any real stats for it at all
 * (see SleeperAPI.getActualWeeklyStats) -- before kickoff there's nothing
 * real to measure against yet, so it's left out rather than shown as 0-0.
 * The current week specifically is flagged `inProgress` and shown in the
 * table but left out of the season summary's record/averages, since most
 * of the players involved likely haven't played yet and a score can (and
 * for the loaded team, currently 0-for-week, easily will) swing hard
 * before the week actually finishes.
 */

const Stats = (() => {
  function teamName(rosterId, rosters, users) {
    const roster = rosters.find(r => r.roster_id === rosterId);
    if (!roster) return null;
    const user = users.find(u => u.user_id === roster.owner_id);
    return user ? (user.metadata?.team_name || user.display_name) : `Team ${rosterId}`;
  }

  // Returns an array of per-week results, oldest week first, for every
  // week from 1 through currentWeek that Sleeper has actual stats for.
  async function loadWeeklyPerformance(leagueId, myRoster, rosters, users, league, currentWeek, season) {
    const weeks = [];
    for (let w = 1; w <= currentWeek; w++) {
      const weekStats = await SleeperAPI.getActualWeeklyStats(season, w, w === currentWeek ? 15 * 60 * 1000 : undefined);
      if (Object.keys(weekStats).length === 0) break; // this week hasn't kicked off yet

      const [matchups, projections] = await Promise.all([
        SleeperAPI.getMatchups(leagueId, w),
        SleeperAPI.getWeeklyProjections(season, w).catch(() => null),
      ]);

      const myTeam = matchups.find(t => t.roster_id === myRoster.roster_id);
      if (!myTeam) continue;
      const oppTeam = myTeam.matchup_id != null
        ? matchups.find(t => t.matchup_id === myTeam.matchup_id && t.roster_id !== myRoster.roster_id)
        : null;

      const starters = myTeam.starters || [];
      const projByPlayer = projections ? Scoring.projectedPointsForLeague(projections, league.scoring_settings || {}) : null;
      const myProjected = projByPlayer
        ? starters.reduce((sum, pid) => sum + (projByPlayer[pid] || 0), 0)
        : null;

      const myActual = Math.round((myTeam.points || 0) * 100) / 100;
      const oppActual = oppTeam ? Math.round((oppTeam.points || 0) * 100) / 100 : null;
      const result = oppTeam ? (myActual > oppActual ? 'W' : myActual < oppActual ? 'L' : 'T') : null;

      weeks.push({
        week: w,
        myActual,
        oppActual,
        result,
        opponentName: oppTeam ? teamName(oppTeam.roster_id, rosters, users) : null,
        myProjected: myProjected != null ? Math.round(myProjected * 100) / 100 : null,
        diff: myProjected != null ? Math.round((myActual - myProjected) * 100) / 100 : null,
        inProgress: w === currentWeek,
      });
    }
    return weeks;
  }

  // Season-long roll-up over the weeks loadWeeklyPerformance returns.
  // Excludes the in-progress current week (if any) from every figure here
  // -- it's still in the `weeks` array for the table, just not folded into
  // a record/average that should only reflect finished weeks. Returns null
  // if there's no completed week yet.
  function summarize(weeks) {
    const completed = weeks.filter(w => !w.inProgress);
    if (!completed.length) return null;

    const decided = completed.filter(w => w.result);
    const wins = decided.filter(w => w.result === 'W').length;
    const losses = decided.filter(w => w.result === 'L').length;
    const ties = decided.filter(w => w.result === 'T').length;

    const totalFor = completed.reduce((s, w) => s + w.myActual, 0);
    const totalAgainst = decided.reduce((s, w) => s + (w.oppActual || 0), 0);
    const avgFor = totalFor / completed.length;

    const best = completed.reduce((a, b) => (b.myActual > a.myActual ? b : a));
    const worst = completed.reduce((a, b) => (b.myActual < a.myActual ? b : a));

    const withProjection = completed.filter(w => w.diff != null);
    const beatProjection = withProjection.filter(w => w.diff > 0).length;
    const avgDiff = withProjection.length
      ? withProjection.reduce((s, w) => s + w.diff, 0) / withProjection.length
      : null;

    return {
      record: `${wins}-${losses}${ties ? `-${ties}` : ''}`,
      avgFor: Math.round(avgFor * 100) / 100,
      totalFor: Math.round(totalFor * 100) / 100,
      totalAgainst: Math.round(totalAgainst * 100) / 100,
      best,
      worst,
      beatProjection,
      projectionWeeks: withProjection.length,
      avgDiff: avgDiff != null ? Math.round(avgDiff * 100) / 100 : null,
    };
  }

  return { loadWeeklyPerformance, summarize };
})();
