/* Vice City Navigator — client-side turn-by-turn PWA.
   Map: dedicated vice-city-style.json built from the OpenMapTiles vector
   source to match the original GTA Vice City pause-map.
   Routing: OSRM demo server. Search: Nominatim. Voice: speechSynthesis. */
'use strict';

const VC = {
  /* map colors live in vice-city-style.json; these are app-level accents */
  routeCasing: '#f5d020', routeCore: '#f5d020', // solid in-game mission-map yellow
  /* HUD accents (kept for the nav instruction icons) */
  yellow: '#fffb96'
};
const STYLE_URL = 'vice-city-style.json';
const OSRM = 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const DUBLIN = [-6.2603, 53.3498]; // fallback centre (user is in Ireland)

const $ = id => document.getElementById(id);
const mapEl = $('map');

/* ---------------- state ---------------- */
let map = null, userMarker = null, destMarker = null;
let userPos = null;            // [lng, lat]
let dest = null;               // {label, lnglat}
let routeCoords = [];          // full route LineString coords
let steps = [];                // nav steps
let totalDist = 0, totalDur = 0;
let navActive = false, followMode = true;
let uiMode = 'explore';      // explore | planning | drive
let discoveryOn = false;     // fog-of-war view (explore only — never while driving)
let stepIdx = 0, watchId = null, lastCamMove = 0, lastPos = null;
let offRouteSince = 0, arrived = false, rerouting = false;

