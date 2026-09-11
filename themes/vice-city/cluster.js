/* WayStation — Vice City cluster console wiring.
   Scope: body.cluster-mode.theme-vice-city ONLY.
   Clock, date, cached weather, speed readout, menu + tab wiring.
   Mirrors themes/gta-v/cluster.js and themes/rdr2/cluster.js. */
(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function inVcCluster() {
    var b = document.body;
    return b && b.classList.contains('cluster-mode') && b.classList.contains('theme-vice-city');
  }

  /* ---------- clock + date ---------- */
  var DAYS = ['SUN','MON','TUE','WED','THU','FRI','SAT'];
  var MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  function paintClock() {
    var tEl = $('vc-time'), dEl = $('vc-date');
    if (!tEl || !dEl) return;
    var d = new Date();
    var h = d.getHours(), m = d.getMinutes();
    tEl.textContent = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    dEl.textContent = DAYS[d.getDay()] + ' ' + String(d.getDate()).padStart(2, '0') + ' ' + MONTHS[d.getMonth()];
  }

  /* ---------- weather (same cache as the dashboard) ---------- */
  function paintWeather() {
    var t = $('vc-temp'), ic = $('vc-wxicon');
    if (!t) return;
    try {
      var c = JSON.parse(localStorage.getItem('vcn.wx.last') || 'null');
      if (!c || typeof c.t !== 'number') return;
      t.textContent = c.t + '°C';
      if (ic && typeof dashWxIcon === 'function') ic.innerHTML = dashWxIcon(c.code);
    } catch (e) {}
  }

  /* ---------- speed (GPS, validated like the shared cluster) ---------- */
  function paintSpeed() {
    var el = $('vc-speed-num');
    if (!el) return;
    var kmh = null;
    try {
      if (typeof lastSpeedKmh === 'number' && isFinite(lastSpeedKmh) && lastSpeedKmh >= 0 && lastSpeedKmh < 360) {
        kmh = lastSpeedKmh;
      } else if (typeof userSpeed === 'number' && isFinite(userSpeed) && userSpeed >= 0 && userSpeed < 100) {
        kmh = userSpeed * 3.6;
      }
    } catch (e) {}
    el.textContent = (kmh === null) ? '--' : String(Math.round(kmh));
  }

  function tick() {
    if (!inVcCluster()) return;
    paintClock(); paintWeather(); paintSpeed();
  }

  document.addEventListener('DOMContentLoaded', function () {
    var menu = $('vc-cluster-menu');
    if (menu) menu.addEventListener('click', function () {
      if (inVcCluster() && typeof openMenu === 'function') openMenu();
    });
    document.querySelectorAll('#vc-tabs button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.dataset.tab;
        if (tab === 'cluster') return;
        if (typeof WayStation !== 'undefined' && WayStation.setAppMode) {
          WayStation.setAppMode(tab === 'map' ? 'map' : 'dashboard');
        }
      });
    });
    if (inVcCluster()) tick();
  });

  setInterval(tick, 1000);
})();
