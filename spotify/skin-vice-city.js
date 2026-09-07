/* ============================================================
   WayStation — Vice City Spotify skin.
   ------------------------------------------------------------
   Synthwave artwork shell (assets/spotify/
   vice_city_synthwave_music_widget.png, 1448x1086) recomposed
   for a 2:3 portrait automotive pane WITHOUT stretching:

   - .vcsp-bg: full art, background-size:cover anchored left-top.
     Pane stage keeps aspect 2/3, so cover scale is always
     H/1086 and the art's left column (logo, pink album frame,
     dark lower region, neon edges) stays put.
   - Album <img> sits exactly in the art's pink frame
     (measured: art x115-564 / y375-746 -> 15.9%/34.5%/62%/34.2%).
   - Track / progress / transport live in the art's dark region.
   - Stage: a peek strip (live mini visualizer) expands to a
     full-pane stage whose background is a crop of the art's
     right-side sunset panel, with a transparent DOM layer for
     future lyrics / karaoke / visualizer modes.

   Lyrics: container + setLyricsRenderer()/clearLyrics() hooks
   exist, but no lyrics are invented or scraped — Spotify's
   public API is not a lyrics source. Without a provider the
   stage shows a now-playing ambient treatment.
   ============================================================ */
'use strict';

(function () {
  const ART = 'assets/spotify/vice_city_synthwave_music_widget.png';

  const SVG = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
    expand: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg>',
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
    let tickTimer = null, rafId = null;
    let currentArtUrl = '';
    let expanded = false;
    let statusTimer = null;
    let lyricsRenderer = null;
    let vizCanvases = [];

    /* ---------- dom ---------- */
    function build() {
      root = el('div', 'vcsp');
      root.innerHTML =
        '<div class="vcsp-stage">' +
          '<div class="vcsp-bg"></div>' +

          '<div class="vcsp-connect" hidden>' +
            '<div class="vcsp-connect-inner">' +
              '<div class="vcsp-connect-note">' + SVG.note + '</div>' +
              '<button class="vcsp-connect-btn" type="button">Connect Spotify</button>' +
              '<p class="vcsp-connect-hint">Plays through the Spotify<br>already open on your phone.</p>' +
            '</div>' +
          '</div>' +

          '<div class="vcsp-main" hidden>' +
            '<div class="vcsp-album">' +
              '<img class="vcsp-artimg a" alt="">' +
              '<img class="vcsp-artimg b" alt="">' +
            '</div>' +
            '<div class="vcsp-track">' +
              '<div class="vcsp-title">—</div>' +
              '<div class="vcsp-artist">—</div>' +
            '</div>' +
            '<div class="vcsp-progress">' +
              '<div class="vcsp-bar" role="slider" aria-label="Seek" tabindex="0">' +
                '<div class="vcsp-bar-fill"></div>' +
                '<div class="vcsp-bar-knob"></div>' +
              '</div>' +
              '<div class="vcsp-times"><span class="vcsp-elapsed">0:00</span><span class="vcsp-duration">0:00</span></div>' +
            '</div>' +
            '<div class="vcsp-transport">' +
              '<button class="vcsp-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
              '<button class="vcsp-tbtn big" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
              '<button class="vcsp-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
            '</div>' +
            '<button class="vcsp-stagepeek" type="button" aria-label="Open stage">' +
              '<canvas class="vcsp-miniviz"></canvas>' +
              '<span class="vcsp-peek-label">Stage ' + SVG.expand + '</span>' +
            '</button>' +
          '</div>' +

          '<div class="vcsp-fullstage" hidden>' +
            '<div class="vcsp-fs-bg"></div>' +
            '<div class="vcsp-fs-top">' +
              '<div class="vcsp-fs-track"><div class="vcsp-fs-title">—</div><div class="vcsp-fs-artist">—</div></div>' +
              '<button class="vcsp-fs-close" aria-label="Close stage">' + SVG.close + '</button>' +
            '</div>' +
            '<div class="vcsp-lyrics"></div>' +
            '<div class="vcsp-fs-now" hidden>' +
              '<img class="vcsp-fs-art" alt="">' +
              '<div class="vcsp-fs-nt">—</div>' +
              '<div class="vcsp-fs-na">—</div>' +
            '</div>' +
            '<canvas class="vcsp-viz"></canvas>' +
          '</div>' +
        '</div>';
      return root;
    }

    const q = sel => root.querySelector(sel);

    /* ---------- status line ---------- */
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
      const main = q('.vcsp-main'), conn = q('.vcsp-connect');
      const connected = core.isConnected();
      conn.hidden = connected;
      main.hidden = !connected;
      if (!connected) { stopTick(); return; }

      const title = q('.vcsp-title'), artist = q('.vcsp-artist');
      const toggle = q('.vcsp-tbtn[data-act="toggle"]');
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Open Spotify on a device and press play';
        setArt('');
        toggle.innerHTML = SVG.play;
        q('.vcsp-duration').textContent = '0:00';
        updateProgress(0, 0);
        renderFullstage(null);
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
      if (s.device && s.device.name) {
        title.title = 'On ' + s.device.name;
      }
      renderFullstage(s);
      startTick();
    }

    function renderFullstage(s) {
      const fs = q('.vcsp-fullstage');
      if (fs.hidden) return;
      q('.vcsp-fs-title').textContent = (s && s.item && s.item.name) || 'Nothing playing';
      q('.vcsp-fs-artist').textContent =
        (s && s.item && (s.item.artists || []).map(a => a.name).join(', ')) || '';
      const box = q('.vcsp-lyrics');
      box.innerHTML = '';
      const now = q('.vcsp-fs-now');
      let node = null;
      if (lyricsRenderer && s && s.item) {
        try { node = lyricsRenderer(s.item); } catch (e) { node = null; }
      }
      if (node) {
        box.appendChild(node);
        now.hidden = true;
      } else {
        // No lyrics provider — ambient now-playing treatment, never fake lyrics.
        now.hidden = false;
        const imgs = s && s.item && s.item.album && s.item.album.images;
        const url = imgs && imgs.length ? (imgs[1] || imgs[0]).url : '';
        const art = q('.vcsp-fs-art');
        if (art.getAttribute('src') !== url) art.setAttribute('src', url || '');
        art.style.visibility = url ? 'visible' : 'hidden';
        q('.vcsp-fs-nt').textContent = (s && s.item && s.item.name) || '—';
        q('.vcsp-fs-na').textContent =
          (s && s.item && (s.item.artists || []).map(a => a.name).join(', ')) || '';
      }
    }

    /* ---------- album art crossfade ---------- */
    function setArt(url) {
      if (url === currentArtUrl) return;
      currentArtUrl = url;
      const a = q('.vcsp-artimg.a'), b = q('.vcsp-artimg.b');
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

    /* ---------- progress ---------- */
    function updateProgress(pos, dur) {
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
      q('.vcsp-bar-fill').style.width = pct + '%';
      q('.vcsp-bar-knob').style.left = pct + '%';
      q('.vcsp-elapsed').textContent = fmt(pos);
      q('.vcsp-bar').setAttribute('aria-valuenow', String(Math.round(pos)));
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

    /* ---------- visualizer (decorative, progress-reactive) ---------- */
    function drawViz(canvas, t, amp) {
      const ctx = canvas.getContext('2d');
      const w = canvas.width, h = canvas.height;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      const n = Math.max(24, Math.floor(w / 9));
      const bw = w / n;
      for (let i = 0; i < n; i++) {
        const ph = i * 0.9;
        // Layered sines = fake groove. Reactive to playback progress
        // (amp eases with elapsed time), never real audio analysis.
        const v = 0.32 +
          0.28 * Math.sin(t * 2.1 + ph) *
          Math.sin(t * 0.63 + ph * 1.7) +
          0.22 * amp * Math.sin(t * 4.7 + ph * 2.3);
        const bh = Math.max(2, Math.min(1, v) * h);
        const x = i * bw + bw * 0.22;
        const g = ctx.createLinearGradient(0, h - bh, 0, h);
        if (i % 3 === 0) { g.addColorStop(0, '#35e0ff'); g.addColorStop(1, '#0a5f7a'); }
        else { g.addColorStop(0, '#ff5fd2'); g.addColorStop(1, '#7a0a4e'); }
        ctx.fillStyle = g;
        const rw = bw * 0.56, rh = Math.max(2, bh);
        const r = Math.min(rw / 2, 3);
        ctx.beginPath();
        ctx.roundRect(x, h - rh, rw, rh, [r, r, 0, 0]);
        ctx.fill();
      }
    }
    function sizeCanvas(c) {
      const r = c.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
    function vizLoop(t) {
      rafId = requestAnimationFrame(vizLoop);
      if (document.hidden) return;
      const s = core.getState();
      const playing = !!(s && s.is_playing && s.item);
      const pos = core.getPosition();
      const amp = playing ? (0.35 + 0.65 * Math.abs(Math.sin(pos / 9000))) : 0.08;
      const tt = t / 1000;
      vizCanvases.forEach(c => {
        if (!c.isConnected || c.offsetParent === null) return;
        sizeCanvas(c);
        drawViz(c, tt, amp);
      });
    }

    /* ---------- wiring ---------- */
    function wire() {
      q('.vcsp-connect-btn').addEventListener('click', () => core.connect());

      q('.vcsp-transport').addEventListener('click', e => {
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
      bar.addEventListener('pointerup', e => {
        if (!seeking) return;
        seeking = false;
        const s = core.getState();
        if (s && s.item) {
          core.seek(seekFrac * s.item.duration_ms).catch(() => status('Seek failed'));
        }
      });
      bar.addEventListener('keydown', e => {
        const s = core.getState();
        if (!s || !s.item) return;
        const step = 5000;
        if (e.key === 'ArrowRight') { core.seek(core.getPosition() + step).catch(() => {}); e.preventDefault(); }
        if (e.key === 'ArrowLeft') { core.seek(core.getPosition() - step).catch(() => {}); e.preventDefault(); }
      });

      q('.vcsp-stagepeek').addEventListener('click', () => setExpanded(true));
      q('.vcsp-fs-close').addEventListener('click', () => setExpanded(false));

      offs.push(core.on('state', render));
      offs.push(core.on('auth', ok => { render(); if (ok) core.startPolling(); }));
      offs.push(core.on('error', err => {
        if (err && err.where === 'control' && err.status === 404) {
          status('No active Spotify device — press play in Spotify');
        }
      }));
    }

    function setExpanded(v) {
      expanded = v;
      const fs = q('.vcsp-fullstage');
      fs.hidden = !v;
      if (v) { renderFullstage(core.getState()); }
    }

    /* ---------- public ---------- */
    function mount(stageEl, spotifyCore) {
      core = spotifyCore;
      stageEl.appendChild(build());
      vizCanvases = [q('.vcsp-viz'), q('.vcsp-miniviz')];
      wire();
      render();
      if (core.isConnected()) core.startPolling();
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(vizLoop);
      return {
        setLyricsRenderer(fn) { lyricsRenderer = fn; renderFullstage(core.getState()); },
        clearLyrics() { lyricsRenderer = null; renderFullstage(core.getState()); },
        setExpanded,
        isExpanded: () => expanded,
      };
    }

    function unmount() {
      offs.forEach(off => off());
      offs = [];
      stopTick();
      cancelAnimationFrame(rafId);
      core.stopPolling();
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    return { mount, unmount };
  }

  window.SpotifySkins.register('vice-city', createSkin());
})();
