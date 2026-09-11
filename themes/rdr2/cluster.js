/* WayStation — RDR2 cluster console wiring.
   Scope: body.cluster-mode.theme-rdr2 ONLY.
   Clock, coords, reverse-geocoded place, cached weather, menu + tab wiring.
   Mirrors themes/gta-v/cluster.js; no map tweaks (style.json owns the look). */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function inRdrCluster() {
    var b = document.body;
    return b && b.classList.contains('cluster-mode') && b.classList.contains('theme-rdr2');
  }

  /* ---------- clock (12h, frontier style) ---------- */
  function paintClock() {
    var el = $('rdr-time');
    if (!el) return;
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    var ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12; if (h === 0) h = 12;
    el.textContent = h + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }

  /* ---------- coords ---------- */
  function paintCoords() {
    var el = $('rdr-coords');
    if (!el) return;
    var p = null;
    try { p = (typeof userPos !== 'undefined') ? userPos : null; } catch (e) {}
    if (!p) { el.textContent = 'ACQUIRING SIGNAL'; return; }
    var lat = p[1], lon = p[0];
    el.textContent = Math.abs(lat).toFixed(4) + '°' + (lat >= 0 ? 'N' : 'S') + ' ' +
      Math.abs(lon).toFixed(4) + '°' + (lon >= 0 ? 'E' : 'W');
  }

  /* ---------- place (reverse geocode, town-preference order) ---------- */
  var rdrPlaceTimer = null, rdrPlaceKey = '';
  function queuePlace() {
    clearTimeout(rdrPlaceTimer);
    rdrPlaceTimer = setTimeout(function () { rdrPlaceTimer = null; syncPlace(); }, 1200);
  }
  async function syncPlace() {
    if (!inRdrCluster()) return;
    var p = null;
    try { p = (typeof userPos !== 'undefined') ? userPos : null; } catch (e) {}
    if (!p) return;
    var key = p[1].toFixed(3) + ',' + p[0].toFixed(3);
    if (key === rdrPlaceKey) return;
    rdrPlaceKey = key;
    var nameEl = $('rdr-place'), subEl = $('rdr-county'), bEl = $('rdr-bplace');
    if (!nameEl) return;
    var nearDublin = Math.hypot(p[1] - 53.3498, p[0] - (-6.2603)) < 0.2;
    try {
      var r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' +
        p[1].toFixed(5) + '&lon=' + p[0].toFixed(5) + '&zoom=16');
      if (!r.ok) throw new Error('geo ' + r.status);
      var j = await r.json(), a = (j && j.address) || {};
      var name = (a.suburb || a.neighbourhood || a.quarter || a.town ||
        a.village || a.hamlet || a.city || a.municipality || a.city_district || '')
        .replace(/\s+ED$/i, '');
      var county = (a.county || '').replace(/^county\s+/i, '');
      if (!name) name = county;
      if (name) {
        var up = name.toUpperCase().slice(0, 28);
        nameEl.textContent = up;
        if (bEl) bEl.textContent = up;
        if (subEl && county) subEl.textContent = 'CO. ' + county.toUpperCase();
      } else if (nearDublin) {
        nameEl.textContent = 'DUBLIN';
        if (bEl) bEl.textContent = 'DUBLIN';
        if (subEl) subEl.textContent = 'CO. DUBLIN';
      }
    } catch (e) {
      if (nearDublin) {
        nameEl.textContent = 'DUBLIN';
        if (bEl) bEl.textContent = 'DUBLIN';
        if (subEl) subEl.textContent = 'CO. DUBLIN';
      }
    }
  }

  /* ---------- weather (same cache as the dashboard) ---------- */
  function wxLabel(code) {
    var c = Number(code);
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
    var t = $('rdr-temp'), ic = $('rdr-wxicon'), cd = $('rdr-cond');
    if (!t) return;
    try {
      var c = JSON.parse(localStorage.getItem('vcn.wx.last') || 'null');
      if (!c || typeof c.t !== 'number') return;
      t.textContent = c.t + '°C';
      if (cd) cd.textContent = wxLabel(c.code);
      if (ic && typeof dashWxIcon === 'function') ic.innerHTML = dashWxIcon(c.code);
    } catch (e) {}
  }

  function tick() {
    if (!inRdrCluster()) return;
    paintClock(); paintCoords(); paintWeather();
    queuePlace();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var b = $('rdr-cluster-menu');
    if (b) b.addEventListener('click', function () {
      if (inRdrCluster() && typeof openMenu === 'function') openMenu();
    });
    document.querySelectorAll('#rdr-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.dataset.tab;
        if (tab === 'cluster') return;
        if (tab === 'dashboard' && typeof WayStation !== 'undefined' && WayStation.setAppMode) {
          WayStation.setAppMode('dashboard');
        }
      });
    });
    var exit = $('rdr-exit');
    if (exit) exit.addEventListener('click', function () {
      if (typeof WayStation !== 'undefined' && WayStation.setAppMode) {
        WayStation.setAppMode('dashboard');
      }
    });
    if (inRdrCluster()) tick();
  });

  setInterval(tick, 1000);
})();
