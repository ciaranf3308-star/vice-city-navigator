/* ============================================================
   Vice City Navigator — theme registry.
   ------------------------------------------------------------
   Theme-specific configuration ONLY. Core behaviour (GPS,
   discovery data, Places, POI cache, routing, navigation,
   UI mode state) never reads anything except through this
   registry, so a future theme (e.g. San Andreas) can reuse
   every core system untouched.

   A theme may control:
     fonts / colours / panel appearance / maneuver graphics /
     AI personality instructions / voice selection + style /
     sound effects.
   ============================================================ */
'use strict';

(function () {
  const THEMES = {
    'vice-city': {
      id: 'vice-city',
      name: 'Vice City',
      ui: {
        bodyClass: 'theme-vice-city',
        arrowColor: '#fffb96',   // maneuver arrow stroke
        accent: '#f5d020',       // route + HUD accent (mission-map yellow)
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
    },
  };

  const ORDER = ['vice-city'];
  let currentId = 'vice-city';

  window.VCNThemes = {
    ids: () => ORDER.slice(),
    currentId: () => currentId,
    setCurrent: id => { if (THEMES[id]) { currentId = id; return true; } return false; },
    get: id => THEMES[id || currentId] || THEMES['vice-city'],
    current: () => THEMES[currentId],
  };
})();
