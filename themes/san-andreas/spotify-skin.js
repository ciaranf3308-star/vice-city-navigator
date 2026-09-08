/* ============================================================
   WayStation — San Andreas Spotify skin (dashboard mode only),
   HARD VISUAL RESET pass 5.

   HERO7 (2026-09-08): the outer skin is the user's hero art sliced
   straight out of it (themes/san-andreas/dashboard/radio-hero7-r2.png,
   701x544, true alpha). Framed unit with baked San Andreas crown
   logo, two dark panels, drawn Spotify logo / progress / transport,
   lowrider at the base — right side, overlapping the dash bars.
   Live HTML sits over the art: album art in the left panel,
   title/artist + lyrics in the right panel, live progress over the
   drawn bar, live transport over the drawn prev/play/next icons.

   LYRICS: owned by the shared kinetic karaoke engine (lyrics.js,
     LRCLIB provider) mounted into [data-lyrics-stage] via
     window.WSLyrics.render(). skin.setLyricsRenderer(fn) /
     skin.clearLyrics() remain as an override hook. Never invent
     lyric text, never scrape, never fake FFT from Spotify audio
     (the Web API exposes none).
   ============================================================ */
'use strict';

(function () {
  const BEZEL = 'themes/san-andreas/dashboard/radio-hero7-r2.png';

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
      root = el('div', 'sasp');
      root.innerHTML =
        '<img class="sasp-bezel" src="' + BEZEL + '" alt="" aria-hidden="true">' +
        '<div class="sasp-main">' +
          '<div class="sasp-artwrap">' +
            '<div class="sasp-art-idle">' + SVG.note + '</div>' +
            '<img class="sasp-art a" alt="">' +
            '<img class="sasp-art b" alt="">' +
          '</div>' +
          '<div class="sasp-side">' +
            '<div class="sasp-track">' +
              '<div class="sasp-title">Radio Los Santos</div>' +
              '<div class="sasp-artist">Connect Spotify to play</div>' +
            '</div>' +
            '<div class="sasp-lyrics" data-lyrics-stage="1"></div>' +
          '</div>' +
          '<div class="sasp-progress">' +
            '<div class="sasp-bar" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100">' +
              '<div class="sasp-bar-fill"></div>' +
              '<div class="sasp-bar-knob"></div>' +
            '</div>' +
            '<div class="sasp-times"><span class="sasp-elapsed">0:00</span><span class="sasp-duration">0:00</span></div>' +
          '</div>' +
          '<div class="sasp-controls">' +
            '<button class="sasp-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
            '<button class="sasp-tbtn big" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
            '<button class="sasp-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="sasp-idle">' +
          '<div class="sasp-idle-kicker">Radio Los Santos</div>' +
          '<button class="sasp-connect-btn" type="button">Connect Spotify</button>' +
          '<p class="sasp-idle-hint">Music plays on your phone or car.<br>WayStation controls it.</p>' +
        '</div>';
      return root;
    }

    const q = sel => root.querySelector(sel);

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
      idle.hidden = connected;
      root.classList.toggle('is-idle', !connected);
      const title = q('.sasp-title'), artist = q('.sasp-artist');
      const toggle = q('.sasp-tbtn[data-act="toggle"]');
      if (!connected) {
        // Disconnected state stays inside the one widget: themed idle
        // text on the console, connect CTA in the stage.
        stopTick();
        title.textContent = 'Radio Los Santos';
        artist.textContent = 'Connect Spotify to play';
        artist.classList.remove('sasp-status');
        setArt('');
        renderLyrics(null);
        return;
      }
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Press play in Spotify';
        setArt('');
        toggle.innerHTML = SVG.play;
        q('.sasp-duration').textContent = '0:00';
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
      artist.classList.remove('sasp-status');
      const imgs = item.album && item.album.images;
      setArt(imgs && imgs.length ? (imgs[1] || imgs[0]).url : '');
      toggle.innerHTML = s.is_playing ? SVG.pause : SVG.play;
      q('.sasp-duration').textContent = fmt(item.duration_ms);
      if (s.device && s.device.name) title.title = 'On ' + s.device.name;
      renderLyrics(s);
      startTick();
    }

    /* Lyrics stage: owned by the shared kinetic karaoke engine
       (lyrics.js, LRCLIB). A custom lyricsRenderer set via the mount
       api still overrides the engine. Never fake words. */
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

    /* ---------- album art crossfade ---------- */
    function setArt(url) {
      if (url === currentArtUrl) return;
      currentArtUrl = url;
      const a = q('.sasp-art.a'), b = q('.sasp-art.b');
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
      core.stopPolling();
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    return { mount, unmount };
  }

  window.SpotifySkins.register('san-andreas', createSkin());
})();
