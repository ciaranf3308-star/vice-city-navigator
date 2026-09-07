/* ============================================================
   TomTom Traffic — API key configuration
   ------------------------------------------------------------
   Live traffic for WayStation: flow overlay tiles, incident
   markers (jams / roadworks / closures) and traffic-aware
   routing. The key is a *public* website key by design (same
   pattern as the Google Places key in places-config.js) —
   TomTom bills by key, so restrict it to your site.

   WHERE TO PUT YOUR KEY:
     1. Sign up free at https://developer.tomtom.com/
        (no credit card — 2,500 requests/day free).
     2. Dashboard -> your app -> copy the API key.
     3. Restrict it: set the allowed HTTP referrer to
            https://ciaranf3308-star.github.io/*
        (so nobody else's site can spend your quota).
     4. Paste it as TOMTOM_TRAFFIC_CONFIG.apiKey below.

   WHAT EACH FEATURE COSTS (free tier = 2,500 req/day):
     - Flow overlay: raster tiles, cached by the browser like
       map tiles — a driving session costs a few dozen requests.
     - Incidents: 1 request per refresh; the app refreshes at
       most every 3 minutes and only after you've moved ~1.5 km,
       so ~20/hour of driving worst case.
     - Routing: 1 request per route plan / reroute, only while
       the Live traffic toggle is ON.

   Do NOT commit a real key to source control. The placeholder
   below keeps every traffic feature inert until you paste one.
   Full 2-minute setup: see TRAFFIC_SETUP.md.
   ============================================================ */
'use strict';

const TOMTOM_TRAFFIC_CONFIG = {
  /* Website-restricted key (github.io only). Paste your key here. */
  apiKey: 'PUT_YOUR_TOMTOM_KEY_HERE',

  /* Traffic Flow tile style. 'relative-delay' paints roads ONLY
     where traffic differs from free-flow (green/yellow/red),
     so the overlay stays quiet on clear roads. Other styles:
     'relative', 'relative0', 'absolute', 'reduced-sensitivity'. */
  flowStyle: 'relative-delay',

  /* Overlay translucency — traffic colours are conventional
     (green/yellow/red); this keeps them from fighting the theme. */
  flowOpacity: 0.8,

  /* Incident refresh: at most this often (ms), and only after the
     map centre has moved this far (m) since the last refresh. */
  incidentRefreshMs: 3 * 60 * 1000,
  incidentMinMoveMeters: 1500,

  /* Daily safety cap on incident refreshes (routing + tiles are
     on top of this, but each is a handful per session). */
  maxIncidentRefreshesPerDay: 160,
};
