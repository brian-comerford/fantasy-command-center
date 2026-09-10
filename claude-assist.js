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
 */

const ClaudeAssist = (() => {
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

  return { ask, buildSwapQuestion, buildWaiverQuestion };
})();
