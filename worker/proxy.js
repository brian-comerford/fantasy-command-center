/* Cloudflare Worker: powers two optional Command Center features.
 *
 * 1. /espn-proxy    -- CORS proxy for ESPN's public fantasy projections
 *    endpoint (see handleEspnProxy below for why it's needed).
 * 2. /claude-assist -- calls the Anthropic API (with live web search) to
 *    research a specific swap/waiver suggestion. Requires an
 *    ANTHROPIC_API_KEY secret on this Worker -- Cloudflare dashboard ->
 *    Workers & Pages -> your worker -> Settings -> Variables and Secrets ->
 *    Add -> type "Secret", name it exactly ANTHROPIC_API_KEY.
 *
 * Both routes are entirely optional -- the app works fine with no Worker
 * deployed at all, just without ESPN blending or the "Ask Claude" button.
 * If you only want one of the two, just don't set up the other's
 * prerequisite (leave ANTHROPIC_API_KEY unset to disable /claude-assist).
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/espn-proxy' || url.pathname === '/espn-proxy/') {
      return handleEspnProxy(url);
    }
    if (url.pathname === '/claude-assist' || url.pathname === '/claude-assist/') {
      return handleClaudeAssist(request, env);
    }
    return new Response('Not found. Try /espn-proxy or /claude-assist.', {
      status: 404,
      headers: corsHeaders(),
    });
  },
};

// ---------------- ESPN proxy ----------------
//
// ESPN's endpoint itself needs no API key and works fine over plain HTTPS --
// it just doesn't send Access-Control-Allow-Origin, so a browser can't read
// the response directly. This route's only job is to add that header.
//
// It deliberately does NOT parse or filter the response: ESPN's own
// documented filter headers (x-fantasy-filter) were tested and don't trim
// this endpoint's payload at all -- it always returns its full ~11,000+
// player database (35-40MB) regardless. Parsing that much JSON would blow
// past Cloudflare's free-plan CPU-time limit (10ms/request), so instead
// this streams the response straight through untouched and lets the
// browser do the parsing/filtering, where a payload that size is trivial
// and gets cached client-side (see espn-api.js) so it only happens once
// every ~20 hours per visitor, not per page load.
async function handleEspnProxy(url) {
  const season = url.searchParams.get('season');
  const week = url.searchParams.get('week');
  if (!season || !week) {
    return new Response('Missing required query params: season, week', {
      status: 400,
      headers: corsHeaders(),
    });
  }

  const espnUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${encodeURIComponent(season)}/players?view=kona_player_info&scoringPeriodId=${encodeURIComponent(week)}`;

  const espnResponse = await fetch(espnUrl, {
    headers: {
      'x-fantasy-filter': JSON.stringify({ players: { filterActive: { value: true } } }),
    },
  });

  const headers = new Headers(espnResponse.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  headers.set('Cache-Control', 'public, max-age=1800');

  // Stream the body straight through -- no buffering, no JSON.parse here.
  return new Response(espnResponse.body, {
    status: espnResponse.status,
    headers,
  });
}

// ---------------- Claude assist ----------------
//
// Takes a short question about one specific swap/waiver decision and asks
// Claude -- with the live web-search tool enabled -- to research it. Web
// search is a server-side tool: Anthropic runs the search and folds the
// results in automatically, so this is a single request/response, no
// client-side tool loop to implement.
//
// Model: claude-opus-5. Each click costs real money on your Anthropic
// account -- roughly a few cents per question at these settings (short
// question in, ~1-3 searches, a short answer capped at max_tokens below).
// If you'd rather trade some quality for lower cost, changing "model" to
// "claude-sonnet-5" cuts the price roughly in half; that's your call to
// make, not something to guess at here.
async function handleClaudeAssist(request, env) {
  if (request.method !== 'POST') {
    return new Response('Use POST', { status: 405, headers: corsHeaders() });
  }
  if (!env.ANTHROPIC_API_KEY) {
    return new Response('This Worker has no ANTHROPIC_API_KEY secret configured.', {
      status: 500,
      headers: corsHeaders(),
    });
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response('Invalid JSON body', { status: 400, headers: corsHeaders() });
  }

  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > 2000) {
    return new Response('Missing or too-long "question" field', { status: 400, headers: corsHeaders() });
  }

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-opus-5',
      max_tokens: 1024,
      output_config: { effort: 'low' }, // quick interactive lookup, not deep reasoning
      system: 'Answer in plain prose only: flowing sentences, no markdown ' +
        '(no **bold**, no headers, no bullet or numbered lists, no asterisks ' +
        'at all). This is displayed as plain text on a small card, not ' +
        'rendered as markdown, so any formatting characters would show up ' +
        'literally.',
      // 3 was too tight for a two-player comparison (each player alone can
      // take 2+ searches for injury/role/matchup), so Claude was running
      // out of budget partway through and returning a hedged non-answer.
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }],
      messages: [{ role: 'user', content: question }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    return new Response(`Claude API error (${anthropicRes.status}): ${errText}`, {
      status: 502,
      headers: corsHeaders(),
    });
  }

  const data = await anthropicRes.json();
  // Web search splits the answer into several small text blocks: adjacent
  // ones (no tool call between them) are fragments of one continuous
  // passage around a citation point, so those get concatenated directly.
  // But a text block separated from the next by a tool_use/tool_result --
  // e.g. Claude's "I'll search for X" remark before the search, then its
  // real answer after -- is a genuinely separate remark, not a citation
  // fragment, and needs a space (not zero, not "\n\n") between it and
  // what follows or the words run together.
  let text = '';
  let lastWasText = false;
  for (const block of data.content || []) {
    if (block.type === 'text') {
      text += (lastWasText || !text ? '' : ' ') + block.text;
      lastWasText = true;
    } else {
      lastWasText = false;
    }
  }
  text = text.replace(/\s+/g, ' ').trim();

  return new Response(JSON.stringify({ text: text || "Claude didn't return a text answer." }), {
    headers: { ...corsHeaders(), 'content-type': 'application/json' },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
