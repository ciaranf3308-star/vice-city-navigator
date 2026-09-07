/* ============================================================================
   Vice City Navigator — navigation-voice Edge Function (Supabase / Deno)

   The ONLY place the OpenAI API key exists: the OPENAI_API_KEY secret on the
   Supabase project (Project Settings → Edge Functions → Secrets). It is read
   here via Deno.env at runtime. It is NEVER committed to git, NEVER shipped
   in the client bundle, and NEVER printed to logs.

   Contract:
     POST /functions/v1/navigation-voice
       Headers: apikey: <anon key>, Authorization: Bearer <anon key>
       Body:    { "text": "Turn left onto Main Street.",
                  "theme": "vice-city", "mode": "themed"|"banter",
                  "profanity": false }
       → 200  { "line": "Hang a left on Main Street, baby!",
                "audio": "<base64 mp3>", "mime": "audio/mpeg" }
       → 400  { "error": "invalid_json" | "bad_text" }
       → 403  wrong Origin
       → 429  { "error": "daily_cap_reached" }   ← per-day request cap
       → 500  { "error": "server_misconfigured" | "rate_limit_unavailable" }
       → 502  { "error": "tts_failed" }

   Pipeline per request:
     1. Rate limit — atomic daily counter in Postgres (navigation_voice_usage,
        bumped via the navigation_voice_bump() RPC with the service_role key).
        Over VOICE_DAILY_CAP (default 1000) → 429. This is INDEPENDENT of the
        Google Places quota: a client bug can never hammer the OpenAI balance.
     2. Rewrite — gpt-4o-mini turns the canonical OSRM maneuver into themed
        dialogue using the server-side persona below. Never fatal: any failure
        falls back to the original text; navigation never waits and the
        deterministic instruction stays on screen.
     3. Speak — gpt-4o-mini-tts renders the themed text to MP3, returned as
        base64 JSON (Supabase functions + the PWA client both prefer JSON).

   The LLM never decides navigation: OSRM maneuvers stay authoritative.
   Personas are ORIGINAL — energetic 80s Miami radio energy, not an
   impersonation of any actor or character.
   ========================================================================== */

const ALLOWED_ORIGIN = 'https://ciaranf3308-star.github.io';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

interface Persona {
  voice: string;
  ttsInstructions: string;
  rewrite: string;
  banter: string;
}

/* Server-side voice personas, keyed by the theme id the app sends.
   Kept here (not in client JS) so the spoken persona can't be swapped by
   editing client code, and the prompts stay with the key they belong to. */
const PERSONAS: Record<string, Persona> = {
  'vice-city': {
    voice: 'echo',
    ttsInstructions:
      'Speak like an energetic 1980s Miami radio DJ doing traffic: punchy, ' +
      'playful, confident, medium-fast pace. Crisp enunciation on street ' +
      'names and numbers so the driver never misses a turn.',
    rewrite:
      'You are the voice of a Vice City street guide — an energetic 1980s ' +
      'Miami radio DJ with playful swagger and the occasional sarcastic aside. ' +
      'Rewrite the navigation instruction below in character. RULES: keep the ' +
      'maneuver direction (left/right/straight/U-turn/roundabout), EVERY street ' +
      'name, and EVERY distance exactly as given — never invent, drop, or change ' +
      'them. One or two short sentences only. No emojis, no hashtags.',
    banter:
      'You may append ONE very short playful quip (under 10 words) after the ' +
      'instruction when it feels natural — never before it, never instead of it.',
  },
};

function personaFor(theme: unknown): Persona {
  if (typeof theme === 'string' && PERSONAS[theme]) return PERSONAS[theme];
  return PERSONAS['vice-city'];
}

