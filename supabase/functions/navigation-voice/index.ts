/* ============================================================================
   Vice City Navigator — navigation-voice Edge Function (Supabase / Deno)

   Provider chain (first configured key wins):
     1. Gemini Developer API (FREE tier) — GEMINI_API_KEY secret.
        Rewrite: gemini-2.0-flash. Speech: gemini-2.5-flash-preview-tts
        (free of charge on the free tier: text input + audio output).
     2. OpenAI — OPENAI_API_KEY secret (optional fallback).
        Rewrite: gpt-4o-mini. Speech: gpt-4o-mini-tts → MP3.

   API keys live ONLY as Supabase Edge Function secrets, read here via
   Deno.env at runtime. They are NEVER committed to git, NEVER shipped in
   the client bundle, and NEVER printed to logs.

   Contract (unchanged — the PWA client needs no modifications):
     POST /functions/v1/navigation-voice
       Headers: apikey: <anon key>, Authorization: Bearer <anon key>
       Body:    { "text": "Turn left onto Main Street.",
                  "theme": "vice-city", "mode": "themed"|"banter",
                  "profanity": false }
       → 200  { "line": "Hang a left on Main Street, baby!",
                "audio": "<base64 wav|mp3>", "mime": "audio/wav"|"audio/mpeg" }
       → 400  { "error": "invalid_json" | "bad_text" }
       → 403  wrong Origin
       → 429  { "error": "daily_cap_reached" }   ← per-day request cap
       → 500  { "error": "server_misconfigured" | "rate_limit_unavailable" }
       → 502  { "error": "tts_failed" }

   Pipeline per request:
     1. Rate limit — atomic daily counter in Postgres (navigation_voice_usage,
        bumped via the navigation_voice_bump() RPC with the service_role key).
        Over VOICE_DAILY_CAP (default 1000) → 429. On the Gemini free tier a
        quota hit surfaces as a provider error → 502, and the client falls
        back to standard voice. No billed account is attached, so the balance
        can never be hammered.
     2. Rewrite — the text model turns the canonical OSRM maneuver into themed
        dialogue using the server-side persona below. Never fatal: any failure
        falls back to the original text; navigation never waits and the
        deterministic instruction stays on screen.
     3. Speak — the TTS model renders the themed text to audio, returned as
        base64 JSON (Supabase functions + the PWA client both prefer JSON).
        Gemini returns raw PCM → wrapped as WAV here.

   The LLM never decides navigation: OSRM maneuvers stay authoritative.
   Personas are ORIGINAL — energetic 80s Miami radio energy, not an
   impersonation of any actor or character.
   ========================================================================== */

const ALLOWED_ORIGIN = 'https://ciaranf3308-star.github.io';

/* Gemini Developer API (free tier). */
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
/* Text models for the rewrite step, in preference order. Google retires model
   aliases without warning (gemini-2.0-flash started 404ing in Sep 2026, then
   gemini-2.5-flash and gemini-2.5-flash-lite 404'd on generateContent), so the
   function discovers a working model at runtime via models.list and falls back
   through these aliases when discovery yields nothing. */
const GEMINI_TEXT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
  'gemini-2.0-flash-lite',
];
const GEMINI_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
const GEMINI_TTS_MODEL = 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_VOICE = 'Puck'; // upbeat prebuilt voice
const GEMINI_TTS_RATE = 24000; // PCM is 24 kHz, 16-bit, mono

/* OpenAI (optional paid fallback). */
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

interface Persona {
  voice: string; // OpenAI voice id (fallback path)
  ttsInstructions: string; // OpenAI style instructions (fallback path)
  geminiStyle: string; // natural-language voice direction, prepended for Gemini TTS
  rewrite: string;
  banter: string;
}

/* Server-side voice personas, keyed by the theme id the app sends.
   Kept here (not in client JS) so the spoken persona can't be swapped by
   editing client code, and the prompts stay with the keys they belong to. */
