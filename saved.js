/* ============================================================
   Vice City Navigator — Saved Places & Home
   ------------------------------------------------------------
   Theme-independent, network-free. Persists the user's curated
   places and their home location in localStorage.

   - Saved places: destinations the user drives to are auto-saved
     here (deduplicated by proximity), plus manual saves from the
     POI card. Managed (rename/remove) from the menu Places
     section.
   - Home: a single special location. Set from the POI card, from
     the current GPS fix, or promoted from a saved place.
     Powers one-tap "navigate home".

   Place: { id, label, lnglat:[lng,lat], semantic, t }
   Home:  { label, lnglat:[lng,lat], t } | null
   ============================================================ */
'use strict';

(function () {
  const SAVED_KEY = 'vcn-saved-places-v1';
  const HOME_KEY = 'vcn-home-v1';
  const MARKER_KEY = 'vcn-custom-markers-v1';
  const DEDUPE_METERS = 100;
  const MAX_SAVED = 200;
  const MAX_MARKERS = 500;

  function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* Haversine distance in metres. */
  function distM(a, b) {
    const R = 6371000;
    const dLat = (b[1] - a[1]) * Math.PI / 180;
    const dLng = (b[0] - a[0]) * Math.PI / 180;
    const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
    const h = s1 * s1 + Math.cos(a[1] * Math.PI / 180) *
      Math.cos(b[1] * Math.PI / 180) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function readList() {
    try {
      const a = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
      if (!Array.isArray(a)) return [];
      return a.filter(p => p && typeof p.label === 'string' &&
        Array.isArray(p.lnglat) && p.lnglat.length === 2 &&
        typeof p.lnglat[0] === 'number' && typeof p.lnglat[1] === 'number');
    } catch (e) { return []; }
  }

  function writeList(list) {
    try {
      localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
    } catch (e) { /* private mode — memory only */ }
  }

  function readHome() {
    try {
      const h = JSON.parse(localStorage.getItem(HOME_KEY) || 'null');
      if (h && typeof h.label === 'string' && Array.isArray(h.lnglat) &&
          h.lnglat.length === 2) return h;
      return null;
    } catch (e) { return null; }
  }

  function writeHome(home) {
    try {
      if (home) localStorage.setItem(HOME_KEY, JSON.stringify(home));
      else localStorage.removeItem(HOME_KEY);
    } catch (e) { /* private mode */ }
  }

  window.VCNSaved = {
    /* ---------- saved places ---------- */
    getPlaces() { return readList(); },

    /* Save a place. If a saved place already exists within
       DEDUPE_METERS, it is refreshed (label/semantic updated,
       moved to top) instead of duplicated. Returns the place. */
    savePlace(input) {
      if (!input || typeof input.label !== 'string' ||
          !Array.isArray(input.lnglat)) return null;
      const lnglat = [input.lnglat[0], input.lnglat[1]];
      const list = readList();
      const existing = list.find(p => distM(p.lnglat, lnglat) <= DEDUPE_METERS);
      if (existing) {
        existing.label = input.label || existing.label;
        if (input.semantic) existing.semantic = input.semantic;
        existing.t = Date.now();
        const rest = list.filter(p => p.id !== existing.id);
        writeList([existing, ...rest]);
        return existing;
      }
      const place = {
        id: uid(),
        label: input.label,
        lnglat,
        semantic: input.semantic || null,
        t: Date.now(),
      };
      writeList([place, ...list]);
      return place;
    },

    removePlace(id) {
      writeList(readList().filter(p => p.id !== id));
    },

    renamePlace(id, label) {
      const clean = String(label || '').trim();
      if (!clean) return false;
      const list = readList();
      const p = list.find(x => x.id === id);
      if (!p) return false;
      p.label = clean;
      writeList(list);
      return true;
    },

    findNear(lnglat, meters) {
      if (!Array.isArray(lnglat)) return null;
      const m = (typeof meters === 'number') ? meters : DEDUPE_METERS;
      return readList().find(p => distM(p.lnglat, lnglat) <= m) || null;
    },

    isSaved(lnglat) { return !!this.findNear(lnglat); },

    /* ---------- home ---------- */
    getHome() { return readHome(); },

    setHome(input) {
      if (!input || typeof input.label !== 'string' ||
          !Array.isArray(input.lnglat)) return null;
      const home = {
        label: input.label,
        lnglat: [input.lnglat[0], input.lnglat[1]],
        t: Date.now(),
      };
      writeHome(home);
      return home;
    },

    clearHome() { writeHome(null); },

    isHome(lnglat) {
      const h = readHome();
      return !!h && Array.isArray(lnglat) && distM(h.lnglat, lnglat) <= DEDUPE_METERS;
    },

    /* ---------- custom markers ----------
       User-placed pins with a chosen icon. The icon is stored as a
       semantic key ('fuel', 'police', …) so it resolves to each
       theme's own art when the theme changes — the marker never
       references a theme-specific filename. */
    getMarkers() {
      try {
        const a = JSON.parse(localStorage.getItem(MARKER_KEY) || '[]');
        if (!Array.isArray(a)) return [];
        return a.filter(m => m && typeof m.id === 'string' &&
          Array.isArray(m.lnglat) && m.lnglat.length === 2 &&
          typeof m.lnglat[0] === 'number' && typeof m.icon === 'string');
      } catch (e) { return []; }
    },

    addMarker(input) {
      if (!input || !Array.isArray(input.lnglat) ||
          typeof input.icon !== 'string') return null;
      const marker = {
        id: uid(),
        label: String(input.label || 'Marker').slice(0, 60) || 'Marker',
        lnglat: [input.lnglat[0], input.lnglat[1]],
        icon: input.icon,
        t: Date.now(),
      };
      const list = this.getMarkers();
      list.unshift(marker);
      try {
        localStorage.setItem(MARKER_KEY, JSON.stringify(list.slice(0, MAX_MARKERS)));
      } catch (e) { /* private mode */ }
      return marker;
    },

    updateMarker(id, patch) {
      const list = this.getMarkers();
      const m = list.find(x => x.id === id);
      if (!m) return null;
      if (patch.label != null) m.label = String(patch.label).slice(0, 60) || m.label;
      if (patch.icon != null) m.icon = patch.icon;
      try { localStorage.setItem(MARKER_KEY, JSON.stringify(list)); } catch (e) {}
      return m;
    },

    removeMarker(id) {
      try {
        localStorage.setItem(MARKER_KEY,
          JSON.stringify(this.getMarkers().filter(m => m.id !== id)));
      } catch (e) {}
    },
  };
})();
