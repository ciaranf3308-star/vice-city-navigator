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
})();
