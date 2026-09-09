/* ============================================================
   Vice City Navigator — Discovery / Fog of War
   ------------------------------------------------------------
   Remembers where the player has physically driven and renders
   a GTA-style fog-of-war overlay for Discovery Mode. Completely
   theme-independent and network-free: discovery DATA is just
   geohash cells, so switching map themes later never loses
   progress.

   Pipeline: GPS movement -> reveal(lnglat) marks the precision-7
   cell plus its 8 neighbours (roughly a 250-400 m discovery
   radius) as discovered, along with coarser parents -> persisted
   to localStorage (debounced) -> renderFog() repaints the fog
   canvas.

   Render: the fog is a MapLibre CanvasSource — an offscreen
   canvas pinned to lnglat corners and composited by the GPU as a
   raster layer. Because the fog lives in WORLD space, panning and
   zooming move it pixel-locked with the map: revealed ground can
   never slide, drift, or lag behind the way a screen-space DOM
   overlay did (that overlay only repainted on moveend, so the
   exposed area visibly moved while panning).

   The canvas covers the viewport expanded by REGION_PAD on every
   side, so ordinary pans need zero repaints — the GPU just moves
   the texture. A repaint only happens when (a) new ground is
   revealed, (b) the viewport nears the canvas edge, (c) the zoom
   precision band changes, or (d) the theme changes.

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
  const FOG_SOURCE_ID = 'vcn-fog-src';
  const FOG_LAYER_ID = 'vcn-fog-layer';
  const FOG_FILL_COLOR = '#0b0b18';
  const FOG_FILL_OPACITY = 0.82;
  const MAX_CELLS = 100000;   // cap on persisted discovered cells
  const MAX_STAMPS = 3000;    // cap on reveal stamps per repaint
  const RENDER_SCALE = 0.5;   // fog is soft — half-res texture
  const REGION_PAD = 2.5;     // canvas extends 250% of the viewport past each edge
                                // (6x viewport: a fast 2-level zoom-out still stays inside the
                                // painted region, so the fog box never shows mid-gesture)
  const REGION_KEEP = 0.2;    // rebuild the region once the viewport strays past this margin
  const MAX_TEX = 2048;       // texture size cap (px)
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

  /* ---------------- state ---------------- */
  let map = null;
  let fogVisible = false;
  let discovered = new Set(); // geohash strings, precisions 5-7
  let persistTimer = null;
  let capLogged = false;
  let fogCanvas = null;      // offscreen canvas owned by the CanvasSource
  let fogCtx = null;
  let fogRegion = null;      // {west,east,north,south,precision} lnglat rect the canvas covers
  let fogDirty = false;      // data/theme changed since last paint
  let refreshQueued = false;
  const boundsCache = new Map(); // geohash -> bounds (pure function memo)

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

  /* ---------------- fog presentation per theme ----------------
     Discovery DATA is pure geohashes and never changes; only the fog
     paint follows the active theme (VC dark/gold, SA dark/tan,
     GTA V muted grey, Frontier parchment/ink). Read fresh on every
     repaint so theme switches apply instantly. */
  function fogTheme() {
    const t = (window.VCNThemes && VCNThemes.current()) || null;
    const ui = (t && t.ui) || {};
    const base = (ui.fogFillOpacity != null) ? ui.fogFillOpacity : FOG_FILL_OPACITY;
    return {
      fill: ui.fogFill || FOG_FILL_COLOR,
      // Dense but never a blackout: the map whispers through the fog.
      fillOpacity: Math.max(0.87, Math.min(base, 0.9)),
    };
  }

  function hexToRgba(hex, alpha) {
    const h = String(hex).replace('#', '');
    const v = h.length === 3
      ? h.split('').map(c => c + c).join('')
      : h.padEnd(6, '0').slice(0, 6);
    const n = parseInt(v, 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' +
      (n & 255) + ',' + alpha + ')';
  }

  /* One soft reveal stamp: a wide partial-erase halo for the GTA
     feathered edge, then a tighter full-erase core. Overlapping
     stamps along the driven path merge into a continuous trail. */
  function softStamp(ctx, x, y, r) {
    let g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.55, 'rgba(0,0,0,0.32)');
    g.addColorStop(0.8, 'rgba(0,0,0,0.12)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2832);
    ctx.fill();

    const rc = r * 0.55;
    g = ctx.createRadialGradient(x, y, 0, x, y, rc);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.7, 'rgba(0,0,0,0.9)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rc, 0, 6.2832);
    ctx.fill();
  }

  /* Deterministic pseudo-random in [0,1) from a geohash + salt.
     Jitters each stamp's centre/size so the underlying square cell
     grid never reads as rectangles — and because it's seeded by the
     cell itself, every repaint is identical (no shimmer). */
  function hash01(str, salt) {
    let h = 2166136261 ^ salt;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }

  /* ---------------- geo-anchored fog render ---------------- */
  function precisionForZoom(z) {
    if (z >= 14) return 7;
    if (z >= 11) return 6;
    if (z >= 7) return 5;
    return 4;
  }

  function cachedBounds(h) {
    let b = boundsCache.get(h);
    if (!b) {
      try { b = geohashBounds(h); } catch (e) { return null; }
      if (boundsCache.size > 40000) boundsCache.clear();
      boundsCache.set(h, b);
    }
    return b;
  }

  /* Unwrap a longitude into the region's continuous frame so the
     antimeridian never breaks the linear canvas mapping. */
  function unwrapLng(lng, west) {
    while (lng < west - 180) lng += 360;
    while (lng > west + 180) lng -= 360;
    return lng;
  }

  /* The lnglat rect the fog canvas should cover: the current
     viewport expanded by REGION_PAD on every side.
     Web-Mercator only exists to +/-85.051129 deg: past that
     fromLngLat() yields +/-Infinity, which poisons the canvas
     source's tile math and the fog layer renders as opaque black.
     The map can't show beyond this latitude anyway, so clamp here. */
  const MERCATOR_MAX_LAT = 85.051129;
  function computeRegion() {
    const b = map.getBounds();
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    let west = sw.lng, east = ne.lng;
    if (east < west) east += 360; // antimeridian
    const dLng = Math.max(east - west, 1e-9);
    const dLat = Math.max(ne.lat - sw.lat, 1e-9);
    return {
      west: west - dLng * REGION_PAD,
      east: east + dLng * REGION_PAD,
      south: Math.max(sw.lat - dLat * REGION_PAD, -MERCATOR_MAX_LAT),
      north: Math.min(ne.lat + dLat * REGION_PAD, MERCATOR_MAX_LAT),
      precision: precisionForZoom(map.getZoom()),
    };
  }

  /* True while the viewport (plus a REGION_KEEP margin) still sits
     comfortably inside the painted region — i.e. the GPU can keep
     moving the texture and no repaint is needed. */
  function regionCovers(region) {
    const b = map.getBounds();
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    let west = sw.lng, east = ne.lng;
    if (east < west) east += 360;
    const dLng = Math.max(east - west, 1e-9);
    const dLat = Math.max(ne.lat - sw.lat, 1e-9);
    const vw = west - dLng * REGION_KEEP, ve = east + dLng * REGION_KEEP;
    const vs = sw.lat - dLat * REGION_KEEP, vn = ne.lat + dLat * REGION_KEEP;
    const rw = region.west, re = region.east;
    // Compare in one continuous frame.
    const uw = unwrapLng(vw, rw), uve = uw + (ve - vw);
    return rw <= uw && re >= uve && region.south <= vs && region.north >= vn;
  }

  function ensureOffscreenCanvas() {
    if (fogCanvas) return;
    fogCanvas = document.createElement('canvas');
    fogCtx = fogCanvas.getContext('2d');
  }

  /* Size the canvas to the viewport (expanded region at RENDER_SCALE).
     Resizing resets the canvas, so the caller always repaints after. */
  function sizeCanvas() {
    const c = map.getContainer();
    const w = Math.min(MAX_TEX, Math.max(2,
      Math.round(c.clientWidth * (1 + 2 * REGION_PAD) * RENDER_SCALE)));
    const h = Math.min(MAX_TEX, Math.max(2,
      Math.round(c.clientHeight * (1 + 2 * REGION_PAD) * RENDER_SCALE)));
    if (fogCanvas.width !== w || fogCanvas.height !== h) {
      fogCanvas.width = w;
      fogCanvas.height = h;
    }
  }

  /* Discovered cells at the region's render precision whose bounds
     touch the region. Coarser precisions are derived from the stored
     finer cells via prefix, so old discoveries still render zoomed
     out. Returns {b, h} pairs — the hash seeds the stamp jitter. */
  function discoveredInRegion(region) {
    const out = [];
    const p = region.precision;
    const inR = b => {
      const lngMin = unwrapLng(b.lngMin, region.west);
      const lngMax = lngMin + (b.lngMax - b.lngMin);
      return !(lngMax < region.west || lngMin > region.east ||
               b.latMax < region.south || b.latMin > region.north);
    };
    if (p >= 5) {
      for (const h of discovered) {
        if (h.length !== p) continue;
        const b = cachedBounds(h);
        if (!b || !inR(b)) continue;
        out.push({ b, h });
        if (out.length >= MAX_STAMPS) break;
      }
    } else {
      const prefixes = new Set();
      for (const h of discovered) {
        if (h.length >= p) prefixes.add(h.slice(0, p));
      }
      for (const pre of prefixes) {
        const b = cachedBounds(pre);
        if (!b || !inR(b)) continue;
        out.push({ b, h: pre });
        if (out.length >= MAX_STAMPS) break;
      }
    }
    return out;
  }

  function drawFog(region) {
    const cw = fogCanvas.width, ch = fogCanvas.height;
    const ctx = fogCtx;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, cw, ch);

    const f = fogTheme();
    ctx.fillStyle = hexToRgba(f.fill, f.fillOpacity);
    ctx.fillRect(0, 0, cw, ch);

    const cells = discoveredInRegion(region);
    if (cells.length === 0) return;

    // Canvas px per metre at the region's mid latitude.
    const midLat = (region.north + region.south) / 2;
    const mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
    const pxPerM = cw / ((region.east - region.west) * mPerDegLng);
    const lngSpan = region.east - region.west;
    const latSpan = region.north - region.south;

    ctx.globalCompositeOperation = 'destination-out';
    for (const { b, h } of cells) {
      const clng = unwrapLng((b.lngMin + b.lngMax) / 2, region.west);
      const clat = (b.latMin + b.latMax) / 2;
      const x = (clng - region.west) / lngSpan * cw;
      const y = (region.north - clat) / latSpan * ch;
      if (x < -300 || y < -300 || x > cw + 300 || y > ch + 300) continue;
      const wM = (b.lngMax - b.lngMin) * mPerDegLng;
      const hM = (b.latMax - b.latMin) * 110540;
      // Half-diagonal of the cell; ×1.9 so neighbouring stamps melt
      // into one continuous organic blob, plus per-cell jitter so the
      // square grid never shows through.
      const r = Math.hypot(wM, hM) / 2 * pxPerM * 1.9 * (0.85 + hash01(h, 3) * 0.35);
      if (r < 1) continue;
      const jx = (hash01(h, 1) - 0.5) * 0.6 * r;
      const jy = (hash01(h, 2) - 0.5) * 0.6 * r;
      softStamp(ctx, x + jx, y + jy, r);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function fogCoords() {
    const r = fogRegion;
    // [top-left, top-right, bottom-right, bottom-left]
    return [
      [r.west, r.north], [r.east, r.north],
      [r.east, r.south], [r.west, r.south],
    ];
  }

  /* Force the CanvasSource to re-upload the mutated canvas exactly
     once. MapLibre only re-uploads on dimension change or while
     playing, so: play() flags _playing and triggers a repaint,
     pause() runs one prepare() (the upload) then stops. */
  function pushTexture() {
    if (!map) return;
    let src = null;
    try { src = map.getSource(FOG_SOURCE_ID); } catch (e) { /* no style */ }
    if (!src) return;
    try {
      if (typeof src.play === 'function' && typeof src.pause === 'function') {
        src.play();
        src.pause();
      }
    } catch (e) { /* source mid-load — the idle hook below covers it */ }
    try { map.triggerRepaint(); } catch (e) {}
  }

  function ensureFogLayer() {
    if (!map || !map.isStyleLoaded() || !fogRegion) return false;
    let src = null;
    try { src = map.getSource(FOG_SOURCE_ID); } catch (e) { return false; }
    const coords = fogCoords();
    if (!src) {
      try {
        map.addSource(FOG_SOURCE_ID, {
          type: 'canvas', canvas: fogCanvas, coordinates: coords, animate: false,
        });
      } catch (e) { return false; }
      try {
        // Below the route line so a route (if ever shown with fog)
        // draws over the fog, never under it. raster-fade-duration 0
        // so the fog never visibly fades in — that would read as lag.
        const layerSpec = {
          id: FOG_LAYER_ID, type: 'raster', source: FOG_SOURCE_ID,
          paint: { 'raster-opacity': 1, 'raster-fade-duration': 0 },
        };
        if (map.getLayer('vcn-route-glow')) map.addLayer(layerSpec, 'vcn-route-glow');
        else map.addLayer(layerSpec);
      } catch (e) {
        try { map.removeSource(FOG_SOURCE_ID); } catch (e2) {}
        return false;
      }
      // Cover the window between addSource and the source finishing
      // load: push once the map goes idle.
      try { map.once('idle', pushTexture); } catch (e) {}
    } else {
      // Same canvas, new geo anchor — just move the quad.
      try { src.setCoordinates(coords); } catch (e) {}
    }
    return true;
  }

  /* The single repaint entry point. Skips entirely when the region
     still covers the viewport and nothing changed — during pans the
     GPU moves the texture, so there is nothing to repaint. */
  function renderFog() {
    if (!map || !fogVisible) return;
    if (!map.isStyleLoaded()) {
      try {
        map.once('styledata', () => { if (fogVisible) queueRenderFog(); });
      } catch (e) {}
      return;
    }
    ensureOffscreenCanvas();
    const region = computeRegion();
    const needRegion = !fogRegion ||
      fogRegion.precision !== region.precision ||
      !regionCovers(fogRegion);
    if (!needRegion && !fogDirty) return;
    fogDirty = false;
    if (needRegion) {
      fogRegion = region;
      sizeCanvas();
    }
    drawFog(fogRegion);
    if (ensureFogLayer()) pushTexture();
  }

  /* Coalesce rapid repaint requests (GPS reveals, resizes) into one
     per animation frame — never a repaint storm. */
  function queueRenderFog() {
    if (refreshQueued || !fogVisible) return;
    refreshQueued = true;
    const run = () => {
      refreshQueued = false;
      try { renderFog(); } catch (e) { /* keep the map alive */ }
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      setTimeout(run, 16);
    }
  }

  /* ---------------- public API ---------------- */
  window.VCNDiscovery = {
    init(m) {
      map = m;
      loadPersisted();
      // No per-move repaint: the geo-anchored texture tracks pans
      // natively. moveend/zoomend only rebuild the region when the
      // viewport outgrows the painted canvas.
      map.on('moveend', queueRenderFog);
      map.on('zoomend', queueRenderFog);
      if (typeof window !== 'undefined') {
        window.addEventListener('resize', queueRenderFog);
      }
    },

    /* Rebuild map-side fog state after a style change. setStyle()
       destroys style sources/layers, so the fog source+layer are
       re-added here. Discovered cells are untouched. */
    rehydrate() {
      if (!map) return;
      fogRegion = null; // force a full rebuild against the new style
      if (fogVisible) {
        fogDirty = true;
        queueRenderFog();
      }
    },
    /* Re-paint fog for the newly active theme (no style change). The
       theme colour is read fresh at paint time. */
    applyTheme() {
      fogDirty = true;
      queueRenderFog();
    },

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
      if (added) {
        schedulePersist();
        fogDirty = true;
        queueRenderFog(); // live reveal while driving
      }
    },

    setFogVisible(on) {
      fogVisible = !!on;
      if (!map) return;
      if (!fogVisible) {
        try { if (map.getLayer(FOG_LAYER_ID)) map.removeLayer(FOG_LAYER_ID); } catch (e) {}
        try { if (map.getSource(FOG_SOURCE_ID)) map.removeSource(FOG_SOURCE_ID); } catch (e) {}
        return;
      }
      fogDirty = true;
      renderFog();
    },
    isFogVisible() { return fogVisible; },

    refreshFog: queueRenderFog,

    stats() {
      let n = 0;
      for (const h of discovered) if (h.length === 7) n++;
      const km2 = n * KM2_PER_CELL;
      return { cells: n, km2, pct: (km2 / IRELAND_KM2) * 100 };
    },

    reset() {
      discovered = new Set();
      boundsCache.clear();
      capLogged = false;
      persistNow();
      fogDirty = true;
      renderFog();
    },
  };
})();
