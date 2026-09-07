/* ============================================================
   WayStation theme: Vice City (existing, preserved).
   Visuals identical to the original Vice City Navigator:
   authentic blips, player arrow, mission-map yellow route,
   Pricedown labels, dark fog with gold edge.
   ============================================================ */
'use strict';

(function () {
  window.VCNThemes.register({
    id: 'vice-city',
    name: 'Vice City',

    map: {
      styleUrl: 'themes/vice-city/style.json',
      routeColor: '#f5d020',
      routeCasingColor: '#f5d020',
      routeWidth: 5,
      routeCasingWidth: 9,
      playerMarker: 'assets/themes/vice-city/player.png',
      fontStack: 'PricedownBl',
    },

    pois: {
      assetPath: 'assets/themes/vice-city/blips/',
      filePrefix: 'blip_', // on-disk names are blip_<stem>.png
      fallbackIcon: 'qmark',
      /* WayStation semantic category -> VC blip file stem.
         Reproduces the original Google-type mapping 1:1. */
      semanticIconMap: {
        fuel: 'fuel', ev_charger: 'fuel',
        garage: 'modGarage', car_wash: 'spray', parking: 'parking',
        airport: 'airYard', train: 'waypoint',
        hospital: 'hostpital', pharmacy: 'hostpital',
        police: 'police', bank: 'cash', atm: 'cash',
        supermarket: 'cash', mall: 'cash', shop: 'cash',
        hotel: 'saveGame',
        restaurant: 'dateFood', fast_food: 'burgerShot',
        pizza: 'pizza', burger: 'burgerShot', chicken: 'chicken',
        cafe: 'diner', bar: 'dateDrink',
        nightlife: 'dateDisco', cinema: 'dateDisco',
        gym: 'gym', stadium: 'race',
      },
    },

    ui: {
      bodyClass: 'theme-vice-city',
      accent: '#f5d020',
      arrowColor: '#fffb96',
      fogFill: '#0b0b18', fogFillOpacity: 0.82,
      fogEdge: '#f5d020', fogEdgeOpacity: 0.15,
    },

    voice: {
      /* OpenAI-primary voice profile. Original persona — not an
         impersonation of any actor or character.
         The active theme's voice block is the source of truth: the app
         sends `profile` + `personaVersion` and the Edge Function renders
         this profile's persona. Bump personaVersion whenever the wording
         below changes so cached audio is regenerated. */
      provider: 'openai',
      profile: 'vice-city',
      personaVersion: 'v2',
      ttsModel: 'gpt-4o-mini-tts',
      rewriteModel: 'gpt-4o-mini',
      ttsVoice: 'echo',
      ttsInstructions:
        'Energetic 1980s Miami traffic-radio DJ. Punchy, charismatic, playful, ' +
        'confident. Medium-fast cadence, late-night FM swagger, occasional ' +
        'dry or sarcastic aside. Exceptionally clear street names, distances, ' +
        'and maneuver words so the driver never misses a turn. Avoid generic ' +
        'GPS voice, modern podcast host, corporate announcer, or exaggerated parody.',
      rewriteInstructions:
        'You are the voice of a Vice City street guide — an energetic 1980s ' +
        'Miami traffic-radio DJ: punchy, charismatic, playful, confident, with ' +
        'late-night FM swagger and the occasional dry or sarcastic aside. ' +
        'Rewrite the navigation instruction below in character. RULES: preserve ' +
        'EVERY direction (left/right/straight/U-turn), roundabout maneuver and ' +
        'exit facts, EVERY road and street name, EVERY distance, destination ' +
        'facts, and maneuver order exactly as given — never invent landmarks or ' +
        'traffic, never change distances or names, never swap directions, never ' +
        'omit or add maneuvers. Keep it to 1-2 short spoken sentences; navigation ' +
        'clarity comes before character. Street names, distances, and maneuver ' +
        'words must be exceptionally clear. Avoid generic GPS voice, modern ' +
        'podcast host, corporate announcer, or exaggerated parody. ' +
        'No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short playful quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: {
      skin: 'vice-city',
    },
  });
})();
