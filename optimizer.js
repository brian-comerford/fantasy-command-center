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

  // Your actual current lineup, exactly as set in Sleeper -- no
  // optimization, just currentStarters read off against rosterPositions
  // (Sleeper orders both the same way, so index i of one is slot i of the
  // other) plus whoever's left over as bench. Same { assignments, bench,
  // totalPts } shape as optimalLineup so callers can render either one
  // the same way; this is what the Lineup tab's own breakdown shows, with
  // optimalLineup reserved for computing the swap suggestions above it.
  function currentLineup(rosterPositions, currentStarters, rosterPlayerIds, playerMeta, valuation) {
    const startSlots = rosterPositions.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
    const assignments = startSlots.map((slot, idx) => {
      const id = (currentStarters || [])[idx];
      if (!id || id === '0' || !playerMeta[id]) return { slot, id: null, pts: 0 };
      return { slot, id, pts: valuation[id] ?? 0 };
    });

    const startedSet = new Set(assignments.map(a => a.id).filter(Boolean));
    const bench = (rosterPlayerIds || [])
      .filter(id => id && playerMeta[id] && !startedSet.has(id))
      .map(id => ({ id, pts: valuation[id] ?? 0, pos: playerMeta[id].pos }))
      .sort((a, b) => b.pts - a.pts);

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

  // For one upcoming week, checks whether the players on bye that week
  // leave any starting slot unfillable that WOULD have been filled at full
  // roster strength -- a gap actually caused by the bye, not a pre-existing
  // thin spot the roster already had regardless of anyone's bye. Compares
  // optimalLineup's assignments index-by-index (same slot position, full
  // roster vs. roster minus that week's bye players) rather than just
  // checking "is anything empty now", since a naturally-empty slot (e.g. no
  // second TE ever rostered) isn't something a bye caused.
  //
  // valuation is deliberately not needed here -- which slots CAN be filled
  // depends only on position eligibility, not on point values, so this
  // passes an empty one through to optimalLineup.
  //
  // Returns the list of affected slot names (e.g. ["RB", "FLEX"]), empty
  // if the bye doesn't actually cost you a startable slot.
  function findByeGaps(rosterPositions, rosterPlayerIds, playerMeta, playerIdsOnBye) {
    const onBye = new Set(playerIdsOnBye);
    const remaining = (rosterPlayerIds || []).filter(id => !onBye.has(id));
    const full = optimalLineup(rosterPositions, rosterPlayerIds || [], playerMeta, {});
    const withByes = optimalLineup(rosterPositions, remaining, playerMeta, {});

    const gaps = [];
    full.assignments.forEach((a, i) => {
      if (a.id && !withByes.assignments[i].id) gaps.push(withByes.assignments[i].slot);
    });
    return gaps;
  }

  // For one slot findByeGaps flagged, suggests two ways to actually fix
  // it: swap the gapped player outright for a free agent who isn't
  // themselves on bye that week, or keep the gapped player and
  // temporarily cut your least valuable bench player instead, just to
  // open a roster spot for that same free agent for the one week (the
  // idea being you drop the fill-in and re-add your own bench player
  // again afterward -- this app doesn't make roster moves for you, so
  // that reversal is on you to remember).
  //
  // Only handles a strict single-position slot (QB/RB/WR/TE/K/DEF) -- a
  // FLEX-type gap means several positions' worth of bench is out at once,
  // rare enough and ambiguous enough about which single position to
  // replace that it's left unsuggested rather than guessed at. Returns
  // null for a FLEX-type slot, or if there's truly no free agent at the
  // position who isn't ALSO on bye that same week.
  function suggestByeGapFix(slot, gapWeek, myRoster, allPlayerMeta, valuation, rosteredIdsLeagueWide, byeWeeks) {
    const eligible = eligiblePositions(slot);
    if (eligible.length !== 1) return null;
    const position = eligible[0];

    const rosteredSet = new Set(rosteredIdsLeagueWide);
    const waiverAdd = Object.entries(allPlayerMeta)
      .filter(([id, meta]) => !rosteredSet.has(id) && meta.active && meta.team !== 'FA'
        && meta.pos === position && byeWeeks[meta.team] !== gapWeek)
      .map(([id, meta]) => ({ id, ...meta, pts: valuation[id] ?? 0 }))
      .sort((a, b) => b.pts - a.pts)[0];
    if (!waiverAdd) return null;

    // Every rostered player at this exact position who's on bye this
    // week -- for a normal single-K/single-DEF roster that's just the one
    // player causing the gap, but a roster carrying two at the position
    // could in principle have both out the same week.
    const gappedPlayers = (myRoster.players || [])
      .filter(id => {
        const meta = allPlayerMeta[id];
        return meta && meta.pos === position && byeWeeks[meta.team] === gapWeek;
      })
      .map(id => ({ id, ...allPlayerMeta[id], pts: valuation[id] ?? 0 }));

    const gappedIds = new Set(gappedPlayers.map(p => p.id));
    const bench = (myRoster.players || [])
      .filter(id => !(myRoster.starters || []).includes(id) && allPlayerMeta[id] && !gappedIds.has(id))
      .map(id => ({ id, ...allPlayerMeta[id], pts: valuation[id] ?? 0 }))
      .sort((a, b) => a.pts - b.pts);

    return { position, waiverAdd, oneForOneDrop: gappedPlayers, tempDrop: bench[0] || null };
  }

  // Scans every OTHER roster in the league for a bench player who'd
  // clearly upgrade one of your own starters -- not a free agent (that's
  // waiverTargets above), a player someone else already owns but isn't
  // using. Only surfaces the target and which of your starters it beats;
  // it deliberately doesn't try to auto-propose a "fair" player to send
  // back -- guessing what the other manager would actually accept is a
  // judgment call, not a numbers problem, so that's left to the trade
  // builder (or Ask Claude) once you've picked a target here.
  //
  // "Bench" is read off optimalLineup for each other roster, same
  // definition used everywhere else in this app: a player that team's own
  // best-possible lineup doesn't have a starting slot for, meaning they
  // already start someone at least as good at that position -- exactly
  // what makes a target plausibly available rather than their best player
  // at the position.
  //
  // K/DEF excluded -- practically nobody trades for a kicker or defense,
  // so a "target" there would just be noise.
  const TRADE_SCAN_POSITIONS = ['QB', 'RB', 'WR', 'TE'];
  const MIN_TRADE_EDGE = 2;

  function leagueTradeScan(myRosterId, rosters, playerMeta, valuation, rosterPositions, limit = 12) {
    const myRoster = rosters.find(r => r.roster_id === myRosterId);
    if (!myRoster) return [];

    const myWeakestStarterByPos = {};
    (myRoster.starters || []).forEach(id => {
      if (!id || id === '0' || !playerMeta[id]) return;
      const meta = playerMeta[id];
      if (!TRADE_SCAN_POSITIONS.includes(meta.pos)) return;
      const pts = valuation[id] ?? 0;
      if (!myWeakestStarterByPos[meta.pos] || pts < myWeakestStarterByPos[meta.pos].pts) {
        myWeakestStarterByPos[meta.pos] = { id, ...meta, pts };
      }
    });

    const opportunities = [];
    rosters.forEach(oppRoster => {
      if (oppRoster.roster_id === myRosterId) return;
      const oppOptimal = optimalLineup(rosterPositions, oppRoster.players || [], playerMeta, valuation);
      oppOptimal.bench.forEach(benchEntry => {
        const meta = playerMeta[benchEntry.id];
        if (!meta || !TRADE_SCAN_POSITIONS.includes(meta.pos)) return;
        const myWeak = myWeakestStarterByPos[meta.pos];
        if (!myWeak) return;
        const edge = Math.round((benchEntry.pts - myWeak.pts) * 100) / 100;
        if (edge <= MIN_TRADE_EDGE) return;
        opportunities.push({
          targetPlayer: { id: benchEntry.id, ...meta, pts: benchEntry.pts },
          myPlayer: myWeak,
          opponentRosterId: oppRoster.roster_id,
          edge,
        });
      });
    });

    // Keep only the single best target per (opponent, position) -- if a
    // team has two bench players who'd both upgrade the same starter,
    // only the better one is worth surfacing.
    const bestByKey = {};
    opportunities.forEach(o => {
      const key = `${o.opponentRosterId}|${o.targetPlayer.pos}`;
      if (!bestByKey[key] || o.edge > bestByKey[key].edge) bestByKey[key] = o;
    });

    return Object.values(bestByKey).sort((a, b) => b.edge - a.edge).slice(0, limit);
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

  return { optimalLineup, currentLineup, suggestedSwaps, waiverTargets, leagueTradeScan, tradeSummary, eligiblePositions, injuryReplacements, findByeGaps, suggestByeGapFix };
})();
