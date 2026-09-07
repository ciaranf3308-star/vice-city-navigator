/* ============================================================
   Vice City Navigator — theme-aware navigation voice.
   ------------------------------------------------------------
   Pipeline: OSRM maneuver -> deterministic structured
   instruction (built by app.js, the LLM never decides
   navigation) -> theme personality rewriter -> OpenAI TTS
   (gpt-4o-mini-tts) -> audio playback.

   The OpenAI key is NEVER in this client. All AI calls go
   through the user's own tiny serverless endpoint (see
   tts-worker.js + VOICE_SETUP.md), whose URL is stored in
   local settings.

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
  const LS_KEY = 'vcn-voice-settings-v1';
  const CACHE_MAX = 24;
  const FETCH_TIMEOUT_MS = 12000;

  const settings = { mode: 'standard', profanity: false, endpoint: '', muted: false };
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
    if (!['standard', 'themed', 'banter', 'off'].includes(settings.mode)) settings.mode = 'standard';
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  function themeId() {
    return (window.VCNThemes && window.VCNThemes.currentId()) || 'vice-city';
  }
  function persona() {
    const t = window.VCNThemes ? window.VCNThemes.current() : null;
    const v = (t && t.voice) || {};
    let rewrite = v.rewriteInstructions || '';
    if (settings.mode === 'banter' && v.banterInstructions) rewrite += ' ' + v.banterInstructions;
    return {
      rewriteInstructions: rewrite,
      voice: v.ttsVoice || 'echo',
      ttsInstructions: v.ttsInstructions || '',
    };
  }
  const cacheKey = text => `${themeId()}|${settings.mode}|${settings.profanity ? 1 : 0}|${text}`;
  const endpointUrl = () => (settings.endpoint || '').trim().replace(/\/+$/, '');

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
    const base = endpointUrl();
    if (!base) return;
    inflight.add(key);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(base + '/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, persona: persona(), profanity: !!settings.profanity }),
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('tts ' + res.status);
      const blob = await res.blob();
      if (!blob || !blob.size) throw new Error('empty audio');
      const url = URL.createObjectURL(blob);
      audioCache.set(key, { url, text });
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
    const base = endpointUrl();
    if (!base) {
      if (!endpointWarned) {
        endpointWarned = true;
        console.info('[vcn-voice] themed mode needs the TTS endpoint URL (menu → voice settings); using standard voice.');
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
        if (!['standard', 'themed', 'banter', 'off'].includes(settings.mode)) settings.mode = 'standard';
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
      if (!endpointUrl()) return;
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