function dailyCap(): number {
  const raw = Deno.env.get('VOICE_DAILY_CAP');
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/* ---- CORS: only our GitHub Pages origin. No Origin (curl/health) passes;
        any other Origin is rejected outright. ---- */
function corsHeaders(req: Request): Record<string, string> {
  const h: Record<string, string> = { 'Vary': 'Origin' };
  if (req.headers.get('Origin') === ALLOWED_ORIGIN) {
    h['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
  }
  return h;
}

function json(req: Request, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

/* ---- Daily usage counter. Atomic INSERT…ON CONFLICT via the
        navigation_voice_bump() RPC, called with the service_role key.
        Fail CLOSED: if the counter is unreachable we 500 rather than
        serve uncapped OpenAI calls. ---- */
async function bumpUsage(): Promise<number> {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) throw new Error('supabase_env_missing');
  const res = await fetch(`${url}/rest/v1/rpc/navigation_voice_bump`, {
    method: 'POST',
    headers: {
      'apikey': serviceKey,
      'Authorization': `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!res.ok) throw new Error(`usage_bump_http_${res.status}`);
  const n = await res.json();
  if (typeof n !== 'number') throw new Error('usage_bump_bad_shape');
  return n;
}

function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  return btoa(binary);
}

async function handleVoice(req: Request): Promise<Response> {
  const openAiKey = Deno.env.get('OPENAI_API_KEY');
  if (!openAiKey) {
    console.error('[navigation-voice] misconfigured: OPENAI_API_KEY secret not set');
    return json(req, { error: 'server_misconfigured' }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: 'invalid_json' }, 400);
  }

  const text = body.text;
  if (typeof text !== 'string' || !text.trim() || text.length > 400) {
    return json(req, { error: 'bad_text: must be a non-empty string of at most 400 characters' }, 400);
  }
  const persona = personaFor(body.theme);
  const mode = body.mode === 'banter' ? 'banter' : 'themed';
  const profanity = body.profanity === true;

  /* 1. Rate limit — before spending a cent on OpenAI. */
  let used: number;
  try {
    used = await bumpUsage();
  } catch (e) {
    console.error('[navigation-voice] usage counter unreachable:', (e as Error).message);
    return json(req, { error: 'rate_limit_unavailable' }, 500);
  }
  if (used > dailyCap()) {
    return json(req, { error: 'daily_cap_reached' }, 429);
  }

  /* 2. Rewrite: canonical maneuver → themed dialogue. Never fatal. */
  let themed = text.trim();
  try {
    const system =
      persona.rewrite +
      (mode === 'banter' ? ' ' + persona.banter : '') +
      (profanity
        ? ' Mild profanity is allowed when it fits the persona.'
        : ' No profanity or slurs, keep it clean.');
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + openAiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: themed },
        ],
        temperature: 0.7,
        max_tokens: 140,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const out = data?.choices?.[0]?.message?.content;
      if (typeof out === 'string' && out.trim()) themed = out.trim();
    }
  } catch {
    /* fall through — themed stays the original deterministic text */
  }

  /* 3. Speak: themed text → MP3. Failure here is a 502; the app's
        standard voice has already spoken, so the driver loses nothing. */
  let speechRes: Response | null = null;
  try {
    speechRes = await fetch(OPENAI_TTS_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + openAiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini-tts',
        voice: persona.voice,
        input: themed,
        instructions: persona.ttsInstructions,
        response_format: 'mp3',
      }),
    });
  } catch {
    speechRes = null;
  }
  if (!speechRes || !speechRes.ok) {
    // Status only — never the key, never response bodies that could echo it.
    console.error('[navigation-voice] tts_failed, openai_status:', speechRes ? speechRes.status : 'network');
    return json(req, { error: 'tts_failed' }, 502);
  }

  const audio = await speechRes.arrayBuffer();
  if (!audio.byteLength) return json(req, { error: 'tts_failed' }, 502);
  return json(req, { line: themed, audio: bufToBase64(audio), mime: 'audio/mpeg' });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const origin = req.headers.get('Origin');
  if (origin && origin !== ALLOWED_ORIGIN) {
    return new Response('Forbidden', { status: 403 });
  }
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders(req),
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (req.method === 'GET') {
    return json(req, { ok: true, service: 'navigation-voice' });
  }
  if (req.method === 'POST') {
    return handleVoice(req);
  }
  return json(req, { error: 'not_found' }, 404);
});
