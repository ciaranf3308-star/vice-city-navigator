/* ============================================================
   WayStation — theme-aware navigation voice.
   ------------------------------------------------------------
   Pipeline: OSRM maneuver -> deterministic structured
   instruction (built by app.js, the LLM never decides
   navigation) -> Supabase Edge Function `navigation-voice`
   (server-side theme persona + OpenAI rewrite + OpenAI TTS
   speech) -> audio playback.

   Normal provider order, for EVERY theme:
     1. Cached generated audio (this client's memory cache, then
        the function's server-side voice-cache bucket)
     2. OpenAI rewrite (gpt-4o-mini, theme persona)
     3. OpenAI TTS (gpt-4o-mini-tts, theme voice)
     4. Browser/device speech — the emergency fallback. The
        deterministic instruction is ALWAYS spoken immediately via
        speechSynthesis; themed audio never blocks navigation.

   Gemini is NEVER attempted in the normal path. (The Edge Function
   keeps an explicit opt-in 'gemini-first' provider slot, but no
   shipped profile uses it.)

   The OpenAI API key is NEVER in this client. The app sends only
   { text, theme, profile, personaVersion, mode, profanity } to the
   Edge Function and gets back { line, audio, mime }. The key lives
   solely as the OPENAI_API_KEY secret on the Supabase project
   (see VOICE_SETUP.md).

   The function enforces its own per-day request cap (VOICE_DAILY_CAP,
   default 1000).

   Modes: standard | themed | banter | off
     standard — browser speechSynthesis, deterministic text
     themed   — AI persona voice, same structured content
     banter   — themed + the persona may add a very short quip
     off      — silent

   Pre-generation: when a route is calculated the app calls
   pregenerate() with the next few maneuver texts; audio is
   fetched in the background and cached (up to 5). Speaking NEVER
   waits for the network — if themed audio isn't cached yet, the
   deterministic standard voice speaks immediately and the
   themed audio warms the cache for next time.

   Stale generation: reroutes and theme switches abort in-flight
   fetches and drop their results, so an old route or an old theme
   can never populate the cache or speak after the switch.
   ============================================================ */
'use strict';

