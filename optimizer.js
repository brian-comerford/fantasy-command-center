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
    const assignments = []; // { slot, id, idx }

    for (const { slot, idx } of orderedSlots) {
      const eligible = eligiblePositions(slot);
      const pick = pool.find(p => !used.has(p.id) && eligible.includes(p.pos));
      if (pick) {
        used.add(pick.id);
        assignments.push({ slot, id: pick.id, pts: pick.pts, idx });
      } else {
        assignments.push({ slot, id: null, pts: 0, idx });
      }
    }

    // Return assignments in the original roster_positions order (not the
    // scarcity-fill order used above) so callers can zip them against
    // currentStarters, which Sleeper also orders by roster_positions.
    assignments.sort((a, b) => a.idx - b.idx);
    assignments.forEach(a => delete a.idx);

    const bench = pool.filter(p => !used.has(p.id));
    const totalPts = assignments.reduce((sum, a) => sum + a.pts, 0);

    return { assignments, bench, totalPts };
  }

  // Compares the optimal lineup against the roster's currently-set starters
  // and returns the specific swaps worth making. Comparing by slot index
  // would flag a false "swap" whenever two starters holding identical slots
  // (e.g. two WR spots) just get reordered between each other, since neither
  // player actually leaves the starting lineup - so this compares the SET of
  // who's starting instead, and only reports a swap where someone currently
  // benched should genuinely replace someone currently starting.
  function suggestedSwaps(rosterPositions, currentStarters, playerIds, playerMeta, valuation) {
    const optimal = optimalLineup(rosterPositions, playerIds, playerMeta, valuation);

    const currentSet = new Set(currentStarters.filter(id => id && playerMeta[id]));
    const optimalSet = new Set(optimal.assignments.map(a => a.id).filter(Boolean));

    const additions = optimal.assignments.filter(a => a.id && !currentSet.has(a.id));
    const removedPool = currentStarters.filter(id => id && playerMeta[id] && !optimalSet.has(id));

    const swaps = [];
    additions.forEach(addition => {
      const eligible = eligiblePositions(addition.slot);
      let matchIdx = removedPool.findIndex(id => eligible.includes(playerMeta[id].pos));
      if (matchIdx === -1 && removedPool.length) matchIdx = 0;
      const currentId = matchIdx !== -1 ? removedPool.splice(matchIdx, 1)[0] : null;

      const currentPts = currentId ? (valuation[currentId] ?? 0) : 0;
      const optimalPts = valuation[addition.id] ?? 0;
      if (optimalPts > currentPts + 0.01) {
        swaps.push({
          slot: addition.slot,
          benchPlayer: { id: addition.id, ...playerMeta[addition.id], pts: optimalPts },
          starterPlayer: currentId ? { id: currentId, ...playerMeta[currentId], pts: currentPts } : null,
          gain: Math.round((optimalPts - currentPts) * 100) / 100,
        });
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

  // For one specific rostered player (typically one flagged with an injury
  // status), finds the best replacement available from your own bench and
  // separately from the waiver wire. Either can come back null if there's
  // genuinely no better option.
  //
  // The bench replacement isn't just "the next-best player at the same
  // position" -- it re-runs the full lineup optimizer with this player
  // removed from the pool and reads off whoever the optimizer now assigns
  // to the exact slot they'd vacate, so it correctly accounts for ripple
  // effects (e.g. removing a WR1 might shift a FLEX-eligible RB into that
  // WR slot, with a bench RB filling the FLEX instead, rather than just
  // handing the WR slot to your next-best bench WR).
  function injuryReplacements(playerId, rosterPositions, currentStarters, rosterPlayerIds, allPlayerMeta, valuation, rosteredIdsLeagueWide, trendingAddIds) {
    let benchReplacement = null;
    const slotIndex = (currentStarters || []).indexOf(playerId);
    if (slotIndex !== -1) {
      const startSlots = rosterPositions.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
      const slot = startSlots[slotIndex];
      const remainingPlayers = (rosterPlayerIds || []).filter(id => id !== playerId);
      const hypothetical = optimalLineup(rosterPositions, remainingPlayers, allPlayerMeta, valuation);
      const assignment = hypothetical.assignments[slotIndex];
      if (assignment && assignment.id) {
        benchReplacement = { id: assignment.id, ...allPlayerMeta[assignment.id], pts: assignment.pts, slot };
      }
    }

    let waiverReplacement = null;
    const meta = allPlayerMeta[playerId];
    if (meta) {
      const myPts = valuation[playerId] ?? 0;
      const rosteredSet = new Set(rosteredIdsLeagueWide);
      const candidate = Object.entries(allPlayerMeta)
        .filter(([id, m]) => !rosteredSet.has(id) && m.active && m.team !== 'FA' && m.pos === meta.pos)
        .map(([id, m]) => ({ id, ...m, pts: valuation[id] ?? 0, trending: trendingAddIds.has(id) }))
        .filter(c => c.pts > myPts + 0.01)
        .sort((a, b) => b.pts - a.pts)[0];
      if (candidate) waiverReplacement = candidate;
    }

    return { benchReplacement, waiverReplacement };
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

  return { optimalLineup, suggestedSwaps, waiverTargets, tradeSummary, eligiblePositions, injuryReplacements };
})();
