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
let navActive = false, followMode = true, voiceOn = true;
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
function speak(text) {
  if (!voiceOn || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.02; u.volume = 1;
    speechSynthesis.speak(u);
  } catch (e) { /* voice unavailable */ }
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
  return `<svg viewBox="0 0 64 64" fill="none" stroke="${VC.yellow}" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
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
    if (window.VCNPlaces) VCNPlaces.init(map, {
      getUserPos: () => userPos,
      formatDist: fmtDist,
      setDestination: d => { dest = d; planRoute(); },
    });
    locateUser(true);
  });
  map.on('dragstart', () => { if (navActive) setFollow(false); });
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

/* ---------------- search ---------------- */
let searchTimer = null;
function wireSearch() {
  const input = $('search'), list = $('results');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { list.hidden = true; return; }
    searchTimer = setTimeout(() => runSearch(q), 450);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(searchTimer); runSearch(input.value.trim()); } });
}
async function runSearch(q) {
  const list = $('results');
  if (!q) return;
  try {
    const url = `${NOMINATIM}?format=jsonv2&extratags=1&limit=6&accept-language=en&q=${encodeURIComponent(q)}`;
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
async function planRoute() {
  if (!dest) return;
  toast('Finding the neon route…', 1500);
  try {
    const from = userPos || await currentPosOnce().catch(() => DUBLIN);
    const route = await osrmRoute(from, dest.lnglat);
    routeCoords = route.geometry.coordinates;
    steps = buildSteps(route);
    totalDist = route.distance; totalDur = route.duration;
    drawRoute();
    $('route-dist').textContent = fmtDist(totalDist);
    $('route-time').textContent = `${Math.round(totalDur / 60)} min`;
    $('route-card').hidden = false;
  } catch (e) { toast('Could not find a route. Try again.'); }
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
  $('start-panel').hidden = true;
  $('nav-banner').hidden = false;
  $('nav-controls').hidden = false;
  setFollow(true);
  updateBanner();
  const first = steps[0];
  speak(`Starting navigation. ${instrText(first)}. Total ${speakDist(totalDist)}.`);
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = navigator.geolocation.watchPosition(onPos, onPosErr,
    { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
}
function endNav() {
  navActive = false;
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  try { speechSynthesis.cancel(); } catch (e) {}
  $('nav-banner').hidden = true; $('nav-controls').hidden = true;
  $('start-panel').hidden = false;
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
  if (heading !== null) { lastHeading = heading; updatePlayerArrow(); }
  if (followMode && now - lastCamMove > 900 && map) {
    lastCamMove = now;
    map.easeTo({ center: p, zoom: 16.5, pitch: 55,
      bearing: heading !== null ? heading : map.getBearing(), duration: 900 });
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
  if (!next.ann300 && dMan < 300) { next.ann300 = true; speak(`In ${speakDist(dMan)}, ${instrText(next)}.`); }
  else if (!next.ann80 && dMan < 80) { next.ann80 = true; speak(`${instrText(next)}.`); }
}

function setFollow(on) {
  followMode = on;
  $('follow-btn').classList.toggle('on', on);
}

/* ---------------- controls ---------------- */
const ICONS = {
  voiceOn: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13v6h5l6 5V8l-6 5H7z" fill="currentColor" stroke="none"/><path d="M22 12c2.6 2.6 2.6 5.4 0 8"/><path d="M25 9c4 4 4 10 0 14"/></svg>',
  voiceOff: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 13v6h5l6 5V8l-6 5H7z" fill="currentColor" stroke="none"/><path d="M23 13l8 8M31 13l-8 8"/></svg>',
  follow: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="16" cy="16" r="8"/><circle cx="16" cy="16" r="1.6" fill="currentColor"/><path d="M16 3v5M16 24v5M3 16h5M24 16h5"/></svg>'
};
function wireControls() {
  $('mute-btn').innerHTML = ICONS.voiceOn;
  $('follow-btn').innerHTML = ICONS.follow;
  $('mute-btn').addEventListener('click', () => {
    voiceOn = !voiceOn;
    $('mute-btn').innerHTML = voiceOn ? ICONS.voiceOn : ICONS.voiceOff;
    if (!voiceOn) { try { speechSynthesis.cancel(); } catch (e) {} }
    else speak('Voice guidance on.');
  });
  $('follow-btn').addEventListener('click', () => {
    setFollow(!followMode);
    if (followMode && userPos && map) map.easeTo({ center: userPos, zoom: 16.5, pitch: 55, duration: 700 });
  });
  $('zoom-in').addEventListener('click', () => map && map.zoomIn());
  $('zoom-out').addEventListener('click', () => map && map.zoomOut());
  $('end-btn').addEventListener('click', endNav);
  $('start-btn').addEventListener('click', startNav);
  $('origin-btn').addEventListener('click', () => { locateUser(true); toast('Origin: your location'); });
}

/* ---------------- boot ---------------- */
wireSearch();
wireControls();
initMap();

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// debug / test hook
window.VCN = {
  state: () => ({ navActive, stepIdx, steps: steps.length, voiceOn, hasMap: !!map, hasRoute: routeCoords.length > 0 }),
  _map: () => map,
  _setTestRoute(coords, testSteps) { routeCoords = coords; steps = testSteps; totalDist = 1000; totalDur = 300; }
};
