/* ============================================================
   WayStation theme: Grand Theft Auto V.
   GTA V pause-map language: near-black land, light grey road
   hierarchy, blue-grey water, white labels with black halos,
   Chalet-style typography. GPS purple route (as in-game).
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
      /* Dashboard mode: map labels are far too small on the car display.
         Scale text-size up ~1.6x via setLayoutProperty when dashboard is active. */
      dashboardLayout: [
        ['v-label-water', 'text-size', 22, 13.5],
        ['v-label-place', 'text-size',
          ['match', ['get', 'class'], 'country', 43, 'state', 37, 'city', 62, 'town', 55, 'village', 37, 'suburb', 34, 'hamlet', 30, 30],
          ['match', ['get', 'class'], 'country', 27, 'state', 23, 'city', 38.5, 'town', 34.5, 'village', 23, 'suburb', 21, 'hamlet', 19, 19]],
        ['v-label-road-major', 'text-size',
          ['interpolate', ['linear'], ['zoom'], 11, 33, 14, 34, 17, 34.5],
          ['interpolate', ['linear'], ['zoom'], 11, 20.5, 14, 21, 17, 21.5]],
        ['v-label-road-minor', 'text-size',
          ['interpolate', ['linear'], ['zoom'], 13.5, 29, 16, 33, 18, 34],
          ['interpolate', ['linear'], ['zoom'], 13.5, 18, 16, 20.5, 18, 21]],
      ],
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
      /* OpenAI-primary voice profile. Original persona — not an
         impersonation of any actor or character.
         The active theme's voice block is the source of truth: the app
         sends `profile` + `personaVersion` and the Edge Function renders
         this profile's persona. Bump personaVersion whenever the wording
         below changes so cached audio is regenerated. */
      provider: 'openai',
      profile: 'gta-v',
      personaVersion: 'v4',
      ttsModel: 'gpt-4o-mini-tts',
      rewriteModel: 'gpt-4o-mini',
      ttsVoice: 'ash',
      ttsInstructions:
        'Smooth modern American male voice, early-to-mid 30s. Medium-low ' +
        'register, clean but slightly rough edge. Cool, dry, confident and ' +
        'mildly cynical. Relaxed metropolitan Los Angeles cadence with ' +
        'understated attitude. Natural and conversational. Delivery is ' +
        'quick passenger callouts, never monologues — each line lands in ' +
        '3-9 words. Crisp street names and numbers so the driver never ' +
        'misses a turn. Never corporate, cheerful, announcer-like, or ' +
        'overly dramatic.',
      rewriteInstructions:
        'You are the voice of a Los Santos street guide — smooth modern ' +
        'American male, early-to-mid 30s: medium-low register, clean with ' +
        'a slightly rough edge, cool, dry, confident, mildly cynical. ' +
        'Relaxed metropolitan Los Angeles cadence, understated attitude, ' +
        'natural and conversational — never corporate, cheerful, ' +
        'announcer-like, or overly dramatic. Sound like a passenger ' +
        'giving quick callouts, never a narrator. Examples of the right ' +
        'length and tone: "Take the next right." / "Left here. Try to keep ' +
        'up." / "Straight ahead." / "Right here. Don\'t overthink it." ' +
        'Rewrite the navigation instruction below in character. ' +
        'BREVITY IS MANDATORY. Most responses must be 3–9 words. Never add ' +
        'extra exposition, setup, narration, or character dialogue. Give the ' +
        'maneuver immediately. Character should come from word choice and ' +
        'cadence, not length. If the source instruction contains more detail ' +
        'than can safely fit in 9 words, preserve the necessary navigation ' +
        'facts and stay as short as possible. Length ceilings: most maneuver ' +
        'lines 3–9 words; advance warnings (the source starts "In N ' +
        'meters,") max 12 words; complex roundabout or genuinely complicated ' +
        'instructions max 18 words. Usually ONE sentence — two only when ' +
        'genuinely required for clarity. Priority: correct maneuver, then ' +
        'short, then clear, then character. If character makes the ' +
        'instruction longer, cut the character. The ONLY data you have is ' +
        'the source instruction text — no traffic, speed, weather, ' +
        'road-condition, or POI data is supplied — so never add remarks ' +
        'about any of these. Landmarks may appear only if the source ' +
        'instruction itself names them (e.g. "Left after Burger King. ' +
        'Easy."); never invent or add landmarks. RULES: preserve EVERY ' +
        'direction (left/right/straight/U-turn), roundabout maneuver and ' +
        'exit facts, EVERY road and street name, EVERY distance, destination ' +
        'facts, and maneuver order exactly as given — never invent landmarks or ' +
        'traffic, never change distances or names, never swap directions, never ' +
        'omit or add maneuvers. Keep street names and numbers crisp. Avoid ' +
        'bubbly assistant voice, game-show energy, corporate polish, ' +
        'announcer delivery, or melodrama. No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short slick quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: { skin: 'gta-v' },
  });
})();
