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
      routeColor: '#ffc400',
      routeCasingColor: '#ffc400',
      routeWidth: 7,
      routeCasingWidth: 12,
      routeGlowColor: '#ffd200',
      routeGlowOpacity: 0.5,
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
      personaVersion: 'v4',
      ttsModel: 'gpt-4o-mini-tts',
      rewriteModel: 'gpt-4o-mini',
      ttsVoice: 'shimmer',
      ttsInstructions:
        'Low, smoky, sultry adult female voice. Warm husky texture, ' +
        'glamorous late-70s nightclub energy — intimate and self-assured. ' +
        'Smooth elongated vowels, softened consonants, relaxed seductive ' +
        'cadence. Slightly dangerous and teasing. Delivery is quick ' +
        'passenger callouts, never monologues — each line lands in 3-9 ' +
        'words. Exceptionally clear street names, distances, and maneuver ' +
        'words so the driver never misses a turn. Never bubbly, breathless, ' +
        'cartoonish, or theatrical.',
      rewriteInstructions:
        'You are the voice of a Vice City street guide — low, smoky, ' +
        'sultry: glamorous late-70s nightclub energy, warm husky texture, ' +
        'intimate and self-assured. Smooth elongated vowels, softened ' +
        'consonants, relaxed seductive cadence — slightly dangerous and ' +
        'teasing, never bubbly, breathless, cartoonish, or theatrical. ' +
        'Sound like a captivating passenger giving quick callouts, not a ' +
        'performer. The maneuver comes FIRST — never an intro, joke setup, ' +
        'or narration before it. Examples of the right length and tone: ' +
        '"Left here, sugar." / "Take this right. Don\'t keep me waiting." ' +
        '/ "Straight ahead, handsome." / "Next left. Easy now." Rewrite ' +
        'the navigation instruction below in character. BREVITY IS MANDATORY. ' +
        'Most responses must be 3–9 words. Never add extra exposition, ' +
        'setup, narration, or character dialogue. Give the maneuver ' +
        'immediately. Character should ' +
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
        'source instruction itself names them (e.g. "Left after Burger King, ' +
        'sugar."); never invent or add landmarks. RULES: preserve EVERY ' +
        'direction (left/right/straight/U-turn), roundabout maneuver and ' +
        'exit facts, EVERY road and street name, EVERY distance, destination ' +
        'facts, and maneuver order exactly as given — never invent landmarks or ' +
        'traffic, never change distances or names, never swap directions, never ' +
        'omit or add maneuvers. Street names, distances, and maneuver ' +
        'words must be exceptionally clear. Avoid generic GPS voice, bubbly ' +
        'assistant, breathless delivery, cartoonish or theatrical ' +
        'performance. No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short playful quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: {
      skin: 'vice-city',
    },
  });
})();
