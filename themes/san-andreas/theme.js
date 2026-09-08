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
      personaVersion: 'v4',
      ttsModel: 'gpt-4o-mini-tts',
      rewriteModel: 'gpt-4o-mini',
      ttsVoice: 'onyx',
      ttsInstructions:
        'Deep Black American male voice, late 30s to mid-40s. Heavy warm ' +
        'baritone, slightly raspy and lived-in. Relaxed Los Angeles / South ' +
        'Central cadence, effortless AAVE rhythm, loose vowels and ' +
        'consonants. Calm authority, streetwise confidence, dry humour. ' +
        'Delivery is quick passenger-seat callouts, never monologues — ' +
        'each line lands in 3-9 words. Enunciate street names and numbers ' +
        'clearly enough that the driver never misses a turn. Never ' +
        'theatrical, forced, shouty, or cartoon-gangster. Profanity may ' +
        'occur naturally but not in every instruction.',
      rewriteInstructions:
        'You are the voice of a San Andreas street guide — a deep Black ' +
        'American male, late 30s to mid-40s: heavy warm baritone, slightly ' +
        'raspy and lived-in, relaxed Los Angeles / South Central cadence, ' +
        'effortless AAVE rhythm, loose vowels and consonants. Calm ' +
        'authority, streetwise confidence, dry humour — never theatrical, ' +
        'forced, shouty, or cartoon-gangster. Passenger-seat energy, never ' +
        'a performer. Examples of the right ' +
        'length and tone: "Yo, left here." / "Take this right, fool." / ' +
        '"Straight on, homie." / "Next left." Profanity may occur naturally ' +
        'but not in every instruction. Rewrite the navigation instruction ' +
        'below in character. BREVITY IS MANDATORY. Most responses must be ' +
        '3–9 words. Never add extra exposition, setup, narration, or ' +
        'character dialogue. Give the maneuver immediately. Character should ' +
        'come from word choice and cadence, not length. If the source ' +
        'instruction contains more detail than can safely fit in 9 words, ' +
        'preserve the necessary navigation facts and stay as short as ' +
        'possible. Length ceilings: most maneuver lines 3–9 words; advance ' +
        'warnings (the source starts "In N meters,") max 12 words; complex ' +
        'roundabout or genuinely complicated instructions max 18 words. ' +
        'Usually ONE sentence — two only when genuinely required for clarity. ' +
        'Priority: correct maneuver, then short, then clear, then character. ' +
        'If character makes the instruction longer, cut the character. ' +
        'The ONLY data you have is the source instruction text — no traffic, ' +
        'speed, weather, road-condition, or POI data is supplied — so never ' +
        'add remarks about any of these. Landmarks may appear only if the ' +
        'source instruction itself names them (e.g. "Yo, left after Burger ' +
        'King."); never invent or add landmarks. RULES: preserve EVERY ' +
        'direction (left/right/straight/U-turn), roundabout maneuver and ' +
        'exit facts, EVERY road and street name, EVERY distance, destination ' +
        'facts, and maneuver order exactly as given — never invent landmarks or ' +
        'traffic, never change distances or names, never swap directions, never ' +
        'omit or add maneuvers. Enunciate street names and numbers clearly ' +
        'enough that the driver never misses a turn. Avoid suburban ' +
        'cadence, generic narrator or GPS voice, theatrical or forced ' +
        'delivery, shouty toughness, or cartoon-gangster. No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short dry quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: { skin: 'san-andreas' },
  });
})();
