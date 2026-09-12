/* ============================================================
   WayStation — San Andreas Spotify skin (dashboard mode only),
   TARGET-LOCK PASS 1 (2026-09-08 hero7 skin replaced 2026-09-12).

   The outer skin is authored art (themes/san-andreas/dashboard/
   radio-target-v1.png, 640x544): dark scenic Los Santos / palm /
   lowrider base with a NEUTRAL top-left zone. Live HTML sits over
   the art: a DYNAMIC GTA:SA station logo (real vendored PNGs in
   themes/san-andreas/radio-stations/, crossfaded on change),
   album art lower-left, title/artist + progress + transport in the
   lower column. Right side, under the 74px topbar.

   DYNAMIC STATION: on every NEW track the skin asks SpotifyCore
   for the artists' full objects (cached 30d, track-change only —
   never on the 5s poll), merges their genre strings and resolves
   the nearest fictional station via SAStationResolver (weighted,
   San-Andreas-owned logic). Episodes -> WCTR with no genre fetch.
   Unresolvable -> keep the previous station (no flicker); first
   run falls back to Radio Los Santos.

   LYRICS: owned by the shared kinetic karaoke engine (lyrics.js,
     LRCLIB provider) mounted into [data-lyrics-stage] via
     window.WSLyrics.render(). Visually suppressed in SA dashboard
     by CSS to match the locked hero; the engine and other themes
     are untouched.
   ============================================================ */
'use strict';

