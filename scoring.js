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

  // Blends multiple independently-sourced valuations (e.g. Sleeper + ESPN)
  // into one number per player, plus an "agreement" signal -- how close the
  // sources are, relative to the size of the projection -- so swap/waiver
  // suggestions can be flagged as strong calls vs. shakier ones where the
  // sources disagree.
  //
  // @param sources array of { name, points: { [player_id]: number } }
  // @returns { blended: { [id]: number }, agreement: { [id]: { level, spread, sources } } }
  function blendValuations(sources) {
    const ids = new Set();
    sources.forEach(s => Object.keys(s.points).forEach(id => ids.add(id)));

    const blended = {};
    const agreement = {};
    ids.forEach(id => {
      const values = sources
        .map(s => ({ name: s.name, pts: s.points[id] }))
        .filter(v => typeof v.pts === 'number');
      if (!values.length) return;

      const avg = values.reduce((sum, v) => sum + v.pts, 0) / values.length;
      blended[id] = Math.round(avg * 100) / 100;

      if (values.length < 2) {
        agreement[id] = { level: 'single-source', spread: 0, sources: values };
        return;
      }
      const spread = Math.max(...values.map(v => v.pts)) - Math.min(...values.map(v => v.pts));
      const relSpread = avg > 0 ? spread / avg : 0;
      const level = relSpread <= 0.15 ? 'strong' : relSpread <= 0.35 ? 'moderate' : 'split';
      agreement[id] = { level, spread: Math.round(spread * 100) / 100, sources: values };
    });

    return { blended, agreement };
  }

  return { pointsFromStats, projectedPointsForLeague, blendValuations };
})();