const PERSONAS: Record<string, Persona> = {
  'vice-city': {
    voice: 'echo',
    ttsInstructions:
      'Speak like an energetic 1980s Miami radio DJ doing traffic: punchy, ' +
      'playful, confident, medium-fast pace. Crisp enunciation on street ' +
      'names and numbers so the driver never misses a turn.',
    geminiStyle:
      'Say it in the voice of an energetic 1980s Miami radio DJ doing the ' +
      'traffic report: punchy, playful, confident, medium-fast. Enunciate ' +
      'street names and numbers crisply so the driver never misses a turn. ' +
      'The line to speak is: ',
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
        serve uncapped provider calls. ---- */
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
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`usage_bump_http_${res.status}`);
  const n = await res.json();
  if (typeof n !== 'number') throw new Error('usage_bump_bad_shape');
  return n;
}

function bufToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as number[]);
  }
  return btoa(binary);
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/* Gemini TTS returns raw 16-bit PCM — wrap it as WAV so browsers play it. */
function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  writeAscii(v, 0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  writeAscii(v, 8, 'WAVE');
  writeAscii(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeAscii(v, 36, 'data');
  v.setUint32(40, pcm.length, true);
  const out = new Uint8Array(44 + pcm.length);
  out.set(new Uint8Array(header), 0);
  out.set(pcm, 44);
  return out;
}

/* ---------------- Gemini provider (free tier, default) ---------------- */
function geminiHeaders(key: string): Record<string, string> {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
}

/* Runtime discovery of a working text model. Hardcoded aliases keep dying, so
   on a cold start (or when the cached model 404s) we ask models.list which
   flash-family models actually support generateContent right now, and remember
   the winner in module state for subsequent requests. */
let cachedTextModel: string | null = null;

async function discoverTextModel(key: string): Promise<string | null> {
  try {
    const res = await fetch(GEMINI_MODELS_URL, {
      headers: geminiHeaders(key),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const models: Array<{ name?: string; supportedGenerationMethods?: string[] }> =
      Array.isArray(data?.models) ? data.models : [];
    const usable = models
      .filter((m) => Array.isArray(m.supportedGenerationMethods) &&
        (m.supportedGenerationMethods as string[]).includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter((n) => n && /flash/i.test(n) && !/tts|embed|image|vision/i.test(n));
    if (!usable.length) return null;
    const rank = (n: string) => {
      const i = GEMINI_TEXT_MODELS.indexOf(n);
      return i === -1 ? GEMINI_TEXT_MODELS.length : i;
    };
    usable.sort((a, b) => rank(a) - rank(b));
    console.log('[navigation-voice] text_model_discovered:', usable[0]);
    return usable[0];
  } catch {
    return null;
  }
}

async function geminiRewrite(key: string, persona: Persona, mode: string, profanity: boolean, text: string): Promise<string> {
  const prompt =
    persona.rewrite +
    (mode === 'banter' ? ' ' + persona.banter : '') +
    (profanity
      ? ' Mild profanity is allowed when it fits the persona.'
      : ' No profanity or slurs, keep it clean.') +
    '\n\nInstruction to rewrite: ' + text;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.8, maxOutputTokens: 140 },
  });
  /* Build the attempt queue: cached winner first, then a fresh discovery,
     then the hardcoded aliases. Each model gets one shot; 404/429 moves on
     (quotas are per-model, so the next alias may succeed). */
  const queue: string[] = [];
  const enqueue = (m: string | null) => { if (m && !queue.includes(m)) queue.push(m); };
  enqueue(cachedTextModel);
  if (!cachedTextModel) enqueue(await discoverTextModel(key));
  for (const m of GEMINI_TEXT_MODELS) enqueue(m);
  let lastErr: Error | null = null;
  for (const model of queue) {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: geminiHeaders(key),
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { lastErr = e as Error; continue; }
    if (res.status === 404 || res.status === 429) {
      lastErr = new Error(`gemini_rewrite_${res.status}:${model}`);
      if (res.status === 404 && model === cachedTextModel) cachedTextModel = null;
      continue;
    }
    if (!res.ok) throw new Error(`gemini_rewrite_${res.status}`);
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    const out = Array.isArray(parts) ? parts.map((p: { text?: unknown }) =>
      typeof p.text === 'string' ? p.text : '').join('').trim() : '';
    if (!out) throw new Error('gemini_rewrite_empty');
    cachedTextModel = model;
    return out;
  }
  throw lastErr ?? new Error('gemini_rewrite_no_model');
}

async function geminiSpeak(key: string, persona: Persona, text: string): Promise<{ audio: string; mime: string }> {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: persona.geminiStyle + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } },
      },
    },
  });
  /* Free-tier TTS rate-limits under burst (the app pre-generates upcoming
     maneuvers), so retry 429s with backoff instead of failing instantly. */
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200 * attempt));
    let res: Response;
    try {
      res = await fetch(`${GEMINI_API_BASE}/${GEMINI_TTS_MODEL}:generateContent`, {
        method: 'POST',
        headers: geminiHeaders(key),
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) { lastErr = e as Error; continue; } // timeout/network -> retry
    if (res.status === 429) { lastErr = new Error('gemini_tts_429'); continue; }
    if (!res.ok) throw new Error(`gemini_tts_${res.status}`);
    const data = await res.json();
    const b64 = data?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (typeof b64 !== 'string' || !b64.length) throw new Error('gemini_tts_empty');
    const bin = atob(b64);
    const pcm = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
    if (!pcm.length) throw new Error('gemini_tts_empty');
    return { audio: bufToBase64(pcmToWav(pcm, GEMINI_TTS_RATE)), mime: 'audio/wav' };
  }
  throw lastErr ?? new Error('gemini_tts_failed');
}

