/* ============================================================
   Vice City Navigator — theme-aware navigation voice.
   ------------------------------------------------------------
   Pipeline: OSRM maneuver -> deterministic structured
   instruction (built by app.js; the voice layer NEVER decides
   navigation) -> themed line -> speechSynthesis.

   Themed + banter modes are generated ON THE PHONE by the DJ
   phrasebook below: an energetic 1980s Miami radio persona
   (original, not an actor clone). No network, no API keys, no
   cost, works in tunnels. The deterministic instruction stays
   on screen regardless of what the DJ says.

   Modes: standard | themed | banter | off
     standard — speechSynthesis, deterministic text, flat delivery
     themed   — DJ phrasebook line, same structured content
     banter   — themed + the DJ may add a very short quip
     off      — silent

   `endpoint` (menu > Voice) remains as an advanced override: if a
   custom voice-server URL is set, themed audio is fetched from it
   exactly as before (Supabase Edge Function contract
   { text, theme, mode, profanity } -> { line, audio }). Empty by
   default = fully on-device.
   ============================================================ */
'use strict';

(function () {
  const LS_KEY = 'vcn-voice-settings-v1';
  const CACHE_MAX = 24;
  const FETCH_TIMEOUT_MS = 12000;

  const settings = { mode: 'standard', profanity: false, endpoint: '', muted: false };
  const audioCache = new Map(); // key -> { url, text } (server path only)
  const inflight = new Set();
  let audioEl = null;
  let djVoice = null;

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

  /* Pick a fitting DJ voice when the platform offers one; otherwise the
     default voice. Best-effort — voices load async on some platforms. */
  function pickDjVoice() {
    if (!('speechSynthesis' in window)) return;
    try {
      const vs = speechSynthesis.getVoices() || [];
      if (!vs.length) return;
      const want = vs.find(v => /daniel|david|alex|fred|jorge|diego/i.test(v.name) && /^en/i.test(v.lang))
        || vs.find(v => /google us english/i.test(v.name))
        || vs.find(v => /^en[-_]US/i.test(v.lang) && /male/i.test(v.name))
        || null;
      djVoice = want || null;
    } catch (e) { djVoice = null; }
  }

  /* ---------------- standard deterministic voice ---------------- */
  function synthSpeak(text, themed) {
    if (!('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = themed ? 1.06 : 1.02;
      u.pitch = themed ? 1.05 : 1;
      u.volume = 1;
      if (themed && djVoice) u.voice = djVoice;
      speechSynthesis.speak(u);
    } catch (e) { /* voice unavailable */ }
  }

  /* ============================================================
     DJ PHRASEBOOK — on-device themed lines.
     Every builder keeps the maneuver facts intact: direction,
     distance and road name always survive the rewrite.
     ============================================================ */
  const lastPick = {};
  function pick(arr, key) {
    if (!arr.length) return '';
    if (arr.length === 1) return arr[0];
    let i = Math.floor(Math.random() * arr.length);
    if (i === lastPick[key]) i = (i + 1) % arr.length;
    lastPick[key] = i;
    return arr[i];
  }

  const INTROS = [
    'Alright Vice City,',
    'Yo, check it —',
    'Traffic report, hot off the wire:',
    'Cruisers, listen up —',
    'Coming at you live —',
  ];
  const OUTROS = [
    'keep it smooth.',
    'stay groovy.',
    'easy does it.',
    'nice and easy.',
  ];
  const QUIPS = [
    'The neon looks good on you tonight.',
    'No cops, no problems.',
    'This city never sleeps, and neither do we.',
    'Windows down, volume up.',
    'Ocean Drive energy, baby.',
  ];
  const SPICY_QUIPS = [
    'Damn, this city is beautiful at night.',
    'Hell of a cruise so far.',
  ];

  /* Parse the canonical instruction into facts the DJ can riff on. */
  function parseFacts(text) {
    let t = String(text || '').trim().replace(/\s+/g, ' ');
    let dist = '';
    const dm = t.match(/^In\s+([^,]+),\s*/i);
    if (dm) { dist = 'in ' + dm[1].trim(); t = t.slice(dm[0].length); }
    const core = t.replace(/\.\s*$/, '');
    const roadM = core.match(/onto\s+(.+)$/i);
    const road = roadM ? roadM[1].trim() : '';
    return { dist, road, onto: road ? ' onto ' + road : '', core };
  }

  function djLine(text) {
    const profane = !!settings.profanity;
    const banter = settings.mode === 'banter';
    const F = parseFacts(text);
    const core = F.core;
    const intro = () => pick(INTROS, 'intro');
    const outro = () => pick(OUTROS, 'outro');
    const distBit = F.dist ? F.dist + ', ' : '';

    /* Announcements first. */
    let m;
    if (/^starting navigation/i.test(core)) {
      const total = (core.match(/total\s+(.+?)$/i) || [])[1] || '';
      const first = core.replace(/^starting navigation\.?\s*/i, '').replace(/\s*total\s+.+?$/i, '').trim();
      return `${intro()} we're rolling! ${first ? first + '. ' : ''}${total ? total + ' of open road ahead of us — ' : ''}let's cruise.`;
    }
    if (/^rerouting/i.test(core)) {
      return pick([
        `Whoa, missed that one — no sweat, I'm recalculating.`,
        `Detour alert! Rerouting you now, stay cool.`,
        `${intro()} slight change of plans — new route coming up.`,
      ], 'reroute');
    }
    if (/^new route/i.test(core)) {
      const rest = core.replace(/^new route\.?\s*/i, '').trim();
      return `Fresh route locked in. ${rest ? rest + '.' : outro()}`;
    }
    if (/arrived/i.test(core)) {
      return pick([
        `And that's the spot — you've arrived. Welcome to Vice City, baby.`,
        `We made it! You've arrived. Kill the engine and enjoy.`,
        `Destination reached. ${intro()} what a cruise that was.`,
      ], 'arrive');
    }

    /* Maneuvers — direction, distance and road always survive. */
    let line = '';
    if ((m = core.match(/at the end of the road,?\s*turn\s+(.+?)(?:\s+onto\s+.+)?$/i))) {
      const dir = m[1].trim();
      line = pick([
        `${intro()} at the end of the road, swing a ${dir}${F.onto}.`,
        `End of the road coming up — take a ${dir}${F.onto}, ${outro()}`,
      ], 'endofroad');
    } else if (/roundabout|rotary/i.test(core)) {
      line = pick([
        `${intro()} roundabout ahead — take the exit${F.onto}.`,
        `Roundabout coming up ${distBit}take the exit${F.onto}, ${outro()}`,
        `Easy through the roundabout — exit${F.onto}, ${distBit}${outro()}`,
      ], 'roundabout');
    } else if ((m = core.match(/turn\s+(.+?)(?:\s+onto\s+.+)?$/i))) {
      const dir = m[1].trim();
      line = pick([
        `${intro()} ${distBit}hang a ${dir}${F.onto}.`,
        `Heads up — ${dir} turn${F.onto} coming up ${distBit}${outro()}`,
        `${distBit}take a ${dir}${F.onto} — nice and easy.`,
        profane ? `Damn, slick ${dir} coming up${F.onto} ${distBit}— take it.` : `${intro()} ${distBit}we're going ${dir}${F.onto}.`,
      ], 'turn');
    } else if ((m = core.match(/keep\s+(left|right)/i))) {
      const dir = m[1].toLowerCase();
      line = pick([
        `Keep ${dir}${F.onto}, ${outro()}`,
        `${intro()} stay ${dir}${F.onto}.`,
      ], 'fork');
    } else if (/^merge/i.test(core)) {
      line = pick([
        `Merge${F.onto} — slide in smooth.`,
        `${intro()} merge${F.onto}, ${outro()}`,
      ], 'merge');
    } else if ((m = core.match(/take the (ramp|exit)/i))) {
      const which = m[1].toLowerCase();
      line = pick([
        `${intro()} take the ${which}${F.onto}.`,
        `${distBit}take the ${which}${F.onto}, ${outro()}`,
      ], 'ramp');
    } else if (/^continue/i.test(core)) {
      line = pick([
        `Just cruise straight${F.onto}${F.dist ? ' — ' + F.dist + ' of open road' : ''}.`,
        `${intro()} straight on${F.onto}, ${outro()}`,
        `Hold your line${F.onto}.`,
      ], 'continue');
    } else if ((m = core.match(/^head\s+(\w+)/i))) {
      const heading = m[1].toLowerCase();
      line = pick([
        `${intro()} head ${heading}${F.onto} — we're rolling.`,
        `We move! Head ${heading}${F.onto}.`,
      ], 'depart');
    }

    if (!line) return text; // unknown text: speak it flat, never drop info
    if (banter && Math.random() < 0.4) {
      const quips = profane ? QUIPS.concat(SPICY_QUIPS) : QUIPS;
      line += ' ' + pick(quips, 'quip');
    }
    return line;
  }

  /* ---------------- server path (advanced override only) ---------------- */
  const cacheKey = text => `${themeId()}|${settings.mode}|${settings.profanity ? 1 : 0}|${text}`;
  function functionUrl() {
    const custom = (settings.endpoint || '').trim().replace(/\/+$/, '');
    if (custom) return custom;
    return ''; // on-device by default; no Supabase call unless overridden
  }
  function serverHeaders() {
    return { 'Content-Type': 'application/json' };
  }
  function stopAudio() {
    if (audioEl) { try { audioEl.pause(); } catch (e) {} audioEl = null; }
  }
  function playCached(entry) {
    stopAudio();
    try { speechSynthesis.cancel(); } catch (e) {}
    audioEl = new Audio(entry.url);
    audioEl.play().catch(() => synthSpeak(entry.text, false));
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
        headers: serverHeaders(),
        body: JSON.stringify({
          text,
          theme: themeId(),
          mode: settings.mode, // 'themed' | 'banter'
          profanity: !!settings.profanity,
        }),
        signal: ctrl.signal,
      });
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

  /* ---------------- themed voice ---------------- */
  function themedSpeak(text) {
    if (functionUrl()) {
      // Advanced override: custom voice server.
      const key = cacheKey(text);
      const hit = audioCache.get(key);
      if (hit) { playCached(hit); return; }
      synthSpeak(text, false); // never wait for the network
      fetchTts(text);
      return;
    }
    // On-device DJ: instant, free, offline.
    synthSpeak(djLine(text), true);
  }

  function speakInternal(text) {
    if (!text || settings.muted || settings.mode === 'off') return;
    if (settings.mode === 'standard') synthSpeak(text, false);
    else themedSpeak(text);
  }

  window.VCNVoice = {
    init() { loadSettings(); pickDjVoice(); try {
      if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = pickDjVoice;
    } catch (e) {} },

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

    /* Pre-generate themed audio for upcoming maneuvers (server path
       only — the on-device DJ is instant). Fire-and-forget. */
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
