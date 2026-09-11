/* Cloudflare Worker: powers three optional Command Center features.
 *
 * 1. /espn-proxy    -- CORS proxy for ESPN's public fantasy projections
 *    endpoint (see handleEspnProxy below for why it's needed).
 * 2. /fftoday-proxy -- CORS proxy for FFToday's public weekly projections
 *    pages (see handleFFTodayProxy below).
 * 3. /claude-assist -- calls the Anthropic API (with live web search) to
 *    research a specific swap/waiver suggestion. Requires an
 *    ANTHROPIC_API_KEY secret on this Worker -- Cloudflare dashboard ->
 *    Workers & Pages -> your worker -> Settings -> Variables and Secrets ->
 *    Add -> type "Secret", name it exactly ANTHROPIC_API_KEY.
 *
 * All three routes are entirely optional -- the app works fine with no
 * Worker deployed at all, just without ESPN/FFToday blending or the
 * "Ask Claude" button. If you only want some of these, just don't set up
 * the others' prerequisites (leave ANTHROPIC_API_KEY unset to disable
 * /claude-assist).
 *
 * WORKER_VERSION below is bumped by hand on every edit to this file. Since
 * editing/committing it locally does NOT change what's actually running on
 * Cloudflare -- only pasting it into the dashboard and clicking Deploy does
 * that -- visiting the bare Worker URL (GET /) shows which version is
 * really deployed, so a stale-code guess doesn't have to be one.
 */

const WORKER_VERSION = 5;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/' || url.pathname === '') {
      return new Response(JSON.stringify({
        ok: true,
        worker_version: WORKER_VERSION,
        routes: ['/espn-proxy', '/fftoday-proxy', '/claude-assist'],
        claude_assist_configured: Boolean(env.ANTHROPIC_API_KEY),
      }, null, 2), {
        headers: { ...corsHeaders(), 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/espn-proxy' || url.pathname === '/espn-proxy/') {
      return handleEspnProxy(url);
    }
    if (url.pathname === '/fftoday-proxy' || url.pathname === '/fftoday-proxy/') {
      return handleFFTodayProxy(url);
    }
    if (url.pathname === '/claude-assist' || url.pathname === '/claude-assist/') {
      return handleClaudeAssist(request, env);
    }
    return new Response('Not found. Try /espn-proxy, /fftoday-proxy, or /claude-assist.', {
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

// ---------------- FFToday proxy ----------------
//
// FFToday's weekly projections pages work fine over plain HTTPS but send no
// CORS headers, so a browser can't read them directly. This route just adds
// those headers, same trick as the ESPN proxy above -- but unlike ESPN,
// FFToday has no JSON API at all, only server-rendered HTML tables, so this
// streams that HTML straight through and the browser parses the table
// itself (see fftoday-api.js) rather than trying to parse HTML inside a
// Worker, which has no DOM to do it with.
//
// posId picks which position's page to fetch (QB=10, RB=20, WR=30, TE=40 --
// see fftoday-api.js for where those map from). Kicker and defense
// deliberately aren't proxied here: FFToday's kicker projections aren't
// distance-bucketed and it has no real defense projections at all (rank
// only), so both stay Sleeper-only same as ESPN blending already does.
async function handleFFTodayProxy(url) {
  const season = url.searchParams.get('season');
  const week = url.searchParams.get('week');
  const posId = url.searchParams.get('posId');
  if (!season || !week || !posId) {
    return new Response('Missing required query params: season, week, posId', {
      status: 400,
      headers: corsHeaders(),
    });
  }

  const fftodayUrl = `https://www.fftoday.com/rankings/playerwkproj.php?Season=${encodeURIComponent(season)}&GameWeek=${encodeURIComponent(week)}&PosID=${encodeURIComponent(posId)}&LeagueID=`;

  const fftodayResponse = await fetch(fftodayUrl);

  const headers = new Headers(fftodayResponse.headers);
  Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));
  headers.set('Cache-Control', 'public, max-age=1800');

  return new Response(fftodayResponse.body, {
    status: fftodayResponse.status,
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
// Model: claude-sonnet-5 -- noticeably faster than Opus 5 for this kind of
// quick lookup-and-summarize task (short question in, a few searches, a
// short answer out), at roughly half the cost too. If you want it faster
// still and can live with less nuanced takes, "claude-haiku-4-5-20251001"
// is faster and cheaper again; if you want Opus-level nuance back and can
// live with slower/pricier, "claude-opus-5" is the other direction. Each
// click costs real money on your Anthropic account either way -- at
// Sonnet 5 it's roughly a cent or two per question at these settings.
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
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      output_config: { effort: 'low' }, // quick interactive lookup, not deep reasoning
      system: 'Answer in plain prose only: flowing sentences, no markdown ' +
        '(no **bold**, no headers, no bullet or numbered lists, no asterisks ' +
        'at all). This is displayed as plain text on a small card, not ' +
        'rendered as markdown, so any formatting characters would show up ' +
        'literally. Do not narrate what you are about to do (no "I\'ll ' +
        'search for...", "Let me check...", etc.) -- just give the final ' +
        'answer directly. If the question asks you to end with a ' +
        '"PROJECTIONS:" line, include exactly that line, in exactly the ' +
        'format requested, as the very last line of your response -- that ' +
        'one line is the only exception to the plain-prose rule above.',
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
  // Only the text blocks AFTER the last tool call are the real answer.
  // Anything before that is narration Claude said on the way there ("I'll
  // search for X", "Now let me check Y") -- not part of the answer, so it
  // gets dropped entirely rather than displayed. The system prompt above
  // also asks Claude not to narrate, but this doesn't depend on it
  // actually complying.
  //
  // Within that final stretch, web search splits the answer into several
  // small adjacent text blocks around each citation point -- fragments of
  // one continuous passage, not separate paragraphs -- so they're
  // concatenated directly rather than with blank lines between them.
  const content = data.content || [];
  let lastToolBlockIndex = -1;
  content.forEach((block, i) => {
    if (block.type !== 'text') lastToolBlockIndex = i;
  });
  const rawText = content
    .slice(lastToolBlockIndex + 1)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();

  // Some questions (see buildSwapQuestion in claude-assist.js) ask Claude
  // to end its answer with one "PROJECTIONS: Name: N pts | Name: N pts"
  // line -- its own point estimate per player, separate from the prose
  // analysis above it. Pulled out here into structured data so the client
  // can show it as its own callout instead of leaving it sitting in the
  // paragraph text. Questions that don't ask for it just won't have a
  // match, and a malformed line degrades harmlessly to null (the prose
  // text is still returned either way).
  let text = rawText;
  let projections = null;
  const projMatch = rawText.match(/PROJECTIONS:\s*(.+)\s*$/i);
  if (projMatch) {
    const parsed = projMatch[1]
      .split('|')
      .map(part => {
        const m = part.trim().match(/^(.+?):\s*([\d.]+)\s*pts?\.?$/i);
        return m ? { name: m[1].trim(), points: parseFloat(m[2]) } : null;
      })
      .filter(Boolean);
    if (parsed.length) {
      projections = parsed;
      text = rawText.slice(0, projMatch.index).trim();
    }
  }

  return new Response(JSON.stringify({ text: text || "Claude didn't return a text answer.", projections }), {
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
