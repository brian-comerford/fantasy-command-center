/* Converts raw stat projections into fantasy points using each league's own
 * scoring_settings, so a custom-scored league (e.g. TE premium, 6pt passing
 * TDs) gets numbers that actually match its rules -- not a generic PPR guess.
 */

const Scoring = (() => {
  function pointsFromStats(statsObj, scoringSettings) {
    if (!statsObj || !scoringSettings) return null;
    let total = 0;
    let matched = false;
    for (const [stat, weight] of Object.entries(scoringSettings)) {
      const val = statsObj[stat];
      if (typeof val === 'number' && typeof weight === 'number') {
        total += val * weight;
        matched = true;
      }
    }
    return matched ? Math.round(total * 100) / 100 : null;
  }

  // Given projections (raw stats by player) + league scoring settings,
  // produce { [player_id]: points }. Falls back to Sleeper's own
  // precomputed pts_ppr/pts_half_ppr/pts_std if the raw-stat math yields
  // nothing (e.g. a stat key Sleeper added that we didn't compute against).
  function projectedPointsForLeague(projectionsById, scoringSettings) {
    const out = {};
    for (const [pid, stats] of Object.entries(projectionsById)) {
      let pts = pointsFromStats(stats, scoringSettings);
      if (pts === null) {
        const isPPR = (scoringSettings.rec || 0) >= 1;
        const isHalf = (scoringSettings.rec || 0) > 0 && (scoringSettings.rec || 0) < 1;
        pts = isPPR ? stats.pts_ppr : (isHalf ? stats.pts_half_ppr : stats.pts_std);
      }
      out[pid] = typeof pts === 'number' ? Math.round(pts * 100) / 100 : 0;
    }
    return out;
  }

  return { pointsFromStats, projectedPointsForLeague };
})();
