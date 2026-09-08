/* ============================================================
   WayStation — GTA V Spotify skin (dashboard mode only).
   ------------------------------------------------------------
   Radio console rebuild: a charcoal/black glass console, not
   an image overlay. Structure:
   - header: WAYSTATION RADIO + status
   - main: album art (148px) + track title/artist/device
   - progress: thin bar with times
   - controls: shuffle, prev, play, next, repeat
   - lyrics stage OR ambient skyline

   LYRICS: owned by the shared kinetic karaoke engine (lyrics.js,
     LRCLIB provider) mounted into [data-lyrics-stage] via
     window.WSLyrics.render(). skin.setLyricsRenderer(fn) /
     skin.clearLyrics() remain as an override hook. Never invent
     lyric text, never scrape, never fake FFT from Spotify audio
     (the Web API exposes none).
   ============================================================ */
'use strict';

(function () {
  const ART = 'themes/gta-v/spotify/';

  const SVG = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    shuffle: '<svg viewBox="0 0 24 24"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
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

  function createSkin() {
    let root = null, core = null;
    let offs = [];
    let tickTimer = null;
    let currentArtUrl = '';
    let artGen = 0;          // bumped on every track change
    let artTrackId = null;   // Spotify item.id the art belongs to
    let statusTimer = null;
    let lyricsRenderer = null;

    /* ---------- dom ---------- */
    function build() {
      root = el('div', 'gvsp');
      root.innerHTML =
        '<div class="gvsp-header">' +
          '<span class="gvsp-header-title">Waystation Radio</span>' +
          '<span class="gvsp-header-status" data-header-status>Los Santos</span>' +
        '</div>' +
        '<div class="gvsp-main">' +
          '<div class="gvsp-artwrap">' +
            '<div class="gvsp-art-idle">' + SVG.note + '</div>' +
            '<img class="gvsp-art a" alt="">' +
            '<img class="gvsp-art b" alt="">' +
          '</div>' +
          '<div class="gvsp-track">' +
            '<div class="gvsp-title">Los Santos Radio</div>' +
            '<div class="gvsp-artist">Connect Spotify to play</div>' +
            '<div class="gvsp-device" data-device></div>' +
          '</div>' +
        '</div>' +
        '<div class="gvsp-progress">' +
          '<div class="gvsp-bar" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100">' +
            '<div class="gvsp-bar-fill"></div>' +
            '<div class="gvsp-bar-knob"></div>' +
          '</div>' +
          '<div class="gvsp-times"><span class="gvsp-elapsed">0:00</span><span class="gvsp-duration">0:00</span></div>' +
        '</div>' +
        '<div class="gvsp-controls">' +
          '<button class="gvsp-tbtn" data-act="shuffle" aria-label="Shuffle">' + SVG.shuffle + '</button>' +
          '<button class="gvsp-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
          '<button class="gvsp-tbtn big" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
          '<button class="gvsp-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
          '<button class="gvsp-tbtn" data-act="repeat" aria-label="Repeat">' + SVG.repeat + '</button>' +
        '</div>' +
        '<div class="gvsp-lyrics" data-lyrics-stage="1"></div>' +
        '<div class="gvsp-ambient">' +
          '<div class="gvsp-ambient-skyline"></div>' +
          '<div class="gvsp-ambient-label">Waystation Radio &mdash; Los Santos</div>' +
        '</div>' +
        '<div class="gvsp-idle">' +
          '<div class="gvsp-idle-kicker">Los Santos Radio</div>' +
          '<button class="gvsp-connect-btn" type="button">Connect Spotify</button>' +
          '<p class="gvsp-idle-hint">Music plays on your phone or car.<br>WayStation controls it.</p>' +
        '</div>';
      return root;
    }

    const q = sel => root.querySelector(sel);

    /* ---------- transient status line (reuses the artist slot) ---------- */
    function status(msg, sticky) {
      const a = q('.gvsp-artist');
      if (!a) return;
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      if (msg) {
        a.dataset.real = a.textContent;
        a.textContent = msg;
        a.classList.add('gvsp-status');
        if (!sticky) statusTimer = setTimeout(() => {
          a.textContent = a.dataset.real || '';
          a.classList.remove('gvsp-status');
        }, 4000);
      }
    }

    /* ---------- render ---------- */
    function render() {
      const s = core.getState();
      const idle = q('.gvsp-idle');
      const connected = core.isConnected();
      /* State bug fix: idle and playback UI are mutually exclusive.
         When connected, idle is hidden and playback UI shows.
         When disconnected, playback UI is hidden and idle shows. */
      idle.hidden = connected;
      root.classList.toggle('is-idle', !connected);
      root.classList.toggle('is-connected', connected);
      const title = q('.gvsp-title'), artist = q('.gvsp-artist');
      const deviceEl = q('[data-device]');
      const headerStatus = q('[data-header-status]');
      const toggle = q('.gvsp-tbtn[data-act="toggle"]');
      const shuffleBtn = q('.gvsp-tbtn[data-act="shuffle"]');
      const repeatBtn = q('.gvsp-tbtn[data-act="repeat"]');
      if (!connected) {
        // Disconnected: show idle, hide all playback UI
        stopTick();
        title.textContent = 'Los Santos Radio';
        artist.textContent = 'Connect Spotify to play';
        artist.classList.remove('gvsp-status');
        if (deviceEl) deviceEl.textContent = '';
        if (headerStatus) headerStatus.textContent = 'Offline';
        if (shuffleBtn) shuffleBtn.classList.remove('active');
        if (repeatBtn) { repeatBtn.classList.remove('active'); repeatBtn.dataset.mode = 'off'; }
        setArt('', null);
        renderLyrics(null);
        updateProgress(0, 0);
        return;
      }
      if (headerStatus) headerStatus.textContent = 'Los Santos';
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Press play in Spotify';
        if (deviceEl) deviceEl.textContent = '';
        setArt('', null);
        toggle.innerHTML = SVG.play;
        q('.gvsp-duration').textContent = '0:00';
        updateProgress(0, 0);
        renderLyrics(null);
        return;
      }
      const item = s.item;
      title.textContent = item.name || '—';
      /* Clear any pending status timer and sync dataset.real so a stale
         timer can't restore the previous track's artist. */
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      artist.textContent = (item.artists || []).map(a => a.name).join(', ') || '—';
      artist.dataset.real = artist.textContent;
      artist.classList.remove('gvsp-status');
      if (deviceEl) {
        deviceEl.textContent = s.device && s.device.name ? 'On ' + s.device.name : '';
      }
      const imgs = item.album && item.album.images;
      /* Atomic per track: capture item.id — title, artist, art, duration
         and lyric request all belong to this ID. */
      const renderTrackId = item.id;
      if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] render', {
        trackId: renderTrackId, title: item.name,
        artist: (item.artists || []).map(a => a.name).join(', '),
        art: imgs && imgs.length ? (imgs[1] || imgs[0]).url : '' });
      setArt(imgs && imgs.length ? (imgs[1] || imgs[0]).url : '', renderTrackId);
      toggle.innerHTML = s.is_playing ? SVG.pause : SVG.play;
      if (shuffleBtn) shuffleBtn.classList.toggle('active', !!s.shuffle_state);
      if (repeatBtn) {
        const rs = s.repeat_state || 'off';
        repeatBtn.classList.toggle('active', rs !== 'off');
        repeatBtn.dataset.mode = rs;
      }
      q('.gvsp-duration').textContent = fmt(item.duration_ms);
      if (s.device && s.device.name) title.title = 'On ' + s.device.name;
      renderLyrics(s);
      startTick();
    }

    /* Lyrics stage: owned by the shared kinetic karaoke engine
       (lyrics.js, LRCLIB). A custom lyricsRenderer set via the mount
       api still overrides the engine. Never fake words.
       The ambient skyline shows when WSLyrics has no lyrics
       (no 'has-lyrics' class) — watched via MutationObserver
       since the lyric fetch is async. */
    let lyricsObserver = null;
    function syncAmbient() {
      const box = q('.gvsp-lyrics');
      const ambient = q('.gvsp-ambient');
      if (!box || !ambient) return;
      const hasLyrics = box.classList.contains('has-lyrics');
      ambient.hidden = hasLyrics;
      box.style.display = hasLyrics ? '' : 'none';
    }
    function renderLyrics(s) {
      const box = q('.gvsp-lyrics');
      if (!box) return;
      // Watch for WSLyrics toggling has-lyrics after async fetch
      if (!lyricsObserver) {
        lyricsObserver = new MutationObserver(syncAmbient);
        lyricsObserver.observe(box, { attributes: true, attributeFilter: ['class'] });
      }
      if (lyricsRenderer && s && s.item) {
        try {
          if (window.WSLyrics) WSLyrics.destroy(box);
          box.innerHTML = '';
          const node = lyricsRenderer(s.item);
          if (node) {
            box.appendChild(node);
            box.classList.add('has-lyrics');
          } else {
            box.classList.remove('has-lyrics');
          }
        } catch (e) {
          box.classList.remove('has-lyrics');
        }
        syncAmbient();
        return;
      }
      if (window.WSLyrics) {
        WSLyrics.render(box, core, s && s.item, 'gta-v');
        // syncAmbient will fire via observer when fetch completes
        syncAmbient();
      } else {
        box.classList.remove('has-lyrics');
        syncAmbient();
      }
    }

    /* ---------- album art crossfade (art sits UNDER the frame) ---------- */
    function setArt(url, trackId) {
      /* Generation-safe: a stale onload can never reveal old artwork.
         The load only becomes visible if, at completion time, the track,
         URL and generation all still match the current render. */
      if (!trackId) {
        artGen++;
        artTrackId = null;
        currentArtUrl = '';
        const a = q('.gvsp-art.a'), b = q('.gvsp-art.b');
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
      const a = q('.gvsp-art.a'), b = q('.gvsp-art.b');
      // Cancel stale handlers so an old load can't toggle visibility.
      a.onload = null; b.onload = null;
      const show = a.classList.contains('on') ? b : a;
      const hide = show === a ? b : a;
      if (!url) {
        a.classList.remove('on'); b.classList.remove('on');
        a.removeAttribute('src'); b.removeAttribute('src');
        return;
      }
      if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] art request', { trackId, url, gen: myGen });
      show.onload = () => {
        if (trackId !== artTrackId || url !== currentArtUrl || myGen !== artGen) {
          if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] art DISCARDED (stale)', { trackId, url, gen: myGen, curTrack: artTrackId, curGen: artGen });
          return; // stale: never toggle .on
        }
        if (window.__WS_SPOTIFY_DIAG) console.log('[spotify-diag] art shown', { trackId, gen: myGen });
        show.classList.add('on');
        hide.classList.remove('on');
      };
      show.setAttribute('src', url);
    }

    /* ---------- progress (local interpolation; core polls the API) ---------- */
    function updateProgress(pos, dur) {
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
      q('.gvsp-bar-fill').style.width = pct + '%';
      q('.gvsp-bar-knob').style.left = pct + '%';
      q('.gvsp-elapsed').textContent = fmt(pos);
      q('.gvsp-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
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
      q('.gvsp-connect-btn').addEventListener('click', () => core.connect());

      q('.gvsp-controls').addEventListener('click', e => {
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
            const on = !(s && s.shuffle_state);
            return core.setShuffle(on).then(() => {
              btn.classList.toggle('active', on);
              if (s) s.shuffle_state = on;
            });
          },
          repeat: () => {
            const s = core.getState();
            const cur = s && s.repeat_state;
            const nextState = cur === 'off' ? 'context' : cur === 'context' ? 'track' : 'off';
            return core.setRepeat(nextState).then(() => {
              btn.classList.toggle('active', nextState !== 'off');
              btn.dataset.mode = nextState;
              if (s) s.repeat_state = nextState;
            });
          },
        }[act];
        if (run) run().catch(err => {
          if (err && err.status === 404) status('No active Spotify device — press play in Spotify');
          else status('Spotify hiccup — try again');
        });
      });

      // Seek: click or drag on the progress bar.
      const bar = q('.gvsp-bar');
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
        /* Override hook: fn(item) -> DOM node replaces the shared
           kinetic karaoke engine (lyrics.js) for this stage. */
        setLyricsRenderer(fn) { lyricsRenderer = fn; renderLyrics(core.getState()); },
        clearLyrics() { lyricsRenderer = null; renderLyrics(core.getState()); },
      };
    }

    function unmount() {
      offs.forEach(off => { try { off(); } catch (e) {} });
      offs = [];
      stopTick();
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      if (lyricsObserver) { lyricsObserver.disconnect(); lyricsObserver = null; }
      core.stopPolling();
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    return { mount, unmount };
  }

  window.SpotifySkins.register('gta-v', createSkin());
})();
