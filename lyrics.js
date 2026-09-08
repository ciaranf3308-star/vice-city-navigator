/* ============================================================
   WayStation — kinetic karaoke lyric engine (THEME-INDEPENDENT).
   ------------------------------------------------------------
   One shared engine; themes only style it (see styles.css:
   .wslyr-vice-city / .wslyr-san-andreas / .wslyr-gta-v /
   .wslyr-rdr2). Replaces any lyric list inside a skin's
   [data-lyrics-stage] element with a three-state kinetic stage:

     PREVIOUS LINE — faint ghost (opacity ~0.08-0.15), drifts away
     CURRENT LINE  — hero: large, karaoke word progression
     NEXT LINE     — small teaser near the bottom edge

   Sync model: currentMs = progressMs + elapsedSinceSpotifyAnchor
   + LYRICS_OFFSET_MS. SpotifyCore.getPosition() already does the
   interpolation; this engine just adds the tunable offset and ticks
   at 400 ms. It never polls Spotify itself.

   Karaoke word progress is an ARTISTIC APPROXIMATION: LRCLIB only
   gives line timestamps, so words are distributed across
   (line start -> next line start). Never presented as true
   word timing.

   Unsynced lyrics -> ambient mode (slow typographic collage,
   no fake sync). Instrumental / missing -> themed idle states.
   Never invent lyric text.

   Provider: LRCLIB GET https://lrclib.net/api/get
   Exposes window.WSLyrics { render, destroy, setOffset }.
   ============================================================ */
'use strict';

