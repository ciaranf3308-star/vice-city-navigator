/* ============================================================
   WayStation — GTA V CLUSTER live wiring.
   Scope: body.cluster-mode.theme-gta-v only. Reuses the shared
   live state (no parallel watchers): userPos, driveForceState /
   driveForceBand, WX cache, navigator.getBattery.
   Also dims the GTA V map labels while the cluster is up so they
   read like the console concept (tracked-out, muted), restoring
   the authored style on exit.
   ============================================================ */
'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const inGvCluster = () => {
    const b = document.body.classList;
    return b.contains('cluster-mode') && b.contains('theme-gta-v');
  };

  /* ---------- clock ---------- */
  function paintClock() {
    const el = $('gv-time');
    if (!el) return;
    try {
      el.textContent = new Date().toLocaleTimeString('en-US',
        { hour: 'numeric', minute: '2-digit', hour12: true }).toUpperCase();
    } catch (e) {}
  }

  /* ---------- live GPS coords ---------- */
  function paintCoords() {
    const el = $('gv-coords');
    if (!el) return;
    try {
      const p = (typeof userPos !== 'undefined') ? userPos : null;
      if (!p) { el.textContent = 'ACQUIRING SIGNAL'; return; }
      const lat = p[1], lng = p[0];
      el.textContent = Math.abs(lat).toFixed(4) + '° ' + (lat >= 0 ? 'N' : 'S') + '  ' +
        Math.abs(lng).toFixed(4) + '° ' + (lng >= 0 ? 'E' : 'W');
    } catch (e) {}
  }

  /* ---------- weather (same cache as the dashboard) ---------- */
  function wxLabel(code) {
    const c = Number(code);
    if (c === 0) return 'CLEAR SKIES';
    if (c === 1) return 'MOSTLY CLEAR';
    if (c === 2) return 'PARTLY CLOUDY';
    if (c === 3) return 'OVERCAST';
    if (c === 45 || c === 48) return 'FOG';
    if ((c >= 51 && c <= 57) || (c >= 80 && c <= 82)) return 'DRIZZLE';
    if (c >= 61 && c <= 67) return 'RAIN';
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) return 'SNOW';
    if (c >= 95) return 'STORM';
    return '—';
  }
  function paintWeather() {
    const t = $('gv-temp'), ic = $('gv-wxicon'), cd = $('gv-cond');
    if (!t) return;
    try {
      const c = JSON.parse(localStorage.getItem('vcn.wx.last') || 'null');
      if (!c || typeof c.t !== 'number') return;
      t.textContent = c.t + '°C';
      if (cd) cd.textContent = wxLabel(c.code);
      if (ic && typeof dashWxIcon === 'function') ic.innerHTML = dashWxIcon(c.code);
    } catch (e) {}
  }

  /* ---------- REGEN / COAST / POWER (GPS-derived, like the VC gauge) ---------- */
  function paintPower() {
    const bar = $('gv-powerbar');
    if (!bar) return;
    let state = 'coast', band = 0;
    try {
      state = (typeof driveForceState !== 'undefined') ? driveForceState : 'coast';
      band = (typeof driveForceBand !== 'undefined') ? driveForceBand : 0;
    } catch (e) {}
    bar.dataset.state = state;
    const frac = Math.min(1, band / 3) * 30;
    const r = bar.querySelector('.gv-pb-regen');
    const p = bar.querySelector('.gv-pb-power');
    if (r) r.style.width = (state === 'regen' ? frac : 0) + '%';
    if (p) p.style.width = (state === 'power' ? frac : 0) + '%';
  }

  /* ---------- phone battery (real; no invented car SOC/range) ---------- */
  let batt = null;
  function paintBattery() {
    const el = $('gv-battpct');
    if (!el) return;
    if (batt) {
      el.textContent = Math.round(batt.level * 100) + '%';
      return;
    }
    try {
      if (navigator.getBattery) navigator.getBattery().then(b => {
        batt = b;
        b.addEventListener('levelchange', paintBattery);
        paintBattery();
      }).catch(() => {});
    } catch (e) {}
  }

  function tick() {
    if (!inGvCluster()) return;
    paintClock(); paintCoords(); paintWeather(); paintPower(); paintBattery();
    applyMapTweaks();
  }

  /* ---------- cluster map label treatment ---------- */
  const TWEAKS = [
    { layer: 'v-label-place', paint: { 'text-color': '#a9b2b2' }, layout: { 'text-letter-spacing': 0.18 } },
    { layer: 'v-label-road-major', paint: { 'text-color': '#8b9494' } },
    { layer: 'v-label-road-minor', paint: { 'text-color': '#7d8686' } },
  ];
  let tweaksOn = false;
  const saved = {};
  function mapInstance() {
    try { return (typeof map !== 'undefined' && map && map.getStyle) ? map : null; }
    catch (e) { return null; }
  }
  function applyMapTweaks() {
    if (tweaksOn) return;
    const m = mapInstance();
    if (!m || !m.getLayer) return;
    try {
      for (const t of TWEAKS) {
        if (!m.getLayer(t.layer)) continue;
        saved[t.layer] = saved[t.layer] || {};
        for (const k of Object.keys(t.paint || {})) {
          if (!(k in saved[t.layer])) saved[t.layer][k] = m.getPaintProperty(t.layer, k);
          m.setPaintProperty(t.layer, k, t.paint[k]);
        }
        for (const k of Object.keys(t.layout || {})) {
          const sk = 'layout:' + k;
          if (!(sk in saved[t.layer])) saved[t.layer][sk] = m.getLayoutProperty(t.layer, k);
          m.setLayoutProperty(t.layer, k, t.layout[k]);
        }
      }
      tweaksOn = true;
    } catch (e) {}
  }
  function restoreMapTweaks() {
    if (!tweaksOn) return;
    const m = mapInstance();
    try {
      if (m && m.getLayer) {
        for (const t of TWEAKS) {
          if (!m.getLayer(t.layer) || !saved[t.layer]) continue;
          for (const k of Object.keys(saved[t.layer])) {
            const v = saved[t.layer][k];
            if (v === undefined) continue;
            if (k.indexOf('layout:') === 0) m.setLayoutProperty(t.layer, k.slice(7), v);
            else m.setPaintProperty(t.layer, k, v);
          }
        }
      }
    } catch (e) {}
    tweaksOn = false;
  }
  /* A theme switch restyles the map; re-apply on the fresh style. */
  function hookStyle() {
    const m = mapInstance();
    if (m && !m._gvClusterHooked) {
      m._gvClusterHooked = true;
      m.on('styledata', () => { tweaksOn = false; if (inGvCluster()) applyMapTweaks(); });
    }
  }

  /* ---------- body-class watcher: enter/exit ---------- */
  let wasIn = false;
  new MutationObserver(() => {
    const isIn = inGvCluster();
    if (isIn && !wasIn) { hookStyle(); tick(); }
    if (!isIn && wasIn) restoreMapTweaks();
    wasIn = isIn;
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  /* ---------- logo tap opens the menu (exit lives there) ---------- */
  document.addEventListener('DOMContentLoaded', () => {
    const b = $('gv-cluster-menu');
    if (b) b.addEventListener('click', () => {
      if (inGvCluster() && typeof openMenu === 'function') openMenu();
    });
    if (inGvCluster()) { hookStyle(); tick(); }
    wasIn = inGvCluster();
  });

  setInterval(tick, 1000);
})();
