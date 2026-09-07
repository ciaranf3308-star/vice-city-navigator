/* ============================================================
   WayStation — Spotify skin registry (theme-independent).
   ------------------------------------------------------------
   Maps a theme id (from VCNThemes) to a skin module. A skin
   owns all visuals: background art, typography, controls,
   lyrics styling, visualizer styling.

   Skin contract:
     { mount(stageEl, core) -> api, unmount() }
   where stageEl is an empty element the skin fills, core is
   window.SpotifyCore, and api may expose optional hooks
   (e.g. setLyricsRenderer for a future lyrics provider).

   Future themes (San Andreas, GTA V, RDR…) register here
   without touching the core or the app wiring.
   ============================================================ */
'use strict';

(function () {
  const SKINS = {};

  window.SpotifySkins = {
    register(themeId, skin) { SKINS[themeId] = skin; },
    get(themeId) { return SKINS[themeId] || null; },
    ids() { return Object.keys(SKINS); },
  };

  /* Minimal default skin: plain transport controls for themes that ship
     no dedicated skin. Purely presentational — the SpotifyCore session
     (auth, polling, playback) is untouched by skin swaps. */
  function createDefaultSkin() {
    let offs = [];
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function render(stageEl, core) {
      const connected = core.isConnected();
      const s = core.getState();
      const item = s && s.item;
      const playing = !!(s && s.is_playing);
      stageEl.innerHTML =
        '<div class="wssp-default">' +
        (connected && item
          ? '<div class="wssp-track">' + esc(item.name) + '</div>' +
            '<div class="wssp-artist">' + esc((item.artists || []).map(a => a.name).join(', ')) + '</div>' +
            '<div class="wssp-transport">' +
            '<button data-act="prev" aria-label="Previous">|&#9664;</button>' +
            '<button data-act="toggle" aria-label="Play or pause">' + (playing ? '&#10074;&#10074;' : '&#9654;') + '</button>' +
            '<button data-act="next" aria-label="Next">&#9654;|</button>' +
            '</div>'
          : '<button class="wssp-connect" data-act="connect">Connect Spotify</button>') +
        '</div>';
    }
    function mount(stageEl, core) {
      const onClick = e => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const act = btn.getAttribute('data-act');
        if (act === 'connect') core.connect();
        else if (act === 'toggle') { const s = core.getState(); (s && s.is_playing ? core.pause() : core.play()); }
        else if (act === 'next') core.next();
        else if (act === 'prev') core.previous();
      };
      stageEl.addEventListener('click', onClick);
      const rerender = () => render(stageEl, core);
      offs = [core.on('state', rerender), core.on('auth', rerender)];
      render(stageEl, core);
      if (core.isConnected()) core.startPolling();
      offs.push(() => stageEl.removeEventListener('click', onClick));
    }
    function unmount() {
      offs.forEach(off => { try { off(); } catch (e) {} });
      offs = [];
    }
    return { mount, unmount };
  }
  window.SpotifySkins.register('default', createDefaultSkin());
})();