(function () {
  const BEZEL = 'themes/san-andreas/dashboard/radio-target-v3.png';
  const STATION_DIR = 'themes/san-andreas/radio-stations/';
  const FALLBACK_STATION = 'radio-los-santos';

  const SVG = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
  };

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function fmt(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function stationName(id) {
    try {
      if (window.SAStationResolver && SAStationResolver.STATIONS[id]) {
        return SAStationResolver.STATIONS[id].name;
      }
    } catch (e) {}
    return 'Radio Los Santos';
  }
  function stationFile(id) {
    try {
      if (window.SAStationResolver && SAStationResolver.STATIONS[id]) {
        return SAStationResolver.STATIONS[id].file;
      }
    } catch (e) {}
    return 'radio-los-santos.png';
  }

  function createSkin() {
    let root = null, core = null;
    let offs = [];
    let tickTimer = null;
    let currentArtUrl = '';
    let artGen = 0;
    let artTrackId = null;
    let statusTimer = null;
    let lyricsRenderer = null;
    /* station state */
    let currentStation = FALLBACK_STATION;
    let stationTrackId = null;   // item.id the logo was resolved for
    let stationGen = 0;

    /* ---------- dom ---------- */
    function build() {
      root = el('div', 'sasp');
      root.innerHTML =
        '<img class="sasp-bezel" src="' + BEZEL + '" alt="" aria-hidden="true">' +
        '<div class="sasp-station" aria-hidden="true">' +
          '<img class="sasp-station-logo a" alt="">' +
          '<img class="sasp-station-logo b" alt="">' +
        '</div>' +
        '<div class="sasp-tagline" aria-hidden="true">GOOD MUSIC<br>BETTER DRIVES</div>' +
        '<div class="sasp-main">' +
          '<div class="sasp-artwrap">' +
            '<div class="sasp-art-idle">' + SVG.note + '</div>' +
            '<img class="sasp-art a" alt="">' +
            '<img class="sasp-art b" alt="">' +
          '</div>' +
          '<div class="sasp-meta">' +
            '<div class="sasp-title">Radio Los Santos</div>' +
            '<div class="sasp-artist">Connect Spotify to play</div>' +
          '</div>' +
          '<div class="sasp-progress">' +
            '<div class="sasp-bar" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100">' +
              '<div class="sasp-bar-fill"></div>' +
              '<div class="sasp-bar-knob"></div>' +
            '</div>' +
            '<div class="sasp-times"><span class="sasp-elapsed">0:00</span><span class="sasp-duration">0:00</span></div>' +
          '</div>' +
          '<div class="sasp-controls">' +
            '<button class="sasp-tbtn" data-act="shuffle" aria-label="Shuffle">' + SVG.shuffle + '</button>' +
            '<button class="sasp-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
            '<button class="sasp-tbtn" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
            '<button class="sasp-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
            '<button class="sasp-tbtn" data-act="repeat" aria-label="Repeat">' + SVG.repeat + '</button>' +
          '</div>' +
          '<div class="sasp-lyrics" data-lyrics-stage="1"></div>' +
        '</div>' +
        '<div class="sasp-idle">' +
          '<div class="sasp-idle-kicker">Radio Los Santos</div>' +
          '<button class="sasp-connect-btn" type="button">Connect Spotify</button>' +
          '<p class="sasp-idle-hint">Music plays on your phone or car.<br>WayStation controls it.</p>' +
        '</div>';
      // initial fallback logo, no flash
      const a = root.querySelector('.sasp-station-logo.a');
      a.src = STATION_DIR + stationFile(currentStation);
      a.classList.add('on');
      return root;
    }

    const q = sel => root.querySelector(sel);

    /* ---------- dynamic station logo ---------- */
    function setStation(id) {
      if (!id || id === currentStation) return;
      currentStation = id;
      stationGen++;
      const myGen = stationGen;
      const a = q('.sasp-station-logo.a'), b = q('.sasp-station-logo.b');
      const show = a.classList.contains('on') ? b : a;
      const hide = show === a ? b : a;
      show.onload = () => {
        if (myGen !== stationGen) return; // stale
        show.classList.add('on');
        hide.classList.remove('on');
      };
      show.onerror = () => { if (myGen === stationGen) show.classList.remove('on'); };
      show.setAttribute('src', STATION_DIR + stationFile(id));
      const kicker = q('.sasp-idle-kicker');
      if (kicker) kicker.textContent = stationName(id);
    }

    /* Resolve the station for a fresh track. Episodes go straight to
       WCTR; music merges cached artist genres then weighted-resolves.
       Null resolution keeps the previous station (no flicker). */
    function resolveStationFor(item) {
      if (!item || !item.id) return;
      stationTrackId = item.id;
      const myTrack = item.id;
      let ep = false;
      try {
        ep = window.SAStationResolver &&
          SAStationResolver.stationForItem(item, []) === 'wctr' &&
          (String(item.currently_playing_type || item.type || '').toLowerCase() === 'episode' ||
           !!item.show);
      } catch (e) {}
      if (ep) { setStation('wctr'); return; }
      if (!window.SAStationResolver || !core.getArtists) return;
      const ids = (item.artists || []).map(a => a && a.id).filter(Boolean);
      if (!ids.length) return; // keep previous
      core.getArtists(ids).then(artists => {
        if (myTrack !== stationTrackId) return; // stale track
        const genres = [];
        (artists || []).forEach(a => (a.genres || []).forEach(g => genres.push(g)));
        let st = null;
        try { st = SAStationResolver.stationForItem(item, genres); } catch (e) {}
        if (st) setStation(st); // null -> retain previous, no flicker
      }).catch(() => { /* offline/API hiccup: keep previous station */ });
    }

    /* ---------- transient status line (reuses the artist slot) ---------- */
    function status(msg, sticky) {
      const a = q('.sasp-artist');
      if (!a) return;
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      if (msg) {
        a.dataset.real = a.textContent;
        a.textContent = msg;
        a.classList.add('sasp-status');
        if (!sticky) statusTimer = setTimeout(() => {
          a.textContent = a.dataset.real || '';
          a.classList.remove('sasp-status');
        }, 4000);
      }
    }

    /* ---------- render ---------- */
    function render() {
      const s = core.getState();
      const idle = q('.sasp-idle');
      const connected = core.isConnected();
      const hasTrack = !!(s && s.item && s.item.id);
      idle.hidden = connected || hasTrack;
      root.classList.toggle('is-idle', !connected && !hasTrack);
      const title = q('.sasp-title'), artist = q('.sasp-artist');
      const toggle = q('.sasp-tbtn[data-act="toggle"]');
      const shuffleBtn = q('.sasp-tbtn[data-act="shuffle"]');
      const repeatBtn = q('.sasp-tbtn[data-act="repeat"]');
      if (!connected) {
        stopTick();
        title.textContent = stationName(currentStation);
        artist.textContent = 'Connect Spotify to play';
        artist.classList.remove('sasp-status');
        setArt('', null);
        stationTrackId = null;
        toggle.innerHTML = SVG.play;
        renderLyrics(null);
        return;
      }
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Press play in Spotify';
        setArt('', null);
        stationTrackId = null;
        toggle.innerHTML = SVG.play;
        q('.sasp-duration').textContent = '0:00';
        updateProgress(0, 0);
        renderLyrics(null);
        return;
      }
      const item = s.item;
      /* new track -> resolve the SA station (once per track id) */
      if (item.id !== stationTrackId) resolveStationFor(item);
      title.textContent = item.name || '—';
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      artist.textContent = (item.artists || []).map(a => a.name).join(', ') || '—';
      artist.dataset.real = artist.textContent;
      artist.classList.remove('sasp-status');
      const imgs = item.album && item.album.images;
      const renderTrackId = item.id;
      setArt(imgs && imgs.length ? (imgs[1] || imgs[0]).url : '', renderTrackId);
      toggle.innerHTML = s.is_playing ? SVG.pause : SVG.play;
      shuffleBtn.classList.toggle('on', !!s.shuffle_state);
      repeatBtn.classList.toggle('on', !!s.repeat_state && s.repeat_state !== 'off');
      repeatBtn.dataset.mode = s.repeat_state || 'off';
      q('.sasp-duration').textContent = fmt(item.duration_ms);
      if (s.device && s.device.name) title.title = 'On ' + s.device.name;
      renderLyrics(s);
      startTick();
    }

    /* Lyrics stage: owned by the shared kinetic karaoke engine
       (lyrics.js, LRCLIB). Visually suppressed in SA dashboard by
       CSS; the engine itself is untouched. */
    function renderLyrics(s) {
      const box = q('.sasp-lyrics');
      if (lyricsRenderer && s && s.item) {
        try {
          if (window.WSLyrics) WSLyrics.destroy(box);
          box.innerHTML = '';
          const node = lyricsRenderer(s.item);
          if (node) { box.appendChild(node); box.classList.add('has-lyrics'); }
          else box.classList.remove('has-lyrics');
        } catch (e) { box.classList.remove('has-lyrics'); }
        return;
      }
      if (window.WSLyrics) WSLyrics.render(box, core, s && s.item, 'san-andreas');
    }

    /* ---------- album art crossfade (generation-safe) ---------- */
    function setArt(url, trackId) {
      if (!trackId) {
        artGen++;
        artTrackId = null;
        currentArtUrl = '';
        const a = q('.sasp-art.a'), b = q('.sasp-art.b');
        a.classList.remove('on'); b.classList.remove('on');
        a.onload = null; b.onload = null;
        a.removeAttribute('src'); b.removeAttribute('src');
        return;
      }
      if (url === currentArtUrl && trackId === artTrackId) return;
      artGen++;
      const myGen = artGen;
      artTrackId = trackId;
      currentArtUrl = url;
      const a = q('.sasp-art.a'), b = q('.sasp-art.b');
      a.onload = null; b.onload = null;
      const show = a.classList.contains('on') ? b : a;
      const hide = show === a ? b : a;
      if (!url) {
        a.classList.remove('on'); b.classList.remove('on');
        a.removeAttribute('src'); b.removeAttribute('src');
        return;
      }
      show.onload = () => {
        if (trackId !== artTrackId || url !== currentArtUrl || myGen !== artGen) return;
        show.classList.add('on');
        hide.classList.remove('on');
      };
      show.setAttribute('src', url);
    }

    /* ---------- progress (local interpolation; core polls the API) ---------- */
    function updateProgress(pos, dur) {
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
      q('.sasp-bar-fill').style.width = pct + '%';
      q('.sasp-bar-knob').style.left = pct + '%';
      q('.sasp-elapsed').textContent = fmt(pos);
      q('.sasp-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
    }
    function tick() {
      const s = core.getState();
      if (s && s.item) updateProgress(core.getPosition(), s.item.duration_ms);
    }
    function startTick() {
      if (tickTimer) return;
      tick();
      tickTimer = setInterval(tick, 500);
    }
    function stopTick() {
      if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    }

    /* ---------- wiring ---------- */
    function wire() {
      q('.sasp-connect-btn').addEventListener('click', () => core.connect());

      q('.sasp-controls').addEventListener('click', e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        const run = {
          prev: () => core.previous(),
          next: () => core.next(),
          toggle: () => {
            const s = core.getState();
            return (s && s.is_playing) ? core.pause() : core.play();
          },
          shuffle: () => {
            const s = core.getState();
            return core.setShuffle(!(s && s.shuffle_state)).catch(() => status('Shuffle failed'));
          },
          repeat: () => {
            const cur = btn.dataset.mode || 'off';
            const nxt = cur === 'off' ? 'context' : cur === 'context' ? 'track' : 'off';
            btn.dataset.mode = nxt;
            btn.classList.toggle('on', nxt !== 'off');
            return core.setRepeat(nxt).catch(() => status('Repeat failed'));
          },
        }[act];
        if (run) run().catch(err => {
          if (err && err.status === 404) status('No active Spotify device — press play in Spotify');
          else status('Spotify hiccup — try again');
        });
      });

      // Seek: click or drag on the progress bar.
      const bar = q('.sasp-bar');
      let seeking = false, seekFrac = 0;
      const fracFromEvent = e => {
        const r = bar.getBoundingClientRect();
        return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      };
      bar.addEventListener('pointerdown', e => {
        seeking = true;
        bar.setPointerCapture(e.pointerId);
        seekFrac = fracFromEvent(e);
        const s = core.getState();
        if (s && s.item) updateProgress(seekFrac * s.item.duration_ms, s.item.duration_ms);
      });
      bar.addEventListener('pointermove', e => {
        if (!seeking) return;
        seekFrac = fracFromEvent(e);
        const s = core.getState();
        if (s && s.item) updateProgress(seekFrac * s.item.duration_ms, s.item.duration_ms);
      });
      bar.addEventListener('pointerup', () => {
        if (!seeking) return;
        seeking = false;
        const s = core.getState();
        if (s && s.item) core.seek(seekFrac * s.item.duration_ms).catch(() => status('Seek failed'));
      });
      bar.addEventListener('keydown', e => {
        const s = core.getState();
        if (!s || !s.item) return;
        const step = 5000;
        if (e.key === 'ArrowRight') { core.seek(core.getPosition() + step).catch(() => {}); e.preventDefault(); }
        if (e.key === 'ArrowLeft') { core.seek(core.getPosition() - step).catch(() => {}); e.preventDefault(); }
      });

      offs.push(core.on('state', render));
      offs.push(core.on('auth', ok => { render(); if (ok) core.startPolling(); }));
      offs.push(core.on('error', err => {
        if (err && err.where === 'control' && err.status === 404) {
          status('No active Spotify device — press play in Spotify');
        }
      }));
    }

    /* ---------- public ---------- */
    function mount(stageEl, spotifyCore) {
      core = spotifyCore;
      stageEl.appendChild(build());
      wire();
      render();
      if (core.isConnected()) core.startPolling();
      return {
        setLyricsRenderer(fn) { lyricsRenderer = fn; renderLyrics(core.getState()); },
        clearLyrics() { lyricsRenderer = null; renderLyrics(core.getState()); },
      };
    }

    function unmount() {
      offs.forEach(off => { try { off(); } catch (e) {} });
      offs = [];
      stopTick();
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      stationTrackId = null;
      core.stopPolling();
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    return { mount, unmount };
  }

  window.SpotifySkins.register('san-andreas', createSkin());
})();
