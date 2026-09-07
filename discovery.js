/* ============================================================
   Vice City Navigator — Discovery / Fog of War
   ------------------------------------------------------------
   Remembers where the player has physically driven and renders
   a fog-of-war overlay for Discovery Mode. Completely
   theme-independent and network-free: discovery DATA is just
   geohash cells, so switching map themes later never loses
   progress.

   Pipeline: GPS movement -> reveal(lnglat) marks the precision-7
   cell plus its 8 neighbours (roughly a 250-400 m discovery
   radius) as discovered, along with coarser parents -> persisted
   to localStorage (debounced) -> refreshFog() paints every
   undiscovered cell in the viewport as fog polygons.

   Safety: fog is ONLY shown when the user deliberately opens
   Discovery Mode via setFogVisible(true). Drive/navigation mode
   must never enable it — that distinction belongs to the
   integrator, not this module.
   ============================================================ */
'use strict';

(function () {
  /* ---------------- module constants (not theme config) ----------------
     These colours belong to the fog system itself. The discovery data
     is pure geohashes and stays valid under any visual theme. */
  const LS_KEY = 'vcn-discovery-v1';
  const SOURCE_ID = 'vcn-fog';
  const FILL_LAYER_ID = 'vcn-fog-fill';
  const EDGE_LAYER_ID = 'vcn-fog-edge';
  const FOG_FILL_COLOR = '#0b0b18';
  const FOG_FILL_OPACITY = 0.82;
  const FOG_EDGE_COLOR = '#f5d020';
  const FOG_EDGE_OPACITY = 0.15;
  const MAX_CELLS = 100000;   // cap on persisted discovered cells
  const MAX_FOG_CELLS = 1500; // cap on fog polygons per rebuild
  const KM2_PER_CELL = 0.014; // precision-7 cell area (mid latitudes)
  const IRELAND_KM2 = 84421;  // denominator for the discovery %

  /* ---------------- self-contained geohash (no dependencies) ---------------- */
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

  function geohashEncode(lat, lng, precision) {
    let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
    let hash = '', bits = 0, ch = 0, even = true; // even bit: longitude
    while (hash.length < precision) {
      if (even) {
        const mid = (lngMin + lngMax) / 2;
        if (lng >= mid) { ch = (ch << 1) | 1; lngMin = mid; }
        else { ch <<= 1; lngMax = mid; }
      } else {
        const mid = (latMin + latMax) / 2;
        if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; }
        else { ch <<= 1; latMax = mid; }
      }
      even = !even;
      if (++bits === 5) { hash += BASE32[ch]; bits = 0; ch = 0; }
    }
    return hash;
  }

  function geohashBounds(hash) {
    let latMin = -90, latMax = 90, lngMin = -180, lngMax = 180;
    let even = true;
    for (const c of String(hash).toLowerCase()) {
      const cd = BASE32.indexOf(c);
      if (cd < 0) throw new Error('[vcn-discovery] bad geohash: ' + hash);
      for (let mask = 16; mask > 0; mask >>= 1) {
        if (even) {
          const mid = (lngMin + lngMax) / 2;
          if (cd & mask) lngMin = mid; else lngMax = mid;
        } else {
          const mid = (latMin + latMax) / 2;
          if (cd & mask) latMin = mid; else latMax = mid;
        }
        even = !even;
      }
    }
    return { latMin, latMax, lngMin, lngMax };
  }

  /* Neighbours without edge-case tables: offset the cell centre by one
     cell height/width in each direction and re-encode. Robust at the
     poles and the antimeridian, where lookup tables get fiddly. */
  function geohashNeighbors(hash) {
    const b = geohashBounds(hash);
    const h = b.latMax - b.latMin, w = b.lngMax - b.lngMin;
    const clat = (b.latMin + b.latMax) / 2, clng = (b.lngMin + b.lngMax) / 2;
    const p = hash.length, out = [];
    for (let dlat = -1; dlat <= 1; dlat++) {
      for (let dlng = -1; dlng <= 1; dlng++) {
        if (dlat === 0 && dlng === 0) continue;
        let lat = clat + dlat * h, lng = clng + dlng * w;
        if (lat > 90) lat = 90; else if (lat < -90) lat = -90;
        while (lng > 180) lng -= 360;
        while (lng < -180) lng += 360;
        out.push(geohashEncode(lat, lng, p));
      }
    }
    return out;
  }

  /* Every cell hash of the given precision covering a lat/lng bbox.
     Walks the grid from the south-west cell — geohash cells tile the
     world with no gaps, so fixed steps land on exact cell centres.
     `limit` bails out early once we know the caller will drop a
     precision level anyway. (Antimeridian-crossing bboxes are out of
     scope for this app and yield no cells.) */
  function geohashesInBounds(sw, ne, precision, limit) {
    const b0 = geohashBounds(geohashEncode(sw.lat, sw.lng, precision));
    const h = b0.latMax - b0.latMin, w = b0.lngMax - b0.lngMin;
    const cells = [], seen = new Set();
    const max = limit || Infinity;
    let lat = (b0.latMin + b0.latMax) / 2, rows = 0, done = false;
    while (lat - h / 2 < ne.lat && rows++ < 40000 && !done) {
      let lng = (b0.lngMin + b0.lngMax) / 2, cols = 0;
      while (lng - w / 2 < ne.lng && cols++ < 40000) {
        const cell = geohashEncode(lat, lng, precision);
        if (!seen.has(cell)) {
          seen.add(cell);
          cells.push(cell);
          if (cells.length >= max) { done = true; break; }
        }
        lng += w;
      }
      lat += h;
    }
    return cells;
  }

  /* ---------------- state ---------------- */
  let map = null;
  let fogVisible = false;
  let discovered = new Set(); // geohash strings, precisions 5-7
  let persistTimer = null;
  let capLogged = false;

  /* ---------------- persistence (debounced, private-mode safe) ---------------- */
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      for (const h of arr) {
        if (discovered.size >= MAX_CELLS) break;
        if (typeof h === 'string' && /^[0-9b-hj-np-z]+$/i.test(h) &&
            h.length >= 3 && h.length <= 12) {
          discovered.add(h.toLowerCase());
        }
      }
      console.info('[vcn-discovery] restored ' + discovered.size + ' cells');
    } catch (e) {
      discovered = new Set(); // corrupt data — start empty
    }
  }
  function persistNow() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify([...discovered]));
    } catch (e) { /* private mode / quota — the memory set still works */ }
  }
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 2000);
  }
  function tryAdd(hash) {
    if (discovered.has(hash)) return false;
    if (discovered.size >= MAX_CELLS) {
      if (!capLogged) {
        capLogged = true;
        console.warn('[vcn-discovery] cell cap reached (' + MAX_CELLS +
          ') — new ground not recorded');
      }
      return false;
    }
    discovered.add(hash);
    return true;
  }

  /* ---------------- map layers ---------------- */
  function ensureLayers() {
    if (!map || map.getSource(SOURCE_ID)) return;
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
    // Sit below ambient POI blips when they exist, so discovered
    // places stay readable; harmless when places.js isn't loaded.
    const before = map.getLayer('vcn-poi') ? 'vcn-poi' : undefined;
    map.addLayer({
      id: FILL_LAYER_ID, type: 'fill', source: SOURCE_ID,
      layout: { visibility: 'none' },
      paint: { 'fill-color': FOG_FILL_COLOR, 'fill-opacity': FOG_FILL_OPACITY },
    }, before);
    map.addLayer({
      id: EDGE_LAYER_ID, type: 'line', source: SOURCE_ID,
      minzoom: 13,
      layout: { visibility: 'none' },
      paint: {
        'line-color': FOG_EDGE_COLOR,
        'line-opacity': FOG_EDGE_OPACITY,
        'line-width': 1,
      },
    }, before);
  }

  /* ---------------- fog presentation per theme ----------------
     Discovery DATA is pure geohashes and never changes; only the fog
     paint follows the active theme (VC dark/gold, SA dark/tan,
     GTA V muted grey, Frontier parchment/ink). */
  function fogTheme() {
    const t = (window.VCNThemes && VCNThemes.current()) || null;
    const ui = (t && t.ui) || {};
    return {
      fill: ui.fogFill || FOG_FILL_COLOR,
      fillOpacity: (ui.fogFillOpacity != null) ? ui.fogFillOpacity : FOG_FILL_OPACITY,
      edge: ui.fogEdge || FOG_EDGE_COLOR,
      edgeOpacity: (ui.fogEdgeOpacity != null) ? ui.fogEdgeOpacity : FOG_EDGE_OPACITY,
    };
  }
  function applyFogTheme() {
    if (!map) return;
    const f = fogTheme();
    if (map.getLayer(FILL_LAYER_ID)) {
      map.setPaintProperty(FILL_LAYER_ID, 'fill-color', f.fill);
      map.setPaintProperty(FILL_LAYER_ID, 'fill-opacity', f.fillOpacity);
    }
    if (map.getLayer(EDGE_LAYER_ID)) {
      map.setPaintProperty(EDGE_LAYER_ID, 'line-color', f.edge);
      map.setPaintProperty(EDGE_LAYER_ID, 'line-opacity', f.edgeOpacity);
    }
  }
  /* ---------------- fog rebuild (moveend only, never per-frame) ---------------- */
  function precisionForZoom(z) {
    if (z >= 14) return 7;
    if (z >= 11) return 6;
    if (z >= 7) return 5;
    return 4;
  }

  function refreshFog() {
    if (!map || !fogVisible) return;
    const src = map.getSource(SOURCE_ID);
    if (!src) return;
    const bounds = map.getBounds();
    if (!bounds) return;
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const bbox = { sw: { lat: sw.lat, lng: sw.lng }, ne: { lat: ne.lat, lng: ne.lng } };

    let precision = precisionForZoom(map.getZoom());
    let cells = geohashesInBounds(bbox.sw, bbox.ne, precision, MAX_FOG_CELLS * 4);
    // Too many cells for one frame: drop one precision level and
    // re-enumerate (once). Coarser cells generalise the fog at
    // wide zooms, which is exactly what we want there.
    if (cells.length > MAX_FOG_CELLS && precision > 1) {
      precision -= 1;
      cells = geohashesInBounds(bbox.sw, bbox.ne, precision, MAX_FOG_CELLS * 4);
    }
    if (cells.length > MAX_FOG_CELLS) cells = cells.slice(0, MAX_FOG_CELLS);

    // Below precision 5 the discovered set has no direct hits — match
    // against the coarser prefixes it implies instead, so a discovered
    // neighbourhood doesn't re-fog when zoomed out.
    const coarse = { 4: new Set(), 3: new Set() };
    if (precision <= 4) {
      for (const h of discovered) {
        if (h.length >= 4) coarse[4].add(h.slice(0, 4));
        if (h.length >= 3) coarse[3].add(h.slice(0, 3));
      }
    }
    const isKnown = h =>
      discovered.has(h) || (coarse[h.length] ? coarse[h.length].has(h) : false);

    const features = [];
    for (const h of cells) {
      if (isKnown(h)) continue;
      const b = geohashBounds(h);
      features.push({
        type: 'Feature',
        properties: { geohash: h },
        geometry: {
          type: 'Polygon',
          coordinates: [[
            [b.lngMin, b.latMin], [b.lngMax, b.latMin],
            [b.lngMax, b.latMax], [b.lngMin, b.latMax],
            [b.lngMin, b.latMin],
          ]],
        },
      });
    }
    src.setData({ type: 'FeatureCollection', features });
  }

  /* ---------------- public API ---------------- */
  window.VCNDiscovery = {
    init(m) {
      map = m;
      loadPersisted();
      ensureLayers();
      applyFogTheme();
      map.on('moveend', () => { if (fogVisible) refreshFog(); });
    },

    /* Rebuild map-side fog state after a style change (setStyle drops
       all custom sources/layers). Discovered cells are untouched. */
    rehydrate() {
      if (!map) return;
      ensureLayers();
      applyFogTheme();
      if (fogVisible) { this.setFogVisible(true); }
    },
    /* Re-paint fog for the newly active theme (no style change). */
    applyTheme() { applyFogTheme(); },

    /* Mark the ground around a GPS fix as discovered. The precision-7
       cell plus its 8 neighbours form a ~460 m square — roughly a
       250-400 m discovery radius around the driven path. Coarser
       parents are stored too, so wide-zoom fog stays consistent.
       Pure local bookkeeping: never touches the network. */
    reveal(lnglat) {
      if (!Array.isArray(lnglat) ||
          typeof lnglat[0] !== 'number' || typeof lnglat[1] !== 'number') return;
      const cell = geohashEncode(lnglat[1], lnglat[0], 7);
      let added = false;
      for (const h of [cell, ...geohashNeighbors(cell)]) {
        for (const p of [7, 6, 5]) {
          if (tryAdd(h.slice(0, p))) added = true;
        }
      }
      if (added) schedulePersist();
    },

    setFogVisible(on) {
      fogVisible = !!on;
      if (!map) return;
      const v = fogVisible ? 'visible' : 'none';
      if (map.getLayer(FILL_LAYER_ID)) map.setLayoutProperty(FILL_LAYER_ID, 'visibility', v);
      if (map.getLayer(EDGE_LAYER_ID)) map.setLayoutProperty(EDGE_LAYER_ID, 'visibility', v);
      if (fogVisible) refreshFog();
    },
    isFogVisible() { return fogVisible; },

    refreshFog,

    stats() {
      let n = 0;
      for (const h of discovered) if (h.length === 7) n++;
      const km2 = n * KM2_PER_CELL;
      return { cells: n, km2, pct: (km2 / IRELAND_KM2) * 100 };
    },

    reset() {
      discovered = new Set();
      capLogged = false;
      persistNow();
      refreshFog();
    },
  };
})();
