/* ============================================================================
   WayStation — navigation-voice Edge Function (Supabase / Deno)

   OpenAI-primary voice for EVERY theme. The client sends
   { text, theme, profile, personaVersion, mode, profanity } and the server
   renders the active theme's persona — the theme's voice block is the
   source of truth for which profile speaks.

   Normal provider order, identical for all four themes:
     1. Cached generated audio — server-side `voice-cache` Storage bucket,
        keyed by voice profile + persona version + normalized instruction +
        mode + profanity + TTS model + voice. Repeats cost nothing.
     2. OpenAI rewrite: gpt-4o-mini with the theme persona below.
     3. OpenAI TTS: gpt-4o-mini-tts → MP3.
     4. Browser/device speech fallback (client-side, on 502/429). The app
        always speaks the deterministic instruction immediately, so the
        driver never waits on AI.

   Gemini is NEVER attempted in the normal path. The code below keeps an
   explicit opt-in `provider: 'gemini-first'` slot, but no shipped profile
   uses it — nothing in the normal flow can add Gemini latency before
   OpenAI.

   Voices (all gpt-4o-mini-tts):
     vice-city  — echo  — energetic 1980s Miami traffic-radio DJ
     san-andreas — onyx — West Coast neighborhood OG, deep baritone
     gta-v      — alloy — slick modern Los Santos city guide
     rdr2       — fable — seasoned frontier trail guide

   API keys live ONLY as Supabase Edge Function secrets, read here via
   Deno.env at runtime. They are NEVER committed to git, NEVER shipped in
   the client bundle, and NEVER printed to logs.

   Contract (unchanged):
     POST /functions/v1/navigation-voice
       Headers: apikey: <anon key>, Authorization: Bearer <anon key>
       Body:    { "text": "Turn left onto Main Street.",
                  "theme": "san-andreas", "profile": "san-andreas",
                  "personaVersion": "v2",
                  "mode": "themed"|"banter", "profanity": false }
       → 200  { "line": "Aight, hang that left on Main Street.",
                "audio": "<base64 mp3>", "mime": "audio/mpeg" }
       → 400  { "error": "invalid_json" | "bad_text" }
       → 403  wrong Origin
       → 429  { "error": "daily_cap_reached" }
       → 500  { "error": "server_misconfigured" | "rate_limit_unavailable" }
       → 502  { "error": "tts_failed" }

   Timeouts: the client (voice.js FETCH_TIMEOUT_MS) abandons the request at
   12s. ALL expensive provider work on the server runs under a single 10s
   global deadline that ALSO fires when the client disconnects (req.signal),
   so the function never keeps burning paid provider calls after nobody is
   listening. No long retry chains.

   Pipeline per request:
     1. Rate limit — atomic daily counter in Postgres (navigation_voice_usage,
        bumped via the navigation_voice_bump() RPC with the service_role key).
        Over VOICE_DAILY_CAP (default 1000) → 429. Fail CLOSED: an
        unreachable counter is a 500, never uncapped provider calls.
     2. Audio cache — content-addressed MP3 in the self-provisioned
        `voice-cache` Storage bucket. Hit → 200 with no provider spend.
     3. Rewrite — the text model turns the canonical OSRM maneuver into
        themed dialogue using the server-side persona below. Never fatal:
        any failure falls back to the original text; navigation never waits
        and the deterministic instruction stays on screen.
     4. Speak — the TTS model renders the themed text to audio, returned as
        base64 JSON. Failure of every provider is a 502; the app's standard
        voice has already spoken, so the driver loses nothing.
     5. Cache store — the fresh MP3 + its rewritten line are stored
        best-effort for the next identical maneuver.

   The LLM never decides navigation: OSRM maneuvers stay authoritative.
   Personas are ORIGINAL — not impersonations of any actor or character.
   ========================================================================== */

const ALLOWED_ORIGIN = 'https://ciaranf3308-star.github.io';

/* Global server deadline (ms). The client gives up at 12s, so provider work
   must stop below that — and instantly when the client disconnects. */
