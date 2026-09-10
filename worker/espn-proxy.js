/* Cloudflare Worker: CORS proxy for ESPN's public fantasy football
 * projections endpoint.
 *
 * ESPN's endpoint itself needs no API key and works fine over plain HTTPS --
 * it just doesn't send Access-Control-Allow-Origin, so a browser can't read
 * the response directly (a request to it from the app's own JS returns
 * type: "opaque" and the body is unreadable). This Worker's only job is to
 * add that header.
 *
 * It deliberately does NOT parse or filter the response: ESPN's own
 * documented filter headers (x-fantasy-filter) were tested and don't trim
 * this endpoint's payload at all -- it always returns its full ~11,000+
 * player database (35-40MB) regardless. Parsing that much JSON would blow
 * past Cloudflare's free-plan CPU-time limit (10ms/request), so instead this
 * streams the response straight through untouched and lets the browser do
 * the parsing/filtering, where a payload that size is trivial and gets
 * cached client-side (see espn-api.js) so it only happens once every ~20
 * hours per visitor, not per page load.
 *
 * Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> paste this
 * file's contents into the editor -> Deploy. Copy the resulting
 * *.workers.dev URL into the app's setup screen as the "ESPN proxy URL".
 */

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

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
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