(function () {
  var LRCLIB = 'https://lrclib.net/api/get';
  var TICK_MS = 400;
  var OFFSET_MS = -100;         // tuned: was 1s early at +600, 0.3s slow at -400
  var WORD_WINDOW_MAX = 12000;  // cap the word-spread window per line
  var AMBIENT_CYCLE_MS = 6000;
  var CACHE_MAX = 50;

  var cache = new Map();        // trackId -> Promise<lyricData>
  var stages = new WeakMap();   // stageEl -> stage state

  /* ---------------- pure utils (also used by tests) ---------------- */

  // FNV-1a 32-bit — deterministic seed from any string.
  function hashSeed(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Parse LRC-ish synced lyrics -> [{t, text}] sorted by time.
  // Skips metadata tags and pure note-marker lines.
  function parseLRC(text) {
    var lines = [];
    var tagRe = /\[(\d{1,3}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
    String(text || '').split(/\r?\n/).forEach(function (raw) {
      var tags = [], m;
      tagRe.lastIndex = 0;
      while ((m = tagRe.exec(raw))) {
        var ms = 0;
        if (m[3]) ms = m[3].length === 3 ? +m[3] : (+m[3]) * 10;
        tags.push((+m[1]) * 60000 + (+m[2]) * 1000 + ms);
      }
      var lyric = raw.replace(tagRe, '').trim();
      if (!tags.length || !lyric) return;
      if (/^[♪♫♬\s]*$/.test(lyric)) return;
      tags.forEach(function (t) { lines.push({ t: t, text: lyric }); });
    });
    lines.sort(function (a, b) { return a.t - b.t; });
    return lines;
  }

  function sizeClass(text) {
    var n = String(text).replace(/\s+/g, ' ').trim().length;
    if (n <= 8) return 'xl';   // short emotional lines may go HUGE
    if (n <= 24) return 'lg';
    if (n <= 48) return 'md';
    return 'sm';
  }

  var ALIGNS = ['left', 'center', 'right'];
  var VPOS = ['up', 'mid', 'low'];
  var CASINGS = ['upper', 'title', 'lower', 'as-is'];
  var SPACINGS = ['tight', 'normal', 'wide'];
  var ENTRANCES = ['spring', 'blur', 'pop', 'sweep', 'snap', 'flicker'];

  // Deterministic visual composition for one line. Same track +
  // same line index always yields the same composition.
  function composeSpec(trackId, lineIndex, text) {
    var rnd = mulberry32(hashSeed(String(trackId) + '|' + lineIndex));
    function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
    return {
      family: Math.floor(rnd() * 5),
      align: pick(ALIGNS),
      vpos: pick(VPOS),
      size: sizeClass(text),
      casing: pick(CASINGS),
      spacing: pick(SPACINGS),
      entrance: pick(ENTRANCES),
    };
  }

  function applyCase(text, casing) {
    var s = String(text);
    if (casing === 'upper') return s.toUpperCase();
    if (casing === 'lower') return s.toLowerCase();
    if (casing === 'title') {
      return s.replace(/\w\S*/g, function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      });
    }
    return s;
  }

  // Artistic word progress: spread words across
  // [lineStart, min(nextLineStart, lineStart + WORD_WINDOW_MAX)].
  // Returns {p, active} where active is the strongest word index.
  function wordProgress(nowMs, lineStartMs, lineEndMs, wordCount) {
    var end = Math.min(lineEndMs, lineStartMs + WORD_WINDOW_MAX);
    var dur = Math.max(1, end - lineStartMs);
    var p = (nowMs - lineStartMs) / dur;
    p = Math.min(1, Math.max(0, p));
    var active = wordCount > 0 ? Math.min(wordCount - 1, Math.floor(p * wordCount)) : -1;
    return { p: p, active: active };
  }

  // Index of the last line whose timestamp <= nowMs (-1 = none yet).
  function activeLineIndex(lines, nowMs) {
    var idx = -1;
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].t <= nowMs) idx = i; else break;
    }
    return idx;
  }

  // Classify an LRCLIB payload into an engine mode.
  function classifyPayload(j) {
    if (!j) return { mode: 'none', lines: [], plain: [] };
    if (j.instrumental) return { mode: 'instrumental', lines: [], plain: [] };
    var lines = parseLRC(j.syncedLyrics || '');
    if (lines.length) return { mode: 'karaoke', lines: lines, plain: [] };
    var plain = String(j.plainLyrics || '').split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && !/^[♪♫♬\s]*$/.test(s); });
    if (plain.length) return { mode: 'ambient', lines: [], plain: plain };
    return { mode: 'none', lines: [], plain: [] };
  }

  /* ---------------- lyric fetching ---------------- */

  var LRCLIB_SEARCH = 'https://lrclib.net/api/search';
  var NEG_TTL_MS = 5 * 60 * 1000; // negative results retry after 5 min

  // Normalize a Spotify title for lyric LOOKUP only — never shown to user.
  // Strips version noise: remasters, radio edits, deluxe markers, year suffixes.
  function normalizeTitle(t) {
    if (!t) return '';
    var s = String(t);
    // Remove parenthetical/bracketed version noise
    s = s.replace(/\s*[\(\[][^\)\]]*(remaster|remastered|radio edit|deluxe|anniversary|explicit|clean|single version|album version|extended|acoustic|live|demo)[^\)\]]*[\)\]]/gi, '');
    // Remove dash-separated version noise: " - Remastered 2011"
    s = s.replace(/\s*-\s*(remastered|remaster|radio edit|deluxe|anniversary).*/gi, '');
    // Remove trailing year in parens: " (2011)"
    s = s.replace(/\s*\(\d{4}\)\s*$/g, '');
    // Remove " - 2011 Remaster" style suffixes
    s = s.replace(/\s*\d{4}\s*(remaster|remastered).*$/gi, '');
    return s.trim().replace(/\s+/g, ' ');
  }

  function normStr(s) {
    return String(s || '').toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]/g, '').replace(/\s+/g, ' ').trim();
  }

  // Pick the best LRCLIB search candidate by title/artist match + duration.
  function pickCandidate(results, title, artist, album, durationMs) {
    if (!results || !results.length) return null;
    var nTitle = normStr(title), nArtist = normStr(artist), nAlbum = normStr(album);
    var durSec = durationMs ? Math.round(durationMs / 1000) : 0;
    var best = null, bestScore = -1;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var score = 0;
      if (normStr(r.trackName || r.name) === nTitle) score += 10;
      else if (normStr(r.trackName || r.name).indexOf(nTitle) === 0 || nTitle.indexOf(normStr(r.trackName || r.name)) === 0) score += 5;
      if (normStr(r.artistName) === nArtist) score += 10;
      else if (normStr(r.artistName).indexOf(nArtist) === 0 || nArtist.indexOf(normStr(r.artistName)) === 0) score += 4;
      if (nAlbum && normStr(r.albumName) === nAlbum) score += 3;
      if (durSec && r.duration) {
        var d = Math.abs(r.duration - durSec);
        if (d <= 2) score += 5;
        else if (d <= 5) score += 2;
      }
      // Must have usable lyrics to be a candidate
      var c = classifyPayload(r);
      if (c.mode === 'none') continue;
      if (score > bestScore) { bestScore = score; best = r; }
    }
    // Require a minimum match quality — don't accept garbage
    return (best && bestScore >= 10) ? best : null;
  }

  async function searchFallback(artists, title, album, durationMs, trackId) {
    var nTitle = normalizeTitle(title);
    var q = 'artist_name=' + encodeURIComponent(artists) +
      '&track_name=' + encodeURIComponent(nTitle || title);
    if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric search fallback', { trackId, q });
    var res;
    try {
      res = await fetch(LRCLIB_SEARCH + '?' + q);
    } catch (e) {
      return { mode: 'none', lines: [], plain: [], _transient: true };
    }
    if (!res.ok) {
      return { mode: 'none', lines: [], plain: [], _transient: res.status >= 500 };
    }
    var arr;
    try { arr = await res.json(); } catch (e) {
      return { mode: 'none', lines: [], plain: [], _transient: true };
    }
    var best = pickCandidate(arr, nTitle || title, artists.split(',')[0], album, durationMs);
    if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric search result', {
      trackId, candidates: arr.length, picked: best ? best.trackName + ' / ' + best.artistName : null });
    if (!best) return { mode: 'none', lines: [], plain: [] };
    return classifyPayload(best);
  }

  function fetchLyrics(item) {
    var id = item.id;
    var cached = cache.get(id);
    // Negative entries expire after NEG_TTL_MS; successes are permanent
    if (cached) {
      if (cached.expires && Date.now() > cached.expires) cache.delete(id);
      else return cached.promise;
    }
    var p = (async function () {
      var artists = (item.artists || []).map(function (a) { return a.name; })
        .filter(Boolean).join(', ');
      if (!item.name || !artists) return { mode: 'none', lines: [], plain: [] };
      var album = (item.album && item.album.name) || '';
      var q = 'artist_name=' + encodeURIComponent(artists) +
        '&track_name=' + encodeURIComponent(item.name) +
        (album ? '&album_name=' + encodeURIComponent(album) : '') +
        (item.duration_ms ? '&duration=' + Math.round(item.duration_ms / 1000) : '');
      if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric exact query', { trackId: id, q: decodeURIComponent(q) });
      var res;
      try {
        res = await fetch(LRCLIB + '?' + q);
      } catch (e) {
        // Network error: transient — do NOT cache permanently
        if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric fetch network error', { trackId: id });
        return { mode: 'none', lines: [], plain: [], _transient: true };
      }
      if (res.status === 404) {
        // Exact miss: try search fallback with normalized title
        var fb = await searchFallback(artists, item.name, album, item.duration_ms, id);
        if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric result mode', { trackId: id, mode: fb.mode, via: 'fallback' });
        return fb;
      }
      if (!res.ok) {
        // 5xx: transient — allow retry
        var transient = res.status >= 500;
        if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric fetch HTTP ' + res.status, { trackId: id });
        return { mode: 'none', lines: [], plain: [], _transient: transient };
      }
      var j;
      try { j = await res.json(); } catch (e) {
        return { mode: 'none', lines: [], plain: [], _transient: true };
      }
      var out = classifyPayload(j);
      if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric result mode', { trackId: id, mode: out.mode, via: 'exact' });
      return out;
    })();
    // Cache policy: successes permanent; transient failures not cached at all;
    // hard negatives cached with short TTL.
    var entry = { promise: p, expires: 0 };
    cache.set(id, entry);
    p.then(function (data) {
      if (data && data._transient) {
        cache.delete(id); // network/5xx/parse: retry next time
      } else if (data && data.mode === 'none') {
        entry.expires = Date.now() + NEG_TTL_MS; // negative: short TTL
      }
      // karaoke/ambient/instrumental: permanent (expires = 0)
    }).catch(function () { cache.delete(id); });
    if (cache.size > CACHE_MAX) {
      var oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
    return p;
  }

  /* ---------------- stage DOM ---------------- */

  function buildStage(stageEl, themeId) {
    stageEl.innerHTML =
      '<div class="wslyr wslyr-' + esc(themeId) + '" data-wslyr>' +
        '<div class="wslyr-prev" aria-hidden="true"></div>' +
        '<div class="wslyr-hero" aria-live="off"></div>' +
        '<div class="wslyr-next" aria-hidden="true"></div>' +
        '<div class="wslyr-state"></div>' +
      '</div>';
    return {
      root: stageEl.firstChild,
      prev: stageEl.querySelector('.wslyr-prev'),
      hero: stageEl.querySelector('.wslyr-hero'),
      next: stageEl.querySelector('.wslyr-next'),
      state: stageEl.querySelector('.wslyr-state'),
    };
  }

  function setStateView(st, name) {
    st.mode = name;
    st.dom.prev.innerHTML = '';
    st.dom.hero.innerHTML = '';
    st.dom.hero.className = 'wslyr-hero';
    st.dom.next.innerHTML = '';
    st.dom.root.classList.remove('is-karaoke', 'is-ambient');
    st.dom.root.classList.add('is-idle');
    st.stageEl.classList.remove('has-lyrics');
    var html = '';
    if (name === 'loading') html = '<span class="wslyr-load"><i></i><i></i><i></i></span>';
    else if (name === 'waiting') html = '<span class="wslyr-wait">\u266A</span>';
    else if (name === 'instrumental') html = '<span class="wslyr-wait">\u266A</span><span class="wslyr-cap">instrumental</span>';
    else html = '<span class="wslyr-cap">lyrics unavailable</span>';
    st.dom.state.innerHTML = html;
    st.dom.state.hidden = false;
  }

  function heroClasses(spec, ambient) {
    return 'wslyr-hero f' + spec.family +
      ' a-' + spec.align + ' v-' + spec.vpos + ' s-' + spec.size +
      ' c-' + spec.casing + ' sp-' + spec.spacing +
      ' in-' + spec.entrance + (ambient ? ' wslyr-ambient-hero' : '');
  }

  function setLine(st, idx, nowMs) {
    var lines = st.data.lines;
    // Previous hero becomes the ghost.
    if (st.curIdx != null && st.curIdx >= 0 && st.curIdx < lines.length) {
      st.dom.prev.textContent = lines[st.curIdx].text;
      // restart the ghost fade
      st.dom.prev.classList.remove('wslyr-ghost-run');
      void st.dom.prev.offsetWidth;
      st.dom.prev.classList.add('wslyr-ghost-run');
    } else {
      st.dom.prev.textContent = '';
    }
    st.curIdx = idx;
    st.dom.state.hidden = true;
    if (idx < 0) {
      // Before the first line: hero empty, first line teased.
      st.dom.hero.innerHTML = '';
      st.dom.hero.className = 'wslyr-hero';
      st.dom.next.textContent = lines.length ? lines[0].text : '';
      st.words = [];
      return;
    }
    var line = lines[idx];
    var spec = composeSpec(st.trackId, idx, line.text);
    var words = applyCase(line.text, spec.casing).split(/\s+/).filter(Boolean);
    st.dom.hero.className = heroClasses(spec, false);
    st.dom.hero.innerHTML = words.map(function (w) {
      return '<span class="wslyr-w unsung">' + esc(w) + '</span>';
    }).join(' ');
    st.words = Array.prototype.slice.call(st.dom.hero.querySelectorAll('.wslyr-w'));
    st.dom.next.textContent = (idx + 1 < lines.length) ? lines[idx + 1].text : '';
    updateWords(st, nowMs);
  }

  function updateWords(st, nowMs) {
    if (!st.words || !st.words.length || st.curIdx == null || st.curIdx < 0) return;
    var lines = st.data.lines;
    var line = lines[st.curIdx];
    var endMs = (st.curIdx + 1 < lines.length) ? lines[st.curIdx + 1].t
      : (st.durationMs || (line.t + WORD_WINDOW_MAX));
    var r = wordProgress(nowMs, line.t, endMs, st.words.length);
    for (var i = 0; i < st.words.length; i++) {
      var cls = 'wslyr-w ' + (i < r.active ? 'sung' : (i === r.active ? 'active' : 'unsung'));
      if (st.words[i].className !== cls) st.words[i].className = cls;
    }
  }

  /* ---------------- ambient mode ---------------- */

  function tickAmbient(st) {
    var plain = st.data.plain;
    if (!plain.length) return;
    var cycle = Math.floor(Date.now() / AMBIENT_CYCLE_MS);
    if (cycle === st.ambientCycle) return;
    st.ambientCycle = cycle;
    var rnd = mulberry32(hashSeed(st.trackId + '|a' + cycle));
    var start = Math.floor(rnd() * plain.length);
    var len = 1 + Math.floor(rnd() * Math.min(3, plain.length));
    var frag = [];
    for (var i = 0; i < len; i++) frag.push(plain[(start + i) % plain.length]);
    var text = frag.join(' \u00B7 ');
    var spec = composeSpec(st.trackId, 10000 + cycle, text);
    spec.entrance = rnd() < 0.5 ? 'blur' : 'spring'; // gentle only
    st.dom.state.hidden = true;
    st.dom.prev.textContent = '';
    st.dom.hero.className = heroClasses(spec, true);
    st.dom.hero.textContent = applyCase(text, spec.casing);
    st.dom.next.textContent = '';
    st.curIdx = -2; // ambient marker
  }

  /* ---------------- engine tick ---------------- */

  function tick(st) {
    if (!st.stageEl.isConnected) {
      if (st.timer) { clearInterval(st.timer); st.timer = null; }
      stages.delete(st.stageEl);
      return;
    }
    var d = st.data;
    if (!d || d === 'loading') return;
    if (d.mode === 'ambient') { tickAmbient(st); return; }
    if (d.mode !== 'karaoke') return;
    var nowMs = st.core.getPosition() + OFFSET_MS;
    var idx = activeLineIndex(d.lines, nowMs);
    if (idx !== st.curIdx) setLine(st, idx, nowMs);
    else updateWords(st, nowMs);
  }

  function ensureTimer(st) {
    if (st.timer) return;
    st.timer = setInterval(function () { tick(st); }, TICK_MS);
  }

  /* ---------------- public API ---------------- */

  // Idempotent: safe to call on every skin render. Only rebuilds
  // when the track changes; otherwise just ticks.
  function render(stageEl, core, item, themeId) {
    if (typeof document === 'undefined' || !stageEl || !core) return;
    var st = stages.get(stageEl);
    if (!st || st.themeId !== themeId) {
      if (st && st.timer) { clearInterval(st.timer); }
      var dom = buildStage(stageEl, themeId || 'vice-city');
      st = {
        stageEl: stageEl, core: core, themeId: themeId || 'vice-city',
        dom: dom, trackId: null, data: null, timer: null,
        curIdx: -1, words: [], durationMs: 0, ambientCycle: -1,
        fetchToken: 0, mode: '',
      };
      stages.set(stageEl, st);
    } else {
      st.core = core;
    }

    if (!item || !item.id) {
      st.trackId = null;
      if (st.mode !== 'waiting') setStateView(st, 'waiting');
      return;
    }
    if (st.trackId !== item.id) {
      st.trackId = item.id;
      st.durationMs = item.duration_ms || 0;
      st.curIdx = null; // uninitialized: first tick always runs setLine
      st.words = [];
      st.ambientCycle = -1;
      st.data = 'loading';
      setStateView(st, 'loading');
      var token = ++st.fetchToken;
      fetchLyrics(item).then(function (data) {
        if (!stages.get(stageEl) || st.fetchToken !== token || st.trackId !== item.id) {
          if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] lyric DISCARDED (stale)', { trackId: item.id, curTrack: st.trackId });
          return;
        }
        st.data = data;
        if (data.mode === 'karaoke') {
          st.dom.root.classList.remove('is-idle');
          st.dom.root.classList.add('is-karaoke');
          st.stageEl.classList.add('has-lyrics');
          tick(st);
        } else if (data.mode === 'ambient') {
          st.dom.root.classList.remove('is-idle');
          st.dom.root.classList.add('is-ambient');
          st.stageEl.classList.add('has-lyrics');
          tick(st);
        } else if (data.mode === 'instrumental') {
          setStateView(st, 'instrumental');
        } else {
          setStateView(st, 'none');
        }
      });
    }
    ensureTimer(st);
    tick(st);
  }

  function destroy(stageEl) {
    var st = stageEl && stages.get(stageEl);
    if (st && st.timer) clearInterval(st.timer);
    if (stageEl) {
      stages.delete(stageEl);
      stageEl.innerHTML = '';
      stageEl.classList.remove('has-lyrics');
    }
  }

  function setOffset(ms) {
    var v = Math.max(-2000, Math.min(5000, Math.round(ms) || 0));
    OFFSET_MS = v;
    return v;
  }

  if (typeof window !== 'undefined') {
    window.WSLyrics = {
      render: render,
      destroy: destroy,
      setOffset: setOffset,
      getOffset: function () { return OFFSET_MS; },
      util: {
        hashSeed: hashSeed,
        parseLRC: parseLRC,
        composeSpec: composeSpec,
        applyCase: applyCase,
        wordProgress: wordProgress,
        activeLineIndex: activeLineIndex,
        classifyPayload: classifyPayload,
        sizeClass: sizeClass,
      },
    };
  }
})();
