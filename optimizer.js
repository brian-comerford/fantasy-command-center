/* Core decision-making logic: lineup optimization, waiver gap-finding,
 * and trade value comparison. All of it works off a single "valuation"
 * number per player, which the caller builds as projected points where
 * available, falling back to recent actual scoring average otherwise.
 */

const Optimizer = (() => {
  const ELIGIBILITY = {
    QB: ['QB'],
    RB: ['RB'],
    WR: ['WR'],
    TE: ['TE'],
    K: ['K'],
    DEF: ['DEF'],
    FLEX: ['RB', 'WR', 'TE'],
    SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'],
    WRRB_FLEX: ['WR', 'RB'],
    REC_FLEX: ['WR', 'TE'],
    DL: ['DL'],
    LB: ['LB'],
    DB: ['DB'],
    IDP_FLEX: ['DL', 'LB', 'DB'],
  };

  function eligiblePositions(slot) {
    return ELIGIBILITY[slot] || [slot];
  }

  // Slots that accept only one position are filled first; broader slots
  // (FLEX, SUPER_FLEX) are filled last so they don't "steal" a player who
  // was the only option for a strict slot.
  function scarcityRank(slot) {
    return eligiblePositions(slot).length;
  }

  /**
   * @param rosterPositions array from league.roster_positions (includes BN)
   * @param playerIds array of player_ids on the roster
   * @param playerMeta { [id]: { name, pos, team, status } }
   * @param valuation { [id]: number } projected/estimated points
   */
  function optimalLineup(rosterPositions, playerIds, playerMeta, valuation) {
    const startSlots = rosterPositions.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
    const orderedSlots = startSlots
      .map((slot, idx) => ({ slot, idx }))
      .sort((a, b) => scarcityRank(a.slot) - scarcityRank(b.slot) || a.idx - b.idx);

    const pool = playerIds
      .filter(id => id && playerMeta[id])
      .map(id => ({ id, pts: valuation[id] ?? 0, pos: playerMeta[id].pos }))
      .sort((a, b) => b.pts - a.pts);

    const used = new Set();
    const assignments = []; // { slot, id }

    for (const { slot } of orderedSlots) {
      const eligible = eligiblePositions(slot);
      const pick = pool.find(p => !used.has(p.id) && eligible.includes(p.pos));
      if (pick) {
        used.add(pick.id);
        assignments.push({ slot, id: pick.id, pts: pick.pts });
      } else {
        assignments.push({ slot, id: null, pts: 0 });
      }
    }

    const bench = pool.filter(p => !used.has(p.id));
    const totalPts = assignments.reduce((sum, a) => sum + a.pts, 0);

    return { assignments, bench, totalPts };
  }

  // Compares the optimal lineup against the roster's currently-set starters
  // and returns the specific swaps worth making.
  function suggestedSwaps(rosterPositions, currentStarters, playerIds, playerMeta, valuation) {
    const optimal = optimalLineup(rosterPositions, playerIds, playerMeta, valuation);
    const startSlots = rosterPositions.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');

    const swaps = [];
    startSlots.forEach((slot, i) => {
      const currentId = currentStarters[i];
      const optimalId = optimal.assignments[i] ? optimal.assignments[i].id : null;
      if (currentId !== optimalId && optimalId) {
        const currentPts = currentId ? (valuation[currentId] ?? 0) : 0;
        const optimalPts = valuation[optimalId] ?? 0;
        if (optimalPts > currentPts + 0.01) {
          swaps.push({
            slot,
            benchPlayer: { id: optimalId, ...playerMeta[optimalId], pts: optimalPts },
            starterPlayer: currentId ? { id: currentId, ...playerMeta[currentId], pts: currentPts } : null,
            gain: Math.round((optimalPts - currentPts) * 100) / 100,
          });
        }
      }
    });
    return { optimal, swaps };
  }

  // Finds free agents who outproject a roster's weakest starter/bench player
  // at the same position.
  function waiverTargets(rosterPlayerIds, allPlayerMeta, valuation, rosteredIdsLeagueWide, trendingAddIds, limit = 25) {
    const rosteredSet = new Set(rosteredIdsLeagueWide);
    const freeAgents = Object.entries(allPlayerMeta)
      .filter(([id, meta]) => !rosteredSet.has(id) && meta.active && meta.team !== 'FA' && ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(meta.pos))
      .map(([id, meta]) => ({ id, ...meta, pts: valuation[id] ?? 0, trending: trendingAddIds.has(id) }))
      .sort((a, b) => b.pts - a.pts);

    const myByPos = {};
    for (const id of rosterPlayerIds) {
      const meta = allPlayerMeta[id];
      if (!meta) continue;
      const pts = valuation[id] ?? 0;
      if (!myByPos[meta.pos] || pts < myByPos[meta.pos].pts) {
        myByPos[meta.pos] = { id, pts };
      }
    }

    const suggestions = [];
    for (const fa of freeAgents.slice(0, 200)) {
      const weakest = myByPos[fa.pos];
      if (weakest && fa.pts > weakest.pts + 0.01) {
        suggestions.push({
          add: fa,
          considerDropping: { id: weakest.id, ...allPlayerMeta[weakest.id], pts: weakest.pts },
          edge: Math.round((fa.pts - weakest.pts) * 100) / 100,
        });
      }
    }
    suggestions.sort((a, b) => b.edge - a.edge);
    return suggestions.slice(0, limit);
  }

  function tradeSummary(sideAIds, sideBIds, playerMeta, valuation) {
    const summarize = (ids) => {
      const players = ids.map(id => ({ id, ...playerMeta[id], pts: valuation[id] ?? 0 }));
      const total = players.reduce((s, p) => s + p.pts, 0);
      return { players, total: Math.round(total * 100) / 100 };
    };
    const a = summarize(sideAIds);
    const b = summarize(sideBIds);
    return { a, b, diff: Math.round((a.total - b.total) * 100) / 100 };
  }

  return { optimalLineup, suggestedSwaps, waiverTargets, tradeSummary, eligiblePositions };
})();
