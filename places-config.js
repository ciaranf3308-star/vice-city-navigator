/* ============================================================
   Google Places API (New) — API key configuration
   ------------------------------------------------------------
   Ambient Vice City POIs (automatic nearby blips) need a Google
   Maps Platform API key with the **Places API (New)** enabled.

   WHERE TO PUT YOUR KEY:
     1. Open the Google Cloud Console -> APIs & Services -> Credentials.
     2. Create (or reuse) an API key.
     3. Restrict it (see below) and paste it as GOOGLE_PLACES_CONFIG.apiKey.

   RECOMMENDED KEY RESTRICTIONS (Google's own guidance):
     - Application restrictions -> Websites (HTTP referrers):
         https://ciaranf3308-star.github.io/*
       This stops anyone else's site from spending your quota.
     - API restrictions -> Restrict key -> select ONLY:
         Places API (New)
       This stops the key being used for any other Google API.

   The project owning the key needs billing enabled — Nearby Search
   (New) is a billed SKU. Each ambient refresh makes a handful of
   small requests (one per category group), gated so they only fire
   after the user has moved ~750 m.

   Do NOT commit an unrestricted key to source control.
   ============================================================ */
'use strict';

const GOOGLE_PLACES_CONFIG = {
  /* Paste your website-restricted key between the quotes. */
  apiKey: 'PASTE_YOUR_GOOGLE_PLACES_API_KEY_HERE',

  /* Master switch for ambient POIs. */
  enabled: true,

  /* Search radius (metres) around the player for each refresh. Max 50000. */
  radiusMeters: 2500,

  /* Re-query Google once the player has moved this far (metres)
     from the centre of the previous POI query. */
  refreshDistanceMeters: 750,

  /* Cached POIs older than this are refetched (24 hours). */
  cacheTtlMs: 24 * 3600 * 1000,
};
