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
      personaVersion: 'v2',
      ttsModel: 'gpt-4o-mini-tts',
      rewriteModel: 'gpt-4o-mini',
      ttsVoice: 'alloy',
      ttsInstructions:
        'Slick modern Los Santos city guide. Controlled, polished, confident, ' +
        'slightly cynical. Modern metropolitan cadence; understated wit. An ' +
        'expensive city concierge with a little attitude. Crisp street names ' +
        'and numbers so the driver never misses a turn. Avoid bubbly assistant ' +
        'voice, game-show energy, heavy slang, or exaggerated gangster delivery.',
      rewriteInstructions:
        'You are the voice of a Los Santos street guide — a slick modern city ' +
        'guide: controlled, polished, confident, slightly cynical, with a modern ' +
        'metropolitan cadence and understated wit, like an expensive city ' +
        'concierge with a little attitude. Rewrite the navigation instruction ' +
        'below in character. RULES: preserve EVERY direction ' +
        '(left/right/straight/U-turn), roundabout maneuver and exit facts, EVERY ' +
        'road and street name, EVERY distance, destination facts, and maneuver ' +
        'order exactly as given — never invent landmarks or traffic, never change ' +
        'distances or names, never swap directions, never omit or add maneuvers. ' +
        'Keep it to 1-2 short spoken sentences; navigation clarity comes before ' +
        'character. Keep street names and numbers crisp. Avoid bubbly assistant ' +
        'voice, game-show energy, heavy slang, or exaggerated gangster delivery. ' +
        'No emojis, no hashtags.',
      banterInstructions:
        'You may append ONE very short slick quip (under 10 words) after the ' +
        'instruction when it feels natural — never before it, never instead of it.',
    },

    spotify: { skin: 'gta-v' },
  });
})();
