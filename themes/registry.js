/* ============================================================
   WayStation — theme registry.
   ------------------------------------------------------------
   Every visual identity lives in a theme definition registered
   here. Core code (GPS, routing, navigation, POIs, discovery,
   Spotify, UI state) NEVER contains game-specific names, asset
   paths, colours or fonts — it only reads them through
   VCNThemes.current().

   Theme shape:
   {
     id, name,
     map: {
       styleUrl,            // MapLibre style JSON (self-hosted)
       routeColor, routeCasingColor, routeWidth, routeCasingWidth,
       playerMarker,        // PNG url for the player arrow/marker
       fontStack,           // glyph fontstack dir under fonts/
     },
     pois: {
       assetPath,           // dir prefix for blip PNGs, e.g. 'assets/themes/san-andreas/blips/'
       semanticIconMap,     // WayStation semantic category -> PNG file stem
       fallbackIcon,        // stem used when a category has no mapping
     },
     ui: {
       bodyClass,           // <body> class while active
       accent,              // HUD accent colour
       arrowColor,          // maneuver arrow stroke
       fogFill, fogEdge,    // discovery fog presentation (data is shared)
     },
     voice: {
       ttsVoice,            // gpt-4o-mini-tts voice id (original personas only)
       ttsInstructions, rewriteInstructions, banterInstructions,
     },
     spotify: {
       skin,                // skin id in spotify/skins.js, or null
     },
   }

   WayStation semantic POI categories (shared across themes):
   fuel, ev_charger, garage, car_wash, parking, airport, train,
   hospital, pharmacy, police, bank, atm, supermarket, mall, shop,
   hotel, restaurant, fast_food, pizza, burger, chicken, cafe, bar,
   nightlife, cinema, gym, stadium
   ============================================================ */
'use strict';

(function () {
  const THEMES = {};
  const ORDER = [];
  const LS_KEY = 'ws-theme-v1';
  let currentId = null;

  /* Canonical WayStation semantic categories (+ the two special stems).
     Anything outside this set is not a real category and resolves to
     the theme's fallback icon instead of a nonexistent file. */
  const KNOWN_SEMANTICS = new Set([
    'fuel','ev_charger','garage','car_wash','parking','airport','train',
    'hospital','pharmacy','police','bank','atm','supermarket','mall','shop',
    'hotel','restaurant','fast_food','pizza','burger','chicken','cafe','bar',
    'nightlife','cinema','gym','stadium','waypoint','qmark',
  ]);

  function persisted() {
    try { return localStorage.getItem(LS_KEY); } catch (e) { return null; }
  }

  window.VCNThemes = {
    register(def) {
      if (!def || !def.id) throw new Error('theme needs an id');
      THEMES[def.id] = def;
      if (!ORDER.includes(def.id)) ORDER.push(def.id);
    },
    ids: () => ORDER.slice(),
    currentId: () => currentId || ORDER[0],
    setCurrent(id) {
      if (!THEMES[id]) return false;
      currentId = id;
      try { localStorage.setItem(LS_KEY, id); } catch (e) {}
      return true;
    },
    get: id => THEMES[id || currentId || ORDER[0]],
    current() { return this.get(this.currentId()); },
    /* First boot: honour the persisted choice, else vice-city. */
    restore() {
      const p = persisted();
      currentId = (p && THEMES[p]) ? p : 'vice-city';
      if (!THEMES[currentId]) currentId = ORDER[0];
      return currentId;
    },
    /* Resolve a semantic POI category to this theme's blip PNG url.
       A theme maps a category to its own file stem; unmapped
       categories fall back to a file named after the category.
       Unknown (non-canonical) semantics resolve to the theme's
       fallback icon so the map never references a missing file. */
    poiIconUrl(semantic, id) {
      const t = this.get(id);
      const known = KNOWN_SEMANTICS.has(semantic);
      const stem = (known && ((t.pois.semanticIconMap && t.pois.semanticIconMap[semantic]) || semantic)) ||
        t.pois.fallbackIcon || 'qmark';
      return t.pois.assetPath + (t.pois.filePrefix || '') + stem + '.png';
    },
    /* Namespaced MapLibre image id for a theme's blip stem. */
    poiImageId(id, stem) { return 'poi-' + id + '-' + stem; },
  };
})();
