/* ============================================================
   WayStation theme: Frontier (Red Dead Redemption 2).
   Paper-map language: warm parchment, hand-inked dark roads,
   thin trails, strong railways, restrained water, Western
   slab-serif labels. Dashed ink-red trail for the route.
   Real-world POIs keep their real names — icons are
   period-appropriate abstractions.
   ============================================================ */
'use strict';

(function () {
  window.VCNThemes.register({
    id: 'rdr2',
    name: 'Frontier',

    map: {
      styleUrl: 'themes/rdr2/style.json',
      routeColor: '#b8352f',
      routeCasingColor: '#5a201b',
      routeWidth: 3,
      routeCasingWidth: 6,
      routeDash: [2, 2.5],
      playerMarker: 'assets/themes/rdr2/player.png',
      fontStack: 'frontier',
    },

    pois: {
      assetPath: 'assets/themes/rdr2/blips/',
      fallbackIcon: 'qmark',
      /* Blip files are named after the semantic category; the
         period abstraction lives in the artwork itself (law for
         police, stable for garage, saloon for food/drink, doctor
         for hospital, supply for fuel, etc.). Real POI names are
         always shown on the place card. */
      semanticIconMap: {},
    },

    ui: {
      bodyClass: 'theme-rdr2',
      accent: '#b8352f',
      arrowColor: '#f5ead0',
      fogFill: '#c9b384', fogFillOpacity: 0.75,
      fogEdge: '#5a4a33', fogEdgeOpacity: 0.35,
    },

    voice: {
      /* Original persona — not an impersonation of any actor or character. */
      ttsVoice: 'fable',
      ttsInstructions:
        'Speak like a seasoned frontier trail guide giving directions: warm, ' +
        'unhurried, plainspoken, with old-soul steadiness. Crisp enunciation ' +
        'on street names and numbers so the rider never misses a turn.',
      rewriteInstructions:
        'You are the voice of a frontier trail guide — a seasoned, warm, ' +
        'plainspoken soul from the old West, steady and unhurried. Rewrite the ' +
        'navigation instruction below in character. RULES: keep the maneuver ' +
        'direction (left/right/straight/U-turn/roundabout), EVERY street name, ' +
        'and EVERY distance exactly as given — never invent, drop, or change ' +
        'them. One or two short sentences only. No emojis, no hashtags. Mild ' +
        'period flavour is welcome but never at the cost of clarity.',
      banterInstructions:
        'You may append ONE very short wry trail-side remark (under 10 words) ' +
        'after the instruction when it feels natural — never before it, never ' +
        'instead of it.',
    },

    spotify: { skin: 'rdr2' },
  });
})();