/* ---------------- helpers ---------------- */
function toast(msg, ms = 3200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, ms);
}
function haversine(a, b) {
  const R = 6371000, toR = d => d * Math.PI / 180;
  const dLat = toR(b[1] - a[1]), dLng = toR(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function ptSegDist(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  if (!L2) return haversine(p, a);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return haversine(p, [a[0] + t * dx, a[1] + t * dy]);
}
function distToRoute(p) {
  let m = Infinity;
  for (let i = 0; i + 1 < routeCoords.length; i++)
    m = Math.min(m, ptSegDist(p, routeCoords[i], routeCoords[i + 1]));
  return m;
}
function fmtDist(m) {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}
function speakDist(m) {
  if (m < 950) return `${Math.max(10, Math.round(m / 10) * 10)} meters`;
  return `${(m / 1000).toFixed(1)} kilometers`;
}
function etaString(remainSec) {
  const t = new Date(Date.now() + remainSec * 1000);
  return t.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Dublin' });
}
/* Voice goes through the theme-aware voice engine (voice.js):
   standard speechSynthesis, themed OpenAI TTS, or off.
   The deterministic text stays on screen regardless. */
function speak(text) {
  if (window.VCNVoice) window.VCNVoice.speakText(text);
}

/* ---------------- Vice City blips ----------------
   Authentic radar blips extracted from ClassicHud's Vice City texture
   packs (hud.txd), mapped to real-world Nominatim place categories. */
const BLIP_PATH = 'assets/blips/blip_';
function blipFor(it) {
  const cat = (it.category || it.class || '').toLowerCase();
  const type = (it.type || '').toLowerCase();
  const cuisine = ((it.extratags && it.extratags.cuisine) || '').toLowerCase();
  const shop = cat === 'shop' ? type : '';
  if (/aerodrome|airport/.test(type) || cat === 'aeroway') return 'airYard';
  if (type === 'hospital' || type === 'clinic' || type === 'doctors') return 'hostpital';
  if (type === 'police') return 'police';
  if (type === 'bank' || type === 'atm' || type === 'bureau_de_change') return 'cash';
  if (type === 'school' || type === 'university' || type === 'college' || type === 'kindergarten') return 'school';
  if (type === 'gym' || type === 'sports_centre' || type === 'stadium' || type === 'pitch') return 'gym';
  if (type === 'car_repair' || shop === 'car_repair' || shop === 'car') return 'modGarage';
  if (type === 'car_wash') return 'spray';
  if (type === 'barbers' || type === 'hairdresser' || type === 'beauty') return 'barbers';
  if (shop === 'tattoo' || type === 'tattoo') return 'tattoo';
  if (shop === 'estate_agent' || type === 'estate_agent') return 'propertyG';
  if (type === 'bar' || type === 'pub' || type === 'biergarten') return 'dateDrink';
  if (type === 'nightclub' || type === 'cinema' || type === 'theatre') return 'dateDisco';
  if (type === 'hotel' || type === 'hostel' || type === 'guest_house' || type === 'motel') return 'saveGame';
  if (type === 'house' || type === 'residential' || type === 'apartments') return 'saveGame';
  if (cat === 'amenity' && /restaurant|fast_food|cafe|food_court|ice_cream/.test(type)) {
    if (/pizza/.test(cuisine)) return 'pizza';
    if (/chicken/.test(cuisine)) return 'chicken';
    if (/burger/.test(cuisine)) return 'burgerShot';
    if (type === 'cafe' || type === 'ice_cream') return 'diner';
    if (type === 'restaurant') return 'dateFood';
    return 'burgerShot';
  }
  return 'qmark';
}
const blipUrl = name => `${BLIP_PATH}${name}.png`;

/* ---------------- maneuver arrows (original SVG) ---------------- */
function themeArrowColor() {
  const t = window.VCNThemes && window.VCNThemes.current();
  return (t && t.ui && t.ui.arrowColor) || VC.yellow;
}
function arrowSvg(kind) {
  const base = '<path d="M32 9 V45 M19 23 L32 9 L45 23"/>';
  const rot = d => `<g transform="rotate(${d} 32 32)">${base}</g>`;
  const bodies = {
    'straight': base,
    'left': rot(-90), 'right': rot(90),
    'slight-left': rot(-35), 'slight-right': rot(35),
    'sharp-left': rot(-125), 'sharp-right': rot(125),
    'uturn': '<path d="M21 50 V27 Q21 11 36 11 Q51 11 51 25 Q51 38 39 38 H29 M35 30 L27 38 L35 46"/>',
    'roundabout': '<circle cx="32" cy="35" r="14"/><path d="M32 7 V21 M25 14 L32 21 L39 14"/>',
    'flag': '<path d="M22 52 V8 M22 11 H47 L40 18.5 L47 26 H22"/>'
  };
  const inner = bodies[kind] || bodies['straight'];
  return `<svg viewBox="0 0 64 64" fill="none" stroke="${themeArrowColor()}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
function arrowKind(m) {
  if (m.type === 'arrive') return 'flag';
  if (m.type === 'roundabout' || m.type === 'rotary') return 'roundabout';
  const mod = m.modifier || '';
  if (mod === 'uturn') return 'uturn';
  if (mod.includes('sharp left')) return 'sharp-left';
  if (mod.includes('sharp right')) return 'sharp-right';
  if (mod.includes('slight left')) return 'slight-left';
  if (mod.includes('slight right')) return 'slight-right';
  if (mod.includes('left')) return 'left';
  if (mod.includes('right')) return 'right';
  return 'straight';
}

/* ---------------- instruction text ---------------- */
function roadName(s) { return [s.ref, s.name].filter(Boolean).join(' '); }
function instrText(step) {
  const m = step.maneuver, road = roadName(step);
  const onto = road ? ` onto ${road}` : '';
  switch (m.type) {
    case 'depart': return `Head ${m.modifier || 'out'}${onto}`;
    case 'arrive': return 'You have arrived';
    case 'roundabout': case 'rotary':
      return road ? `At the roundabout, exit onto ${road}` : 'At the roundabout, go straight';
    case 'turn': return `Turn ${m.modifier || ''}${onto}`;
    case 'new name': case 'continue': return `Continue${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'fork': return `Keep ${(m.modifier || '').replace('slight ', '')}${onto}`;
    case 'on ramp': return `Take the ramp${onto}`;
    case 'off ramp': return `Take the exit${onto}`;
    case 'end of road': return `At the end of the road, turn ${m.modifier || ''}${onto}`;
    default: return (m.type || 'Continue') + onto;
  }
}

/* ---------------- map init ---------------- */
async function initMap() {
  let style;
  try {
    const res = await fetch(STYLE_URL);
    if (!res.ok) throw new Error('style fetch failed');
    style = await res.json();
  } catch (e) {
    toast('Could not load the Vice City map style. Check your connection.');
    return;
  }
  map = new maplibregl.Map({
    container: mapEl, style, center: DUBLIN, zoom: 12,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('load', () => {
    // Each module init is isolated: one failing module must never
    // silently prevent the others (e.g. POIs) from starting.
    try { if (window.VCNThemes) document.body.classList.add(window.VCNThemes.current().ui.bodyClass); }
    catch (e) { console.error('[vcn] themes init failed', e); }
    try { if (window.VCNVoice) VCNVoice.init(); }
    catch (e) { console.error('[vcn] voice init failed', e); }
    try { if (window.VCNDiscovery) VCNDiscovery.init(map); }
    catch (e) { console.error('[vcn] discovery init failed', e); }
    try {
      if (window.VCNPlaces) VCNPlaces.init(map, {
        getUserPos: () => userPos,
        formatDist: fmtDist,
        setDestination: d => { dest = d; planRoute(); },
        navigateTo: d => { dest = d; showRoutePending(d && d.label); planRoute({ autostart: true }); },
        openPlanning: v => openPlanning(v || 'poi'),
      });
    } catch (e) { console.error('[vcn] places init failed', e); }
    // Restore the pre-Spotify-OAuth view (the auth redirect reloads the page).
    const rv = pendingSpotifyView;
    pendingSpotifyView = null;
    if (rv && rv.center) {
      map.jumpTo({ center: rv.center, zoom: rv.zoom || 12, bearing: rv.bearing || 0 });
      if (rv.uiMode === 'drive' && navActive) setUiMode('drive');
      else if (rv.uiMode === 'planning') setUiMode('planning');
      locateUser(false);
    } else {
      locateUser(true);
    }
  });
  map.on('dragstart', () => { if (navActive) setFollow(false); });
  // Fetch ambient POIs for wherever the map is looking — the 750 m
  // gate inside maybeRefresh keeps this thrifty, so manual panning
  // behaves like driving: new area = one refresh, then quiet.
  map.on('moveend', () => {
    if (window.VCNPlaces && map) VCNPlaces.maybeRefresh(map.getCenter().toArray());
  });
  maybeShowPoiDebug();
}

/* Temporary diagnostic: open the app with ?poi-debug in the URL to get a
   small live panel showing the ambient-POI pipeline state (init, key,
   cache, last refresh result/error, budget). Remove once POIs are confirmed. */
function maybeShowPoiDebug() {
  let enabled = false;
  try { enabled = new URLSearchParams(location.search).has('poi-debug'); } catch (e) { /* ignore */ }
  if (!enabled) return;
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;top:8px;left:8px;z-index:99999;background:rgba(8,8,12,.94);' +
    'color:#7dffb0;font:11px/1.55 monospace;padding:10px 12px;border:1px solid #f5d020;' +
    'border-radius:8px;max-width:82vw;max-height:60vh;overflow:auto;';
  const pre = document.createElement('div');
  pre.style.whiteSpace = 'pre-wrap';
  const btn = document.createElement('button');
  btn.textContent = 'refresh POIs now';
  btn.style.cssText = 'margin-top:8px;padding:8px 12px;font:12px monospace;touch-action:manipulation;';
  btn.onclick = () => {
    try {
      const m = (window.VCN && window.VCN._map) ? window.VCN._map() : null;
      const c = m ? m.getCenter().toArray() : [-6.68, 53.29];
      window.VCNPlaces.maybeRefresh(c);
      pre.textContent = 'manual refresh triggered…\n' + pre.textContent;
    } catch (e) { pre.textContent = 'ERR ' + e.message; }
  };
  el.appendChild(pre);
  el.appendChild(btn);
  document.body.appendChild(el);
  const tick = () => {
    try {
      const s = window.VCNPlaces ? window.VCNPlaces.status() : null;
      pre.textContent = s ? JSON.stringify(s, null, 1) : 'VCNPlaces missing!';
    } catch (e) { pre.textContent = 'status ERR: ' + e.message; }
  };
  tick();
  setInterval(tick, 2000);
}

function locateUser(center) {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      userPos = [pos.coords.longitude, pos.coords.latitude];
      placeUserMarker();
      if (window.VCNPlaces) VCNPlaces.maybeRefresh(userPos); // ambient POIs
      if (center && map) map.flyTo({ center: userPos, zoom: 14, duration: 1200 });
    },
    () => { if (center) toast('Location unavailable — showing Dublin.'); },
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

let lastHeading = 0; // GPS travel heading, rotates the player arrow
/* Device compass heading (degrees clockwise from north), when the phone
   reports one. Lets the map/arrow follow the direction the user *faces*,
   not just the direction GPS sees them move — crucial when stationary or
   walking slowly, where GPS heading is unavailable. */
let compassHeading = null;
let orientationListening = false;
let lastBearingPush = 0;
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading; // iOS: true compass heading
  } else if (e.absolute === true && typeof e.alpha === 'number' && !isNaN(e.alpha)) {
    h = (360 - e.alpha) % 360; // Android absolute mode
  }
  if (h === null) return;
  compassHeading = h;
  // Arrow follows the compass when GPS has no travel heading for us.
  if (!navActive) { lastHeading = h; updatePlayerArrow(); }
  // Keep the map rotated to the direction faced while driving (follow mode).
  if (navActive && followMode && map) {
    const now = Date.now();
    let d = Math.abs(h - map.getBearing()) % 360;
    if (d > 180) d = 360 - d;
    if (now - lastBearingPush > 500 && d > 3) {
      lastBearingPush = now;
      try { map.easeTo({ bearing: h, duration: 300 }); } catch (err) {}
    }
  }
}
/* iOS requires compass permission from inside a user gesture — startNav's
   tap counts. Android needs no permission but requires the
   'deviceorientationabsolute' event for a true-north heading — the plain
   'deviceorientation' event's alpha is relative on Android Chrome and never
   sets absolute=true, so without this the compass stays dead on Android.
   Safe to call repeatedly. */
function enableCompass() {
  if (typeof window.DeviceOrientationEvent === 'undefined') return;
  if (orientationListening) return;
  const listen = () => {
    window.addEventListener('deviceorientation', onOrientation);
    // Android Chrome: absolute (true-north) headings arrive here.
    window.addEventListener('deviceorientationabsolute', onOrientation);
    orientationListening = true;
  };
  try {
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission().then(s => {
        if (s === 'granted' && !orientationListening) listen();
      }).catch(() => {});
    } else {
      listen();
    }
  } catch (e) {}
}
/* Best available heading: compass first (faces direction), then GPS travel. */
function bestBearing(fallback) {
  if (compassHeading !== null) return compassHeading;
  if (fallback !== undefined && fallback !== null) return fallback;
  return map ? map.getBearing() : 0;
}
/* Authentic player arrow extracted from ClassicHud's Vice City hud.txd
   ("arrow" texture) — replaces the earlier hand-drawn SVG. */
function placeUserMarker() {
  if (!map || !userPos) return;
  if (!userMarker) {
    const el = document.createElement('div');
    el.className = 'player-arrow';
    const img = document.createElement('img');
    img.src = 'assets/player_arrow.png';
    img.alt = '';
    el.appendChild(img);
    userMarker = new maplibregl.Marker({ element: el }).setLngLat(userPos).addTo(map);
  } else userMarker.setLngLat(userPos);
  updatePlayerArrow();
}
function updatePlayerArrow() {
  if (!userMarker) return;
  const img = userMarker.getElement().querySelector('img');
  if (img) img.style.transform = `rotate(${lastHeading}deg)`;
}

/* ---------------- recent destinations ----------------
   Repeat drives become two taps: open search, tap a recent. */
const RECENT_KEY = 'vcn-recent-dest-v1';
const RECENT_MAX = 8;
function loadRecents() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(a) ? a.filter(r => r && r.label && Array.isArray(r.lnglat)) : [];
  } catch (e) { return []; }
}
function saveRecent(d) {
  if (!d || !d.label || !Array.isArray(d.lnglat)) return;
  const key = r => `${r.label}|${r.lnglat[0].toFixed(4)},${r.lnglat[1].toFixed(4)}`;
  const list = loadRecents().filter(r => key(r) !== key(d));
  list.unshift({ label: d.label, lnglat: d.lnglat.slice(), blip: d.blip || 'waypoint', t: Date.now() });
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX))); } catch (e) {}
}
function renderRecents() {
  const wrap = $('recent-wrap'), list = $('recent-list');
  const recents = loadRecents();
  list.innerHTML = '';
  if (!recents.length) { wrap.hidden = true; return; }
  for (const r of recents) {
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.className = 'res-blip'; img.alt = ''; img.src = blipUrl(r.blip || 'waypoint');
    const strong = document.createElement('strong'); strong.textContent = r.label;
    li.append(img, strong);
    li.addEventListener('click', () => {
      dest = { label: r.label, lnglat: r.lnglat.slice(), blip: r.blip };
      $('search').value = r.label;
      $('results').hidden = true;
      $('recent-wrap').hidden = true;
      showRoutePending(r.label);
      planRoute();
    });
    list.appendChild(li);
  }
  wrap.hidden = false;
}
/* Instant drawer feedback the moment a destination is picked —
   no dead air while the route computes. */
