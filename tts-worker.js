/* ============================================================================
   Vice City Navigator — TTS proxy worker (Cloudflare Workers, ES module)

   Why this exists: the OpenAI API key must NEVER appear in the GitHub Pages
   client JavaScript. The app POSTs navigation phrases here; this worker adds
   the key from an encrypted Worker secret and calls OpenAI server-side.

   Pipeline per request:
     1. Rewrite  — gpt-4o-mini turns the canonical OSRM maneuver into themed
                    dialogue (persona instructions). Any failure falls back
                    to the original text; the request NEVER fails here.
     2. Speak    — gpt-4o-mini-tts renders the themed text to MP3 audio,
                    returned as audio/mpeg. Failure -> 502 { error: 'tts_failed' }.

   The LLM never decides navigation: OSRM maneuvers stay authoritative and
   the deterministic instruction stays on screen; only the spoken phrasing
   is themed.

   ----------------------------------------------------------------------------
   Minimal wrangler.toml (place next to this file):

     name = "vcn-tts"
     main = "tts-worker.js"
     compatibility_date = "2026-09-07"

   ----------------------------------------------------------------------------
   Deploy — 5 steps (run from the folder containing this file):

     1. Save this file as tts-worker.js and create the wrangler.toml above
        next to it.
     2. npx wrangler login
        # opens a browser to authorise wrangler with your Cloudflare account
     3. npx wrangler secret put OPENAI_API_KEY
        # paste your OpenAI API key when prompted — stored encrypted as a
        # Worker secret, never in source control or client code
     4. npx wrangler deploy
        # publishes; note the https://vcn-tts.<your-subdomain>.workers.dev URL
     5. Paste that worker URL into the app's voice settings as the TTS
        endpoint, then verify: curl <url>/health  ->  {"ok":true}

   No real keys anywhere in this file.
   ============================================================================ */

const ALLOWED_ORIGIN = 'https://ciaranf3308-star.github.io';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

/* Reflect the allowed origin for CORS; any other Origin gets no ACAO header
   (and is rejected outright in the fetch handler below). */
function corsHeaders(request) {
  const headers = { 'Vary': 'Origin' };
  if (request.headers.get('Origin') === ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  }
  return headers;
}

function jsonResponse(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
  });
}

async function handleTts(request, env) {
  if (!env.OPENAI_API_KEY) {
    return jsonResponse(request, { error: 'server_misconfigured' }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse(request, { error: 'invalid_json' }, 400);
  }

  const text = body ? body.text : undefined;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > 400) {
    return jsonResponse(
      request,
      { error: 'text must be a non-empty string of at most 400 characters' },
      400
    );
  }

  const persona = (body && body.persona) || {};
  const profanity = body && body.profanity === true;

  /* ---- 1. Rewrite: canonical maneuver -> themed dialogue.
          Never fatal: any failure falls back to the original text. ---- */
  let themed = text;
  const rewriteInstructions = persona.rewriteInstructions;
  if (typeof rewriteInstructions === 'string' && rewriteInstructions.trim()) {
    try {
      const system =
        rewriteInstructions +
        (profanity
          ? ' Mild profanity is allowed when it fits the persona.'
          : ' No profanity or slurs, keep it clean.');
      const res = await fetch(OPENAI_CHAT_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: text },
          ],
          temperature: 0.7,
          max_tokens: 140,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const out =
          data && data.choices && data.choices[0] &&
          data.choices[0].message && data.choices[0].message.content;
        if (typeof out === 'string' && out.trim()) themed = out.trim();
      }
    } catch (e) {
      /* fall through — themed stays the original deterministic text */
    }
  }

  /* ---- 2. Speak: themed text -> MP3. Failure here is a 502. ---- */
  const speechRes = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + env.OPENAI_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: persona.voice || 'echo',
      input: themed,
      instructions: persona.ttsInstructions || '',
      response_format: 'mp3',
    }),
  }).catch(() => null);

  if (!speechRes || !speechRes.ok) {
    return jsonResponse(request, { error: 'tts_failed' }, 502);
  }

  const audio = await speechRes.arrayBuffer();
  return new Response(audio, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', ...corsHeaders(request) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS gate: only our GitHub Pages origin. Requests with no Origin
    // header (curl, server-to-server) are allowed through; any other
    // Origin is rejected.
    if (origin && origin !== ALLOWED_ORIGIN) {
      return new Response('Forbidden', { status: 403 });
    }

    // Preflight for the browser client.
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(request, { ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/tts') {
      return handleTts(request, env);
    }

    return jsonResponse(request, { error: 'not_found' }, 404);
  },
};
