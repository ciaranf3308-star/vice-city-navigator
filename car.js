/* ============================================================================
   WayStation — car-mode adapter (?car=1).

   Loaded BEFORE app.js. Its only early job is to plant the car flag so
   initAppMode() forces dashboard mode for this session (without persisting
   it to localStorage — the phone/PWA experience is untouched).

   The full window.WayStationCar bridge (visible/stable-area forwarding,
   Spotify token handoff, state queries) is installed by app.js after boot,
   because it needs SpotifyCore / theme / nav state to exist first.

   There is currently no mobile-only install prompt in the app (no
   beforeinstallprompt handler), so there is nothing to suppress; if one
   is ever added, gate it on !window.__WAYSTATION_CAR.
   ========================================================================== */
(function () {
  'use strict';
  try {
    if (new URLSearchParams(window.location.search).get('car') === '1') {
      window.__WAYSTATION_CAR = true;
    }
  } catch (e) { /* non-car path: nothing to do */ }
})();