function showRoutePending(label) {
  $('dest-label').textContent = label || 'Destination';
  $('route-dist').textContent = 'Finding route…';
  $('route-time').textContent = '';
  $('route-card').hidden = false;
}

/* ---------------- search ---------------- */
let searchTimer = null;
function wireSearch() {
  const input = $('search'), list = $('results');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { list.hidden = true; renderRecents(); return; }
    $('recent-wrap').hidden = true;
    searchTimer = setTimeout(() => runSearch(q), 450);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(input.value.trim()); } });
}
async function runSearch(q) {
  const list = $('results');
  if (!q) return;
  try {
    // Bias results toward the user's area (viewbox boosts nearby ranking
    // without filtering out far-away matches entirely).
    const anchor = userPos || (map ? map.getCenter().toArray() : null);
    let vb = '';
    if (anchor) {
      const d = 0.75, [lng, lat] = anchor;
      vb = `&viewbox=${lng - d},${lat + d},${lng + d},${lat - d}`;
    }
    const url = `${NOMINATIM}?format=jsonv2&extratags=1&limit=6${vb}&accept-language=en&q=${encodeURIComponent(q)}`;
    const res = await fetch(url);
    const items = await res.json();
    list.innerHTML = '';
    if (!items.length) { list.hidden = true; toast('No places found.'); return; }
    for (const it of items) {
      const li = document.createElement('li');
      const name = (it.display_name || '').split(',').slice(0, 2).join(',');
      const blip = blipFor(it);
      const img = document.createElement('img');
      img.className = 'res-blip'; img.alt = '';
      img.src = blipUrl(blip);
      const wrap = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = name;
      const small = document.createElement('small'); small.textContent = it.display_name;
      wrap.append(strong, small);
      li.append(img, wrap);
      li.addEventListener('click', () => {
        dest = { label: name, lnglat: [parseFloat(it.lon), parseFloat(it.lat)], blip };
        list.hidden = true; $('search').value = name;
        $('recent-wrap').hidden = true;
        showRoutePending(name);
        planRoute();
      });
      list.appendChild(li);
    }
    list.hidden = false;
  } catch (e) { toast('Search failed — check your connection.'); }
}