const SERVER_DEADLINE_MS = 10000;

/* Combine the client-disconnect signal with the global deadline into one
   AbortSignal for every expensive call. Hand-rolled (no AbortSignal.any) for
   maximum runtime compatibility. Call done() when the request finishes. */
function deadlineScope(req: Request): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SERVER_DEADLINE_MS);
  const src = req.signal;
  const onAbort = () => { if (!ctrl.signal.aborted) ctrl.abort(); };
  if (src.aborted) onAbort();
  else src.addEventListener('abort', onAbort, { once: true });
  return {
    signal: ctrl.signal,
    done: () => {
      clearTimeout(timer);
      src.removeEventListener('abort', onAbort);
    },
  };
}

/* Gemini Developer API (free tier) — kept ONLY behind the explicit
   'gemini-first' provider opt-in. No shipped profile uses it, so none of
   this code runs in the normal OpenAI-primary path. */
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

/* OpenAI. */
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_TTS_URL = 'https://api.openai.com/v1/audio/speech';

interface Persona {
  /* 'openai' — OpenAI only, Gemini is never attempted for this profile.
     'gemini-first' — explicit opt-in only; NO shipped profile uses it, so
     the normal path never touches Gemini. */
  provider: 'openai' | 'gemini-first';
  /* Server-side generated-audio cache for this profile. */
  cacheAudio: boolean;
  voice: string; // OpenAI voice id
  ttsModel: string; // OpenAI TTS model
  rewriteModel: string; // OpenAI chat model for the rewrite step
  /* Persona/instruction version. Bump whenever the wording below changes;
     it is part of the cache key so stale audio is never reused. */
  personaVersion: string;
  ttsInstructions: string; // OpenAI TTS style instructions
  geminiStyle?: string; // only used by the 'gemini-first' opt-in
  rewrite: string; // rewrite system prompt: persona + hard preservation rules
  banter: string; // appended in banter mode
}

/* Server-side voice personas, keyed by the theme id the app sends.
   Kept here (not in client JS) so the spoken persona can't be swapped by
   editing client code, and the prompts stay with the keys they belong to.
   Mirrors the wording in each theme's voice block — bump personaVersion
   here AND in the theme config whenever either changes. */
