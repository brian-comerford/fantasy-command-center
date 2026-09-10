/* "Ask Claude" -- an on-demand research assistant for a specific swap or
 * waiver suggestion. Calls the /claude-assist route on the same Worker
 * used for ESPN blending (see worker/proxy.js); the Anthropic API key
 * lives only on that Worker as a secret, never in this file or the
 * browser.
 *
 * Entirely optional and click-triggered: nothing here runs unless the user
 * has configured a Worker proxy URL and clicks "Ask Claude" on a specific
 * card. No automatic/background calls -- each click is a real, billed
 * request on the user's own Anthropic account.
 *
 * Answers are cached in localStorage per (league, week, player pair) so
 * coming back to a suggestion you already asked about shows the same
 * answer for free instead of spending tokens again. Entries older than
 * CACHE_TTL_MS are pruned on write -- well past the week or two a given
 * suggestion stays relevant, so it's just housekeeping, not a real
 * expiration a user would notice.
 */

const ClaudeAssist = (() => {
  const CACHE_KEY = 'fcc_claude_answer_cache_v1';
  const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

  function cacheKeyFor({ type, leagueId, season, week, aId, bId }) {
    return [type, leagueId, season, week, aId, bId || ''].join('|');
  }

  function loadCacheStore() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function pruneAndSave(store) {
    const cutoff = Date.now() - CACHE_TTL_MS;
    for (const [key, entry] of Object.entries(store)) {
      if (!entry || entry.ts < cutoff) delete store[key];
    }
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(store));
    } catch (e) {
      console.warn('Claude answer cache too large for localStorage, continuing without saving this entry.', e);
    }
  }

  // Returns { text, ts } or null.
  function getCached(key) {
    return loadCacheStore()[key] || null;
  }

  function setCached(key, text) {
    const store = loadCacheStore();
    store[key] = { text, ts: Date.now() };
    pruneAndSave(store);
  }

  async function ask(proxyBaseUrl, question) {
    if (!proxyBaseUrl) throw new Error('No Worker proxy URL configured.');
    const res = await fetch(`${proxyBaseUrl.replace(/\/$/, '')}/claude-assist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${errText ? `: ${errText}` : ''}`);
    }
    const data = await res.json();
    return data.text;
  }

  function buildSwapQuestion({ league, week, season, incoming, outgoing, slot }) {
    const outgoingPart = outgoing
      ? `currently-started ${outgoing.name} (${outgoing.pos} ${outgoing.team})`
      : `an empty ${slot} slot`;
    return `I play fantasy football in a league called "${league}" (${season} season, ` +
      `Week ${week}). My lineup tool suggests starting ${incoming.name} ` +
      `(${incoming.pos} ${incoming.team}) over ${outgoingPart} in my ${slot} slot. ` +
      `Search for the latest news on both players -- injury status, snap counts/role, ` +
      `this week's matchup difficulty, and any beat-reporter or start/sit buzz -- and ` +
      `give me a short, concrete take (3-5 sentences) on whether this swap looks right ` +
      `this week.`;
  }

  function buildWaiverQuestion({ league, week, season, add, drop }) {
    return `I play fantasy football in a league called "${league}" (${season} season, ` +
      `Week ${week}). My waiver tool suggests adding free agent ${add.name} ` +
      `(${add.pos} ${add.team}) and dropping my ${drop.name} (${drop.pos} ${drop.team}). ` +
      `Search for the latest news on both -- why ${add.name} is available, recent role ` +
      `or snap-count changes, injury status, and upcoming matchups -- and give me a ` +
      `short, concrete take (3-5 sentences) on whether this pickup looks right this week.`;
  }

  function buildInjuryQuestion({ league, week, season, player, injuryLabel, benchReplacement, waiverReplacement }) {
    const replacementParts = [];
    if (benchReplacement) replacementParts.push(`benching them for ${benchReplacement.name} (${benchReplacement.pos} ${benchReplacement.team}) from my own roster`);
    if (waiverReplacement) replacementParts.push(`picking up free agent ${waiverReplacement.name} (${waiverReplacement.pos} ${waiverReplacement.team})`);
    const replacementPart = replacementParts.length
      ? ` If they can't go, my options are ${replacementParts.join(' or ')} -- ` +
        `say which one you'd take.`
      : ` I don't have an obvious replacement for them on my roster or the waiver wire, ` +
        `so also flag if that's a real problem given how unclear their status is.`;
    const rosterPart = player.isStarter
      ? `My starting ${player.pos} ${player.name} (${player.team})`
      : `My benched ${player.pos} ${player.name} (${player.team})`;
    const decisionPart = player.isStarter
      ? 'whether I should trust them to start'
      : 'whether they\'re worth starting over a healthy option, or worth dropping';
    return `I play fantasy football in a league called "${league}" (${season} season, ` +
      `Week ${week}). ${rosterPart} is listed as ${injuryLabel}. Search for the latest ` +
      `on their actual status -- practice participation this week, beat-reporter or ` +
      `team-source updates, and how likely they are to play meaningful snaps if active -- ` +
      `and give me a short, concrete take (3-5 sentences) on ${decisionPart}.${replacementPart}`;
  }

  return { ask, buildSwapQuestion, buildWaiverQuestion, buildInjuryQuestion, cacheKeyFor, getCached, setCached };
})();