/* ---------------- OpenAI provider (optional fallback) ---------------- */
async function openaiRewrite(key: string, persona: Persona, mode: string, profanity: boolean, text: string): Promise<string> {
  const system =
    persona.rewrite +
    (mode === 'banter' ? ' ' + persona.banter : '') +
    (profanity
      ? ' Mild profanity is allowed when it fits the persona.'
      : ' No profanity or slurs, keep it clean.');
  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
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
  if (!res.ok) throw new Error(`openai_rewrite_${res.status}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) throw new Error('openai_rewrite_empty');
  return out.trim();
}

async function openaiSpeak(key: string, persona: Persona, text: string): Promise<{ audio: string; mime: string }> {
  const res = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: persona.voice,
      input: text,
      instructions: persona.ttsInstructions,
      response_format: 'mp3',
    }),
  });
  if (!res.ok) throw new Error(`openai_tts_${res.status}`);
  const buf = await res.arrayBuffer();
  if (!buf.byteLength) throw new Error('openai_tts_empty');
  return { audio: bufToBase64(buf), mime: 'audio/mpeg' };
}

/* ---------------- request handler ---------------- */
async function handleVoice(req: Request): Promise<Response> {
  const geminiKey = Deno.env.get('GEMINI_API_KEY');
  const openAiKey = Deno.env.get('OPENAI_API_KEY');
  const provider = geminiKey ? 'gemini' : openAiKey ? 'openai' : null;
  if (!provider) {
    console.error('[navigation-voice] misconfigured: no GEMINI_API_KEY or OPENAI_API_KEY secret set');
    return json(req, { error: 'server_misconfigured' }, 500);
  }
  const providerKey = (provider === 'gemini' ? geminiKey : openAiKey) as string;

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

  /* 1. Rate limit — before any provider call. */
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
    themed = provider === 'gemini'
      ? await geminiRewrite(providerKey, persona, mode, profanity, themed)
      : await openaiRewrite(providerKey, persona, mode, profanity, themed);
  } catch (e) {
    // Status only — never the key, never response bodies that could echo it.
    console.error('[navigation-voice] rewrite_failed, provider:', provider, (e as Error).message);
    /* fall through — themed stays the original deterministic text */
  }

  /* 3. Speak: themed text → audio. Failure here is a 502; the app's
        standard voice has already spoken, so the driver loses nothing. */
  try {
    const spoken = provider === 'gemini'
      ? await geminiSpeak(providerKey, persona, themed)
      : await openaiSpeak(providerKey, persona, themed);
    return json(req, { line: themed, audio: spoken.audio, mime: spoken.mime });
  } catch (e) {
    // Status only — never the key, never response bodies that could echo it.
    console.error('[navigation-voice] tts_failed, provider:', provider, (e as Error).message);
    return json(req, { error: 'tts_failed' }, 502);
  }
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