const PERSONAS: Record<string, Persona> = {
  'vice-city': {
    provider: 'openai',
    cacheAudio: true,
    voice: 'echo',
    ttsModel: 'gpt-4o-mini-tts',
    rewriteModel: 'gpt-4o-mini',
    personaVersion: 'v2',
    ttsInstructions:
      'Energetic 1980s Miami traffic-radio DJ. Punchy, charismatic, playful, ' +
      'confident. Medium-fast cadence, late-night FM swagger, occasional ' +
      'dry or sarcastic aside. Exceptionally clear street names, distances, ' +
      'and maneuver words so the driver never misses a turn. Avoid generic ' +
      'GPS voice, modern podcast host, corporate announcer, or exaggerated parody.',
    rewrite:
      'You are the voice of a Vice City street guide — an energetic 1980s ' +
      'Miami traffic-radio DJ: punchy, charismatic, playful, confident, with ' +
      'late-night FM swagger and the occasional dry or sarcastic aside. ' +
      'Rewrite the navigation instruction below in character. RULES: preserve ' +
      'EVERY direction (left/right/straight/U-turn), roundabout maneuver and ' +
      'exit facts, EVERY road and street name, EVERY distance, destination ' +
      'facts, and maneuver order exactly as given — never invent landmarks or ' +
      'traffic, never change distances or names, never swap directions, never ' +
      'omit or add maneuvers. Keep it to 1-2 short spoken sentences; navigation ' +
      'clarity comes before character. Street names, distances, and maneuver ' +
      'words must be exceptionally clear. Avoid generic GPS voice, modern ' +
      'podcast host, corporate announcer, or exaggerated parody. ' +
      'No emojis, no hashtags.',
    banter:
      'You may append ONE very short playful quip (under 10 words) after the ' +
      'instruction when it feels natural — never before it, never instead of it.',
  },
  'san-andreas': {
    provider: 'openai',
    cacheAudio: true,
    voice: 'onyx',
    ttsModel: 'gpt-4o-mini-tts',
    rewriteModel: 'gpt-4o-mini',
    personaVersion: 'v2',
    ttsInstructions:
      'Deep Black American male voice, roughly late 30s to mid 40s. Heavy ' +
      'baritone, warm low end, slightly raspy and lived-in. A respected West ' +
      'Coast neighborhood OG riding shotgun — not a narrator, not a performer. ' +
      'Natural Los Angeles / South Central AAVE rhythm: relaxed vowels and ' +
      'consonants, occasional effortless slang. Slow-to-moderate, laid-back ' +
      'pacing; calm power, never shouting. Enunciate street names and numbers ' +
      'clearly enough that the driver never misses a turn. Avoid suburban ' +
      'cadence, generic narrator or GPS voice, cartoon gangster, parody, ' +
      'forced slang, or theatrical toughness. Profanity may occur naturally ' +
      'but not in every instruction.',
    rewrite:
      'You are the voice of a San Andreas street guide — a respected West ' +
      'Coast neighborhood OG, a deep Black American male roughly late 30s to ' +
      'mid 40s, riding shotgun: heavy baritone warmth, natural Los Angeles / ' +
      'South Central AAVE rhythm, relaxed vowels and consonants, occasional ' +
      'effortless slang, slow-to-moderate laid-back pacing, calm power. ' +
      'Rewrite the navigation instruction below in character. RULES: preserve ' +
      'EVERY direction (left/right/straight/U-turn), roundabout maneuver and ' +
      'exit facts, EVERY road and street name, EVERY distance, destination ' +
      'facts, and maneuver order exactly as given — never invent landmarks or ' +
      'traffic, never change distances or names, never swap directions, never ' +
      'omit or add maneuvers. Keep it to 1-2 short spoken sentences; navigation ' +
      'clarity comes before character. Profanity may occur naturally but not in ' +
      'every instruction. Avoid suburban cadence, generic narrator or GPS voice, ' +
      'cartoon gangster, parody, forced slang, or theatrical toughness. ' +
      'No emojis, no hashtags.',
    banter:
      'You may append ONE very short dry quip (under 10 words) after the ' +
      'instruction when it feels natural — never before it, never instead of it.',
  },
  'gta-v': {
    provider: 'openai',
    cacheAudio: true,
    voice: 'alloy',
    ttsModel: 'gpt-4o-mini-tts',
    rewriteModel: 'gpt-4o-mini',
    personaVersion: 'v2',
    ttsInstructions:
      'Slick modern Los Santos city guide. Controlled, polished, confident, ' +
      'slightly cynical. Modern metropolitan cadence; understated wit. An ' +
      'expensive city concierge with a little attitude. Crisp street names ' +
      'and numbers so the driver never misses a turn. Avoid bubbly assistant ' +
      'voice, game-show energy, heavy slang, or exaggerated gangster delivery.',
    rewrite:
      'You are the voice of a Los Santos street guide — a slick modern city ' +
      'guide: controlled, polished, confident, slightly cynical, with a modern ' +
      'metropolitan cadence and understated wit, like an expensive city ' +
      'concierge with a little attitude. Rewrite the navigation instruction ' +
      'below in character. RULES: preserve EVERY direction ' +
      '(left/right/straight/U-turn), roundabout maneuver and exit facts, EVERY ' +
      'road and street name, EVERY distance, destination facts, and maneuver ' +
      'order exactly as given — never invent landmarks or traffic, never change ' +
      'distances or names, never swap directions, never omit or add maneuvers. ' +
      'Keep it to 1-2 short spoken sentences; navigation clarity comes before ' +
      'character. Keep street names and numbers crisp. Avoid bubbly assistant ' +
      'voice, game-show energy, heavy slang, or exaggerated gangster delivery. ' +
      'No emojis, no hashtags.',
    banter:
      'You may append ONE very short slick quip (under 10 words) after the ' +
      'instruction when it feels natural — never before it, never instead of it.',
  },
  'rdr2': {
    provider: 'openai',
    cacheAudio: true,
    voice: 'fable',
    ttsModel: 'gpt-4o-mini-tts',
    rewriteModel: 'gpt-4o-mini',
    personaVersion: 'v2',
    ttsInstructions:
      'Seasoned frontier trail guide. Warm, weathered, unhurried, plainspoken, ' +
      'old-soul steadiness. Slightly gravelly where supported; wry rather than ' +
      'comedic. Period flavor is acceptable, but modern real-world road ' +
      'terminology must remain clear. Crisp enunciation on street names and ' +
      'numbers so the rider never misses a turn. Avoid theatrical cowboy ' +
      'parody, cartoon Western accent, or excessive archaic language.',
    rewrite:
      'You are the voice of a frontier trail guide — seasoned, warm, weathered, ' +
      'unhurried, plainspoken, with old-soul steadiness; wry rather than comedic. ' +
      'Rewrite the navigation instruction below in character. RULES: preserve ' +
      'EVERY direction (left/right/straight/U-turn), roundabout maneuver and ' +
      'exit facts, EVERY road and street name, EVERY distance, destination ' +
      'facts, and maneuver order exactly as given — never invent landmarks or ' +
      'traffic, never change distances or names, never swap directions, never ' +
      'omit or add maneuvers. Keep it to 1-2 short spoken sentences; navigation ' +
      'clarity comes before character. Period flavor is acceptable, but modern ' +
      'real-world road terminology must remain clear. Avoid theatrical cowboy ' +
      'parody, cartoon Western accent, or excessive archaic language. ' +
      'No emojis, no hashtags.',
    banter:
      'You may append ONE very short wry trail-side remark (under 10 words) ' +
      'after the instruction when it feels natural — never before it, never ' +
      'instead of it.',
  },
};

