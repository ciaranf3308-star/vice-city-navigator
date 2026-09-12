/* VCNLocation — one location pipeline for every host.
 *
 * Native-first: inside the WayStation Android app, window.WayStationLocation
 * (NativeLocationBridge, LocationManager under the hood) streams fixes
 * straight to the page via window.__wsLocPush — no WebView geolocation
 * prompt, no Chromium middleman, no Permissions API lies. In a plain
 * browser (PWA in Chrome) the same API falls back to navigator.geolocation.
 *
 * One shared watch: startWatch replaces any previous watch, stopWatch ends
 * it. Positions arrive shaped like GeolocationPosition so existing
 * downstream code (heading, discovery, POIs) works untouched.
 *
 * Debug: open the app with ?loc-debug in the URL for a live readout of
 * every layer (mode, native permission/provider state, last fix, errors).
 */
(function () {
  'use strict';

  var S = {
    mode: 'unknown', // 'native' | 'browser' | 'none'
    state: 'idle',   // idle|starting|waiting-permission|waiting-fix|active|denied|no-provider|error
    watching: false,
    lastFix: null,   // {lat,lng,acc,ts}
    fixCount: 0,
    lastError: null, // {code,message,ts}
    browserWatchId: null,
  };
  var watchListeners = { pos: null, err: null };
  var oneShots = []; // {resolve,reject,timer}

  function detectMode() {
    if (S.mode !== 'unknown') return S.mode;
    try {
      if (window.WayStationLocation &&
          typeof window.WayStationLocation.getState === 'function') {
        S.mode = 'native';
      } else if (typeof navigator !== 'undefined' &&
                 navigator.geolocation &&
                 typeof navigator.geolocation.watchPosition === 'function') {
        S.mode = 'browser';
      } else {
        S.mode = 'none';
      }
    } catch (e) { S.mode = 'none'; }
    return S.mode;
  }

  function asPosition(f) {
    return {
      coords: {
        latitude: f.lat, longitude: f.lng,
        accuracy: f.acc, altitude: null,
        altitudeAccuracy: null, heading: null,
        speed: (typeof f.speed === 'number' && f.speed >= 0) ? f.speed : null,
      },
      timestamp: f.ts,
    };
  }

  function flushOneShots(ok, val) {
    var pending = oneShots; oneShots = [];
    for (var i = 0; i < pending.length; i++) {
      try { clearTimeout(pending[i].timer); } catch (e) {}
      try { (ok ? pending[i].resolve : pending[i].reject)(val); } catch (e) {}
    }
  }

  function onFix(lat, lng, acc, ts, speed) {
    var f = { lat: lat, lng: lng, acc: acc, ts: ts || Date.now(), speed: speed };
    S.lastFix = f; S.fixCount++; S.state = 'active';
    var pos = asPosition(f);
    try { if (watchListeners.pos) watchListeners.pos(pos); } catch (e) {}
    flushOneShots(true, pos);
  }

  function onError(code, message) {
    S.lastError = { code: code, message: String(message || ''), ts: Date.now() };
    S.state = code === 1 ? 'denied' : (code === 2 ? 'no-provider' : 'error');
    try { if (watchListeners.err) watchListeners.err({ code: code, message: String(message || '') }); } catch (e) {}
    flushOneShots(false, { code: code, message: String(message || '') });
  }

  // Installed before any watch starts; the native bridge pushes here.
  window.__wsLocPush = function (lat, lng, acc, ts, speed) {
    try { onFix(Number(lat), Number(lng), Number(acc), Number(ts), Number(speed)); }
    catch (e) { /* malformed push: ignore */ }
  };
  window.__wsLocError = function (code, msg) {
    try { onError(Number(code) || 2, msg); }
    catch (e) { /* ignore */ }
  };

  function nativeState() {
    try {
      var raw = window.WayStationLocation.getState();
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function startWatch(onPos, onErr) {
    detectMode();
    watchListeners.pos = onPos || null;
    watchListeners.err = onErr || null;
    if (S.mode === 'native') {
      S.state = 'starting';
      var res = 'error';
      try { res = String(window.WayStationLocation.startWatch()); }
      catch (e) { res = 'error'; }
      if (res === 'ok') { S.watching = true; S.state = 'waiting-fix'; }
      else if (res === 'permission-needed') { S.watching = true; S.state = 'waiting-permission'; }
      else if (res === 'no-provider') {
        S.watching = false;
        onError(2, 'no location provider enabled on device');
      } else { S.watching = false; onError(2, 'native watch failed: ' + res); }
      return;
    }
    if (S.mode === 'browser') {
      try {
        if (S.browserWatchId !== null) {
          try { navigator.geolocation.clearWatch(S.browserWatchId); } catch (e) {}
        }
        S.watching = true; S.state = 'waiting-fix';
        S.browserWatchId = navigator.geolocation.watchPosition(
          function (p) {
            try {
              onFix(p.coords.latitude, p.coords.longitude,
                    p.coords.accuracy == null ? -1 : p.coords.accuracy,
                    p.timestamp,
                    p.coords.speed == null ? -1 : p.coords.speed);
            } catch (e) {}
          },
          function (e) { onError(e && e.code ? e.code : 2, e && e.message ? e.message : 'browser error'); },
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }
        );
      } catch (e) { S.watching = false; onError(2, 'browser watch failed'); }
      return;
    }
    S.watching = false;
    onError(2, 'geolocation not supported on this device');
  }

  function stopWatch() {
    detectMode();
    watchListeners.pos = null; watchListeners.err = null;
    flushOneShots(false, { code: 3, message: 'watch stopped' });
    if (S.mode === 'native') {
      try { window.WayStationLocation.stopWatch(); } catch (e) {}
    } else if (S.mode === 'browser' && S.browserWatchId !== null) {
      try { navigator.geolocation.clearWatch(S.browserWatchId); } catch (e) {}
      S.browserWatchId = null;
    }
    S.watching = false;
    if (S.state !== 'denied') S.state = 'idle';
  }

  function restart() {
    if (!S.watching && S.state !== 'active') return;
    var p = watchListeners.pos, e = watchListeners.err;
    stopWatch();
    startWatch(p, e);
  }

  function getCurrentPosition(timeoutMs) {
    detectMode();
    var timeout = timeoutMs || 25000;
    return new Promise(function (resolve, reject) {
      if (S.mode === 'none') { reject({ code: 2, message: 'unsupported' }); return; }
      if (S.state === 'denied') { reject({ code: 1, message: 'denied' }); return; }
      var f = S.lastFix;
      if (f && (Date.now() - f.ts < 30000)) { resolve(asPosition(f)); return; }
      var shot = { resolve: resolve, reject: reject, timer: 0 };
      shot.timer = setTimeout(function () {
        var i = oneShots.indexOf(shot);
        if (i >= 0) oneShots.splice(i, 1);
        reject({ code: 3, message: 'fix timed out' });
      }, timeout);
      oneShots.push(shot);
      // Make sure fixes are flowing; a no-op if a watch is already up.
      startWatch(watchListeners.pos, watchListeners.err);
    });
  }

  /* Permission state for user guidance. Native: the bridge reads the TRUE
   * Android grant — never the Permissions API, which lies inside WebViews.
   * Browser: the Permissions API is trustworthy in real browsers. */
  function checkPermission(cb) {
    detectMode();
    try {
      if (S.mode === 'native') {
        var st = nativeState();
        cb(st && (st.coarse || st.fine) ? 'granted' : 'denied');
        return;
      }
      if (S.mode === 'browser' && navigator.permissions &&
          navigator.permissions.query) {
        navigator.permissions.query({ name: 'geolocation' }).then(function (r) {
          cb(r.state === 'denied' ? 'denied' : (r.state === 'granted' ? 'granted' : 'prompt'));
        }).catch(function () { cb('unknown'); });
        return;
      }
      cb('unknown');
    } catch (e) { cb('unknown'); }
  }

  function getState() {
    detectMode();
    return {
      mode: S.mode, state: S.state, watching: S.watching,
      lastFixAgeMs: S.lastFix ? Date.now() - S.lastFix.ts : -1,
      lastFixAcc: S.lastFix ? S.lastFix.acc : -1,
      fixCount: S.fixCount, lastError: S.lastError,
      native: S.mode === 'native' ? nativeState() : null,
    };
  }

  /* ?loc-debug — live readout of every location layer. For the head unit. */
  function maybeDebug() {
    try {
      if (!/loc-debug/.test(window.location.search || '')) return;
    } catch (e) { return; }
    var el = document.createElement('div');
    el.id = 'vcn-loc-debug';
    el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99999;' +
      'background:rgba(10,10,14,.92);color:#7CFFB2;font:11px/1.5 monospace;' +
      'padding:10px 12px;border:1px solid #2c5; border-radius:8px;max-width:78vw;' +
      'white-space:pre-wrap;pointer-events:none;';
    document.addEventListener('DOMContentLoaded', function () {
      document.body.appendChild(el);
    });
    if (document.body) document.body.appendChild(el);
    var permQ = '?';
    function tick() {
      detectMode();
      var st = getState();
      var lines = [
        'LOC-DEBUG  ?loc-debug (remove param to hide)',
        'mode=' + st.mode + '  state=' + st.state + '  watching=' + st.watching,
        'native=' + JSON.stringify(st.native),
        'lastFix: age=' + (st.lastFixAgeMs < 0 ? 'never' : Math.round(st.lastFixAgeMs / 1000) + 's') +
          ' acc=' + st.lastFixAcc + 'm  fixes=' + st.fixCount,
        'lastError=' + JSON.stringify(st.lastError),
        'permissions.query=' + permQ,
        'bridge present=' + (!!window.WayStationLocation),
      ];
      el.textContent = lines.join('\n');
      try {
        if (navigator.permissions && navigator.permissions.query) {
          navigator.permissions.query({ name: 'geolocation' }).then(function (r) {
            permQ = r.state;
          }).catch(function () { permQ = 'n/a'; });
        } else permQ = 'n/a';
      } catch (e) { permQ = 'n/a'; }
    }
    tick();
    setInterval(tick, 1000);
  }
  try { maybeDebug(); } catch (e) {}

  window.VCNLocation = {
    startWatch: startWatch,
    stopWatch: stopWatch,
    restart: restart,
    getCurrentPosition: getCurrentPosition,
    checkPermission: checkPermission,
    getState: getState,
    debug: getState,
  };
})();