/* ---------------- routing ---------------- */
async function osrmRoute(from, to) {
  const url = `${OSRM}/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('no route');
  return data.routes[0];
}
function ensureRouteLayers() {
  if (map.getSource('vcn-route')) return;
  map.addSource('vcn-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'vcn-route-casing', type: 'line', source: 'vcn-route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': VC.routeCasing, 'line-width': 9, 'line-opacity': 0.95 }
  });
  map.addLayer({
    id: 'vcn-route-core', type: 'line', source: 'vcn-route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': VC.routeCore, 'line-width': 5 }
  });
}
function drawRoute() {
  ensureRouteLayers();
  map.getSource('vcn-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeCoords }, properties: {} });
  if (destMarker) destMarker.remove();
  const el = document.createElement('div'); el.className = 'dest-pin';
  el.style.backgroundImage = `url('${blipUrl((dest && dest.blip) || 'waypoint')}')`;
  destMarker = new maplibregl.Marker({ element: el }).setLngLat(dest.lnglat).addTo(map);
  const b = new maplibregl.LngLatBounds();
  routeCoords.forEach(c => b.extend(c));
  map.fitBounds(b, { padding: 60, duration: 800 });
}
function buildSteps(route) {
  const leg = route.legs[0];
  return leg.steps.map(s => ({
    loc: s.maneuver.location.slice(),
    dist: s.distance, dur: s.duration,
    name: s.name || '', ref: s.ref || '',
    maneuver: s.maneuver,
    ann300: false, ann80: false
  }));
}
async function planRoute(opts) {
  if (!dest) return;
  const autostart = !!(opts && opts.autostart);
  if (!autostart) toast('Finding the neon route…', 1500);
  try {
    const from = userPos || await currentPosOnce().catch(() => DUBLIN);
    const route = await osrmRoute(from, dest.lnglat);
    routeCoords = route.geometry.coordinates;
    steps = buildSteps(route);
    totalDist = route.distance; totalDur = route.duration;
    drawRoute();
    saveRecent(dest);
    if (autostart) { startNav(); return; }
    $('dest-label').textContent = (dest && dest.label) || 'Destination';
    $('route-dist').textContent = fmtDist(totalDist);
    $('route-time').textContent = `${Math.round(totalDur / 60)} min`;
    openPlanning('route');
    const rc = $('route-card');
    if (rc && rc.scrollIntoView) rc.scrollIntoView({ block: 'nearest' });
  } catch (e) {
    $('route-card').hidden = true;
    toast('Could not find a route. Try again.');
  }
}
function currentPosOnce() {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      p => { userPos = [p.coords.longitude, p.coords.latitude]; placeUserMarker(); resolve(userPos); },
      reject, { enableHighAccuracy: true, timeout: 9000 });
  });
}

/* ---------------- navigation engine ---------------- */
function startNav() {
  if (!steps.length) return;
  navActive = true; stepIdx = 0; arrived = false; offRouteSince = 0;
  if (discoveryOn) setDiscovery(false); // fog never shows during navigation
  setUiMode('drive');
  setFollow(true);
  enableCompass(); // map follows the direction the user faces, not just GPS travel
  updateBanner();
  const first = steps[0];
  speak(`Starting navigation. ${instrText(first)}. Total ${speakDist(totalDist)}.`);
  // Pre-generate themed voice for upcoming maneuvers — background only,
  // navigation never waits for it. Canonical texts are stable ("In 300
  // meters, …") so they match exactly what maybeAnnounce will speak.
  if (window.VCNVoice) VCNVoice.pregenerate(upcomingManeuverTexts());
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr,
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
}
/* Stable canonical maneuver texts for the next few steps (voice pregen). */
function upcomingManeuverTexts() {
  const out = [];
  for (let i = 1; i < Math.min(steps.length, 4); i++) {
    const t = instrText(steps[i]);
    out.push(`In 300 meters, ${t}.`, `${t}.`);
  }
  return out;
}
function endNav() {
  navActive = false;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (window.VCNVoice) VCNVoice.cancel();
  setUiMode('explore');
  if (map) {
    if (map.getSource('vcn-route')) map.getSource('vcn-route').setData({ type: 'FeatureCollection', features: [] });
    if (destMarker) { destMarker.remove(); destMarker = null; }
    map.easeTo({ pitch: 0, duration: 600 });
  }
  routeCoords = []; steps = []; stepIdx = 0;
}
function onPosErr() { /* keep last known position; toast once */ }

function onPos(pos) {
  const p = [pos.coords.longitude, pos.coords.latitude];
  userPos = p; placeUserMarker();
  // Passive discovery tracking — no network, runs in every mode.
  // The fog itself is only *shown* in Discovery Mode (never while driving).
  if (window.VCNDiscovery) VCNDiscovery.reveal(p);
  if (window.VCNPlaces) VCNPlaces.maybeRefresh(p); // ambient POIs, 750 m gated
  if (!navActive || !steps.length) return;

  // camera follow
  const now = Date.now();
  let heading = null;
  if (lastPos) {
    const dt = (pos.timestamp - lastPos.t) / 1000;
    const d = haversine(lastPos.p, p);
    if (dt > 0 && d / dt > 1.5 && d > 4) {
      heading = Math.atan2(p[0] - lastPos.p[0], p[1] - lastPos.p[1]) * 180 / Math.PI;
    }
  }
  lastPos = { p, t: pos.timestamp };
  if (heading !== null) lastHeading = heading; // GPS travel heading wins when moving
  else if (compassHeading !== null) lastHeading = compassHeading; // else face direction
  updatePlayerArrow();
  if (followMode && now - lastCamMove > 900 && map) {
    lastCamMove = now;
    map.easeTo({ center: p, zoom: 16.5, pitch: 55,
      bearing: bestBearing(heading), duration: 900 });
  }

  // off-route detection
  const offD = distToRoute(p);
  if (offD > 60) {
    if (!offRouteSince) offRouteSince = now;
    else if (now - offRouteSince > 10000 && !rerouting) { reroute(); return; }
  } else offRouteSince = 0;

  // step advancement: next maneuver is at steps[stepIdx+1] (step maneuver = start of step)
  const nextIdx = Math.min(stepIdx + 1, steps.length - 1);
  let dMan = haversine(p, steps[nextIdx].loc);
  // jumped past the maneuver? skip ahead
  if (nextIdx + 1 < steps.length && haversine(p, steps[nextIdx + 1].loc) < dMan - 30) {
    stepIdx = nextIdx; return onPos(pos);
  }
  if (nextIdx > stepIdx && dMan < 25) { stepIdx = nextIdx; }
  else dMan = haversine(p, steps[Math.min(stepIdx + 1, steps.length - 1)].loc);

  updateBanner(dMan);
  maybeAnnounce(dMan);
}

async function reroute() {
  if (!dest || !userPos || rerouting) return;
  rerouting = true; speak('Rerouting.');
  toast('Rerouting…');
  try {
    const route = await osrmRoute(userPos, dest.lnglat);
    routeCoords = route.geometry.coordinates;
    steps = buildSteps(route);
    totalDist = route.distance; totalDur = route.duration;
    stepIdx = 0; offRouteSince = 0; arrived = false;
    drawRouteKeepView();
    updateBanner();
    // Regenerate themed voice for the new route; drop stale audio.
    if (window.VCNVoice) {
      VCNVoice.pruneCache([]);
      VCNVoice.pregenerate(upcomingManeuverTexts());
    }
    speak(`New route. ${instrText(steps[0])}.`);
  } catch (e) { toast('Reroute failed — staying on current route.'); }
  rerouting = false;
}
function drawRouteKeepView() {
  ensureRouteLayers();
  map.getSource('vcn-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeCoords }, properties: {} });
}

function updateBanner(dMan) {
  if (!steps.length) return;
  const nextIdx = Math.min(stepIdx + 1, steps.length - 1);
  const next = steps[nextIdx];
  if (dMan === undefined) dMan = userPos ? haversine(userPos, next.loc) : next.dist;

  $('maneuver-arrow').innerHTML = arrowSvg(arrowKind(next.maneuver));
  $('next-dist').textContent = fmtDist(dMan);
  $('next-instr').textContent = instrText(next);

  const remainDist = steps.slice(nextIdx).reduce((a, s) => a + s.dist, 0) + dMan;
  const remainDur = totalDur * (totalDist ? remainDist / totalDist : 0);
  $('trip-meta').textContent = `${fmtDist(remainDist)} to go • arrive ${etaString(remainDur)}`;
}

function maybeAnnounce(dMan) {
  const nextIdx = Math.min(stepIdx + 1, steps.length - 1);
  const next = steps[nextIdx];
  if (next.maneuver.type === 'arrive') {
    if (!arrived && dMan < 40) { arrived = true; speak('You have arrived.'); }
    return;
  }
  // Stable canonical texts ("In 300 meters, …") so themed-voice
  // pre-generation matches exactly what is spoken here.
  if (!next.ann300 && dMan < 300) { next.ann300 = true; speak(`In 300 meters, ${instrText(next)}.`); }
  else if (!next.ann80 && dMan < 80) { next.ann80 = true; speak(`${instrText(next)}.`); }
}

function setFollow(on) {
  followMode = on;
  $('follow-btn').classList.toggle('on', on);
  if (on) enableCompass(); // re-arm heading sensor when follow resumes
}

/* ---------------- UI modes: explore / planning / drive ----------------
   Explore:  full-screen map, minimal chrome (menu, search, locate).
   Planning: slide-out drawer (desktop) / bottom sheet (mobile) with
             search, results, destination, route preview, Start Drive.
   Drive:    compact HUD only — maneuver card + trip bar.
   The MapLibre instance is created once and never recreated. */
function setUiMode(mode) {
  uiMode = mode;
  $('explore-ui').hidden = mode === 'drive';
  $('drawer').hidden = mode !== 'planning';
  $('drive-hud').hidden = mode !== 'drive';
  if (mode === 'drive') closeMenu();
}
function openPlanning(view) {
  closeMenu();
  setUiMode('planning');
  $('poi-detail').hidden = view !== 'poi';
  if (view !== 'route') $('route-card').hidden = true;
  if (view === 'search') {
    // Synchronous focus inside the tap gesture so the mobile keyboard
    // opens immediately — a deferred focus won't.
    const s = $('search');
    if (s.value.trim().length >= 3) $('recent-wrap').hidden = true;
    else renderRecents();
    if (s) s.focus({ preventScroll: true });
  }
}
function closeDrawer() {
  setUiMode(navActive ? 'drive' : 'explore');
}
function openMenu() {
  $('menu-panel').hidden = false;
  syncDiscoveryStats();
}
function closeMenu() { $('menu-panel').hidden = true; }

/* ---------------- Spotify pane (WayStation music widget) ----------------
   Theme-independent core (spotify-core.js) + per-theme skin mounted
   into #spotify-stage. OAuth redirects reload the page, so the UI/map
   state is stashed in sessionStorage before leaving and restored after
   the callback — the map never visibly resets. */
const SPOTIFY_CLIENT_ID = 'e15ad96d357849999f72380200c0e37d';
const SPOTIFY_REDIRECT_URI = 'https://ciaranf3308-star.github.io/vice-city-navigator/';
const SPOTIFY_SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
];
const SPOTIFY_PREAUTH = 'vcn.spotify.preAuth';
const SPOTIFY_PANE_OPEN = 'vcn.spotify.paneOpen';
let pendingSpotifyView = null;

function setSpotifyPane(open) {
  $('spotify-pane').hidden = !open;
  try {
    if (open) localStorage.setItem(SPOTIFY_PANE_OPEN, '1');
    else localStorage.removeItem(SPOTIFY_PANE_OPEN);
  } catch (e) {}
  if (window.SpotifyCore && SpotifyCore.isConnected()) {
    if (open) SpotifyCore.startPolling();
    else SpotifyCore.stopPolling();
  }
  offsetMapForSpotify(open);
}

/* Shift the map's visual center left so it stays clear of the floating music widget. */
function offsetMapForSpotify(open) {
  try {
    if (!map || !map.easeTo) return;
    const w = (open && window.innerWidth > 700) ? ($('spotify-pane').offsetWidth + 28) : 0;
    map.easeTo({ padding: { top: 0, bottom: 0, left: 0, right: w }, duration: 400 });
  } catch (e) {}
}

function saveSpotifyPreAuth() {
  try {
    const s = { uiMode, paneOpen: !$('spotify-pane').hidden };
    if (map) {
      const c = map.getCenter();
      s.center = [c.lng, c.lat];
      s.zoom = map.getZoom();
      s.bearing = map.getBearing();
    }
    sessionStorage.setItem(SPOTIFY_PREAUTH, JSON.stringify(s));
  } catch (e) {}
}

async function initSpotify() {
  if (!window.SpotifyCore || !window.SpotifySkins) return;
  SpotifyCore.onBeforeRedirect(saveSpotifyPreAuth);
  const themeId = window.VCNThemes ? VCNThemes.currentId() : 'vice-city';
  const skin = SpotifySkins.get(themeId) || SpotifySkins.get('vice-city');
  if (skin) skin.mount($('spotify-stage'), SpotifyCore);
  let hadCallback = false;
  try {
    hadCallback = await SpotifyCore.init({
      clientId: SPOTIFY_CLIENT_ID,
      redirectUri: SPOTIFY_REDIRECT_URI,
      scopes: SPOTIFY_SCOPES,
    });
  } catch (e) { /* init is best-effort; widget shows connect state */ }
  if (hadCallback) {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(SPOTIFY_PREAUTH) || 'null'); } catch (e) {}
    try { sessionStorage.removeItem(SPOTIFY_PREAUTH); } catch (e) {}
    if (s) {
      pendingSpotifyView = s; // applied once the map finishes loading
      if (s.paneOpen) setSpotifyPane(true);
      else setSpotifyPane(localStorage.getItem(SPOTIFY_PANE_OPEN) === '1');
    }
  } else {
    try {
      if (localStorage.getItem(SPOTIFY_PANE_OPEN) === '1') setSpotifyPane(true);
    } catch (e) {}
  }
}

function wireSpotifyButtons() {
  const toggle = () => setSpotifyPane($('spotify-pane').hidden);
  $('music-btn').addEventListener('click', toggle);
  $('drive-music-btn').addEventListener('click', toggle);
  $('spotify-close').addEventListener('click', () => setSpotifyPane(false));
  window.addEventListener('resize', () => {
    if (!$('spotify-pane').hidden) offsetMapForSpotify(true);
  });
}
function toggleMenu() { $('menu-panel').hidden ? openMenu() : closeMenu(); }

/* ---------------- discovery menu wiring ---------------- */
function syncDiscoveryStats() {
  if (!window.VCNDiscovery) return;
  const s = VCNDiscovery.stats();
  const km = s.km2 < 10 ? s.km2.toFixed(1) : Math.round(s.km2);
  $('discovery-stats').textContent =
    `${s.cells} areas · ${km} km² discovered (${s.pct.toFixed(2)}% of Ireland)`;
}
function setDiscovery(on) {
  discoveryOn = on;
  if (window.VCNDiscovery) VCNDiscovery.setFogVisible(on && !navActive);
  $('discovery-toggle').checked = on;
  if (on) { syncDiscoveryStats(); toast('Discovery Map — drive to reveal the fog'); }
}

/* ---------------- controls ---------------- */
const ICONS = {
  voiceOn: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13v6h5l6 5V8l-6 5H7z" fill="currentColor" stroke="none"/><path d="M22 12c2.6 2.6 2.6 5.4 0 8"/><path d="M25 9c4 4 4 10 0 14"/></svg>',
  voiceOff: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13v6h5l6 5V8l-6 5H7z" fill="currentColor" stroke="none"/><path d="M23 13l8 8M31 13l-8 8"/></svg>',
  follow: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="16" cy="16" r="8"/><circle cx="16" cy="16" r="1.6" fill="currentColor"/><path d="M16 3v5M16 24v5M3 16h5M24 16h5"/></svg>'
};
function syncMuteIcon() {
  const muted = window.VCNVoice ? VCNVoice.isMuted() : false;
  $('mute-btn').innerHTML = muted ? ICONS.voiceOff : ICONS.voiceOn;
}
function wireControls() {
  $('mute-btn').innerHTML = ICONS.voiceOn;
  $('follow-btn').innerHTML = ICONS.follow;
  $('mute-btn').addEventListener('click', () => {
    if (!window.VCNVoice) return;
    const muted = !VCNVoice.isMuted();
    VCNVoice.setMuted(muted);
    syncMuteIcon();
    if (!muted) speak('Voice guidance on.');
  });
  $('follow-btn').addEventListener('click', () => {
    setFollow(!followMode);
    if (followMode && userPos && map) map.easeTo({ center: userPos, zoom: 16.5, pitch: 55,
      bearing: bestBearing(), duration: 700 });
  });
  $('zoom-in').addEventListener('click', () => map && map.zoomIn());
  $('zoom-out').addEventListener('click', () => map && map.zoomOut());
  $('end-btn').addEventListener('click', endNav);
  $('start-btn').addEventListener('click', startNav);
  $('locate-btn').addEventListener('click', () => locateUser(true));

  // explore chrome
  $('menu-btn').addEventListener('click', toggleMenu);
  $('menu-close').addEventListener('click', closeMenu);
  $('search-bar').addEventListener('click', () => openPlanning('search'));

  // planning drawer
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-handle').addEventListener('click', closeDrawer);

  // drive HUD
  $('drive-menu-btn').addEventListener('click', toggleMenu);
  $('drive-search-btn').addEventListener('click', () => openPlanning('search'));

  // menu: discovery
  $('discovery-toggle').addEventListener('change', e => setDiscovery(e.target.checked));
  $('discovery-reset').addEventListener('click', () => {
    if (!window.VCNDiscovery) return;
    if (confirm('Reset the discovered map? All fog-of-war progress will be erased.')) {
      VCNDiscovery.reset();
      syncDiscoveryStats();
      toast('Discovery map reset.');
    }
  });

  // menu: voice settings
  if (window.VCNVoice) {
    VCNVoice.init(); // load saved settings before populating controls
    const cfg = VCNVoice.getConfig();
    $('voice-mode').value = cfg.mode;
    $('profanity-toggle').checked = !!cfg.profanity;
    $('endpoint-url').value = cfg.endpoint || '';
    syncMuteIcon();
  }
  $('voice-mode').addEventListener('change', e => {
    if (window.VCNVoice) VCNVoice.setConfig({ mode: e.target.value });
    syncMuteIcon();
  });
  $('profanity-toggle').addEventListener('change', e => {
    if (window.VCNVoice) VCNVoice.setConfig({ profanity: e.target.checked });
  });
  $('endpoint-url').addEventListener('change', e => {
    if (window.VCNVoice) {
      VCNVoice.setConfig({ endpoint: e.target.value.trim() });
      toast('Voice server saved.');
    }
  });

  setUiMode('explore');
}

/* ---------------- boot ---------------- */
wireSearch();
wireControls();
wireSpotifyButtons();
initMap();
initSpotify();

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// debug / test hook
window.VCN = {
  state: () => ({ navActive, uiMode, stepIdx, steps: steps.length,
    voiceMuted: window.VCNVoice ? VCNVoice.isMuted() : true,
    voiceMode: window.VCNVoice ? VCNVoice.mode() : 'n/a',
    discovery: window.VCNDiscovery ? VCNDiscovery.stats() : null,
    hasMap: !!map, hasRoute: routeCoords.length > 0 }),
  _map: () => map,
  _setTestRoute(coords, testSteps) { routeCoords = coords; steps = testSteps; totalDist = 1000; totalDur = 300; }
};