function personaFor(theme: unknown): Persona {
  if (typeof theme === 'string' && PERSONAS[theme]) return PERSONAS[theme];
  return PERSONAS['vice-city'];
}

function profileIdFor(theme: unknown): string {
  if (typeof theme === 'string' && PERSONAS[theme]) return theme;
  return 'vice-city';
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
    signal: AbortSignal.timeout(5000),
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

/* Gemini TTS returns raw 16-bit PCM — wrap it as WAV so browsers play it.
   Only reachable via the explicit 'gemini-first' provider opt-in. */
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

/* ---- Server-side generated-audio cache (OpenAI profiles) ----
   Supabase Storage bucket `voice-cache`, self-provisioned on first use with
   the service_role key (no dashboard step needed). Cache key:

     v2 | voice profile | persona version | mode | profanity |
     normalized instruction | TTS model | voice   →   sha256 hex

   The MP3 lives at <key>.mp3; the rewritten line (for the client's
   speak-fallback path) rides along at <key>.json. The bucket is private;
   only this function (service_role) ever reads or writes it. */
const VOICE_CACHE_BUCKET = 'voice-cache';
let bucketReady: Promise<void> | null = null;

function storageHeaders(serviceKey: string): Record<string, string> {
  return { 'apikey': serviceKey, 'Authorization': 'Bearer ' + serviceKey };
}

function ensureVoiceCacheBucket(supabaseUrl: string, serviceKey: string): Promise<void> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const res = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...storageHeaders(serviceKey), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: VOICE_CACHE_BUCKET, public: false }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok && res.status !== 409) {
        const t = await res.text().catch(() => '');
        if (!/already exists|duplicate/i.test(t)) throw new Error(`voice_cache_bucket_${res.status}`);
      }
    })();
    // A failed ensure must not poison later requests — retry next time.
    bucketReady.catch(() => { bucketReady = null; });
  }
  return bucketReady;
}

