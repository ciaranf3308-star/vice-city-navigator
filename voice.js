/* ============================================================
   Vice City Navigator — theme-aware navigation voice.
   ------------------------------------------------------------
   Pipeline: OSRM maneuver -> deterministic structured
   instruction (built by app.js, the LLM never decides
   navigation) -> Supabase Edge Function `navigation-voice`
   (server-side theme persona + Gemini free-tier rewrite +
   Gemini TTS speech) -> audio playback.

   The Gemini API key is NEVER in this client. The app sends only
   { text, theme, mode, profanity } to the Edge Function and gets
   back { line, audio }. The key lives solely as the GEMINI_API_KEY
   secret on the Supabase project (see VOICE_SETUP.md).

   The function enforces its own per-day request cap (VOICE_DAILY_CAP,
   default 1000), independent of the Google Places quota.

   Modes: standard | themed | banter | off
     standard — browser speechSynthesis, deterministic text
     themed   — AI persona voice, same structured content
     banter   — themed + the persona may add a very short quip
     off      — silent

   Pre-generation: when a route is calculated the app calls
   pregenerate() with the next few maneuver texts; audio is
   fetched in the background and cached. Speaking NEVER waits
   for the network — if themed audio isn't cached yet, the
   deterministic standard voice speaks immediately and the
   themed audio warms the cache for next time.
   ============================================================ */
'use strict';

(function () {
  const LS_KEY = 'vcn-voice-settings-v2';
  const CACHE_MAX = 24;
  const FETCH_TIMEOUT_MS = 12000;

  /* Defaults: full Vice City DJ — banter + profanity on. */
  const settings = { mode: 'banter', profanity: true, endpoint: '', muted: false };
  const audioCache = new Map(); // key -> { url, text }
  const inflight = new Set();
  let audioEl = null;
  let endpointWarned = false;

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
  /* The spoken persona now lives server-side in the Edge Function; the app
     only sends the theme id. `settings.endpoint` remains as an advanced
     override for a custom function URL. */
  const cacheKey = text => `${themeId()}|${settings.mode}|${settings.profanity ? 1 : 0}|${text}`;
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
  async function fetchTts(text) {
    const key = cacheKey(text);
    if (audioCache.has(key) || inflight.has(key)) return;
    const url = functionUrl();
    if (!url) return;
    inflight.add(key);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: supabaseHeaders(),
        body: JSON.stringify({
          text,
          theme: themeId(),
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
    finally { clearTimeout(timer); inflight.delete(key); }
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
    // Never wait: standard voice now, themed audio warms the cache.
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
      texts.filter(Boolean).slice(0, 5).forEach(t => { fetchTts(t); });
    },

    /* Drop cached audio for maneuvers no longer on the route. */
    pruneCache(keepTexts) {
      const keep = new Set((keepTexts || []).filter(Boolean).map(cacheKey));
      for (const [k, entry] of audioCache) {
        if (!keep.has(k)) {
          audioCache.delete(k);
          try { URL.revokeObjectURL(entry.url); } catch (e) {}
        }
      }
    },

    cancel() {
      stopAudio();
      try { speechSynthesis.cancel(); } catch (e) {}
    },
  };
})();
