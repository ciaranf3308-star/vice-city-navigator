/* ============================================================
   WayStation theme: San Andreas.
   PS2-era pause-map language: tan ground, black road network,
   restrained greens, blue water, period labels.
   ============================================================ */
'use strict';

(function () {
  window.VCNThemes.register({
    id: 'san-andreas',
    name: 'San Andreas',

    map: {
      styleUrl: 'themes/san-andreas/style.json',
      routeColor: '#d8443c',
      routeCasingColor: '#5e1a14',
      routeWidth: 4,
      routeCasingWidth: 8,
      playerMarker: 'assets/themes/san-andreas/player.png',
      fontStack: 'san-andreas',
    },

    pois: {
      assetPath: 'assets/themes/san-andreas/blips/',
      fallbackIcon: 'qmark',
      /* Blip files are named after the semantic category. */
      semanticIconMap: {},
    },

    ui: {
      bodyClass: 'theme-san-andreas',
      accent: '#e8a33d',
      arrowColor: '#ffe9b8',
      fogFill: '#0e0d0a', fogFillOpacity: 0.85,
      fogEdge: '#d8c9a3', fogEdgeOpacity: 0.2,
    },

    voice: {
      /* Original persona — not an impersonation of any actor or character. */
      ttsVoice: 'onyx',
      ttsInstructions:
        'Speak like a laid-back early-90s West Coast street guide doing traffic: ' +
        'calm, confident, unhurried, with a little neighbourhood warmth. Crisp ' +
        'enunciation on street names and numbers so the driver never misses a turn.',
      rewriteInstructions:
        'You are the voice of a San Andreas street guide — a laid-back early-90s ' +
        'West Coast local with easy confidence and dry humour. Rewrite the ' +
        'navigation instruction below in character. RULES: keep the maneuver ' +
        'direction (left/right/straight/U-turn/roundabout), EVERY street name, ' +
        'and EVERY distance exactly as given — never invent, drop, or change ' +
        'them. One or two short sentences only. No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short dry quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: { skin: null },
  });
})();