async function voiceCacheKey(
  profile: string, personaVersion: string, mode: string, profanity: boolean,
  text: string, ttsModel: string, voice: string,
): Promise<string> {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  const canonical = ['v2', profile, personaVersion, mode, profanity ? 'p1' : 'p0', normalized, ttsModel, voice].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${profile}/${hex}`;
}

interface CachedVoice {
  audio: Uint8Array;
  line: string;
}

async function voiceCacheGet(
  supabaseUrl: string, serviceKey: string, key: string, signal: AbortSignal,
): Promise<CachedVoice | null> {
  try {
    const h = storageHeaders(serviceKey);
    const base = `${supabaseUrl}/storage/v1/object/${VOICE_CACHE_BUCKET}/${key}`;
    const [mp3Res, jsonRes] = await Promise.all([
      fetch(base + '.mp3', { headers: h, signal }),
      fetch(base + '.json', { headers: h, signal }),
    ]);
    if (mp3Res.status === 404) return null;
    if (!mp3Res.ok) throw new Error(`voice_cache_get_${mp3Res.status}`);
    const audio = new Uint8Array(await mp3Res.arrayBuffer());
    if (!audio.length) throw new Error('voice_cache_empty');
    let line = '';
    if (jsonRes.ok) {
      try {
        const j = await jsonRes.json();
        if (j && typeof j.line === 'string') line = j.line;
      } catch { /* line is optional */ }
    }
    return { audio, line };
  } catch (e) {
    // Best-effort: any cache failure (including the deadline firing) just
    // falls through to the providers, which abort instantly on a dead signal.
    console.error('[navigation-voice] voice_cache_get_failed', (e as Error).message);
    return null;
  }
}

async function voiceCachePut(
  supabaseUrl: string, serviceKey: string, key: string,
  audioB64: string, line: string, signal: AbortSignal,
): Promise<void> {
  try {
    const bin = atob(audioB64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const h = storageHeaders(serviceKey);
    const base = `${supabaseUrl}/storage/v1/object/${VOICE_CACHE_BUCKET}/${key}`;
    const put = async (suffix: string, body: BodyInit, contentType: string) => {
      const res = await fetch(base + suffix, {
        method: 'POST',
        headers: { ...h, 'Content-Type': contentType, 'x-upsert': 'true' },
        body,
        signal,
      });
      if (!res.ok) throw new Error(`voice_cache_put_${res.status}`);
    };
    await put('.mp3', bytes, 'audio/mpeg');
    await put('.json', JSON.stringify({ line }), 'application/json');
  } catch (e) {
    // Best-effort: the freshly generated audio is still returned to the
    // client even when the cache store fails.
    console.error('[navigation-voice] voice_cache_put_failed', (e as Error).message);
  }
}

/* ---------------- Gemini provider (free tier) ----------------
   ONLY reachable when a persona explicitly opts in with
   provider: 'gemini-first'. No shipped profile does, so this never
   runs — and never adds latency — in the normal OpenAI-primary path. */
function geminiHeaders(key: string): Record<string, string> {
  return { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
}

/* Truncated Google error payload for logs. The API key is sent in a request
   header and is never echoed in these bodies; still, keep it short. */
async function geminiErrorSnippet(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t ? ' body:' + t.slice(0, 300).replace(/\s+/g, ' ') : '';
  } catch {
    return '';
  }
}

/* Runtime discovery of a working text model. Hardcoded aliases keep dying, so
   on a cold start (or when the cached model 404s) we ask models.list which
   flash-family models actually support generateContent right now, and remember
   the winner in module state for subsequent requests. */
let cachedTextModel: string | null = null;

async function discoverTextModel(key: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(GEMINI_MODELS_URL, { headers: geminiHeaders(key), signal });
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

async function geminiRewrite(
  key: string, persona: Persona, mode: string, profanity: boolean,
  text: string, signal: AbortSignal,
): Promise<string> {
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
  if (!cachedTextModel) enqueue(await discoverTextModel(key, signal));
  for (const m of GEMINI_TEXT_MODELS) enqueue(m);
  let lastErr: Error | null = null;
  for (const model of queue) {
    let res: Response;
    try {
      res = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
        method: 'POST',
        headers: geminiHeaders(key),
        body,
        signal,
      });
    } catch (e) { lastErr = e as Error; continue; }
    if (res.status === 404 || res.status === 429) {
      lastErr = new Error(`gemini_rewrite_${res.status}:${model}${await geminiErrorSnippet(res)}`);
      if (res.status === 404 && model === cachedTextModel) cachedTextModel = null;
      continue;
    }
    if (!res.ok) throw new Error(`gemini_rewrite_${res.status}${await geminiErrorSnippet(res)}`);
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

async function geminiSpeak(
  key: string, persona: Persona, text: string, signal: AbortSignal,
): Promise<{ audio: string; mime: string }> {
  const body = JSON.stringify({
    contents: [{ parts: [{ text: (persona.geminiStyle || '') + text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_TTS_VOICE } },
      },
    },
  });
  /* Free-tier TTS rate-limits under burst (the app pre-generates upcoming
     maneuvers). One quick retry, then give up fast so the fallback (or the
     client's standard voice) takes over instead of burning the server
     deadline on doomed retries. */
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1200));
    let res: Response;
    try {
      res = await fetch(`${GEMINI_API_BASE}/${GEMINI_TTS_MODEL}:generateContent`, {
        method: 'POST',
        headers: geminiHeaders(key),
        body,
        signal,
      });
    } catch (e) { lastErr = e as Error; continue; } // timeout/network -> retry
    if (res.status === 429) { lastErr = new Error('gemini_tts_429' + await geminiErrorSnippet(res)); continue; }
    if (!res.ok) throw new Error(`gemini_tts_${res.status}` + await geminiErrorSnippet(res));
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

/* ---------------- OpenAI provider ---------------- */
async function openaiRewrite(
  key: string, persona: Persona, mode: string, profanity: boolean,
  text: string, signal: AbortSignal,
): Promise<string> {
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
      model: persona.rewriteModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
      temperature: 0.7,
      max_tokens: 140,
    }),
    signal,
  });
  if (!res.ok) throw new Error(`openai_rewrite_${res.status}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content;
  if (typeof out !== 'string' || !out.trim()) throw new Error('openai_rewrite_empty');
  return out.trim();
}

