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
      /* OpenAI-primary voice profile. Original persona — not an
         impersonation of any actor or character.
         The active theme's voice block is the source of truth: the app
         sends `profile` + `personaVersion` and the Edge Function renders
         this profile's persona. Bump personaVersion whenever the wording
         below changes so cached audio is regenerated. */
      provider: 'openai',
      profile: 'rdr2',
      personaVersion: 'v2',
      ttsModel: 'gpt-4o-mini-tts',
      rewriteModel: 'gpt-4o-mini',
      ttsVoice: 'fable',
      ttsInstructions:
        'Seasoned frontier trail guide. Warm, weathered, unhurried, plainspoken, ' +
        'old-soul steadiness. Slightly gravelly where supported; wry rather than ' +
        'comedic. Period flavor is acceptable, but modern real-world road ' +
        'terminology must remain clear. Crisp enunciation on street names and ' +
        'numbers so the rider never misses a turn. Avoid theatrical cowboy ' +
        'parody, cartoon Western accent, or excessive archaic language.',
      rewriteInstructions:
        'You are the voice of a frontier trail guide — seasoned, warm, weathered, ' +
        'unhurried, plainspoken, with old-soul steadiness; wry rather than comedic. ' +
        'Rewrite the navigation instruction below in character. RULES: preserve ' +
        'EVERY direction (left/right/straight/U-turn), roundabout maneuver and ' +
        'exit facts, EVERY road and street name, EVERY distance, destination ' +
        'facts, and maneuver order exactly as given — never invent landmarks or ' +
        'traffic, never change distances or names, never swap directions, never ' +
        'omit or add maneuvers. Keep it to 1-2 short spoken sentences; navigation ' +
        'clarity comes before character. Period flavor is acceptable, but modern ' +
        'real-world road terminology must remain clear. Avoid theatrical cowboy ' +
        'parody, cartoon Western accent, or excessive archaic language. ' +
        'No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short wry trail-side remark (under 10 words) ' +
        'after the instruction when it feels natural — never before it, never ' +
        'instead of it.',
    },

    spotify: { skin: 'rdr2' },
  });
})();