(function () {
  const LS_KEY = 'vcn-voice-settings-v2';
  const CACHE_MAX = 24;
  const FETCH_TIMEOUT_MS = 12000;
  const PREGEN_DEPTH = 5;

  /* Defaults: full themed voice — banter + profanity on. */
  const settings = { mode: 'banter', profanity: true, endpoint: '', muted: false };
  const audioCache = new Map(); // key -> { url, text }
  const inflight = new Map(); // key -> { ctrl, theme, epoch }
  let audioEl = null;
  let endpointWarned = false;
  let routeEpoch = 0; // bumped on reroute/theme change; stale fetches drop results

  function loadSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (raw && typeof raw === 'object') {
        for (const k of ['mode', 'profanity', 'endpoint', 'muted']) {
          if (raw[k] !== undefined) settings[k] = raw[k];
        }
      }
    } catch (e) { /* start with defaults */ }
    if (!['standard', 'themed', 'banter', 'off'].includes(settings.mode)) settings.mode = 'banter';
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function themeId() {
    return (window.VCNThemes && window.VCNThemes.currentId()) || 'vice-city';
  }
  /* The active theme's voice block is the source of truth for the profile.
     Switching themes automatically changes the profile for every request
     made after the switch. */
  function voiceProfile() {
    const theme = (window.VCNThemes && window.VCNThemes.current()) || null;
    const v = (theme && theme.voice) || {};
    return {
      profile: v.profile || themeId(),
      provider: v.provider || 'openai',
      ttsVoice: v.ttsVoice || 'echo',
      ttsModel: v.ttsModel || 'gpt-4o-mini-tts',
      personaVersion: v.personaVersion || 'v1',
    };
  }
  /* Cache identity: profile + persona version + TTS model + TTS voice +
     mode + profanity + the deterministic instruction text. A theme switch,
     a persona wording bump, or a voice/model change never collides with
     another profile's cached audio. */
  const cacheKey = text => {
    const p = voiceProfile();
    return `${p.profile}|${p.personaVersion}|${p.ttsModel}|${p.ttsVoice}|` +
      `${settings.mode}|${settings.profanity ? 1 : 0}|${text}`;
  };
  function functionUrl() {
    const custom = (settings.endpoint || '').trim().replace(/\/+$/, '');
    if (custom) return custom;
    const cfg = window.VCNSupabase || {};
    const base = (cfg.url || '').trim().replace(/\/+$/, '');
    if (!base || /^https:\/\/YOUR_PROJECT_REF/i.test(base)) return '';
    return base + (cfg.functionPath || '/functions/v1/navigation-voice');
  }
  function supabaseHeaders() {
    const h = { 'Content-Type': 'application/json' };
    const cfg = window.VCNSupabase || {};
    const key = (cfg.anonKey || '').trim();
    if (key && !/^YOUR_SUPABASE/i.test(key)) {
      h['apikey'] = key;
      h['Authorization'] = 'Bearer ' + key;
    }
    return h;
  }

  /* ---------------- standard deterministic voice ---------------- */
  function synthSpeak(text) {
    if (!('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02; u.volume = 1;
      speechSynthesis.speak(u);
    } catch (e) { /* voice unavailable */ }
  }

  /* ---------------- themed voice ---------------- */
  function stopAudio() {
    if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl = null; }
  }
  function playCached(entry) {
    stopAudio();
    try { speechSynthesis.cancel(); } catch (e) {}
    audioEl = new Audio(entry.url);
    audioEl.play().catch(() => synthSpeak(entry.text));
  }
  function abortInflight(predicate) {
    for (const [key, rec] of inflight) {
      if (!predicate || predicate(key, rec)) {
        try { rec.ctrl.abort(); } catch (e) {}
        inflight.delete(key);
      }
    }
  }
  async function fetchTts(text) {
    const key = cacheKey(text);
    if (audioCache.has(key) || inflight.has(key)) return; // dedupe concurrent
    const url = functionUrl();
    if (!url) return;
    const profile = voiceProfile();
    const theme = themeId();
    const epoch = routeEpoch;
    const ctrl = new AbortController();
    inflight.set(key, { ctrl, theme, epoch });
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          text,
          theme,
          profile: profile.profile,
          personaVersion: profile.personaVersion,
          mode: settings.mode, // 'themed' | 'banter'
          profanity: !!settings.profanity,
        }),
        signal: ctrl.signal,
      });
      if (res.status === 429) throw new Error('voice daily cap reached');
      if (!res.ok) throw new Error('voice ' + res.status);
      const data = await res.json();
      const b64 = data && data.audio;
      const line = (data && data.line) || text;
      if (typeof b64 !== 'string' || !b64.length) throw new Error('empty audio');
      /* Stale check: a reroute or theme switch while this was in flight
         means this audio belongs to a dead route/theme — drop it. */
      const rec = inflight.get(key);
      if (!rec || rec.epoch !== routeEpoch || rec.theme !== themeId()) return;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: (data && data.mime) || 'audio/mpeg' });
      if (!blob.size) throw new Error('empty audio');
      const objUrl = URL.createObjectURL(blob);
      audioCache.set(key, { url: objUrl, text: line });
      while (audioCache.size > CACHE_MAX) {
        const oldest = audioCache.keys().next().value;
        const evicted = audioCache.get(oldest);
        audioCache.delete(oldest);
        try { URL.revokeObjectURL(evicted.url); } catch (e) {}
      }
    } catch (e) { /* silent: fallback already spoke; stays retryable */ }
    finally {
      clearTimeout(timer);
      const rec = inflight.get(key);
      if (rec && rec.ctrl === ctrl) inflight.delete(key);
    }
  }

  function themedSpeak(text) {
    const url = functionUrl();
    if (!url) {
      if (!endpointWarned) {
        endpointWarned = true;
        console.info('[vcn-voice] themed mode needs the Supabase voice function — see VOICE_SETUP.md, then set supabase-config.js; using standard voice.');
      }
      synthSpeak(text);
      return;
    }
    const key = cacheKey(text);
    const hit = audioCache.get(key);
    if (hit) { playCached(hit); return; }
    // Never wait for AI on an immediate maneuver: deterministic browser
    // speech now, themed audio warms the cache in the background.
    synthSpeak(text);
    fetchTts(text);
  }

  function speakInternal(text) {
    if (!text || settings.muted || settings.mode === 'off') return;
    if (settings.mode === 'standard') synthSpeak(text);
    else themedSpeak(text);
  }

  window.VCNVoice = {
    init() { loadSettings(); },

    getConfig: () => ({ ...settings }),
    setConfig(patch) {
      if (patch && typeof patch === 'object') {
        for (const k of ['mode', 'profanity', 'endpoint', 'muted']) {
          if (patch[k] !== undefined) settings[k] = patch[k];
        }
        if (!['standard', 'themed', 'banter', 'off'].includes(settings.mode)) settings.mode = 'banter';
        saveSettings();
      }
      return { ...settings };
    },
    mode: () => settings.mode,
    isMuted: () => settings.muted || settings.mode === 'off',
    setMuted(muted) {
      settings.muted = !!muted;
      saveSettings();
      if (settings.muted) { stopAudio(); try { speechSynthesis.cancel(); } catch (e) {} }
      return settings.muted;
    },

    /* Announcements ("Starting navigation", "Rerouting", "You have arrived") */
    speakText: text => speakInternal(text),

    /* Maneuver speech. text = deterministic canonical instruction
       built by app.js from the OSRM maneuver (the on-screen text). */
    speakManeuver: text => speakInternal(text),

    /* Pre-generate themed audio for upcoming maneuvers. Fire-and-forget:
       never awaited by navigation. */
    pregenerate(texts) {
      if (!Array.isArray(texts)) return;
      if (settings.mode !== 'themed' && settings.mode !== 'banter') return;
      if (!functionUrl()) return;
      texts.filter(Boolean).slice(0, PREGEN_DEPTH).forEach(t => { fetchTts(t); });
    },

    /* Drop cached audio for maneuvers no longer on the route, and abort
       any in-flight generation for them. Called on reroute. */
    pruneCache(keepTexts) {
      routeEpoch++;
      const keep = new Set((keepTexts || []).filter(Boolean).map(cacheKey));
      for (const [k, entry] of audioCache) {
        if (!keep.has(k)) {
          audioCache.delete(k);
          try { URL.revokeObjectURL(entry.url); } catch (e) {}
        }
      }
      abortInflight(key => !keep.has(key));
    },

    /* Called by app.js after a theme switch commits: the voice profile
       changes with the theme, so kill every in-flight generation from the
       old theme — it must never populate the cache or speak. */
    onThemeChanged() {
      routeEpoch++;
      abortInflight();
    },

    cancel() {
      stopAudio();
      try { speechSynthesis.cancel(); } catch (e) {}
      abortInflight();
    },
  };
})();
