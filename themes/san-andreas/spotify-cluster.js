/* ============================================================
   WayStation — San Andreas Spotify skin, CLUSTER mode only.

   The cluster stage is the user's own background art used directly
   (themes/san-andreas/dashboard/cluster-overlay.png, 2048x768), which
   already contains empty container boxes for the music widget:
     - album art box   : stage (1304,283) 208x204
     - track info area : stage (1519,283) 314x204
     - lyric bar       : stage (1297,503) 532x43
   This skin builds a compact widget that lives INSIDE those boxes —
   it never paints its own frame. The dashboard keeps the full .sasp
   skin (spotify-skin.js) untouched.

   Layout mirrors the hero music widget: art left, title/artist +
   progress + transport right, single lyric line along the bottom.

   LYRICS: the shared kinetic karaoke engine (lyrics.js, LRCLIB)
   renders into [data-lyrics-stage]; the cluster CSS isolates the
   .wslyr-hero current line so the 43px bar shows one live line.
   Never invent lyric text.
   ============================================================ */
'use strict';

(function () {
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
    let artGen = 0;
    let artTrackId = null;
    let statusTimer = null;

    function build() {
      root = el('div', 'sacl');
      root.innerHTML =
        '<div class="sacl-artwrap">' +
          '<div class="sacl-art-idle">' + SVG.note + '</div>' +
          '<img class="sacl-art a" alt="">' +
          '<img class="sacl-art b" alt="">' +
        '</div>' +
        '<div class="sacl-info">' +
          '<div class="sacl-title">Radio Los Santos</div>' +
          '<div class="sacl-artist">Connect Spotify to play</div>' +
          '<div class="sacl-progress">' +
            '<div class="sacl-bar" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100">' +
              '<div class="sacl-bar-fill"></div>' +
              '<div class="sacl-bar-knob"></div>' +
            '</div>' +
            '<div class="sacl-times"><span class="sacl-elapsed">0:00</span><span class="sacl-duration">0:00</span></div>' +
          '</div>' +
          '<div class="sacl-controls">' +
            '<button class="sacl-tbtn" data-act="prev" aria-label="Previous">' + SVG.prev + '</button>' +
            '<button class="sacl-tbtn big" data-act="toggle" aria-label="Play or pause">' + SVG.play + '</button>' +
            '<button class="sacl-tbtn" data-act="next" aria-label="Next">' + SVG.next + '</button>' +
          '</div>' +
          '<div class="sacl-idle">' +
            '<div class="sacl-idle-kicker">Radio Los Santos</div>' +
            '<button class="sacl-connect-btn" type="button">Connect Spotify</button>' +
          '</div>' +
        '</div>' +
        '<div class="sacl-lyrics" data-lyrics-stage="1"></div>';
      return root;
    }

    const q = sel => root.querySelector(sel);

    function status(msg, sticky) {
      const a = q('.sacl-artist');
      if (!a) return;
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      if (msg) {
        a.dataset.real = a.textContent;
        a.textContent = msg;
        a.classList.add('sacl-status');
        if (!sticky) statusTimer = setTimeout(() => {
          a.textContent = a.dataset.real || '';
          a.classList.remove('sacl-status');
        }, 4000);
      }
    }

    function render() {
      const s = core.getState();
      const idle = q('.sacl-idle');
      const connected = core.isConnected();
      const hasTrack = !!(s && s.item && s.item.id);
      idle.hidden = connected || hasTrack;
      root.classList.toggle('is-idle', !connected && !hasTrack);
      const title = q('.sacl-title'), artist = q('.sacl-artist');
      const toggle = q('.sacl-tbtn[data-act="toggle"]');
      if (!connected) {
        stopTick();
        title.textContent = 'Radio Los Santos';
        artist.textContent = 'Connect Spotify to play';
        artist.classList.remove('sacl-status');
        setArt('', null);
        renderLyrics(null);
        return;
      }
      if (!s || !s.item) {
        title.textContent = 'Nothing playing';
        artist.textContent = 'Press play in Spotify';
        setArt('', null);
        toggle.innerHTML = SVG.play;
        q('.sacl-duration').textContent = '0:00';
        updateProgress(0, 0);
        renderLyrics(null);
        return;
      }
      const item = s.item;
      title.textContent = item.name || '—';
      if (statusTimer) { clearTimeout(statusTimer); statusTimer = null; }
      artist.textContent = (item.artists || []).map(a => a.name).join(', ') || '—';
      artist.dataset.real = artist.textContent;
      artist.classList.remove('sacl-status');
      const imgs = item.album && item.album.images;
      const renderTrackId = item.id;
      setArt(imgs && imgs.length ? (imgs[1] || imgs[0]).url : '', renderTrackId);
      toggle.innerHTML = s.is_playing ? SVG.pause : SVG.play;
      q('.sacl-duration').textContent = fmt(item.duration_ms);
      if (s.device && s.device.name) title.title = 'On ' + s.device.name;
      renderLyrics(s);
      startTick();
    }

    function renderLyrics(s) {
      const box = q('.sacl-lyrics');
      if (window.WSLyrics) WSLyrics.render(box, core, s && s.item, 'san-andreas');
    }

    function setArt(url, trackId) {
      if (!trackId) {
        artGen++;
        artTrackId = null;
        currentArtUrl = '';
        const a = q('.sacl-art.a'), b = q('.sacl-art.b');
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
      const a = q('.sacl-art.a'), b = q('.sacl-art.b');
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
      q('.sacl-bar-fill').style.width = pct + '%';
      q('.sacl-bar-knob').style.left = pct + '%';
      q('.sacl-elapsed').textContent = fmt(pos);
      q('.sacl-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
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
      q('.sacl-connect-btn').addEventListener('click', () => core.connect());

      q('.sacl-controls').addEventListener('click', e => {
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

      const bar = q('.sacl-bar');
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

  window.SpotifySkins.register('san-andreas-cluster', createSkin());
})();
