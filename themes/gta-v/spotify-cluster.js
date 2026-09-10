/* ============================================================
   WayStation — GTA V Spotify skin, CLUSTER mode only.
   Registers 'gta-v-cluster' (.gvcl): the console concept's music
   card — art left, title/artist + progress + transport right,
   tagline along the bottom. Mirrors the proven .sacl wiring
   (one SpotifyCore session, seek bar, transport, connect flow).
   No lyrics here — the concept card carries none.
   ============================================================ */
'use strict';

(function () {
  const SVG = {
    play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>',
    heart: '<svg viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>',
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
    let artGen = 0;
    let artTrackId = null;
    let statusTimer = null;

    function build() {
      root = el('div', 'gvcl');
      root.innerHTML =
        '<div class="gvcl-artwrap">' +
          '<div class="gvcl-art-idle">' + SVG.note + '</div>' +
          '<img class="gvcl-art a" alt="">' +
          '<img class="gvcl-art b" alt="">' +
        '</div>' +
        '<div class="gvcl-info">' +
          '<div class="gvcl-title">Radio Los Santos</div>' +
          '<div class="gvcl-artist">Connect Spotify to play</div>' +
          '<div class="gvcl-progress">' +
            '<div class="gvcl-bar" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100">' +
              '<div class="gvcl-bar-fill"></div>' +
              '<div class="gvcl-bar-knob"></div>' +
            '</div>' +
            '<div class="gvcl-times"><span class="gvcl-elapsed">0:00</span><span class="gvcl-duration">0:00</span></div>' +
          '</div>' +
          '<div class="gvcl-controls">' +
            '<button class="gvcl-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
            '<button class="gvcl-tbtn big" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
            '<button class="gvcl-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
            '<button class="gvcl-tbtn gvcl-like" data-act="like" aria-label="Like">' + SVG.heart + '</button>' +
          '</div>' +
        '</div>' +
        '<div class="gvcl-tag">MUSIC MOVES DIFFERENT HERE</div>' +
        '<div class="gvcl-idle">' +
          '<div class="gvcl-idle-kicker">RADIO LOS SANTOS</div>' +
          '<button class="gvcl-connect-btn" type="button">Connect Spotify</button>' +
        '</div>';
      return root;
    }

    const q = sel => root.querySelector(sel);

    function status(msg, sticky) {
      const a = q('.gvcl-artist');
      if (!a) return;
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      if (msg) {
        a.dataset.real = a.textContent;
        a.textContent = msg;
        a.classList.add('gvcl-status');
        if (!sticky) statusTimer = setTimeout(() => {
          a.textContent = a.dataset.real || '';
          a.classList.remove('gvcl-status');
        }, 4000);
      }
    }

    function render() {
      const s = core.getState();
      const idle = q('.gvcl-idle');
      const connected = core.isConnected();
      const hasTrack = !!(s && s.item && s.item.id);
      idle.hidden = connected || hasTrack;
      const title = q('.gvcl-title'), artist = q('.gvcl-artist');
      const toggle = q('.gvcl-tbtn[data-act="toggle"]');
      if (!connected) {
        stopTick();
        title.textContent = 'Radio Los Santos';
        artist.textContent = 'Connect Spotify to play';
        artist.classList.remove('gvcl-status');
        setArt('', null);
        return;
      }
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Press play in Spotify';
        setArt('', null);
        toggle.innerHTML = SVG.play;
        q('.gvcl-duration').textContent = '0:00';
        updateProgress(0, 0);
        return;
      }
      const item = s.item;
      title.textContent = item.name || '—';
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      artist.textContent = (item.artists || []).map(a => a.name).join(', ') || '—';
      artist.dataset.real = artist.textContent;
      artist.classList.remove('gvcl-status');
      const imgs = item.album && item.album.images;
      setArt(imgs && imgs.length ? (imgs[1] || imgs[0]).url : '', item.id);
      toggle.innerHTML = s.is_playing ? SVG.pause : SVG.play;
      q('.gvcl-duration').textContent = fmt(item.duration_ms);
      if (s.device && s.device.name) title.title = 'On ' + s.device.name;
      startTick();
    }

    function setArt(url, trackId) {
      if (!trackId) {
        artGen++;
        artTrackId = null;
        currentArtUrl = '';
        const a = q('.gvcl-art.a'), b = q('.gvcl-art.b');
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
      const a = q('.gvcl-art.a'), b = q('.gvcl-art.b');
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

    function updateProgress(pos, dur) {
      const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
      q('.gvcl-bar-fill').style.width = pct + '%';
      q('.gvcl-bar-knob').style.left = pct + '%';
      q('.gvcl-elapsed').textContent = fmt(pos);
      q('.gvcl-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
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

    function wire() {
      q('.gvcl-connect-btn').addEventListener('click', () => core.connect());
      q('.gvcl-controls').addEventListener('click', e => {
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
          like: () => { btn.classList.toggle('liked'); return Promise.resolve(); },
        }[act];
        if (run) run().catch(err => {
          if (err && err.status === 404) status('No active Spotify device — press play in Spotify');
          else status('Spotify hiccup — try again');
        });
      });
      const bar = q('.gvcl-bar');
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

    function mount(stageEl, spotifyCore) {
      core = spotifyCore;
      stageEl.appendChild(build());
      wire();
      render();
      if (core.isConnected()) core.startPolling();
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

  window.SpotifySkins.register('gta-v-cluster', createSkin());
})();
