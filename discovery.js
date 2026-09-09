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
   to localStorage (debounced) -> refreshFog() repaints the fog
   canvas.

   Render: a full-viewport canvas overlay sits above the map
   tiles. It is filled with the theme's fog colour, then soft
   radial "reveals" are punched out (destination-out) at every
   discovered cell in view. Overlapping soft stamps along the
   driven path merge into organic, GTA-like revealed trails —
   no hard grid edges, no blocky cells.

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
  const CANVAS_ID = 'vcn-fog-canvas';
  const FOG_FILL_COLOR = '#0b0b18';
  const FOG_FILL_OPACITY = 0.82;
  const MAX_CELLS = 100000;   // cap on persisted discovered cells
  const MAX_STAMPS = 3000;    // cap on reveal stamps per repaint
  const RENDER_SCALE = 0.5;   // fog is soft — half-res canvas, CSS upscaled
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
  let fogCanvas = null;
  let fogCtx = null;
  let refreshQueued = false;

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

  /* ---------------- fog canvas overlay ----------------
     A DOM canvas above the map tiles (below markers/controls).
     Filled with fog colour; discovered ground is revealed by
     punching soft radial holes. Because it is DOM — not a map
     style layer — it survives setStyle() untouched. */
  function ensureFogCanvas() {
    if (fogCanvas || !map) return;
    const container = map.getContainer();
    if (!container) return;
    fogCanvas = document.createElement('canvas');
    fogCanvas.id = CANVAS_ID;
    fogCanvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'pointer-events:none;z-index:1;display:none;';
    // Sit directly above the tile canvas, below markers & controls.
    const cc = container.querySelector('.maplibregl-canvas-container');
    if (cc && cc.nextSibling) container.insertBefore(fogCanvas, cc.nextSibling);
    else container.appendChild(fogCanvas);
    fogCtx = fogCanvas.getContext('2d');
  }

  /* ---------------- fog presentation per theme ----------------
     Discovery DATA is pure geohashes and never changes; only the fog
     paint follows the active theme (VC dark/gold, SA dark/tan,
     GTA V muted grey, Frontier parchment/ink). Read fresh on every
     repaint so theme switches apply instantly. */
  function fogTheme() {
    const t = (window.VCNThemes && VCNThemes.current()) || null;
    const ui = (t && t.ui) || {};
    return {
      fill: ui.fogFill || FOG_FILL_COLOR,
      fillOpacity: (ui.fogFillOpacity != null) ? ui.fogFillOpacity : FOG_FILL_OPACITY,
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
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.65, 'rgba(0,0,0,0.28)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 6.2832);
    ctx.fill();

    const rc = r * 0.6;
    g = ctx.createRadialGradient(x, y, 0, x, y, rc);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.75, 'rgba(0,0,0,0.92)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, rc, 0, 6.2832);
    ctx.fill();
  }

  /* ---------------- fog repaint ---------------- */
  function precisionForZoom(z) {
    if (z >= 14) return 7;
    if (z >= 11) return 6;
    if (z >= 7) return 5;
    return 4;
  }

  /* Discovered cells at the render precision whose bounds touch the
     viewport. Coarser precisions are derived from the stored finer
     cells via prefix, so old discoveries still render zoomed out. */
  function discoveredInViewport(precision, bounds) {
    const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
    const out = [];
    if (precision >= 5) {
      for (const h of discovered) {
        if (h.length !== precision) continue;
        let b;
        try { b = geohashBounds(h); } catch (e) { continue; }
        if (b.lngMax < sw.lng || b.lngMin > ne.lng ||
            b.latMax < sw.lat || b.latMin > ne.lat) continue;
        out.push(b);
        if (out.length >= MAX_STAMPS) break;
      }
    } else {
      const prefixes = new Set();
      for (const h of discovered) {
        if (h.length >= precision) prefixes.add(h.slice(0, precision));
      }
      for (const p of prefixes) {
        let b;
        try { b = geohashBounds(p); } catch (e) { continue; }
        if (b.lngMax < sw.lng || b.lngMin > ne.lng ||
            b.latMax < sw.lat || b.latMin > ne.lat) continue;
        out.push(b);
        if (out.length >= MAX_STAMPS) break;
      }
    }
    return out;
  }

  function refreshFog() {
    if (!map || !fogVisible) return;
    ensureFogCanvas();
    if (!fogCtx) return;
    const container = map.getContainer();
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    const bounds = map.getBounds();
    if (!bounds) return;

    fogCanvas.width = Math.max(1, Math.round(w * RENDER_SCALE));
    fogCanvas.height = Math.max(1, Math.round(h * RENDER_SCALE));

    const ctx = fogCtx;
    ctx.setTransform(RENDER_SCALE, 0, 0, RENDER_SCALE, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, w, h);

    const f = fogTheme();
    ctx.fillStyle = hexToRgba(f.fill, f.fillOpacity);
    ctx.fillRect(0, 0, w, h);

    const precision = precisionForZoom(map.getZoom());
    const cells = discoveredInViewport(precision, bounds);
    if (cells.length === 0) return;

    ctx.globalCompositeOperation = 'destination-out';
    for (const b of cells) {
      const cx = (b.lngMin + b.lngMax) / 2;
      const cy = (b.latMin + b.latMax) / 2;
      let p;
      try { p = map.project([cx, cy]); } catch (e) { continue; }
      if (p.x < -200 || p.y < -200 || p.x > w + 200 || p.y > h + 200) continue;
      let c;
      try { c = map.project([b.lngMax, b.latMax]); } catch (e) { continue; }
      // Half-diagonal of the cell on screen; ×1.35 so neighbouring
      // stamps overlap into one continuous revealed trail.
      const r = Math.hypot(c.x - p.x, c.y - p.y) * 1.35;
      if (r < 1) continue;
      softStamp(ctx, p.x, p.y, r);
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* Coalesce rapid repaint requests (GPS reveals, resizes) into one
     per animation frame — never a repaint storm. */
  function queueRefreshFog() {
    if (refreshQueued || !fogVisible) return;
    refreshQueued = true;
    const run = () => {
      refreshQueued = false;
      try { refreshFog(); } catch (e) { /* keep the map alive */ }
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
      ensureFogCanvas();
      map.on('moveend', queueRefreshFog);
      map.on('zoomend', queueRefreshFog);
      if (typeof window !== 'undefined') {
        window.addEventListener('resize', queueRefreshFog);
      }
    },

    /* Rebuild map-side fog state after a style change. The canvas is
       DOM, not a style layer, so it survives setStyle() — this just
       repaints in case the container was rebuilt. Discovered cells
       are untouched. */
    rehydrate() {
      if (!map) return;
      ensureFogCanvas();
      if (fogVisible) queueRefreshFog();
    },
    /* Re-paint fog for the newly active theme (no style change). The
       theme colour is read fresh at paint time. */
    applyTheme() { queueRefreshFog(); },

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
        queueRefreshFog(); // live reveal while driving
      }
    },

    setFogVisible(on) {
      fogVisible = !!on;
      ensureFogCanvas();
      if (fogCanvas) {
        fogCanvas.style.display = fogVisible ? 'block' : 'none';
      }
      if (fogVisible) refreshFog();
    },
    isFogVisible() { return fogVisible; },

    refreshFog: queueRefreshFog,

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
