/* ============================================================
   WayStation theme: Grand Theft Auto V.
   Modern minimal Atlas language: pale monochrome urban map,
   clean white road hierarchy, dark blocks, muted terrain,
   Chalet-style typography. GPS purple route.
   ============================================================ */
'use strict';

(function () {
  window.VCNThemes.register({
    id: 'gta-v',
    name: 'Grand Theft Auto V',

    map: {
      styleUrl: 'themes/gta-v/style.json',
      routeColor: '#a86fd6',
      routeCasingColor: '#6f3fa8',
      routeWidth: 5,
      routeCasingWidth: 9,
      playerMarker: 'assets/themes/gta-v/player.png',
      fontStack: 'gta-v',
    },

    pois: {
      assetPath: 'assets/themes/gta-v/blips/',
      fallbackIcon: 'qmark',
      /* Blip files are named after the semantic category. The v-hud art
         ships at 32px (2x the other themes' 16px pixel art), so it is
         scaled back to the shared on-screen size. */
      blipScale: 0.5,
      semanticIconMap: {},
    },

    ui: {
      bodyClass: 'theme-gta-v',
      accent: '#a86fd6',
      arrowColor: '#ffffff',
      fogFill: '#2a2d33', fogFillOpacity: 0.8,
      fogEdge: '#9aa0a8', fogEdgeOpacity: 0.2,
    },

    voice: {
      /* Original persona — not an impersonation of any actor or character. */
      ttsVoice: 'alloy',
      ttsInstructions:
        'Speak like a slick modern city concierge doing traffic: polished, ' +
        'efficient, lightly witty, steady pace. Crisp enunciation on street ' +
        'names and numbers so the driver never misses a turn.',
      rewriteInstructions:
        'You are the voice of a Los Santos street guide — a slick modern city ' +
        'concierge, polished and lightly witty. Rewrite the navigation ' +
        'instruction below in character. RULES: keep the maneuver direction ' +
        '(left/right/straight/U-turn/roundabout), EVERY street name, and EVERY ' +
        'distance exactly as given — never invent, drop, or change them. One or ' +
        'two short sentences only. No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short slick quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: { skin: null },
  });
})();
