/**
 * RunTrack — Anthropic API Proxy (Cloudflare Worker)
 *
 * Deploy this to Cloudflare Workers. Set the environment variable:
 *   ANTHROPIC_API_KEY = sk-ant-...
 *
 * After deploying, copy the Worker URL (e.g. https://runtrack-ai.YOUR_USER.workers.dev)
 * and paste it into script.js as the value of ANTHROPIC_PROXY_URL.
 *
 * Deploy steps:
 *   1. Go to dash.cloudflare.com → Workers & Pages → Create application → Create Worker
 *   2. Paste this file's contents into the editor, click Save & Deploy
 *   3. Go to Settings → Variables → Add: ANTHROPIC_API_KEY = sk-ant-api03-...
 *   4. Copy the Worker URL and set ANTHROPIC_PROXY_URL in script.js
 */

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (!env.ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: { message: 'ANTHROPIC_API_KEY not configured on Worker.' } }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({ error: { message: 'Invalid JSON body.' } }),
        { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } }
      );
    }

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    const data = await upstream.text();

    return new Response(data, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(),
      },
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
