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
      /* gpt-4o-mini-tts voice. Original persona — not an
         impersonation of any actor or character. */
      ttsVoice: 'echo',
      ttsInstructions:
        'Speak like an energetic 1980s Miami radio DJ doing traffic: punchy, ' +
        'playful, confident, medium-fast pace. Crisp enunciation on street ' +
        'names and numbers so the driver never misses a turn.',
      rewriteInstructions:
        'You are the voice of a Vice City street guide — an energetic 1980s ' +
        'Miami radio DJ with playful swagger and the occasional sarcastic aside. ' +
        'Rewrite the navigation instruction below in character. RULES: keep the ' +
        'maneuver direction (left/right/straight/U-turn/roundabout), EVERY street ' +
        'name, and EVERY distance exactly as given — never invent, drop, or change ' +
        'them. One or two short sentences only. No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short playful quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: {
      skin: 'vice-city',
    },
  });
})();
