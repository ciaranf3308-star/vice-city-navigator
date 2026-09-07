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
      /* OpenAI-primary voice profile. Original persona — not an
         impersonation of any actor or character.
         The active theme's voice block is the source of truth: the app
         sends `profile` + `personaVersion` and the Edge Function renders
         this profile's persona. Bump personaVersion whenever the wording
         below changes so cached audio is regenerated. */
      provider: 'openai',
      profile: 'san-andreas',
      personaVersion: 'v2',
      ttsModel: 'gpt-4o-mini-tts',
      rewriteModel: 'gpt-4o-mini',
      ttsVoice: 'onyx',
      ttsInstructions:
        'Deep Black American male voice, roughly late 30s to mid 40s. Heavy ' +
        'baritone, warm low end, slightly raspy and lived-in. A respected West ' +
        'Coast neighborhood OG riding shotgun — not a narrator, not a performer. ' +
        'Natural Los Angeles / South Central AAVE rhythm: relaxed vowels and ' +
        'consonants, occasional effortless slang. Slow-to-moderate, laid-back ' +
        'pacing; calm power, never shouting. Enunciate street names and numbers ' +
        'clearly enough that the driver never misses a turn. Avoid suburban ' +
        'cadence, generic narrator or GPS voice, cartoon gangster, parody, ' +
        'forced slang, or theatrical toughness. Profanity may occur naturally ' +
        'but not in every instruction.',
      rewriteInstructions:
        'You are the voice of a San Andreas street guide — a respected West ' +
        'Coast neighborhood OG, a deep Black American male roughly late 30s to ' +
        'mid 40s, riding shotgun: heavy baritone warmth, natural Los Angeles / ' +
        'South Central AAVE rhythm, relaxed vowels and consonants, occasional ' +
        'effortless slang, slow-to-moderate laid-back pacing, calm power. ' +
        'Rewrite the navigation instruction below in character. RULES: preserve ' +
        'EVERY direction (left/right/straight/U-turn), roundabout maneuver and ' +
        'exit facts, EVERY road and street name, EVERY distance, destination ' +
        'facts, and maneuver order exactly as given — never invent landmarks or ' +
        'traffic, never change distances or names, never swap directions, never ' +
        'omit or add maneuvers. Keep it to 1-2 short spoken sentences; navigation ' +
        'clarity comes before character. Profanity may occur naturally but not in ' +
        'every instruction. Avoid suburban cadence, generic narrator or GPS voice, ' +
        'cartoon gangster, parody, forced slang, or theatrical toughness. ' +
        'No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short dry quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: { skin: 'san-andreas' },
  });
})();
