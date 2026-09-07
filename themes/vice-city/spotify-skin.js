/* ============================================================
   WayStation — Vice City Spotify skin (dashboard mode only).
   ------------------------------------------------------------
   Recomposed from the transparent concept art
   (themes/vice-city/spotify/*.png, cropped from the 1448x1086
   source — see tools/build_spotify_crops.py). The art is a
   TRANSPARENT UI skin, not a background: every root here is
   transparent and the map stays visible behind transparent
   pixels. There is no opaque panel, no modal, no close
   button, no spectrum strip, no generic Spotify chrome.

   Portrait composition (~2:3 automotive pane):

     header    — neon Vice City logo + skyline (may overlap edges)
     album     — square album art UNDER the art's pink neon frame
                 (z-order: art below, frame artwork over it)
     track     — title / artist / progress on the art's dark band
     stage     — the art's sunset/palms stage, 35%+ of the pane.
                 Transparent DOM layer (.vcsp-lyrics) hosts live
                 lyrics later; ambient glow until then.
     controls  — prev / play-pause / next, neon, large touch areas
     tube      — the art's neon tube along the bottom edge

   LYRICS (future pass):
     The stage exposes [data-lyrics-stage] plus
     skin.setLyricsRenderer(fn) / skin.clearLyrics().
     The proven provider is LRCLIB:
       GET https://lrclib.net/api/get?artist=<a>&track=<t>
     A renderer receives the Spotify item and returns a DOM node
     using .vc-lyric-line > .active (karaoke) / .ghost (previous)
     / .next (upcoming). Never invent lyric text, never scrape,
     never fake FFT from Spotify audio (the Web API exposes none).
   ============================================================ */
'use strict';

