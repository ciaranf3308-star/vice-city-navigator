/* ============================================================
   WayStation — GTA V Spotify skin (dashboard mode only).
   ------------------------------------------------------------
   Art: themes/gta-v/spotify/*.png (generated from the Los Santos
   concept — downtown skyline + freeway sign header band, dark
   neon-green-framed album panel, palm-sunset stage). Portrait
   composition (~2:3 automotive pane):

     header    — skyline + "Los Santos" freeway-sign band
     album     — square live album art OVER the frame's black
                 opening, sized to the measured interior
                 (x0=0.1125 y0=0.1125 x1=0.8875 y1=0.8875).
                 The frame interior is opaque black (not a
                 transparent cutout), so the art layers above the
                 frame and the neon-green double border stays visible
                 around it. Two stacked <img> crossfade on track
                 change, same as the VC skin.
     track     — title / artist / progress on the pane's dark panel
     stage     — the palm-sunset street scene. Transparent DOM
                 layer (.gvsp-lyrics) hosts live lyrics later;
                 ambient glow until then.
     controls  — prev / play-pause / next as dark chips with
                 neon-green icons, large touch areas

   LYRICS (future pass):
     The stage exposes [data-lyrics-stage] plus
     skin.setLyricsRenderer(fn) / skin.clearLyrics().
     The proven provider is LRCLIB:
       GET https://lrclib.net/api/get?artist=<a>&track=<t>
     A renderer receives the Spotify item and returns a DOM node
     using .gv-lyric-line > .active (karaoke) / .ghost (previous)
     / .next (upcoming). Never invent lyric text, never scrape,
     never fake FFT from Spotify audio (the Web API exposes none).
   ============================================================ */
'use strict';

(function () {
  const ART = 'themes/gta-v/spotify/';
  const CSS_HREF = 'themes/gta-v/spotify-skin.css';

  /* Album-art placement: square, centered in the frame's measured
     interior opening, as fractions of album.png. */
  const FRAME = { x0: 0.12, y0: 0.12, x1: 0.88, y1: 0.88 };

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
  /* The skin JS/CSS are statically linked in index.html; this is a
     safety net for any host that mounts the skin without them. */
  function ensureCss() {
    const links = document.querySelectorAll
      ? Array.from(document.querySelectorAll('link[rel="stylesheet"]'))
      : [];
    if (links.some(l => (l.getAttribute('href') || '').indexOf('gta-v/spotify-skin.css') >= 0)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = CSS_HREF;
    document.head.appendChild(l);
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
      root = el('div', 'gvsp');
      const artStyle =
        'left:' + (FRAME.x0 * 100).toFixed(2) + '%;' +
        'top:' + (FRAME.y0 * 100).toFixed(2) + '%;' +
        'width:' + ((FRAME.x1 - FRAME.x0) * 100).toFixed(2) + '%;' +
        'height:' + ((FRAME.y1 - FRAME.y0) * 100).toFixed(2) + '%;';
      root.innerHTML =
        '<img class="gvsp-header" src="' + ART + 'header.png" alt="" aria-hidden="true">' +

        '<div class="gvsp-albumzone">' +
          '<div class="gvsp-framesq">' +
            '<img class="gvsp-art a" style="' + artStyle + '" alt="">' +
            '<img class="gvsp-art b" style="' + artStyle + '" alt="">' +
            '<img class="gvsp-albumframe" src="' + ART + 'album.png" alt="" aria-hidden="true">' +
          '</div>' +
          '<div class="gvsp-track">' +
            '<div class="gvsp-title">—</div>' +
            '<div class="gvsp-artist">—</div>' +
            '<div class="gvsp-progress">' +
              '<div class="gvsp-bar" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100">' +
                '<div class="gvsp-bar-fill"></div>' +
                '<div class="gvsp-bar-knob"></div>' +
              '</div>' +
              '<div class="gvsp-times"><span class="gvsp-elapsed">0:00</span><span class="gvsp-duration">0:00</span></div>' +
            '</div>' +
          '</div>' +
        '</div>' +

        '<div class="gvsp-stagewrap">' +
          '<img class="gvsp-stagebg" src="' + ART + 'stage.png" alt="" aria-hidden="true">' +
          '<div class="gvsp-ambient" aria-hidden="true"></div>' +
          '<div class="gvsp-lyrics" data-lyrics-stage="1"></div>' +
          '<div class="gvsp-controls">' +
            '<button class="gvsp-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
            '<button class="gvsp-tbtn big" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
            '<button class="gvsp-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
          '</div>' +
        '</div>' +

        '<div class="gvsp-connect" hidden>' +
          '<div class="gvsp-connect-pill">' +
            '<div class="gvsp-connect-note">' + SVG.note + '</div>' +
            '<button class="gvsp-connect-btn" type="button">Connect Spotify</button>' +
            '<p class="gvsp-connect-hint">Music plays on your phone or car.<br>WayStation just drives it.</p>' +
          '</div>' +
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
      const conn = q('.gvsp-connect');
      const connected = core.isConnected();
      conn.hidden = connected;
      if (!connected) { stopTick(); return; }

      const title = q('.gvsp-title'), artist = q('.gvsp-artist');
      const toggle = q('.gvsp-tbtn[data-act="toggle"]');
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Press play in Spotify';
        setArt('');
        toggle.innerHTML = SVG.play;
        q('.gvsp-duration').textContent = '0:00';
        updateProgress(0, 0);
        renderLyrics(null);
        return;
      }
      const item = s.item;
      title.textContent = item.name || '—';
      artist.textContent = (item.artists || []).map(a => a.name).join(', ') || '—';
      artist.classList.remove('gvsp-status');
      const imgs = item.album && item.album.images;
      setArt(imgs && imgs.length ? (imgs[1] || imgs[0]).url : '');
      toggle.innerHTML = s.is_playing ? SVG.pause : SVG.play;
      q('.gvsp-duration').textContent = fmt(item.duration_ms);
      if (s.device && s.device.name) title.title = 'On ' + s.device.name;
      renderLyrics(s);
      startTick();
    }

    /* Lyrics stage: a renderer (future LRCLIB pass) owns this DOM.
       With no provider, the stage stays ambient — never fake words. */
    function renderLyrics(s) {
      const box = q('.gvsp-lyrics');
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

    /* ---------- album art crossfade (art fills the frame's black
       opening; the interior is opaque, so the art layers ABOVE
       the frame and the neon border stays visible around it) ---------- */
    function setArt(url) {
      if (url === currentArtUrl) return;
      currentArtUrl = url;
      const a = q('.gvsp-art.a'), b = q('.gvsp-art.b');
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
      ensureCss();
      core = spotifyCore;
      stageEl.appendChild(build());
      wire();
      render();
      if (core.isConnected()) core.startPolling();
      return {
        /* Future lyrics pass: fn(item) -> DOM node built from LRCLIB
           (https://lrclib.net/api/get?artist=&track=). Use
           .gv-lyric-line with .active (karaoke), .ghost (previous),
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

  window.SpotifySkins.register('gta-v', createSkin());
})();