async function openaiSpeak(
  key: string, persona: Persona, text: string, signal: AbortSignal,
): Promise<{ audio: string; mime: string }> {
  const res = await fetch(OPENAI_TTS_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: persona.ttsModel,
      voice: persona.voice,
      input: text,
      instructions: persona.ttsInstructions,
      response_format: 'mp3',
    }),
    signal,
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
  if (!geminiKey && !openAiKey) {
    console.error('[navigation-voice] misconfigured: no GEMINI_API_KEY or OPENAI_API_KEY secret set');
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
  const profile = profileIdFor(body.theme);
  const mode = body.mode === 'banter' ? 'banter' : 'themed';
  const profanity = body.profanity === true;
  /* Persona version from the active theme (the source of truth), falling
     back to the server-side profile version. Part of the cache key. */
  const personaVersion = typeof body.personaVersion === 'string' && body.personaVersion
    ? body.personaVersion
    : persona.personaVersion;

  /* Every shipped profile is OpenAI-primary — a missing key is a hard
     misconfiguration, not something to paper over with another provider. */
  if (persona.provider === 'openai' && !openAiKey) {
    console.error('[navigation-voice] misconfigured: OPENAI_API_KEY secret required for the ' + profile + ' profile');
    return json(req, { error: 'server_misconfigured' }, 500);
  }

  /* 1. Rate limit — before any provider spend. */
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

  /* Every expensive call below shares one scope: the 10s global server
     deadline plus the client-disconnect signal. When either fires, in-flight
     provider and Storage calls abort instead of running on unpaid. */
  const scope = deadlineScope(req);
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    /* 2. Server audio cache: an exact repeat of a generated line costs
          nothing — no rewrite, no TTS. */
    let cacheKeyStr: string | null = null;
    if (persona.cacheAudio && supabaseUrl && serviceKey) {
      try {
        await ensureVoiceCacheBucket(supabaseUrl, serviceKey);
        cacheKeyStr = await voiceCacheKey(
          profile, personaVersion, mode, profanity, text.trim(), persona.ttsModel, persona.voice);
        const hit = await voiceCacheGet(supabaseUrl, serviceKey, cacheKeyStr, scope.signal);
        if (hit) {
          console.log('[navigation-voice] voice_cache_hit profile=' + profile);
          return json(req, {
            line: hit.line || text.trim(),
            audio: bufToBase64(hit.audio),
            mime: 'audio/mpeg',
          });
        }
      } catch (e) {
        console.error('[navigation-voice] voice_cache_lookup_failed', (e as Error).message);
      }
    }

    /* 3. Rewrite: canonical maneuver → themed dialogue. Never fatal.
          Gemini is never attempted unless the profile explicitly opts in
          with provider: 'gemini-first' (none do). */
    let themed = text.trim();
    if (persona.provider === 'openai') {
      if (openAiKey) {
        try {
          themed = await openaiRewrite(openAiKey, persona, mode, profanity, themed, scope.signal);
        } catch (e) {
          console.error('[navigation-voice] rewrite_failed, provider: openai', (e as Error).message);
          /* fall through — themed stays the original deterministic text */
        }
      }
    } else {
      let rewriteOk = false;
      if (geminiKey) {
        try {
          themed = await geminiRewrite(geminiKey, persona, mode, profanity, themed, scope.signal);
          rewriteOk = true;
        } catch (e) {
          // Truncated Google error payload only — never the key.
          console.error('[navigation-voice] rewrite_failed, provider: gemini', (e as Error).message);
        }
      }
      if (!rewriteOk && openAiKey) {
        try {
          themed = await openaiRewrite(openAiKey, persona, mode, profanity, themed, scope.signal);
        } catch (e) {
          console.error('[navigation-voice] rewrite_failed, provider: openai', (e as Error).message);
          /* fall through — themed stays the original deterministic text */
        }
      }
    }

    /* 4. Speak: themed text → audio. Failure of every provider is a 502;
          the app's standard voice has already spoken, so the driver loses
          nothing and the browser speech fallback covers the rest. */
    let spoken: { audio: string; mime: string } | null = null;
    if (persona.provider === 'openai') {
      if (openAiKey) {
        try {
          spoken = await openaiSpeak(openAiKey, persona, themed, scope.signal);
        } catch (e) {
          console.error('[navigation-voice] tts_failed, provider: openai', (e as Error).message);
        }
      }
    } else {
      if (geminiKey) {
        try {
          spoken = await geminiSpeak(geminiKey, persona, themed, scope.signal);
        } catch (e) {
          // Truncated Google error payload only — never the key.
          console.error('[navigation-voice] tts_failed, provider: gemini', (e as Error).message);
        }
      }
      if (!spoken && openAiKey) {
        try {
          spoken = await openaiSpeak(openAiKey, persona, themed, scope.signal);
          console.log('[navigation-voice] tts_fallback: openai');
        } catch (e) {
          console.error('[navigation-voice] tts_failed, provider: openai', (e as Error).message);
        }
      }
    }
    if (!spoken) return json(req, { error: 'tts_failed' }, 502);

    /* 5. Cache the fresh audio for the next identical maneuver
          (best-effort — the audio is returned regardless). */
    if (cacheKeyStr && supabaseUrl && serviceKey) {
      await voiceCachePut(supabaseUrl, serviceKey, cacheKeyStr, spoken.audio, themed, scope.signal);
    }
    return json(req, { line: themed, audio: spoken.audio, mime: spoken.mime });
  } finally {
    scope.done();
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