(function () {
  const ART = 'themes/vice-city/spotify/';

  /* Album-art placement: square, centered in the frame's measured
     interior opening, as fractions of album.png. */
  const FRAME = { x0: 0.139, y0: 0.0454, x1: 0.861, y1: 0.6521 };

  const SVG = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
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
    let statusTimer = null;
    let lyricsRenderer = null;

    /* ---------- dom ---------- */
    function build() {
      root = el('div', 'vcsp');
      const artStyle =
        'left:' + (FRAME.x0 * 100).toFixed(2) + '%;' +
        'top:' + (FRAME.y0 * 100).toFixed(2) + '%;' +
        'width:' + ((FRAME.x1 - FRAME.x0) * 100).toFixed(2) + '%;' +
        'aspect-ratio:1;';
      root.innerHTML =
        '<img class="vcsp-header" src="' + ART + 'header.png" alt="" aria-hidden="true">' +

        '<div class="vcsp-albumzone">' +
          '<img class="vcsp-art a" style="' + artStyle + '" alt="">' +
          '<img class="vcsp-art b" style="' + artStyle + '" alt="">' +
          '<img class="vcsp-albumframe" src="' + ART + 'album.png" alt="" aria-hidden="true">' +
          '<div class="vcsp-track">' +
            '<div class="vcsp-title">—</div>' +
            '<div class="vcsp-artist">—</div>' +
            '<div class="vcsp-progress">' +
              '<div class="vcsp-bar" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100">' +
                '<div class="vcsp-bar-fill"></div>' +
                '<div class="vcsp-bar-knob"></div>' +
              '</div>' +
              '<div class="vcsp-times"><span class="vcsp-elapsed">0:00</span><span class="vcsp-duration">0:00</span></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="vcsp-stagewrap">' +
          '<img class="vcsp-stagebg" src="' + ART + 'stage.png" alt="" aria-hidden="true">' +
          '<div class="vcsp-ambient" aria-hidden="true"></div>' +
          '<div class="vcsp-lyrics" data-lyrics-stage="1"></div>' +
          '<div class="vcsp-controls">' +
            '<button class="vcsp-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
            '<button class="vcsp-tbtn big" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
            '<button class="vcsp-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
          '</div>' +
          '<img class="vcsp-tube" src="' + ART + 'tube.png" alt="" aria-hidden="true">' +
        '</div>' +

        '<div class="vcsp-connect" hidden>' +
          '<div class="vcsp-connect-pill">' +
            '<div class="vcsp-connect-note">' + SVG.note + '</div>' +
            '<button class="vcsp-connect-btn" type="button">Connect Spotify</button>' +
            '<p class="vcsp-connect-hint">Music plays on your phone or car.<br>WayStation just drives it.</p>' +
          '</div>' +
        '</div>';
      return root;
    }

    const q = sel => root.querySelector(sel);

    /* ---------- transient status line (reuses the artist slot) ---------- */
    function status(msg, sticky) {
      const a = q('.vcsp-artist');
      if (!a) return;
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      if (msg) {
        a.dataset.real = a.textContent;
        a.textContent = msg;
        a.classList.add('vcsp-status');
        if (!sticky) statusTimer = setTimeout(() => {
          a.textContent = a.dataset.real || '';
          a.classList.remove('vcsp-status');
        }, 4000);
      }
    }

    /* ---------- render ---------- */
    function render() {
      const s = core.getState();
      const conn = q('.vcsp-connect');
      const connected = core.isConnected();
      conn.hidden = connected;
      if (!connected) { stopTick(); return; }

      const title = q('.vcsp-title'), artist = q('.vcsp-artist');
      const toggle = q('.vcsp-tbtn[data-act="toggle"]');
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Press play in Spotify';
        setArt('');
        toggle.innerHTML = SVG.play;
        q('.vcsp-duration').textContent = '0:00';
        updateProgress(0, 0);
        renderLyrics(null);
        return;
      }
      const item = s.item;
      title.textContent = item.name || '—';
      artist.textContent = (item.artists || []).map(a => a.name).join(', ') || '—';
      artist.classList.remove('vcsp-status');
      const imgs = item.album && item.album.images;
      setArt(imgs && imgs.length ? (imgs[1] || imgs[0]).url : '');
      toggle.innerHTML = s.is_playing ? SVG.pause : SVG.play;
      q('.vcsp-duration').textContent = fmt(item.duration_ms);
      if (s.device && s.device.name) title.title = 'On ' + s.device.name;
      renderLyrics(s);
      startTick();
    }

    /* Lyrics stage: a renderer (future LRCLIB pass) owns this DOM.
       With no provider, the stage stays ambient — never fake words. */
    function renderLyrics(s) {
      const box = q('.vcsp-lyrics');
      box.innerHTML = '';
      let node = null;
      if (lyricsRenderer && s && s.item) {
        try { node = lyricsRenderer(s.item); } catch (e) { node = null; }
      }
      if (node) {
        box.appendChild(node);
        box.classList.add('has-lyrics');
      } else {
        box.classList.remove('has-lyrics');
      }
    }

    /* ---------- album art crossfade (art sits UNDER the frame) ---------- */
    function setArt(url) {
      if (url === currentArtUrl) return;
      currentArtUrl = url;
      const a = q('.vcsp-art.a'), b = q('.vcsp-art.b');
      const show = a.classList.contains('on') ? b : a;
      const hide = show === a ? b : a;
      if (!url) {
        a.classList.remove('on'); b.classList.remove('on');
        a.removeAttribute('src'); b.removeAttribute('src');
        return;
      }
      show.onload = () => {
        show.classList.add('on');
        hide.classList.remove('on');
      };
      show.setAttribute('src', url);
    }

    /* ---------- progress (local interpolation; core polls the API) ---------- */
    function updateProgress(pos, dur) {
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
      q('.vcsp-bar-fill').style.width = pct + '%';
      q('.vcsp-bar-knob').style.left = pct + '%';
      q('.vcsp-elapsed').textContent = fmt(pos);
      q('.vcsp-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
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
      q('.vcsp-connect-btn').addEventListener('click', () => core.connect());

      q('.vcsp-controls').addEventListener('click', e => {
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
        }[act];
        if (run) run().catch(err => {
          if (err && err.status === 404) status('No active Spotify device — press play in Spotify');
          else status('Spotify hiccup — try again');
        });
      });

      // Seek: click or drag on the progress bar.
      const bar = q('.vcsp-bar');
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
        /* Future lyrics pass: fn(item) -> DOM node built from LRCLIB
           (https://lrclib.net/api/get?artist=&track=). Use
           .vc-lyric-line with .active (karaoke), .ghost (previous),
           .next (upcoming) inside the returned node. */
        setLyricsRenderer(fn) { lyricsRenderer = fn; renderLyrics(core.getState()); },
        clearLyrics() { lyricsRenderer = null; renderLyrics(core.getState()); },
      };
    }

    function unmount() {
      offs.forEach(off => { try { off(); } catch (e) {} });
      offs = [];
      stopTick();
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      core.stopPolling();
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    return { mount, unmount };
  }

  window.SpotifySkins.register('vice-city', createSkin());
})();
