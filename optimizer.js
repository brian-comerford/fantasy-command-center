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

  // Positions the waiver/value tools reason about -- IDP slots are left
  // out here same as everywhere else that already special-cases K/DEF
  // (leagueTradeScan, etc.), since most leagues don't roster them.
  const NEED_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

  // How many starting slots (excluding bench/IR/taxi) each position could
  // fill, counting both its own strict slot(s) and any shared FLEX-type
  // slot it's eligible for -- a rough measure of how many good players a
  // full-strength roster actually needs at that position, used below to
  // judge depth against real demand rather than against a fixed slot count.
  function positionDemand(rosterPositions) {
    const startSlots = rosterPositions.filter(s => s !== 'BN' && s !== 'IR' && s !== 'TAXI');
    const demand = {};
    NEED_POSITIONS.forEach(pos => { demand[pos] = 0; });
    startSlots.forEach(slot => {
      eligiblePositions(slot).forEach(pos => {
        if (pos in demand) demand[pos] += 1;
      });
    });
    return demand;
  }

  // Every ROSTERED player league-wide at each position, best to worst by
  // valuation -- the full universe of "ownable" quality at that position
  // right now. Ranking a roster's own players against this (instead of
  // just against that same roster's single weakest player) is what lets
  // "team need" below tell a genuinely thin position apart from one that
  // only looks weak because its own worst bench player is, well, a bench
  // player.
  function leagueWideByPosition(rosters, playerMeta, valuation) {
    const byPos = {};
    NEED_POSITIONS.forEach(pos => { byPos[pos] = []; });
    rosters.forEach(roster => {
      (roster.players || []).forEach(id => {
        const meta = playerMeta[id];
        if (!meta || !(meta.pos in byPos)) return;
        byPos[meta.pos].push({ id, rosterId: roster.roster_id, pts: valuation[id] ?? 0 });
      });
    });
    NEED_POSITIONS.forEach(pos => byPos[pos].sort((a, b) => b.pts - a.pts));
    return byPos;
  }

  // Replacement level per position: the valuation of the player sitting
  // right at the point in the league-wide ranking where every team's
  // demand for that position (positionDemand * number of teams) runs out
  // -- roughly "the best player still sitting on the waiver wire," i.e.
  // the standard fantasy-analysis baseline that a player's real value is
  // measured ABOVE, not their raw point total (which just rewards
  // high-scoring positions like RB/WR over e.g. TE regardless of how
  // replaceable a given player actually is).
  function replacementLevels(rosterPositions, rosters, playerMeta, valuation) {
    const demand = positionDemand(rosterPositions);
    const leagueWide = leagueWideByPosition(rosters, playerMeta, valuation);
    const numTeams = rosters.length || 1;
    const levels = {};
    NEED_POSITIONS.forEach(pos => {
      const pool = leagueWide[pos];
      if (!pool.length) { levels[pos] = 0; return; }
      const rank = Math.max(1, Math.round(numTeams * (demand[pos] || 0)));
      const idx = Math.min(rank, pool.length) - 1;
      levels[pos] = pool[idx].pts;
    });
    return levels;
  }

  // How thin or deep a roster genuinely is at each position, relative to
  // the rest of the league -- not "what's my single worst player here"
  // (which just describes a bench, every roster has a worst player at
  // every position it rosters two-plus of), but where this roster's own
  // players at that position actually RANK among every player anyone in
  // the league has rostered there. A position where my players sit near
  // the top of that league-wide list is a real strength; one where
  // they're buried in the bottom half, or I don't even have enough of
  // them to fill my own starting need, is a real weakness -- exactly the
  // "3 good RBs but only 1-2 good WRs" case this is meant to catch.
  // needScore is 0 (as deep as it gets) to 1 (worst possible); a missing
  // starter-tier player counts as the worst possible rank, since not
  // having enough bodies at a position is itself a need.
  function positionalNeed(rosterPositions, rosters, myRosterId, playerMeta, valuation) {
    const demand = positionDemand(rosterPositions);
    const leagueWide = leagueWideByPosition(rosters, playerMeta, valuation);
    const myRoster = rosters.find(r => r.roster_id === myRosterId);
    const myIds = new Set((myRoster && myRoster.players) || []);

    const need = {};
    NEED_POSITIONS.forEach(pos => {
      const pool = leagueWide[pos];
      const need_n = demand[pos] || 0;
      if (!pool.length || !need_n) {
        need[pos] = { needScore: 0, demand: need_n };
        return;
      }
      const myRanks = pool
        .map((p, i) => ({ id: p.id, rank: i + 1 }))
        .filter(p => myIds.has(p.id))
        .map(p => p.rank)
        .sort((a, b) => a - b)
        .slice(0, need_n);
      while (myRanks.length < need_n) myRanks.push(pool.length + 1);

      const avgRank = myRanks.reduce((s, r) => s + r, 0) / myRanks.length;
      const needScore = Math.max(0, Math.min(1, avgRank / (pool.length + 1)));
      need[pos] = { needScore, demand: need_n };
    });
    return need;
  }

  // How much extra weight a real positional need adds to a waiver edge's
  // sort priority -- 0 (no need) leaves the edge as-is, 1 (maximum need)
  // doubles it, so a smaller edge at a position the roster is genuinely
  // thin at can outrank a bigger edge at one that's already stacked.
  const NEED_WEIGHT = 1;

  // Finds free agents who outproject a roster's weakest starter/bench
  // player at the same position, same as before, but sorted by a priority
  // score that also weighs in how much of a real team need that position
  // is (see positionalNeed above) -- not just the raw point edge, and not
  // just "replace whichever single player happens to be my lowest scorer,"
  // since that alone can't tell a genuinely thin position apart from a
  // deep one that simply has to have a last-ranked player too.
  function waiverTargets(rosterPlayerIds, allPlayerMeta, valuation, rosteredIdsLeagueWide, trendingAddIds, rosters, rosterPositions, myRosterId, limit = 25) {
    const rosteredSet = new Set(rosteredIdsLeagueWide);
    const freeAgents = Object.entries(allPlayerMeta)
      .filter(([id, meta]) => !rosteredSet.has(id) && meta.active && meta.team !== 'FA' && NEED_POSITIONS.includes(meta.pos))
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

    const need = positionalNeed(rosterPositions, rosters, myRosterId, allPlayerMeta, valuation);

    const suggestions = [];
    for (const fa of freeAgents.slice(0, 200)) {
      const weakest = myByPos[fa.pos];
      if (weakest && fa.pts > weakest.pts + 0.01) {
        const edge = Math.round((fa.pts - weakest.pts) * 100) / 100;
        const needScore = (need[fa.pos] && need[fa.pos].needScore) || 0;
        const priority = edge * (1 + NEED_WEIGHT * needScore);
        suggestions.push({
          add: fa,
          considerDropping: { id: weakest.id, ...allPlayerMeta[weakest.id], pts: weakest.pts },
          edge,
          needScore: Math.round(needScore * 100) / 100,
          priority,
        });
      }
    }
    suggestions.sort((a, b) => b.priority - a.priority);
    return suggestions.slice(0, limit);
  }

  // The best free agents on the wire, full stop -- independent of this
  // roster's own needs, ranked by value over replacement (a player's
  // valuation minus their position's replacementLevel above) rather than
  // raw points, so a QB/RB/WR/TE/K/DEF's genuinely scarce value at their
  // own position is what's being compared, not positions with naturally
  // higher point totals crowding out the rest.
  function bestAvailableValue(allPlayerMeta, valuation, rosteredIdsLeagueWide, trendingAddIds, rosters, rosterPositions, limit = 15) {
    const rosteredSet = new Set(rosteredIdsLeagueWide);
    const levels = replacementLevels(rosterPositions, rosters, allPlayerMeta, valuation);
    const values = Object.entries(allPlayerMeta)
      .filter(([id, meta]) => !rosteredSet.has(id) && meta.active && meta.team !== 'FA' && NEED_POSITIONS.includes(meta.pos))
      .map(([id, meta]) => {
        const pts = valuation[id] ?? 0;
        const vor = Math.round((pts - (levels[meta.pos] || 0)) * 100) / 100;
        return { id, ...meta, pts, vor, trending: trendingAddIds.has(id) };
      })
      .filter(fa => fa.vor > 0)
      .sort((a, b) => b.vor - a.vor);
    return values.slice(0, limit);
  }

  // For one specific rostered player (typically one flagged with an injury
  // status), finds the best replacement available from your own bench and
  // separately from the waiver wire. Either can come back null if there's
  // genuinely no better option.
  //
  // The bench replacement isn't just "the next-best player at the same
  // position" -- it compares the optimal lineup WITH this player available
  // against the optimal lineup WITHOUT them, and reads off whoever is
  // newly in the second one. Both sides go through the same optimizer, so
  // the diff isolates exactly the ripple this one player's absence causes
  // (e.g. a FLEX-eligible player sliding over, a true bench player finally
  // getting a slot) -- as opposed to diffing against the user's actual
  // real-world starters, which can disagree with the optimizer for
  // reasons that have nothing to do with this injury (a different
  // starter they're already benching by choice, say), and would then get
  // wrongly reported as "the bench replacement" for an unrelated slot.
  //
  // Comparing by the SET of who's starting, not a fixed slot index,
  // matters too: with two interchangeable slots (e.g. two WR spots), the
  // optimizer's greedy refill can slide an already-starting player (the
  // other WR) into the exact slot index a naive comparison would read,
  // while the genuine bench player who actually joins the lineup lands in
  // the OTHER WR slot instead -- which misreads as "your other starter is
  // the bench replacement", i.e. suggesting a player who's already in
  // your lineup.
  // waiverValuation lets the waiver-side search use a different number
  // than the bench-side lineup math above it -- specifically so it can be
  // handed a version of valuation with this week's real score swapped in
  // for anyone who's already played (see waiverTradeValuation in app.js),
  // rather than a stale pre-game projection for a game that's already
  // over. Defaults to plain valuation so existing callers keep working
  // unchanged.
  function injuryReplacements(playerId, rosterPositions, currentStarters, rosterPlayerIds, allPlayerMeta, valuation, rosteredIdsLeagueWide, trendingAddIds, waiverValuation = valuation) {
    let benchReplacement = null;
    if ((currentStarters || []).includes(playerId)) {
      const withPlayer = optimalLineup(rosterPositions, rosterPlayerIds, allPlayerMeta, valuation);
      const withPlayerSet = new Set(withPlayer.assignments.map(a => a.id).filter(Boolean));

      const remainingPlayers = (rosterPlayerIds || []).filter(id => id !== playerId);
      const withoutPlayer = optimalLineup(rosterPositions, remainingPlayers, allPlayerMeta, valuation);
      const addition = withoutPlayer.assignments.find(a => a.id && !withPlayerSet.has(a.id));
      if (addition) {
        benchReplacement = { id: addition.id, ...allPlayerMeta[addition.id], pts: addition.pts, slot: addition.slot };
      }
    }

    let waiverReplacement = null;
    const meta = allPlayerMeta[playerId];
    if (meta) {
      const myPts = waiverValuation[playerId] ?? 0;
      const rosteredSet = new Set(rosteredIdsLeagueWide);
      const candidate = Object.entries(allPlayerMeta)
        .filter(([id, m]) => !rosteredSet.has(id) && m.active && m.team !== 'FA' && m.pos === meta.pos)
        .map(([id, m]) => ({ id, ...m, pts: waiverValuation[id] ?? 0, trending: trendingAddIds.has(id) }))
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

  return { optimalLineup, currentLineup, suggestedSwaps, waiverTargets, bestAvailableValue, positionalNeed, leagueTradeScan, tradeSummary, eligiblePositions, injuryReplacements, findByeGaps, suggestByeGapFix };
})();
