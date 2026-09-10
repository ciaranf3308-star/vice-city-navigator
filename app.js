/* WayStation — client-side turn-by-turn PWA.
   Map: per-theme MapLibre style JSON built from the OpenMapTiles vector
   source (themes/<id>/style.json).
   Routing: OSRM demo server. Search: Nominatim. Voice: speechSynthesis. */
'use strict';

/* ---------------- theme ----------------
   All game-specific visuals come from the active theme definition.
   This file never hard-codes blip names, asset paths, colours or
   fonts — everything flows through VCNThemes. */
function wsTheme() {
  return (window.VCNThemes && VCNThemes.current()) || null;
}
function wsThemeId() {
  return (window.VCNThemes && VCNThemes.currentId()) || 'vice-city';
}
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
function speak(text, opts) {
  if (window.VCNVoice) window.VCNVoice.speakText(text, opts);
}

/* ---------------- WayStation semantic blips ----------------
   Nominatim place categories map to game-agnostic semantic POI
   categories; the active theme resolves each to its own icon art. */
function semanticForNominatim(it) {
  const cat = (it.category || it.class || '').toLowerCase();
  const type = (it.type || '').toLowerCase();
  const cuisine = ((it.extratags && it.extratags.cuisine) || '').toLowerCase();
  const shop = cat === 'shop' ? type : '';
  if (/aerodrome|airport/.test(type) || cat === 'aeroway') return 'airport';
  if (type === 'hospital' || type === 'clinic' || type === 'doctors') return 'hospital';
  if (type === 'pharmacy' || shop === 'pharmacy') return 'pharmacy';
  if (type === 'police') return 'police';
  if (type === 'bank' || type === 'atm' || type === 'bureau_de_change') return 'bank';
  if (type === 'stadium') return 'stadium';
  if (type === 'gym' || type === 'sports_centre' || type === 'pitch') return 'gym';
  if (type === 'car_repair' || shop === 'car_repair' || shop === 'car') return 'garage';
  if (type === 'car_wash') return 'car_wash';
  if (type === 'fuel' || shop === 'fuel') return 'fuel';
  if (/parking/.test(type) || /parking/.test(cat)) return 'parking';
  if (/railway/.test(cat) && /station/.test(type)) return 'train';
  if (type === 'bar' || type === 'pub' || type === 'biergarten') return 'bar';
  if (type === 'nightclub') return 'nightlife';
  if (type === 'cinema' || type === 'theatre') return 'cinema';
  if (type === 'hotel' || type === 'hostel' || type === 'guest_house' || type === 'motel') return 'hotel';
  if (cat === 'amenity' && /restaurant|fast_food|cafe|food_court|ice_cream/.test(type)) {
    if (/pizza/.test(cuisine)) return 'pizza';
    if (/chicken/.test(cuisine)) return 'chicken';
    if (/burger/.test(cuisine)) return 'burger';
    if (type === 'cafe' || type === 'ice_cream') return 'cafe';
    if (type === 'restaurant') return 'restaurant';
    return 'fast_food';
  }
  if (shop === 'supermarket' || shop === 'grocery' || shop === 'convenience') return 'supermarket';
  if (shop === 'mall' || shop === 'department_store') return 'mall';
  if (cat === 'shop') return 'shop';
  return null; // theme renders its fallback icon
}
/* Semantic category -> active theme's blip PNG url. */
const themeBlipUrl = semantic =>
  (window.VCNThemes ? VCNThemes.poiIconUrl(semantic, wsThemeId()) : '');
/* Destination marker art: the place's semantic blip when known,
   otherwise the theme's waypoint marker (never the qmark fallback). */
const destBlipUrl = () =>
  themeBlipUrl(dest && dest.semantic ? dest.semantic : 'waypoint');

/* ---------------- cluster mode: live regions ----------------
   Every region reuses the existing live state — no parallel variables,
   no second watchers, no duplicate Spotify polling. */

/* Pure: the next-manoeuvre payload for the cluster turn block, or null
   when nothing should show. Same arrow/instruction logic as the nav
   banner and voice. */
function nextTurnData(next, dMan) {
  if (!next || dMan === undefined || dMan === null) return null;
  return {
    kind: arrowKind(next.maneuver),
    dist: fmtDist(dMan),
    road: roadName(next),
    instruction: instrText(next),
  };
}

/* The manoeuvre the cluster should show right now, from live nav state. */
function currentTurnData() {
  if (!navActive || !steps.length) return null;
  const nextIdx = Math.min(stepIdx + 1, steps.length - 1);
  const next = steps[nextIdx];
  const dMan = userPos ? haversine(userPos, next.loc) : next.dist;
  return nextTurnData(next, dMan);
}

function syncClusterTurn(data) {
  const t = $('cluster-turn');
  if (!t) return;
  const show = clusterLayoutActive() && navActive && !!data;
  t.hidden = !show;
  if (!show) return;
  const ar = $('cluster-turn-arrow');
  if (ar) ar.innerHTML = arrowSvg(data.kind);
  const d = $('cluster-turn-distance');
  if (d && d.textContent !== data.dist) d.textContent = data.dist;
  const r = $('cluster-turn-road');
  if (r) { if (r.textContent !== data.road) r.textContent = data.road; r.hidden = !data.road; }
  const ins = $('cluster-turn-instruction');
  if (ins && ins.textContent !== data.instruction) ins.textContent = data.instruction;
  /* VC hero compass needle follows the live map bearing. */
  const needle = $('cluster-compass-needle');
  if (needle && typeof map !== 'undefined' && map) {
    try { needle.style.transform = `rotate(${-map.getBearing()}deg)`; } catch (e) {}
  }
}

/* Push the current live state into every cluster region — called when
   entering cluster mode so the shell is correct immediately, not just
   after the next GPS fix or nav update. (Spotify needs no sync: the real
   #spotify-pane widget mounts its own skin per layout, not duplicated.) */
function refreshClusterLive() {
  updateSpeedo();
  syncClusterTurn(currentTurnData());
  buildClusterGauge();
  bindClusterTabs();
  startClusterClock();
  /* Seat the radar N on the live bearing immediately. */
  try { syncRadarNorth(map ? map.getBearing() : 0, 1); } catch (e) {}
}

/* ============ Vice City cluster hero ============
   Pixel contract: themes/vice-city/cluster/hero.png. The slots live in
   the shared #cluster-ui DOM; only the VC skin shows them. Everything
   displayed is real live state — no fabricated battery, range or gear. */

/* --- header clock + weather --- */
const VC_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const VC_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sept', 'oct', 'nov', 'dec'];
function syncClusterHeader() {
  if (!clusterLayoutActive() || !document.body.classList.contains('theme-vice-city')) return;
  const now = new Date();
  const dateStr = `${VC_DAYS[now.getDay()]} ${String(now.getDate()).padStart(2, '0')} ${VC_MONTHS[now.getMonth()]}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const d = $('cluster-date'), t = $('cluster-time');
  if (d) d.textContent = dateStr;
  if (t) t.textContent = timeStr;
  /* The VC cluster reuses the dashboard topbar chrome — keep its
     date/time/temp live too (same values, same weather cache). */
  const dd = $('dash-date'), dt = $('dash-time');
  if (dd) dd.textContent = dateStr;
  if (dt) dt.textContent = timeStr;
  /* Last-known weather from the same cache the dashboard paints from. */
  try {
    const c = JSON.parse(localStorage.getItem(WX_CACHE_KEY) || 'null');
    const te = $('cluster-temp');
    if (te && c && typeof c.t === 'number') te.textContent = c.t + '°C';
    const dte = $('dash-temp');
    if (dte && c && typeof c.t === 'number') dte.textContent = c.t + '°C';
  } catch (e) {}
}
let clusterClockT = null;
function startClusterClock() {
  stopClusterClock();
  syncClusterHeader();
  clusterClockT = setInterval(() => { if (clusterLayoutActive()) syncClusterHeader(); }, 15000);
}
function stopClusterClock() {
  if (clusterClockT) { clearInterval(clusterClockT); clusterClockT = null; }
}

/* --- trip strip on the nav card: "12 min • 6,8 km • 21:36" --- */
function syncClusterTrip(remainDist, remainDur) {
  const el = $('cluster-trip');
  if (!el || !clusterLayoutActive()) return;
  if (!navActive || remainDist == null || remainDur == null) { el.hidden = true; return; }
  el.hidden = false;
  const mins = Math.max(1, Math.round(remainDur / 60));
  el.innerHTML = `<span>${mins} min</span><span class="trip-sep">•</span>` +
    `<span class="trip-cyan">${fmtDist(remainDist)}</span><span class="trip-sep">•</span>` +
    `<span>${etaString(remainDur)}</span>`;
}

/* --- inferred drive meter: REGEN / COAST / POWER arc ---
   This is NOT vehicle telemetry. It is a visual inference of driving
   force derived from longitudinal GPS speed change (the same stream that
   feeds gpsSpeed). No battery kW, no SOC, no range, no gear is shown or
   implied anywhere — those need a real vehicle telemetry provider. */
let smoothedAcceleration = 0;  // m/s^2, low-pass filtered
let driveForceState = 'coast'; // 'regen' | 'coast' | 'power'
let driveForceBand = 0;        // 0 coast, 1 light, 2 medium, 3 strong
let dfPrevMps = null, dfPrevT = 0;
function updateDriveForce(kmh) {
  if (typeof kmh === 'number' && isFinite(kmh) && kmh >= 0) {
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (dfPrevMps !== null) {
      const dt = (now - dfPrevT) / 1000;
      if (dt > 0.2 && dt < 10) {
        const rawAccel = (kmh / 3.6 - dfPrevMps) / dt;
        /* Reject unrealistic instantaneous spikes (GPS noise, tunnels). */
        if (Math.abs(rawAccel) < 8) smoothedAcceleration = smoothedAcceleration * 0.8 + rawAccel * 0.2;
      } else if (dt >= 10) {
        smoothedAcceleration = 0; // stale gap: decay back to coast
      }
    }
    dfPrevMps = kmh / 3.6; dfPrevT = now;
  } else {
    dfPrevMps = null; smoothedAcceleration = 0;
  }
  const a = smoothedAcceleration, mag = Math.abs(a);
  /* ±0.08 m/s^2 dead zone so GPS noise never flickers the meter. */
  driveForceState = a < -0.08 ? 'regen' : (a > 0.08 ? 'power' : 'coast');
  driveForceBand = mag < 0.08 ? 0 : mag < 0.35 ? 1 : mag < 0.8 ? 2 : 3;
  syncDriveForceGauge();
}
let clusterGaugeTicks = [];
function buildClusterGauge() {
  const svg = $('cluster-gauge-svg');
  if (!svg || clusterGaugeTicks.length) return;
  if (typeof document.createElementNS !== 'function') return;
  const NS = 'http://www.w3.org/2000/svg';
  /* Chunky wedge segments fanning along a shallow ribbon, like a physical
     instrument bezel: REGEN on the left end, POWER on the right, COAST on
     the centre wedges. i=0 stays the left end so the regen/coast/power zone
     mapping and the centre-out fill logic below are unchanged. */
  const N = 25, cx = 235, cy = -300, mid = (N - 1) / 2;
  const ORX = 362, ORY = 470, IRX = 332, IRY = 446, HW = 0.92;
  const rad = d => d * Math.PI / 180;
  /* Bevel gradients: lit wedges catch light on their outer edge. */
  const defs = document.createElementNS(NS, 'defs');
  const mkGrad = (id, hi, lo) => {
    const g = document.createElementNS(NS, 'linearGradient');
    g.setAttribute('id', id);
    g.setAttribute('x1', '0'); g.setAttribute('y1', '0');
    g.setAttribute('x2', '0'); g.setAttribute('y2', '1');
    const s1 = document.createElementNS(NS, 'stop');
    s1.setAttribute('offset', '0'); s1.setAttribute('stop-color', hi);
    const s2 = document.createElementNS(NS, 'stop');
    s2.setAttribute('offset', '1'); s2.setAttribute('stop-color', lo);
    g.appendChild(s1); g.appendChild(s2);
    return g;
  };
  defs.appendChild(mkGrad('cg-grad-regen', '#b8f6ff', '#01cdfe'));
  defs.appendChild(mkGrad('cg-grad-power', '#ffa8d2', '#ff2d95'));
  defs.appendChild(mkGrad('cg-grad-coast', '#ffffff', '#c9c9d8'));
  svg.appendChild(defs);
  for (let i = 0; i < N; i++) {
    const a = 118 - (56 * i) / (N - 1);
    const a1 = rad(a - HW), a2 = rad(a + HW);
    const px = (r, an) => (cx + r * Math.cos(an)).toFixed(1);
    const py = (r, an) => (cy + r * Math.sin(an)).toFixed(1);
    const pg = document.createElementNS(NS, 'polygon');
    pg.setAttribute('points',
      `${px(IRX, a1)},${py(IRY, a1)} ${px(IRX, a2)},${py(IRY, a2)} ` +
      `${px(ORX, a2)},${py(ORY, a2)} ${px(ORX, a1)},${py(ORY, a1)}`);
    const zone = i < mid - 2 ? 'regen' : (i > mid + 2 ? 'power' : 'coast');
    pg.dataset.zone = zone;
    pg.dataset.slot = Math.abs(i - mid);
    pg.setAttribute('class', 'cg-seg' + (i === mid ? ' cg-mid' : ''));
    svg.appendChild(pg);
    clusterGaugeTicks.push(pg);
  }
  syncDriveForceGauge();
}
/* Fills from the centre outward per band — never snaps across the arc. */
function syncDriveForceGauge() {
  if (!clusterGaugeTicks.length) return;
  /* Band 0..3 (from real GPS acceleration) spreads across the side's
     ticks from the centre outward: 1 -> 4 -> 7 -> 10 lit. The inference
     is untouched — this is only how much of the ribbon illuminates. */
  const litSlots = driveForceBand; // 0..3
  clusterGaugeTicks.forEach(ln => {
    const zone = ln.dataset.zone, slot = +ln.dataset.slot;
    const active = driveForceState !== 'coast' && zone === driveForceState && (slot - 3) <= litSlots * 3;
    const coastOn = driveForceState === 'coast' && zone === 'coast';
    ln.classList.toggle('lit-regen', active && zone === 'regen');
    ln.classList.toggle('lit-power', active && zone === 'power');
    ln.classList.toggle('lit-coast', coastOn);
  });
}

/* --- footer tabs + header logo: presentation switching only, no dead tabs --- */
let clusterTabsBound = false;
function bindClusterTabs() {
  if (clusterTabsBound) return; clusterTabsBound = true;
  if (typeof document.querySelectorAll !== 'function') return;
  document.querySelectorAll('#cluster-tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab === 'cluster') return;
      if (tab === 'dashboard') { WayStation.setAppMode('dashboard'); return; }
      if (tab === 'map') { WayStation.setAppMode('normal'); return; }
    });
  });
  const logo = $('cluster-logo');
  if (logo) logo.addEventListener('click', () => openMenu());
  /* VC cluster reuses the dashboard topbar as its header — its brand mark
     takes over the menu-button role (the old #cluster-logo is hidden). */
  const dashBrand = document.querySelector('#dash-topbar .dash-brand');
  if (dashBrand) dashBrand.addEventListener('click', () => {
    if (clusterLayoutActive() && document.body.classList.contains('theme-vice-city')) openMenu();
  });
  /* SA cluster: transparent tap target over the overlay's WayStation logo
     (its console header/menu button are painted into the overlay art). */
  const saMenu = document.getElementById('sa-cluster-menu');
  if (saMenu) saMenu.addEventListener('click', () => {
    if (clusterLayoutActive() && document.body.classList.contains('theme-san-andreas')) openMenu();
  });
}

/* ---------------- maneuver arrows (original SVG) ---------------- */
function themeArrowColor() {
  const t = wsTheme();
  return (t && t.ui && t.ui.arrowColor) || '#fffb96';
}
function saArrowSvg(kind) {
  // GTA SA HUD block arrows: chunky white fill, heavy black outline — matches Bank Gothic/blackletter theme
  const base = '<path d="M26 58 L26 32 L14 32 L32 10 L50 32 L38 32 L38 58 Z" fill="#f6efdb" stroke="#111" stroke-width="4" stroke-linejoin="round"/>';
  const rot = d => `<g transform="rotate(${d} 32 32)">${base}</g>`;
  const bodies = {
    'straight': base,
    'left': rot(-90), 'right': rot(90),
    'slight-left': rot(-35), 'slight-right': rot(35),
    'sharp-left': rot(-125), 'sharp-right': rot(125),
    'uturn': '<path d="M24 56 L24 30 Q24 12 38 12 Q52 12 52 26 Q52 40 40 40 L32 40" fill="none" stroke="#111" stroke-width="16" stroke-linecap="round"/><path d="M24 56 L24 30 Q24 12 38 12 Q52 12 52 26 Q52 40 40 40 L32 40" fill="none" stroke="#fff" stroke-width="9" stroke-linecap="round"/><path d="M39 31 L28 40 L39 49 Z" fill="#fff" stroke="#111" stroke-width="3" stroke-linejoin="round"/>',
    'roundabout': '<circle cx="32" cy="37" r="13" fill="none" stroke="#111" stroke-width="15"/><circle cx="32" cy="37" r="13" fill="none" stroke="#fff" stroke-width="8"/><path d="M32 6 L32 20 M25 13 L32 20 L39 13" fill="none" stroke="#111" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/><path d="M32 6 L32 20 M25 13 L32 20 L39 13" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
    'flag': '<path d="M24 58 L24 8" fill="none" stroke="#111" stroke-width="14" stroke-linecap="round"/><path d="M24 58 L24 8" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/><path d="M24 12 L52 12 L45 20 L52 28 L24 28 Z" fill="#fff" stroke="#111" stroke-width="3" stroke-linejoin="round"/>'
  };
  const inner = bodies[kind] || bodies['straight'];
  return `<svg viewBox="0 0 64 64">${inner}</svg>`;
}
function arrowSvg(kind) {
  const t = wsTheme();
  if (t && t.id === 'san-andreas') return saArrowSvg(kind);
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
  if (window.VCNThemes) VCNThemes.restore();
  // Paint the theme chrome (bars, menu docking, Spotify skin) immediately:
  // the dashboard must never depend on vector tiles arriving.
  try { if (window.VCNThemes) applyBodyTheme(VCNThemes.currentId()); } catch (e) {}
  // Sync the Spotify skin on init too — applyBodyTheme doesn't cover it,
  // and a stale skin (e.g. SA) with a VC body is the classic mismatch.
  try { if (window.VCNThemes) mountSpotifySkin(VCNThemes.currentId()); } catch (e) {}
  // The theme selector may have built before restore(); re-sync it now.
  try { syncThemeSelector(); } catch (e) {}
  const theme = wsTheme();
  const styleUrl = (theme && theme.map.styleUrl) || 'themes/vice-city/style.json';
  let style;
  try {
    const res = await fetch(styleUrl);
    if (!res.ok) throw new Error('style fetch failed');
    style = await res.json();
  } catch (e) {
    toast('Could not load the map style. Check your connection.');
    return;
  }
  const glOk = !window.maplibregl || typeof maplibregl.supported !== 'function' || maplibregl.supported();
  if (!glOk) {
    mapEl.innerHTML = '<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#ff71ce;font:16px sans-serif;text-align:center;padding:20px">Map needs WebGL.<br>Try a browser with hardware acceleration enabled.</div>';
    toast('Map could not start: WebGL unavailable.');
    return;
  }
  map = new maplibregl.Map({
    container: mapEl, style, center: DUBLIN, zoom: 12,
    attributionControl: { compact: true }
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
  map.on('load', () => {
    try { map.on('move', syncDashCompass); } catch (e) {}
    try { map.on('moveend', queueDashLocality); } catch (e) {}
    try { syncDashPadding(); } catch (e) {}
    try { applyDashboardMapPaint(); } catch (e) {}
    // Each module init is isolated: one failing module must never
    // silently prevent the others (e.g. POIs) from starting.
    try { if (window.VCNThemes) applyBodyTheme(VCNThemes.currentId()); }
    catch (e) { console.error('[vcn] themes init failed', e); }
    try { if (window.VCNVoice) VCNVoice.init(); }
    catch (e) { console.error('[vcn] voice init failed', e); }
    try { if (window.VCNDiscovery) VCNDiscovery.init(map); }
    catch (e) { console.error('[vcn] discovery init failed', e); }
    try {
      if (window.VCNTraffic) { VCNTraffic.restore(); VCNTraffic.init(map); }
    } catch (e) { console.error('[vcn] traffic init failed', e); }
    try {
      if (window.VCNPlaces) VCNPlaces.init(map, {
        getUserPos: () => userPos,
        formatDist: fmtDist,
        setDestination: d => { dest = d; planRoute(); },
        navigateTo: d => { dest = d; showRoutePending(d && d.label); planRoute({ autostart: true }); },
        openPlanning: v => openPlanning(v || 'poi'),
        refreshSavedLists: () => { renderSavedLists(); },
        toast: msg => toast(msg),
      });
    } catch (e) { console.error('[vcn] places init failed', e); }
    try { wireLongPress(); } catch (e) { console.error('[vcn] long-press init failed', e); }
    try { renderCustomMarkers(); } catch (e) { console.error('[vcn] custom markers init failed', e); }
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
  // Sticky action-result line: survives the 2s tick refresh below.
  const actionLine = document.createElement('div');
  actionLine.style.cssText = 'white-space:pre-wrap;color:#f5d020;margin-bottom:6px;min-height:1em;';
  const btn = document.createElement('button');
  btn.textContent = 'refresh POIs now';
  btn.style.cssText = 'margin-top:8px;padding:8px 12px;font:12px monospace;touch-action:manipulation;';
  const copyBtn = document.createElement('button');
  copyBtn.textContent = 'copy';
  copyBtn.style.cssText = 'margin-top:8px;margin-left:8px;padding:8px 12px;font:12px monospace;touch-action:manipulation;';
  copyBtn.onclick = () => {
    try {
      const s = window.VCNPlaces ? window.VCNPlaces.status() : null;
      const txt = (actionLine.textContent ? actionLine.textContent + '\n' : '') + JSON.stringify(s, null, 1);
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(
          () => { actionLine.textContent = 'copied ✓'; },
          () => { actionLine.textContent = 'copy failed'; });
      } else {
        const ta = document.createElement('textarea');
        ta.value = txt;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); actionLine.textContent = 'copied ✓'; }
        catch (e) { actionLine.textContent = 'copy failed'; }
        document.body.removeChild(ta);
      }
    } catch (e) { actionLine.textContent = 'ERR ' + e.message; }
  };
  btn.onclick = () => {
    try {
      const m = (window.VCN && window.VCN._map) ? window.VCN._map() : null;
      const c = m ? m.getCenter().toArray() : [-6.68, 53.29];
      window.VCNPlaces.maybeRefresh(c);
      if (window.VCNPlaces.renderPois) window.VCNPlaces.renderPois();
      const s = window.VCNPlaces ? window.VCNPlaces.status() : null;
      actionLine.textContent = 'after render: ' + JSON.stringify(s);
    } catch (e) { actionLine.textContent = 'ERR ' + e.message; }
  };
  el.appendChild(actionLine);
  el.appendChild(pre);
  el.appendChild(btn);
  el.appendChild(copyBtn);
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

/* ---------------- themes ----------------
   Switching themes restyles the map via setStyle (which drops all
   custom sources/layers/images) and then rehydrates every overlay:
   route, POIs, fog, player marker, destination marker. All app
   state — GPS, destination, route, navigation, discovery data,
   Places cache, Spotify session, recents, voice settings — lives
   outside the style and survives untouched. Safe while navigating.

   Switching is generation-guarded: rapid selections coalesce and the
   latest request always wins; a stale in-flight switch can never
   commit over a newer one. The target style JSON is fetched and
   validated BEFORE the map is touched, applied with a full rebuild
   ({diff:false}) — never a style diff, which does not reliably fire
   style.load and caused false "failed to load" rollbacks — and the
   new theme is only persisted once the style actually loads. */
let themeSwitchGen = 0;
/* Vice City dashboard-only map contrast (hero convergence pass 4).
   The base style.json is the phone-mode palette; in dashboard mode the
   theme's dashboardPaint list is applied on top via setPaintProperty and
   reverted when leaving dashboard mode. A full style rebuild wipes paint,
   so the flag is reset wherever setStyle completes. */
let dashPaintActive = false;
function applyDashboardMapPaint() {
  if (!map || !window.VCNThemes) return;
  /* Get the current theme from the body class (e.g. theme-gta-v -> gta-v) */
  let currentTheme = null;
  let themeClass = null;
  for (const tid of VCNThemes.ids()) {
    const t = VCNThemes.get(tid);
    if (t && t.ui && t.ui.bodyClass && document.body.classList.contains(t.ui.bodyClass)) {
      currentTheme = t;
      themeClass = t.ui.bodyClass;
      break;
    }
  }
  if (!currentTheme) return;
  const mapCfg = currentTheme.map;
  if (!mapCfg) return;
  const paintList = mapCfg.dashboardPaint || [];
  const layoutList = mapCfg.dashboardLayout || [];
  if (!paintList.length && !layoutList.length) {
    if (dashPaintActive) dashPaintActive = false;
    return;
  }
  const want = document.body.classList.contains('dashboard-mode');
  if (want === dashPaintActive) return;
  for (const [layer, prop, dashVal, baseVal] of paintList) {
    try {
      if (typeof map.getLayer === 'function' && !map.getLayer(layer)) continue;
      map.setPaintProperty(layer, prop, want ? dashVal : baseVal);
    } catch (e) { /* one missing layer must not break the pass */ }
  }
  for (const [layer, prop, dashVal, baseVal] of layoutList) {
    try {
      if (typeof map.getLayer === 'function' && !map.getLayer(layer)) continue;
      map.setLayoutProperty(layer, prop, want ? dashVal : baseVal);
    } catch (e) { /* one missing layer must not break the pass */ }
  }
  dashPaintActive = want;
}
function restoreRouteOverlay() {
  ensureRouteLayers();
  if (routeCoords.length) {
    map.getSource('vcn-route').setData({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: routeCoords },
      properties: {},
    });
  }
  if (destMarker) { destMarker.remove(); destMarker = null; }
  if (dest && dest.lnglat) {
    const el = document.createElement('div'); el.className = 'dest-pin';
    el.style.backgroundImage = `url('${destBlipUrl()}')`;
    destMarker = new maplibregl.Marker({ element: el }).setLngLat(dest.lnglat).addTo(map);
  }
}
function applyBodyTheme(id) {
  if (!window.VCNThemes) return;
  for (const tid of VCNThemes.ids()) {
    const t = VCNThemes.get(tid);
    if (t && t.ui && t.ui.bodyClass) document.body.classList.remove(t.ui.bodyClass);
  }
  const cur = VCNThemes.get(id);
  if (cur && cur.ui && cur.ui.bodyClass) document.body.classList.add(cur.ui.bodyClass);
  // Theme geometry changed (widget widths differ per theme) — re-aim the
  // camera target now that the new body class is on. This also fixes the
  // first-load ordering: the map 'load' handler syncs padding before the
  // theme class lands, which used to leave right=8 (raw screen center).
  try { syncDashPadding(); } catch (e) {}
  layoutDashMenu(); // bar heights changed with the theme — re-dock the menu panel
  layoutDashDrawer(); // and the planning drawer
}
async function fetchThemeStyle(theme) {
  const res = await fetch(theme.map.styleUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error('style HTTP ' + res.status);
  const style = await res.json();
  if (!style || !Array.isArray(style.layers) || !style.layers.length) {
    throw new Error('style JSON has no layers');
  }
  return style;
}
/* Wait for a freshly applied full style rebuild to report loaded.
   A generation token lets a superseding switch cancel the wait. */
function waitForStyleLoad(isStale) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('style load timeout')); }, 30000);
    const onLoad = () => { if (isStale()) { cleanup(); reject(new Error('superseded')); return; } cleanup(); resolve(); };
    const onError = () => {};
    function cleanup() { clearTimeout(timer); map.off('style.load', onLoad); map.off('error', onError); }
    map.on('error', onError);
    map.once('style.load', onLoad);
  });
}
async function applyTheme(id) {
  if (!window.VCNThemes) return;
  if (!map) {
    // Map unavailable (e.g. WebGL-less environment or failed init):
    // still apply every non-map part of the theme — body chrome,
    // persisted choice, Spotify skin — so theme switching never
    // dead-ends. A later map init loads the persisted theme's style.
    if (VCNThemes.currentId() === id) { syncThemeSelector(); return; }
    const themeNoMap = VCNThemes.get(id);
    if (!themeNoMap) { syncThemeSelector(); return; }
    VCNThemes.setCurrent(id);
    try { if (window.VCNVoice) VCNVoice.onThemeChanged(); } catch (e) {}
    applyBodyTheme(id);
    try { mountSpotifySkin(id); } catch (e) { console.error('[ws] spotify skin swap failed', e); }
    try { renderCustomMarkers(); } catch (e) {}
    syncThemeSelector();
    toast(themeNoMap.name + ' theme active.');
    return;
  }
  if (VCNThemes.currentId() === id) { syncThemeSelector(); return; }
  const theme = VCNThemes.get(id);
  if (!theme) { syncThemeSelector(); return; }
  const gen = ++themeSwitchGen;
  const isStale = () => gen !== themeSwitchGen;
  const priorId = VCNThemes.currentId();
  const priorTheme = VCNThemes.current();
  // Apply the chrome immediately so the dropdown and body can never go out
  // of sync (a map style hiccup must not leave the old theme's chrome up).
  // The persisted theme still only commits once the new style is live.
  applyBodyTheme(id);
  try { mountSpotifySkin(id); } catch (e) { console.error('[ws] spotify skin swap failed', e); }
  const sel = document.getElementById('theme-select');
  if (sel) sel.value = id;
  let style = null, priorStyle = null;
  try {
    // Fetch the target (and the prior, for exact rollback) before the
    // map is touched, so a bad fetch can never leave a broken map.
    [style, priorStyle] = await Promise.all([
      fetchThemeStyle(theme),
      fetchThemeStyle(priorTheme).catch(() => null),
    ]);
  } catch (e) {
    if (isStale()) return;
    // Roll the chrome back too — it was applied optimistically above.
    applyBodyTheme(priorId);
    try { mountSpotifySkin(priorId); } catch (e2) {}
    syncThemeSelector();
    toast('Could not load the ' + theme.name + ' map style.');
    return;
  }
  if (isStale()) return;
  try {
    const loadP = waitForStyleLoad(isStale);
    map.setStyle(style, { diff: false });
    await loadP;
  } catch (e) {
    if (isStale() || (e && e.message === 'superseded')) return;
    // Real load failure: restore the exact prior style, then roll the
    // UI back to match what the map actually shows.
    try {
      if (priorStyle) {
        const rp = waitForStyleLoad(() => false);
        map.setStyle(priorStyle, { diff: false });
        await rp;
      }
    } catch (e2) { console.error('[ws] prior-style restore failed', e2); }
    if (isStale()) return;
    applyBodyTheme(priorId);
    try { mountSpotifySkin(priorId); } catch (e3) {}
    syncThemeSelector();
    toast('Could not load the ' + theme.name + ' map style.');
    return;
  }
  if (isStale()) return;
  // Commit only now that the style is live.
  VCNThemes.setCurrent(id);
  // The voice profile follows the theme: abort any in-flight generation
  // from the old theme so it can never populate the cache or speak.
  try { if (window.VCNVoice) VCNVoice.onThemeChanged(); } catch (e) {}
  applyBodyTheme(id);
  syncThemeSelector();
  // Rehydrate every custom overlay the style change dropped.
  try { restoreRouteOverlay(); paintRouteTheme(); } catch (e) { console.error('[ws] route rehydrate failed', e); }
  try { if (window.VCNPlaces) VCNPlaces.rehydrate(); } catch (e) { console.error('[ws] POI rehydrate failed', e); }
  try { if (window.VCNDiscovery) VCNDiscovery.rehydrate(); } catch (e) { console.error('[ws] fog rehydrate failed', e); }
  try { if (window.VCNTraffic) VCNTraffic.rehydrate(); } catch (e) { console.error('[ws] traffic rehydrate failed', e); }
  try { renderCustomMarkers(); } catch (e) { console.error('[ws] marker rehydrate failed', e); }
  try { refreshPlayerMarkerArt(); } catch (e) { console.error('[ws] marker rehydrate failed', e); }
  try { mountSpotifySkin(id); } catch (e) { console.error('[ws] spotify skin swap failed', e); }
  try { syncDashPadding(); } catch (e) {}
  dashPaintActive = false; // full rebuild wiped paint — force reapply below
  try { applyDashboardMapPaint(); } catch (e) { console.error('[ws] dash paint failed', e); }
  toast(theme.name + ' theme active.');
}
function syncThemeSelector() {
  const sel = document.getElementById('theme-select');
  if (sel && window.VCNThemes) sel.value = VCNThemes.currentId();
  // VC hero tagline: "Good Roads Better Times" (other themes keep "Good Music")
  try {
    const tag = document.querySelector('.dash-tag .tag-line:first-child');
    if (tag) tag.textContent = (window.VCNThemes && VCNThemes.currentId() === 'vice-city') ? 'Good Roads' : 'Good Music';
  } catch (e) {}
}
function buildThemeSelector() {
  const sel = document.getElementById('theme-select');
  if (!sel || !window.VCNThemes) return;
  sel.innerHTML = '';
  for (const id of VCNThemes.ids()) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = VCNThemes.get(id).name;
    sel.appendChild(opt);
  }
  sel.value = VCNThemes.currentId();
  sel.addEventListener('change', () => applyTheme(sel.value));
}

function locateUser(center) {
  if (!('geolocation' in navigator)) return;
  // Center on the last known fix straight away so the button always
  // answers visibly, then refine with a fresh fix when it arrives.
  if (center && userPos && map) map.flyTo({ center: userPos, duration: 800 });
  navigator.geolocation.getCurrentPosition(
    pos => {
      userPos = [pos.coords.longitude, pos.coords.latitude];
      placeUserMarker();
      if (window.VCNPlaces) VCNPlaces.maybeRefresh(userPos); // ambient POIs
      if (center && map) map.flyTo({ center: userPos, zoom: 14, duration: 1200 });
    },
    () => { if (center && !userPos) toast('Location unavailable — showing Dublin.'); },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
}

let lastHeading = 0; // displayed heading, rotates the player arrow
/* Heading sources, ranked by reliability:
   - gpsCourse: travel direction from successive GPS fixes — best when
     the car is clearly moving, immune to compass interference.
   - compassHeading: device compass — best when stationary or slow,
     and the fallback where GPS travel heading is unavailable.
   The naïve `360 - alpha` is gone: GPS wins at speed, and the alpha
   path is rotated into the screen frame so a landscape car mount
   doesn't spin the map. */
let compassHeading = null;
let compassAt = 0;
let gpsCourse = null;
let gpsCourseAt = 0;
let gpsSpeed = null; // m/s, validated (see setGpsSpeed) — from coords.speed or fix-to-fix
let gpsSpeedAt = 0;  // timestamp of the last accepted fix
let gpsRejectSince = 0; // when the current rejection streak started (0 = none)
/* ---------------- validated GPS speed ----------------
   Phone GPS occasionally reports a wild coords.speed on a bad fix
   (e.g. 182 m/s while sitting still). Displaying it raw puts "657 km/h"
   on the cluster. Every candidate is validated before it becomes
   gpsSpeed — never invented, only physically-impossible jumps refused:
   - non-finite / negative candidates are dropped
   - displacement cross-check: fix-to-fix travel is ground truth. If the
     phone barely moved but the candidate claims speed, the fix is bogus —
     fall back to the displacement-derived speed
   - acceleration gate: vs the last accepted speed, |dv| must fit within
     12 m/s^2 (emergency braking is ~10; 12 is generous)
   - re-anchor: if candidates keep failing for > 5 s, trust displacement
     so one bad anchor can't freeze the readout forever
   Staleness: readers use freshGpsSpeed() — anything older than 10 s is
   unknown and displays '--', never a frozen number. */
function setGpsSpeed(candidate, fixMs, dtSec) {
  const now = Date.now();
  const dt = (typeof dtSec === 'number' && dtSec > 0) ? dtSec : 1;
  const fix = (typeof fixMs === 'number' && isFinite(fixMs) && fixMs >= 0) ? fixMs : 0;
  let v = (typeof candidate === 'number' && isFinite(candidate) && candidate >= 0) ? candidate : NaN;
  // displacement cross-check: the phone isn't moving, the claim is bogus
  if (!isNaN(v) && fix < 2 && v > 10) v = fix;
  else if (!isNaN(v) && gpsSpeed === null && fix < 5 && v > 15) v = fix; // first fix: extra strict
  if (isNaN(v)) {
    // receiver gave nothing usable; displacement is still truth
    if (gpsSpeed === null || now - gpsRejectSince > 5000) { gpsSpeed = fix; gpsSpeedAt = now; gpsRejectSince = 0; }
    return;
  }
  if (gpsSpeed !== null) {
    if (Math.abs(v - gpsSpeed) > 12 * dt + 3) {
      if (!gpsRejectSince) gpsRejectSince = now;
      if (now - gpsRejectSince > 5000) { gpsSpeed = fix; gpsSpeedAt = now; gpsRejectSince = 0; }
      return; // impossible jump: hold the last good value
    }
  }
  gpsSpeed = v; gpsSpeedAt = now; gpsRejectSince = 0;
}
function freshGpsSpeed() {
  return (gpsSpeed !== null && Date.now() - gpsSpeedAt <= 10000) ? gpsSpeed : null;
}
let orientationListening = false;
let lastBearingPush = 0;
function screenAngle() {
  try { return (screen.orientation && screen.orientation.angle) || 0; }
  catch (e) { return 0; }
}
function clearlyMoving() { const s = freshGpsSpeed(); return s !== null && s > 2.5; }

/* ---------------- wanted level: stars for speeding (GTA V) ----------------
   Heat builds while over the posted limit (faster the further over),
   decays while driving legal — GTA evade feel. 5 authentic v-hud stars.
   Resets when the drive ends (endNav) or the dashboard closes. */
let wantedHeat = 0;    // 0..100
let wantedStars = 0;   // 0..5 displayed
let wantedLastAt = 0;  // last tick timestamp
/* <test-extract:wanted> */
const WANTED_STOPS = [12, 30, 50, 70, 90]; // heat needed for stars 1..5
function starsForHeat(h) {
  let s = 0;
  for (let i = 0; i < WANTED_STOPS.length; i++) if (h >= WANTED_STOPS[i]) s = i + 1;
  return s;
}
/* </test-extract> */
function wantedTick(dt) {
  if (!document.body.classList.contains('dashboard-mode')) return;
  const gta = document.body.classList.contains('theme-gta-v');
  const gsp = freshGpsSpeed();
  const kmh = (typeof gsp === 'number' && !isNaN(gsp) && gsp >= 0)
    ? gsp * 3.6 : null;
  if (gta && kmh !== null && speedLimitKmh && kmh > speedLimitKmh) {
    wantedHeat = Math.min(100, wantedHeat + (kmh - speedLimitKmh) * dt * 0.6);
  } else {
    wantedHeat = Math.max(0, wantedHeat - dt * 5);
  }
  const stars = starsForHeat(wantedHeat);
  if (stars !== wantedStars) {
    const up = stars > wantedStars;
    wantedStars = stars;
    updateWanted(up);
  }
}
function updateWanted(flash) {
  const el = $('wanted');
  if (!el) return;
  const show = document.body.classList.contains('dashboard-mode') &&
               document.body.classList.contains('theme-gta-v') &&
               wantedStars > 0;
  el.hidden = !show;
  if (!show) return;
  const kids = el.children;
  for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('on', i < wantedStars);
  if (flash) { // GTA flashes the row when the level rises
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}
function resetWanted() {
  wantedHeat = 0; wantedStars = 0;
  updateWanted(false);
}

/* ---------------- speed cluster: GPS speed + OSM posted limit ----------------
   Google Maps-style: live speed from the GPS fix, limit from the nearest
   OSM way's maxspeed tag (Overpass, debounced by distance/time, cached).
   Dashboard-only; degrades to speed-alone when the limit is unknown. */
let speedLimitKmh = null;      // posted limit, null = unknown
let limitQueryAt = 0, limitQueryPos = null, limitPending = false;
const limitCache = new Map();  // ~100m grid key -> kmh
/* <test-extract:parseMaxspeed> */
function parseMaxspeed(s) {
  s = String(s == null ? '' : s).trim().toLowerCase();
  if (!s || s === 'none' || s === 'signals' || s === 'walk' || s === 'no') return null;
  if (s === 'ie:urban') return 50;    // Ireland's conditional tags
  if (s === 'ie:rural') return 80;
  if (s === 'ie:motorway' || s === 'ie:trunk') return 120;
  let m = s.match(/^([\d.]+)\s*mph/);
  if (m) return Math.round(parseFloat(m[1]) * 1.60934);
  m = s.match(/^([\d.]+)/);
  if (m) return Math.round(parseFloat(m[1])); // default unit: km/h
  return null;
}
/* </test-extract> */
function updateSpeedo() {
  if (!speedDisplayActive()) return;
  const gsp = freshGpsSpeed();
  const kmh = (typeof gsp === 'number' && !isNaN(gsp) && gsp >= 0)
    ? Math.round(gsp * 3.6) : null;
  if (dashboardLayoutActive()) {
    const el = $('speedo');
    if (!el || !userPos) return; // no fix yet: stay hidden
    el.hidden = false;
    const num = $('speedo-num');
    const txt = kmh === null ? '--' : String(kmh);
    if (num.textContent !== txt) num.textContent = txt;
    const lim = $('speedo-limit');
    if (speedLimitKmh) {
      lim.hidden = false;
      const ltxt = String(speedLimitKmh);
      if ($('speedo-limit-num').textContent !== ltxt) $('speedo-limit-num').textContent = ltxt;
      el.classList.toggle('over', kmh !== null && kmh > speedLimitKmh);
    } else {
      lim.hidden = true;
      el.classList.remove('over');
    }
  }
  if (clusterLayoutActive()) updateClusterSpeed(kmh);
}

/* Cluster hero speed. Same gpsSpeed, same speedLimitKmh — no second
   watcher. '--' when unknown, never a stale value; the limit badge hides
   cleanly when unknown; overspeed is a subtle state shift, never a
   flashing alarm. */
function updateClusterSpeed(kmh) {
  const num = $('cluster-speed-num');
  if (num) {
    const txt = kmh === null ? '--' : String(kmh);
    if (num.textContent !== txt) num.textContent = txt;
  }
  const lim = $('cluster-limit');
  if (lim) {
    if (speedLimitKmh) {
      lim.hidden = false;
      const ltxt = String(speedLimitKmh);
      const ln = $('cluster-limit-num');
      if (ln && ln.textContent !== ltxt) ln.textContent = ltxt;
    } else lim.hidden = true;
  }
  const sp = $('cluster-speed');
  if (sp) {
    sp.classList.toggle('over', kmh !== null && !!speedLimitKmh && kmh > speedLimitKmh);
    /* Pricedown Bl's hyphen renders as a solid block, so the unavailable
       state gets its own class for a clean fallback-font placeholder. */
    sp.classList.toggle('na', kmh == null);
  }
  /* Inferred drive meter — same GPS stream, no second watcher. */
  updateDriveForce(kmh);
}
async function maybeFetchSpeedLimit(lat, lon) {
  if (!speedDisplayActive()) return;
  const key = lat.toFixed(3) + ',' + lon.toFixed(3);
  if (limitCache.has(key)) {
    if (speedLimitKmh !== limitCache.get(key)) { speedLimitKmh = limitCache.get(key); updateSpeedo(); }
    return;
  }
  const now = Date.now();
  if (limitPending || now - limitQueryAt < 15000) return;
  if (limitQueryPos && haversine(limitQueryPos, [lon, lat]) < 80) return;
  limitPending = true; limitQueryAt = now; limitQueryPos = [lon, lat];
  const q = '[out:json][timeout:10];way(around:30,' + lat.toFixed(5) + ',' +
    lon.toFixed(5) + ')[maxspeed];out tags center 1;';
  const hosts = ['https://overpass.kumi.systems/api/interpreter',
                 'https://overpass-api.de/api/interpreter'];
  let best = null;
  for (const h of hosts) {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 9000);
      let r;
      try {
        r = await fetch(h, { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal });
      } finally { clearTimeout(to); }
      if (!r.ok) continue;
      const j = await r.json();
      const ways = (j.elements || []).filter(e => e.tags && e.tags.maxspeed);
      if (!ways.length) break; // road simply untagged: stop, don't burn the fallback
      const cosLat = Math.cos(lat * Math.PI / 180);
      ways.sort((a, b) => {
        const ca = a.center || {}, cb = b.center || {};
        const da = Math.hypot((ca.lat - lat) * 111320, (ca.lon - lon) * 111320 * cosLat);
        const db = Math.hypot((cb.lat - lat) * 111320, (cb.lon - lon) * 111320 * cosLat);
        return da - db;
      });
      best = parseMaxspeed(ways[0].tags.maxspeed);
      break;
    } catch (e) { /* try the next host */ }
  }
  if (best) {
    speedLimitKmh = best;
    limitCache.set(key, best);
    if (limitCache.size > 240) limitCache.delete(limitCache.keys().next().value);
  }
  limitPending = false;
  updateSpeedo();
}
function onOrientation(e) {
  let h = null;
  if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
    h = e.webkitCompassHeading; // iOS: true compass heading
  } else if (e.absolute === true && typeof e.alpha === 'number' && !isNaN(e.alpha)) {
    // Alpha is measured in the device frame — rotate into the screen
    // frame so landscape/portrait mounts agree on north.
    h = (360 - e.alpha + screenAngle()) % 360;
  }
  if (h === null) return;
  compassHeading = (h + 360) % 360;
  compassAt = Date.now();
  if (clearlyMoving()) return; // GPS course owns the heading at speed
  lastHeading = compassHeading;
  updatePlayerArrow();
  // Keep the map rotated to the direction faced while driving slowly
  // or standing still (follow mode) — during navigation, and always on
  // the cluster minimap, which is heading-up like a car instrument.
  if (followMode && map && (navActive || clusterLayoutActive())) {
    const now = Date.now();
    let d = Math.abs(compassHeading - map.getBearing()) % 360;
    if (d > 180) d = 360 - d;
    if (now - lastBearingPush > 500 && d > 3) {
      lastBearingPush = now;
      try { map.easeTo({ bearing: compassHeading, duration: 300 }); } catch (err) {}
      syncRadarNorth(compassHeading, 300);
    }
  }
}
/* Vice City cluster radar north cue: a small bezel N orbiting the rim.
   The map is heading-up, so the N sits at the live bearing reversed from
   top — always marking true north, never faked. Shortest-path rotation so
   the bezel never does a full spin crossing 0/360. */
let lastRadarNorth = 0;
function syncRadarNorth(bearing, durationMs) {
  if (!clusterLayoutActive() || !document.body.classList.contains('theme-vice-city')) return;
  const ring = document.getElementById('cluster-radar-north');
  if (!ring) return;
  const b = ((bearing % 360) + 360) % 360;
  let d = b - lastRadarNorth;
  if (d > 180) d -= 360; else if (d < -180) d += 360;
  lastRadarNorth += d;
  const ms = Math.max(1, durationMs | 0);
  ring.style.transition = `transform ${ms}ms ease`;
  ring.style.transform = `rotate(${-lastRadarNorth}deg)`;
  const s = ring.firstElementChild;
  if (s) {
    s.style.transition = `transform ${ms}ms ease`;
    s.style.transform = `translateX(-50%) rotate(${lastRadarNorth}deg)`;
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
/* Best available heading: GPS course while clearly moving and fresh,
   compass while stationary/slow, then the caller's fallback. */
function bestBearing(fallback) {
  const now = Date.now();
  if (gpsCourse !== null && now - gpsCourseAt < 8000 && clearlyMoving()) return gpsCourse;
  if (compassHeading !== null && now - compassAt < 8000) return compassHeading;
  if (fallback !== undefined && fallback !== null) return fallback;
  return map ? map.getBearing() : 0;
}
/* Player marker comes from the active theme (each game has its own
   radar arrow/marker art). */
function playerMarkerUrl() {
  const t = wsTheme();
  return (t && t.map.playerMarker) || '';
}
function placeUserMarker() {
  if (!map || !userPos) return;
  if (!userMarker) {
    const el = document.createElement('div');
    el.className = 'player-arrow';
    const img = document.createElement('img');
    img.src = playerMarkerUrl();
    img.alt = '';
    el.appendChild(img);
    userMarker = new maplibregl.Marker({ element: el }).setLngLat(userPos).addTo(map);
  } else userMarker.setLngLat(userPos);
  updatePlayerArrow();
}
/* Swap the marker art when the theme changes (marker survives setStyle). */
function refreshPlayerMarkerArt() {
  if (!userMarker) return;
  const img = userMarker.getElement().querySelector('img');
  if (img) img.src = playerMarkerUrl();
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
  list.unshift({ label: d.label, lnglat: d.lnglat.slice(), semantic: d.semantic || null, t: Date.now() });
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
    img.className = 'res-blip'; img.alt = ''; img.src = themeBlipUrl(r.semantic);
    const strong = document.createElement('strong'); strong.textContent = r.label;
    li.append(img, strong);
    li.addEventListener('click', () => {
      dest = { label: r.label, lnglat: r.lnglat.slice(), semantic: r.semantic || null };
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
/* ---------------- saved places & home ----------------
   Curated places (auto-saved on drive + manual) and the home
   location. Rendered in the planning drawer and the menu Places
   section. */
function goHome() {
  if (!window.VCNSaved) return;
  const home = VCNSaved.getHome();
  if (!home) { toast('No home set — set it from the menu or a place card.'); return; }
  dest = { label: home.label, lnglat: home.lnglat.slice(), semantic: null };
  closeDrawer();
  showRoutePending(home.label);
  planRoute({ autostart: true });
}

function renderSavedLists() {
  if (!window.VCNSaved) return;
  const places = VCNSaved.getPlaces();
  const home = VCNSaved.getHome();

  /* Drawer: home button + saved list. */
  const goHomeBtn = $('go-home-btn');
  if (goHomeBtn) goHomeBtn.hidden = !home;
  const savedWrap = $('saved-wrap'), savedList = $('saved-list');
  if (savedWrap && savedList) {
    savedList.innerHTML = '';
    if (!places.length) { savedWrap.hidden = true; }
    else {
      for (const p of places.slice(0, 8)) {
        const li = document.createElement('li');
        const img = document.createElement('img');
        img.className = 'res-blip'; img.alt = ''; img.src = themeBlipUrl(p.semantic);
        const strong = document.createElement('strong'); strong.textContent = p.label;
        li.append(img, strong);
        li.addEventListener('click', () => {
          dest = { label: p.label, lnglat: p.lnglat.slice(), semantic: p.semantic || null };
          closeDrawer();
          showRoutePending(p.label);
          planRoute({ autostart: true });
        });
        savedList.appendChild(li);
      }
      savedWrap.hidden = false;
    }
  }

  /* Menu: home status + actions + manageable saved list. */
  const homeStatus = $('menu-home-status');
  if (homeStatus) homeStatus.textContent = home ? '⌂ ' + home.label : 'No home set';
  const menuGoHome = $('menu-go-home'), menuClearHome = $('menu-clear-home');
  if (menuGoHome) menuGoHome.hidden = !home;
  if (menuClearHome) menuClearHome.hidden = !home;
  const menuSavedWrap = $('menu-saved-wrap'), menuSavedList = $('menu-saved-list');
  if (menuSavedWrap && menuSavedList) {
    menuSavedList.innerHTML = '';
    if (!places.length) { menuSavedWrap.hidden = true; }
    else {
      for (const p of places) {
        const li = document.createElement('li');
        li.className = 'place-row';
        const name = document.createElement('button');
        name.className = 'place-name';
        name.textContent = (VCNSaved.isHome(p.lnglat) ? '⌂ ' : '') + p.label;
        name.title = 'Navigate';
        name.addEventListener('click', () => {
          closeMenu();
          dest = { label: p.label, lnglat: p.lnglat.slice(), semantic: p.semantic || null };
          showRoutePending(p.label);
          planRoute({ autostart: true });
        });
        const homeBtn = document.createElement('button');
        homeBtn.className = 'place-act';
        homeBtn.textContent = '⌂';
        homeBtn.title = 'Set as home';
        homeBtn.setAttribute('aria-label', 'Set as home');
        homeBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          VCNSaved.setHome({ label: p.label, lnglat: p.lnglat });
          toast('Home set: ' + p.label);
          renderSavedLists();
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'place-act danger';
        delBtn.textContent = '✕';
        delBtn.title = 'Remove';
        delBtn.setAttribute('aria-label', 'Remove saved place');
        delBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          VCNSaved.removePlace(p.id);
          renderSavedLists();
        });
        li.append(name, homeBtn, delBtn);
        menuSavedList.appendChild(li);
      }
      menuSavedWrap.hidden = false;
    }
  }

  /* Menu: custom markers with edit / delete. */
  const menuMarkersWrap = $('menu-markers-wrap'), menuMarkersList = $('menu-markers-list');
  if (menuMarkersWrap && menuMarkersList) {
    const markers = VCNSaved.getMarkers();
    menuMarkersList.innerHTML = '';
    if (!markers.length) { menuMarkersWrap.hidden = true; }
    else {
      for (const m of markers) {
        const li = document.createElement('li');
        li.className = 'place-row';
        const icon = document.createElement('img');
        icon.className = 'place-icon';
        icon.alt = '';
        icon.src = markerIconUrl(m.icon);
        const name = document.createElement('button');
        name.className = 'place-name';
        name.textContent = m.label;
        name.title = 'Navigate';
        name.addEventListener('click', () => {
          closeMenu();
          dest = { label: m.label, lnglat: m.lnglat.slice(), semantic: null };
          showRoutePending(m.label);
          planRoute({ autostart: true });
        });
        const editBtn = document.createElement('button');
        editBtn.className = 'place-act';
        editBtn.textContent = '✎';
        editBtn.title = 'Edit icon / label';
        editBtn.setAttribute('aria-label', 'Edit marker');
        editBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          closeMenu();
          openMarkerSheet(m.lnglat, m.id);
        });
        const delBtn = document.createElement('button');
        delBtn.className = 'place-act danger';
        delBtn.textContent = '✕';
        delBtn.title = 'Remove';
        delBtn.setAttribute('aria-label', 'Remove marker');
        delBtn.addEventListener('click', ev => {
          ev.stopPropagation();
          VCNSaved.removeMarker(m.id);
          renderCustomMarkers();
          renderSavedLists();
        });
        li.append(icon, name, editBtn, delBtn);
        menuMarkersList.appendChild(li);
      }
      menuMarkersWrap.hidden = false;
    }
  }
}

function wireSavedPlaces() {
  const goHomeBtn = $('go-home-btn');
  if (goHomeBtn) goHomeBtn.addEventListener('click', goHome);
  const menuGoHome = $('menu-go-home');
  if (menuGoHome) menuGoHome.addEventListener('click', () => { closeMenu(); goHome(); });
  const menuSetHome = $('menu-set-home');
  if (menuSetHome) menuSetHome.addEventListener('click', async () => {
    if (!window.VCNSaved) return;
    let pos = (typeof userPos !== 'undefined') ? userPos : null;
    if (!pos) {
      try {
        pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(
            p => resolve([p.coords.longitude, p.coords.latitude]),
            reject, { enableHighAccuracy: true, timeout: 9000 });
        });
      } catch (e) { toast('Could not get your location.'); return; }
    }
    VCNSaved.setHome({ label: 'Home', lnglat: pos });
    toast('Home set to your current location.');
    renderSavedLists();
  });
  const menuClearHome = $('menu-clear-home');
  if (menuClearHome) menuClearHome.addEventListener('click', () => {
    if (window.VCNSaved) VCNSaved.clearHome();
    renderSavedLists();
  });
}
/* ---------------- custom markers ----------------
   Long-press the map to drop a pin, pick an icon from the current
   theme's blip pack, optionally label it. Markers are DOM
   maplibregl.Marker pins so they use the theme's PNG art; the icon
   is stored as a semantic key and re-resolved on theme switch. */
const customMarkers = new Map(); // id -> maplibregl.Marker
let pendingPin = null;           // { lnglat } while the picker is open
let editingMarkerId = null;
let pickedIcon = 'waypoint';

function markerIconUrl(iconKey) {
  try {
    return window.VCNThemes
      ? VCNThemes.poiIconUrl(iconKey, VCNThemes.currentId())
      : '';
  } catch (e) { return ''; }
}

function renderCustomMarkers() {
  if (!window.VCNSaved || !map) return;
  // Drop stale markers.
  const live = new Set(VCNSaved.getMarkers().map(m => m.id));
  for (const [id, mk] of customMarkers) {
    if (!live.has(id)) { try { mk.remove(); } catch (e) {} customMarkers.delete(id); }
  }
  // Add / refresh.
  for (const m of VCNSaved.getMarkers()) {
    let mk = customMarkers.get(m.id);
    const url = markerIconUrl(m.icon);
    if (!mk) {
      const el = document.createElement('img');
      el.className = 'custom-marker';
      el.alt = m.label || 'Marker';
      el.src = url;
      el.addEventListener('click', ev => {
        ev.stopPropagation();
        openMarkerDetail(m.id);
      });
      mk = new maplibregl.Marker({ element: el, anchor: 'bottom' });
      mk.setLngLat(m.lnglat).addTo(map);
      customMarkers.set(m.id, mk);
    } else {
      const el = mk.getElement();
      if (el && el.src !== url) el.src = url;
      try { mk.setLngLat(m.lnglat); } catch (e) {}
    }
  }
}

function openMarkerDetail(id) {
  if (!window.VCNSaved) return;
  const m = VCNSaved.getMarkers().find(x => x.id === id);
  if (!m) return;
  // Reuse the POI detail card.
  $('poi-blip').src = markerIconUrl(m.icon);
  $('poi-name').textContent = m.label || 'Marker';
  $('poi-type').textContent = 'Custom marker';
  $('poi-dist').textContent = '';
  openPlanning('poi');
  $('poi-drive').onclick = () => {
    dest = { label: m.label, lnglat: m.lnglat.slice(), semantic: null };
    showRoutePending(m.label); planRoute({ autostart: true });
  };
  $('poi-go').onclick = () => {
    dest = { label: m.label, lnglat: m.lnglat.slice(), semantic: null };
    showRoutePending(m.label); planRoute();
  };
  const saveBtn = $('poi-save'), homeBtn = $('poi-home');
  if (saveBtn) { saveBtn.textContent = 'Change icon'; saveBtn.onclick = () => openMarkerSheet(m.lnglat, m.id); }
  if (homeBtn) { homeBtn.textContent = 'Delete marker'; homeBtn.disabled = false; homeBtn.onclick = () => {
    VCNSaved.removeMarker(m.id);
    renderCustomMarkers(); renderSavedLists();
    closeDrawer();
    toast('Marker removed.');
  }; }
}

/* Icon picker sheet. When markerId is set we are editing that
   marker's icon/label instead of placing a new pin. */
function openMarkerSheet(lnglat, markerId) {
  pendingPin = lnglat ? { lnglat: lnglat.slice() } : null;
  editingMarkerId = markerId || null;
  pickedIcon = 'waypoint';
  const sheet = $('marker-sheet');
  const grid = $('marker-icon-grid');
  const labelInput = $('marker-label');
  if (!sheet || !grid) return;
  let existing = null;
  if (editingMarkerId && window.VCNSaved) {
    existing = VCNSaved.getMarkers().find(x => x.id === editingMarkerId);
    if (existing) pickedIcon = existing.icon || 'waypoint';
  }
  if (labelInput) labelInput.value = existing ? (existing.label || '') : '';
  $('marker-sheet-title').textContent = editingMarkerId ? 'Edit marker' : 'Drop a marker';
  $('marker-save').textContent = editingMarkerId ? 'Save changes' : 'Place marker';
  // Build the icon grid from the current theme's pack.
  grid.innerHTML = '';
  let keys = [];
  try { keys = window.VCNThemes ? VCNThemes.iconKeys() : []; } catch (e) {}
  for (const key of keys) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-pick' + (key === pickedIcon ? ' picked' : '');
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', key === pickedIcon ? 'true' : 'false');
    b.title = key.replace(/_/g, ' ');
    const img = document.createElement('img');
    img.src = markerIconUrl(key);
    img.alt = key;
    b.appendChild(img);
    b.addEventListener('click', () => {
      pickedIcon = key;
      grid.querySelectorAll('.icon-pick').forEach(x => {
        const on = x === b;
        x.classList.toggle('picked', on);
        x.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    });
    grid.appendChild(b);
  }
  sheet.hidden = false;
}

function closeMarkerSheet() {
  const sheet = $('marker-sheet');
  if (sheet) sheet.hidden = true;
  pendingPin = null;
  editingMarkerId = null;
}

function wireMarkerSheet() {
  const closeBtn = $('marker-sheet-close');
  if (closeBtn) closeBtn.addEventListener('click', closeMarkerSheet);
  const saveBtn = $('marker-save');
  if (saveBtn) saveBtn.addEventListener('click', () => {
    if (!window.VCNSaved) { closeMarkerSheet(); return; }
    const label = ($('marker-label').value || '').trim() || 'Marker';
    if (editingMarkerId) {
      VCNSaved.updateMarker(editingMarkerId, { label, icon: pickedIcon });
      toast('Marker updated.');
    } else if (pendingPin) {
      VCNSaved.addMarker({ label, lnglat: pendingPin.lnglat, icon: pickedIcon });
      toast('Marker placed.');
    }
    closeMarkerSheet();
    renderCustomMarkers();
    renderSavedLists();
  });
}

/* Long-press (touch & mouse) on the map drops a pending pin and
   opens the icon picker. Movement beyond a small slop cancels. */
function wireLongPress() {
  if (!map) return;
  const container = map.getContainer();
  let timer = null, startX = 0, startY = 0;
  const SLOPPX = 12, HOLDTIME = 600;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const begin = (x, y) => {
    cancel();
    startX = x; startY = y;
    timer = setTimeout(() => {
      timer = null;
      if (navActive) return; // never interrupt navigation
      try {
        const rect = container.getBoundingClientRect();
        const lnglat = map.unproject([x - rect.left, y - rect.top]);
        openMarkerSheet([lnglat.lng, lnglat.lat], null);
      } catch (e) {}
    }, HOLDTIME);
  };
  container.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) { cancel(); return; }
    begin(e.touches[0].clientX, e.touches[0].clientY);
  }, { passive: true });
  container.addEventListener('touchmove', e => {
    if (!timer) return;
    const t = e.touches[0];
    if (Math.hypot(t.clientX - startX, t.clientY - startY) > SLOPPX) cancel();
  }, { passive: true });
  container.addEventListener('touchend', cancel, { passive: true });
  container.addEventListener('touchcancel', cancel, { passive: true });
  container.addEventListener('mousedown', e => { if (e.button === 0) begin(e.clientX, e.clientY); });
  container.addEventListener('mousemove', e => {
    if (!timer) return;
    if (Math.hypot(e.clientX - startX, e.clientY - startY) > SLOPPX) cancel();
  });
  container.addEventListener('mouseup', cancel);
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
      const semantic = semanticForNominatim(it);
      const img = document.createElement('img');
      img.className = 'res-blip'; img.alt = '';
      img.src = themeBlipUrl(semantic);
      const wrap = document.createElement('div');
      const strong = document.createElement('strong'); strong.textContent = name;
      const small = document.createElement('small'); small.textContent = it.display_name;
      wrap.append(strong, small);
      li.append(img, wrap);
      li.addEventListener('click', () => {
        dest = { label: name, lnglat: [parseFloat(it.lon), parseFloat(it.lat)], semantic };
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

/* ---------------- voice search (speech-to-text) ----------------
   Web Speech API: Chrome/Android (the car) supports it. Where the
   browser has no SpeechRecognition (e.g. iOS Safari) the mic button
   hides itself instead of failing. */
let voiceRec = null, voiceListening = false;
function wireVoiceSearch() {
  const btn = $('voice-search-btn'), input = $('search');
  if (!btn || !input) return;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { btn.hidden = true; return; }
  btn.addEventListener('click', () => {
    if (voiceListening) { try { voiceRec.stop(); } catch (e) {} return; }
    const rec = new SR();
    voiceRec = rec;
    rec.lang = 'en-IE';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = e => {
      let text = '';
      for (const r of e.results) text += r[0].transcript;
      input.value = text;
      const last = e.results[e.results.length - 1];
      if (last.isFinal) { const q = text.trim(); if (q) runSearch(q); }
    };
    rec.onerror = e => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
        toast('Microphone blocked — allow it in the browser site settings.');
      else if (e.error === 'no-speech') toast('Didn’t catch that — tap the mic and try again.');
      else if (e.error !== 'aborted') toast('Voice search isn’t available right now.');
    };
    rec.onend = () => {
      voiceListening = false; voiceRec = null;
      btn.classList.remove('listening');
      input.placeholder = 'Search places…';
    };
    voiceListening = true;
    btn.classList.add('listening');
    input.placeholder = 'Listening…';
    try { rec.start(); } catch (e) { rec.onend(); }
  });
}
function stopVoiceSearch() {
  if (voiceListening && voiceRec) { try { voiceRec.stop(); } catch (e) {} }
}

/* ---------------- routing ---------------- */
async function osrmRoute(from, to) {
  const url = `${OSRM}/${from[0]},${from[1]};${to[0]},${to[1]}?overview=full&geometries=geojson&steps=true`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes || !data.routes.length) throw new Error('no route');
  return data.routes[0];
}
function routeTheme() {
  const t = wsTheme();
  const m = (t && t.map) || {};
  const core = m.routeColor || '#f5d020';
  return {
    core,
    casing: m.routeCasingColor || '#f5d020',
    width: m.routeWidth || 5,
    casingWidth: m.routeCasingWidth || 9,
    dash: m.routeDash || null,
    glow: m.routeGlowColor || core,
    glowOpacity: m.routeGlowOpacity != null ? m.routeGlowOpacity : 0.35,
  };
}
function ensureRouteLayers() {
  if (map.getSource('vcn-route')) return;
  const rt = routeTheme();
  map.addSource('vcn-route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'vcn-route-glow', type: 'line', source: 'vcn-route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': rt.glow, 'line-width': rt.casingWidth + 12,
      'line-opacity': rt.glowOpacity, 'line-blur': 8
    }
  });
  map.addLayer({
    id: 'vcn-route-casing', type: 'line', source: 'vcn-route',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': rt.casing, 'line-width': rt.casingWidth, 'line-opacity': 0.95 }
  });
  map.addLayer({
    id: 'vcn-route-core', type: 'line', source: 'vcn-route',
    layout: {
      'line-cap': 'round', 'line-join': 'round',
      ...(rt.dash ? { 'line-dasharray': rt.dash } : {}),
    },
    paint: { 'line-color': rt.core, 'line-width': rt.width }
  });
}
/* Re-apply the active theme's route paint (used after theme switches). */
function paintRouteTheme() {
  if (!map || !map.getLayer('vcn-route-core')) return;
  const rt = routeTheme();
  map.setPaintProperty('vcn-route-glow', 'line-color', rt.glow);
  map.setPaintProperty('vcn-route-glow', 'line-width', rt.casingWidth + 12);
  map.setPaintProperty('vcn-route-glow', 'line-opacity', rt.glowOpacity);
  map.setPaintProperty('vcn-route-casing', 'line-color', rt.casing);
  map.setPaintProperty('vcn-route-casing', 'line-width', rt.casingWidth);
  map.setPaintProperty('vcn-route-core', 'line-color', rt.core);
  map.setPaintProperty('vcn-route-core', 'line-width', rt.width);
}
function drawRoute() {
  ensureRouteLayers();
  map.getSource('vcn-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeCoords }, properties: {} });
  if (destMarker) destMarker.remove();
  const el = document.createElement('div'); el.className = 'dest-pin';
  el.style.backgroundImage = `url('${destBlipUrl()}')`;
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
    // Live traffic routing when the toggle is ON and a TomTom key is set;
    // any TomTom failure falls back to OSRM silently for that request.
    let route = null, trafficDelayMin = 0;
    const trafficOn = !!(window.VCNTraffic && VCNTraffic.shouldRouteWithTraffic());
    if (trafficOn) {
      try { route = await VCNTraffic.route(from, dest.lnglat); }
      catch (e) { console.warn('[ws] tomtom routing failed, OSRM fallback', e); }
    }
    if (!route) route = await osrmRoute(from, dest.lnglat);
    routeCoords = route.geometry.coordinates;
    steps = buildSteps(route);
    totalDist = route.distance; totalDur = route.duration;
    if (trafficOn && window.VCNTraffic) trafficDelayMin = Math.round((VCNTraffic.lastDelaySec() || 0) / 60);
    drawRoute();
    saveRecent(dest);
    if (autostart) { startNav(); return; }
    $('dest-label').textContent = (dest && dest.label) || 'Destination';
    $('route-dist').textContent = fmtDist(totalDist);
    $('route-time').textContent = trafficDelayMin > 0
      ? `${Math.round(totalDur / 60)} min (+${trafficDelayMin} traffic)`
      : `${Math.round(totalDur / 60)} min`;
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
  /* Places driven to are saved — the curated list, not just recents. */
  try {
    if (window.VCNSaved && dest && dest.label && Array.isArray(dest.lnglat)) {
      VCNSaved.savePlace({ label: dest.label, lnglat: dest.lnglat, semantic: dest.semantic || null });
      renderSavedLists();
    }
  } catch (e) { /* saved places must never break navigation */ }
  if (discoveryOn) setDiscovery(false); // fog never shows during navigation
  setUiMode('drive');
  setFollow(true);
  enableCompass(); // map follows the direction the user faces, not just GPS travel
  updateBanner();
  const first = steps[0];
  // The opening announcement briefly waits for the persona voice (up to 5s)
  // so the route doesn't open with the robot and switch to the DJ mid-drive.
  speak(`Starting navigation. ${instrText(first)}. Total ${speakDist(totalDist)}.`, { awaitThemed: true });
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
  syncDashTrip();
  try { const vc = $('vc-maneuver'); if (vc) vc.hidden = true; } catch (e) {}
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  /* Hand the GPS watch back to the passive speed feed so the readout keeps
     working after the route ends (dashboard speedo or cluster hero). */
  if (speedDisplayActive() && 'geolocation' in navigator) {
    try {
      watchId = navigator.geolocation.watchPosition(onPos, onPosErr,
        { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
    } catch (e) {}
  }
  resetWanted(); // drive's over: the heat dies with it
  syncClusterTurn(null);
  syncClusterTrip(null, null);
  if (window.VCNVoice) VCNVoice.cancel();
  setUiMode('explore');
  if (map) {
    if (map.getSource('vcn-route')) map.getSource('vcn-route').setData({ type: 'FeatureCollection', features: [] });
    if (destMarker) { destMarker.remove(); destMarker = null; }
    map.easeTo({ pitch: 0, duration: 600 });
  }
  routeCoords = []; steps = []; stepIdx = 0;
  try { const mc2 = $('maneuver-card'); if (mc2) mc2.classList.remove('has-maneuver'); } catch (e) {}
  try { const tm = $('trip-meta'); if (tm) tm.textContent = ''; } catch (e) {}
}
function onPosErr() { /* keep last known position; toast once */ }

function onPos(pos) {
  const p = [pos.coords.longitude, pos.coords.latitude];
  userPos = p; placeUserMarker();
  // Passive discovery tracking — no network, runs in every mode.
  // The fog itself is only *shown* in Discovery Mode (never while driving).
  if (window.VCNDiscovery) VCNDiscovery.reveal(p);
  if (window.VCNPlaces) VCNPlaces.maybeRefresh(p); // ambient POIs, 750 m gated

  // --- heading bookkeeping (every mode, not just navigation) ---
  const now = Date.now();
  let heading = null;
  const cSpeed = pos.coords.speed;
  if (lastPos) {
    const dt = (pos.timestamp - lastPos.t) / 1000;
    const d = haversine(lastPos.p, p);
    if (dt > 0 && d > 4) {
      const v = d / dt;
      setGpsSpeed(cSpeed, v, dt); // validated: wild coords.speed spikes are refused
      if (v > 1.5) {
        heading = Math.atan2(p[0] - lastPos.p[0], p[1] - lastPos.p[1]) * 180 / Math.PI;
        gpsCourse = heading; gpsCourseAt = now;
      }
    } else if (typeof cSpeed === 'number' && !isNaN(cSpeed)) {
      // barely moved: displacement (~0) anchors the validation
      setGpsSpeed(cSpeed, d / Math.max(dt, 1), dt);
    }
  } else if (typeof cSpeed === 'number' && !isNaN(cSpeed)) {
    setGpsSpeed(cSpeed, 0, 1); // first fix: no displacement yet, extra-strict cross-check
  }
  lastPos = { p, t: pos.timestamp };
  if (heading !== null) lastHeading = heading; // GPS travel heading wins when moving
  else if (!clearlyMoving() && compassHeading !== null) lastHeading = compassHeading; // compass when slow
  updatePlayerArrow();
  /* Cluster minimap stays heading-up while driving: GPS course owns the
     bearing when moving (the compass handler above covers slow/stationary).
     Throttled and yields to manual camera moves, like the nav follow cam. */
  if (clusterLayoutActive() && !navActive && followMode && map && heading !== null) {
    let dh = Math.abs(heading - map.getBearing()) % 360;
    if (dh > 180) dh = 360 - dh;
    if (now - lastCamMove > 900 && now - lastBearingPush > 500 && dh > 3) {
      lastBearingPush = now;
      try { map.easeTo({ bearing: heading, duration: 300 }); } catch (err) {}
      syncRadarNorth(heading, 300);
    }
  }
  updateSpeedo(); // live speed readout (dashboard)
  maybeFetchSpeedLimit(pos.coords.latitude, pos.coords.longitude); // posted limit
  // wanted level: tick heat from the GPS speed
  const wNow = Date.now();
  if (wantedLastAt) wantedTick(Math.min(5, (wNow - wantedLastAt) / 1000));
  wantedLastAt = wNow;

  if (!navActive || !steps.length) return;

  // camera follow
  if (followMode && now - lastCamMove > 900 && map) {
    lastCamMove = now;
    const camBearing = bestBearing(heading);
    /* The VC cluster radar loses the rectangle's corners, so it rides a
       touch wider than the dashboard follow cam. Dashboard untouched. */
    map.easeTo({ center: p, zoom: clusterLayoutActive() ? 16.2 : 16.5, pitch: 55,
      bearing: camBearing, duration: 900 });
    syncRadarNorth(camBearing, 900);
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
    let route = null;
    const trafficOn = !!(window.VCNTraffic && VCNTraffic.shouldRouteWithTraffic());
    if (trafficOn) {
      try { route = await VCNTraffic.route(userPos, dest.lnglat); }
      catch (e) { console.warn('[ws] tomtom reroute failed, OSRM fallback', e); }
    }
    if (!route) route = await osrmRoute(userPos, dest.lnglat);
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
    speak(`New route. ${instrText(steps[0])}.`, { awaitThemed: true });
  } catch (e) { toast('Reroute failed — staying on current route.'); }
  rerouting = false;
}
function drawRouteKeepView() {
  ensureRouteLayers();
  map.getSource('vcn-route').setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: routeCoords }, properties: {} });
}

function updateBanner(dMan) {
  /* Idle state: the maneuver card stays hidden until a real maneuver
     exists — never two literal "—" dashes (GTA V hides the card via
     the .has-maneuver hook in its theme CSS; other themes unaffected). */
  const mc = $('maneuver-card');
  if (mc) mc.classList.toggle('has-maneuver', steps.length > 0);
  if (!steps.length) return;
  const nextIdx = Math.min(stepIdx + 1, steps.length - 1);
  const next = steps[nextIdx];
  if (dMan === undefined) dMan = userPos ? haversine(userPos, next.loc) : next.dist;

  $('maneuver-arrow').innerHTML = arrowSvg(arrowKind(next.maneuver));
  $('next-dist').textContent = fmtDist(dMan);
  /* dashboard hero: the card shows the clean road name; the full spoken
     instruction stays in instrText() for voice. */
  $('next-instr').textContent = roadName(next) || instrText(next);

  const remainDist = steps.slice(nextIdx).reduce((a, s) => a + s.dist, 0) + dMan;
  const remainDur = totalDur * (totalDist ? remainDist / totalDist : 0);
  $('trip-meta').textContent = `${fmtDist(remainDist)} to go • arrive ${etaString(remainDur)}`;
  const ns = $('next-stats');
  if (ns) ns.innerHTML = `<span class="ns-min">${Math.max(1, Math.round(remainDur / 60))} min</span>` +
    `<span class="ns-sep"> • </span><span>${fmtDist(remainDist)}</span>` +
    `<span class="ns-sep"> • </span><span>${etaString(remainDur)}</span>`;
  syncDashTrip(remainDur);
  syncClusterTrip(remainDist, remainDur);
  /* VC dashboard hero card: same live data, no fakes. */
  try {
    const vc = $('vc-maneuver');
    if (vc) {
      vc.hidden = false;
      const vd = $('vc-man-dist'); if (vd) vd.textContent = fmtDist(dMan);
      const vr = $('vc-man-road'); if (vr) vr.textContent = roadName(next) || instrText(next);
      const ve = $('vc-man-eta'); if (ve) ve.textContent = Math.max(1, Math.round(remainDur / 60)) + ' min';
      const vm = $('vc-man-remain'); if (vm) vm.textContent = fmtDist(remainDist);
      const va = $('vc-man-arrive'); if (va) va.textContent = etaString(remainDur);
    }
  } catch (e) {}
  syncClusterTurn(currentTurnData());
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
  /* Dashboard car chrome (top/bottom bars) is drive-mode chrome only:
     it shows for every theme while navigating, never outside drive mode. */
  document.body.classList.toggle('nav-driving', mode === 'drive');
  try { if (window.map) syncDashPadding(); } catch (e) {}
  if (mode === 'drive') closeMenu();
}
function openPlanning(view) {
  closeMenu();
  setUiMode('planning');
  layoutDashDrawer(); // dock the drawer to the live stage rect in dashboard mode
  $('poi-detail').hidden = view !== 'poi';
  if (view !== 'route') $('route-card').hidden = true;
  if (view === 'search') {
    // Synchronous focus inside the tap gesture so the mobile keyboard
    // opens immediately — a deferred focus won't.
    const s = $('search');
    renderSavedLists();
    if (s.value.trim().length >= 3) $('recent-wrap').hidden = true;
    else renderRecents();
    if (s) s.focus({ preventScroll: true });
  }
}
function closeDrawer() {
  stopVoiceSearch();
  setUiMode(navActive ? 'drive' : 'explore');
}
function openMenu() {
  $('menu-panel').hidden = false;
  try { syncDiscoveryStats(); } catch (e) { /* menu must always open */ }
  try { renderSavedLists(); } catch (e) { /* menu must always open */ }
}
function closeMenu() { $('menu-panel').hidden = true; }

/* ---------------- App mode: normal | dashboard | cluster ----------------
   The Spotify player is a DASHBOARD feature. In normal (mobile)
   mode the map is full-screen and Spotify lives only in the menu
   (connect / disconnect). Dashboard mode is an explicit app mode —
   never inferred from screen width alone — forced with the
   "Dashboard Preview" menu option, ?dashboard=1 (persisted), or
   WayStation.setAppMode('dashboard') so a future Android/Android
   Auto host can flip it directly.

   CLUSTER mode is a third presentation mode: a minimal driving HUD /
   instrument display (huge speed, limit, next manoeuvre, small minimap,
   small now-playing) reusing the exact same live state — no second map,
   no second watchers, no duplicated Spotify polling. Forced with
   ?cluster=1 (wins over the persisted preference, never persisted
   itself) or WayStation.setAppMode('cluster'). The car session
   (?car=1) still forces dashboard and never writes the stored
   preference, so phone/PWA mode stays independent.

   The dashboard is ONE implementation: a fixed 1920×720 automotive
   reference canvas (#dash-stage). On a real car display it renders at
   zoom 1; everywhere else JS zooms the whole canvas proportionally to
   fit the window, so Dashboard Preview on a phone or desktop shows the
   exact same layout, HUD, theme, controls and state. The map fills the
   entire canvas — no column is reserved for music. The Spotify widget
   is a single floating overlay object above the full-screen map: the
   widget artwork defines its silhouette and transparent areas reveal
   the map. The MapLibre instance is never recreated, only resized.
   Route, markers, POIs, discovery, voice and the Spotify session all
   survive the switch. */
const APP_MODE_KEY = 'ws.appMode';
const WX_CACHE_KEY = 'vcn.wx.last'; // last-known dashboard weather
let appMode = 'normal'; // normal | dashboard | cluster

/* Pure app-mode logic (DOM-free; unit-tested in tools/theme_tests.js).
   Precedence: car session > ?cluster=1 > ?dashboard= > persisted choice.
   ?cluster=1 wins over a persisted dashboard/normal and is never treated
   as a persisted choice itself — callers decide what to persist. */
function parseAppMode(search, car, stored) {
  if (car) return 'dashboard';
  let cluster = null, dash = null;
  try {
    const q = new URLSearchParams(search);
    cluster = q.get('cluster');
    dash = q.get('dashboard');
  } catch (e) { /* malformed query: fall through to stored */ }
  if (cluster === '1') return 'cluster';
  if (dash === '1') return 'dashboard';
  if (dash === '0') return 'normal';
  return stored === 'dashboard' || stored === 'cluster' ? stored : 'normal';
}

/* Body-class flags for a mode. Dashboard and cluster are mutually
   exclusive by construction; normal sets neither. */
function modeBodyFlags(mode) {
  return { dashboard: mode === 'dashboard', cluster: mode === 'cluster' };
}

/* True when the driving speed readout should be live: the dashboard
   speedo or the cluster hero number. One passive GPS watch serves both. */
function speedDisplayActive() {
  return appMode === 'dashboard' || appMode === 'cluster';
}

function clusterLayoutActive() {
  return appMode === 'cluster';
}

function initAppMode() {
  try {
    const q = new URLSearchParams(location.search);
    const car = !!window.__WAYSTATION_CAR;
    let stored = null;
    try { stored = localStorage.getItem(APP_MODE_KEY); } catch (e) {}
    appMode = parseAppMode(location.search, car, stored);
    /* Persist explicit URL choices for dashboard/normal only. ?cluster=1
       and the car session never write the stored preference. */
    if (!car && q.get('cluster') !== '1') {
      const param = q.get('dashboard');
      if (param === '1') localStorage.setItem(APP_MODE_KEY, 'dashboard');
      else if (param === '0') localStorage.setItem(APP_MODE_KEY, 'normal');
    }
  } catch (e) { appMode = 'normal'; }
}

/* True when dashboard was explicitly requested. No viewport detection:
   forcing appMode='dashboard' is the whole point of Dashboard Preview. */
function dashboardLayoutActive() {
  return appMode === 'dashboard';
}

/* Fixed 1920×720 canvas. The dashboard surface (map, HUD chrome, music
   pane) is reparented into #dash-stage and authored in 1920×720
   coordinates; the stage is zoomed to fit the window. Menus, drawers
   and toasts stay at body level so they remain usable at any scale. */
const DASH_W = 1920, DASH_H = 720;
const DASH_STAGE_NODES = ['map', 'fx', 'explore-ui', 'drive-hud', 'spotify-pane', 'dash-topbar', 'dash-bottombar', 'sa-grove-panel', 'speedo', 'wanted'];
/* NOTE: #menu-panel is deliberately NOT reparented into the stage — it
   stays at body level so it never shrinks with the stage zoom. */

/* Dashboard bar heights in 1920×720 stage coordinates, per theme. The
   body-level menu panel must dock clear of the bars in REAL pixels, so
   layoutDashMenu() scales these by the live stage zoom. */
const DASH_BAR_HEIGHTS = {
  'vice-city':   { top: 76, bottom: 100 },
  'san-andreas': { top: 126, bottom: 126 },
  'gta-v':       { top: 120, bottom: 120 },
  'rdr2':        { top: 104, bottom: 84 },
};

/* Dock the body-level menu panel against the LIVE dashboard stage rect.
   Fixed stage-coordinate CSS can't place this panel: on any window where
   the stage is letterboxed or zoomed below 1, stage-coordinate offsets
   land on top of the dash bars / off the visible canvas. This positions
   the panel inside the visible stage, clear of the current theme's real
   bar heights, in real CSS pixels. Runs on stage fit, theme commit and
   mode switch; clears its inline geometry outside dashboard mode. */
function layoutDashMenu() {
  const panel = $('menu-panel');
  if (!panel) return;
  if (!dashboardLayoutActive()) {
    panel.style.left = ''; panel.style.top = '';
    panel.style.bottom = ''; panel.style.width = '';
    return;
  }
  const stage = $('dash-stage');
  let r = null;
  try { r = stage && stage.getBoundingClientRect(); } catch (e) {}
  if (!r || !r.width) return; // stage not built yet; CSS fallback applies
  const s = r.width / DASH_W; // live stage zoom (zoom or transform scale)
  const bars = DASH_BAR_HEIGHTS[wsThemeId()] || DASH_BAR_HEIGHTS['vice-city'];
  const pad = 12;
  panel.style.left = Math.max(0, r.left + pad) + 'px';
  panel.style.top = (r.top + (bars.top + pad) * s) + 'px';
  panel.style.width = Math.max(300, Math.min(540, r.width - pad * 2)) + 'px';
  const bottomClear = (bars.bottom + pad) * s;
  panel.style.bottom = Math.max(0, window.innerHeight - (r.bottom - bottomClear)) + 'px';
}

/* Dock the body-level planning drawer (search / results / route preview)
   the same way: it is deliberately not reparented into the scaled stage,
   so fixed offsets would land it in the letterbox or under the dash bars.
   Real CSS pixels, clear of the current theme's bar heights. */
function layoutDashDrawer() {
  const drawer = $('drawer');
  if (!drawer) return;
  if (!dashboardLayoutActive()) {
    drawer.style.left = ''; drawer.style.top = '';
    drawer.style.bottom = ''; drawer.style.width = '';
    return;
  }
  const stage = $('dash-stage');
  let r = null;
  try { r = stage && stage.getBoundingClientRect(); } catch (e) {}
  if (!r || !r.width) return; // stage not built yet; CSS fallback applies
  const s = r.width / DASH_W; // live stage zoom (zoom or transform scale)
  const bars = DASH_BAR_HEIGHTS[wsThemeId()] || DASH_BAR_HEIGHTS['vice-city'];
  const pad = 12;
  drawer.style.left = Math.max(0, r.left + pad) + 'px';
  drawer.style.top = (r.top + (bars.top + pad) * s) + 'px';
  drawer.style.width = Math.max(320, Math.min(560, r.width - pad * 2)) + 'px';
  const bottomClear = (bars.bottom + pad) * s;
  drawer.style.bottom = Math.max(0, window.innerHeight - (r.bottom - bottomClear)) + 'px';
}

function buildDashboardStage() {
  let stage = $('dash-stage');
  if (stage) return stage;
  stage = document.createElement('div');
  stage.id = 'dash-stage';
  document.body.appendChild(stage);
  for (const id of DASH_STAGE_NODES) {
    const n = $(id);
    if (!n || n.parentNode === stage) continue;
    n._dashHome = { parent: n.parentNode, next: n.nextSibling };
    stage.appendChild(n);
  }
  return stage;
}

function teardownDashboardStage() {
  const stage = $('dash-stage');
  if (!stage) return;
  for (const id of DASH_STAGE_NODES) {
    const n = $(id);
    const home = n && n._dashHome;
    if (n && home && home.parent) {
      const next = (home.next && home.next.parentNode === home.parent) ? home.next : null;
      home.parent.insertBefore(n, next);
      delete n._dashHome;
    }
  }
  stage.remove();
}

function fitDashboardStage() {
  const stage = $('dash-stage');
  if (!stage) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const s = Math.min(1, vw / DASH_W, vh / DASH_H);
  if (s > 0 && 'zoom' in stage.style) {
    stage.style.transform = '';
    stage.style.zoom = String(s);
  } else {
    stage.style.zoom = '';
    stage.style.transform = 'scale(' + s + ')';
    stage.style.transformOrigin = 'top left';
  }
  stage.style.left = ((vw - DASH_W * s) / 2) + 'px';
  stage.style.top = ((vh - DASH_H * s) / 2) + 'px';
  layoutDashMenu(); // re-dock the body-level menu panel to the new stage rect
  layoutDashDrawer(); // and the planning drawer
}

/* ---------------- cluster stage: fixed 1920x720 canvas ----------------
   Mirrors the dashboard stage: #map and #spotify-pane are reparented into
   #cluster-ui (the 1920x720 canvas) on entry and restored to their homes on
   exit, so the cluster always keeps the dashboard's aspect ratio no matter
   the screen. Children are stage-absolute (see styles.css); JS only zooms
   and centers the canvas, exactly like fitDashboardStage. */
const CLUSTER_W = 1920, CLUSTER_H = 720;
const CLUSTER_STAGE_NODES = ['map', 'spotify-pane', 'dash-topbar', 'dash-bottombar'];
function buildClusterStage() {
  const stage = $('cluster-ui');
  if (!stage) return stage;
  for (const id of CLUSTER_STAGE_NODES) {
    const n = $(id);
    if (!n || n.parentNode === stage) continue;
    n._clusterHome = { parent: n.parentNode, next: n.nextSibling };
    stage.appendChild(n);
  }
  return stage;
}
function teardownClusterStage() {
  for (const id of CLUSTER_STAGE_NODES) {
    const n = $(id);
    const home = n && n._clusterHome;
    if (n && home && home.parent) {
      const next = (home.next && home.next.parentNode === home.parent) ? home.next : null;
      home.parent.insertBefore(n, next);
      delete n._clusterHome;
    }
  }
}
function fitClusterStage() {
  const ui = $('cluster-ui');
  if (!ui) return;
  const vw = window.innerWidth, vh = window.innerHeight;
  const s = Math.min(1, vw / CLUSTER_W, vh / CLUSTER_H);
  if (s > 0 && 'zoom' in ui.style) {
    ui.style.transform = '';
    ui.style.zoom = String(s);
  } else {
    ui.style.zoom = '';
    ui.style.transform = 'scale(' + s + ')';
    ui.style.transformOrigin = 'top left';
  }
  ui.style.left = ((vw - CLUSTER_W * s) / 2) + 'px';
  ui.style.top = ((vh - CLUSTER_H * s) / 2) + 'px';
}

/* The Vice City widget floats over the right of the map, so the camera's
   effective viewport is offset left: "center on me" (and follow mode, and
   route fit) targets the middle of the visible map — between the left
   margin and the widget — never the raw screen center. The map itself is
   never resized; this only shifts the camera target point. */
function syncDashPadding() {
  /* NOTE: window.map is the #map container DIV (browsers expose id="map" as
     a named global); the MapLibre instance is the module-scope `map`. The
     old guard checked window.map and its setPadding test failed on the div,
     so this function silently early-returned forever and the padding never
     applied. Check the real instance. */
  const m = map;
  if (!m || typeof m.setPadding !== 'function') return;
  const b = document.body.classList;
  // Dash bars are always visible in dashboard mode (every theme), so
  // keep the camera target clear of them whether driving or exploring.
  const dash = b.contains('dashboard-mode');
  // The music widget floats on the right of the stage in dashboard mode.
  // The user asked repeatedly for the recenter target to sit between the
  // left margin and the START of the music widget, not the raw screen
  // center — so the right padding clears each theme's authored widget
  // geometry (px on the 1920-wide stage). The radio tab hides the widget
  // for a full-bleed map, so no widget padding applies then.
  const widgetHidden = !dash || b.contains('radio-off');
  let right = 8;
  if (!widgetHidden) {
    if (b.contains('theme-vice-city')) right = 765;       // .vcsp: right:110px, width:687px
    else if (b.contains('theme-san-andreas')) right = 701; // .sasp: left:1219px, width:701px
    else if (b.contains('theme-gta-v')) right = 568;      // .gvsp: right:48px, width:520px
    else if (b.contains('theme-rdr2')) right = 670;       // .rdsp: right:70px, width:600px
  }
  if (dash) {
    // Bar clearances come from the shared per-theme table (stage coords) so
    // the camera target clears every theme's real bars, not just VC's.
    const themeId = (window.VCNThemes && VCNThemes.currentId()) || 'vice-city';
    const bars = DASH_BAR_HEIGHTS[themeId] || { top: 76, bottom: 88 };
    m.setPadding({ top: bars.top, right: right, bottom: bars.bottom, left: 8 });
  }
  else m.setPadding({ top: 0, right: 0, bottom: 0, left: 0 });
}

function applyAppMode() {
  const dash = dashboardLayoutActive();
  const clu = clusterLayoutActive();
  const flags = modeBodyFlags(appMode);
  document.body.classList.toggle('dashboard-mode', flags.dashboard);
  document.body.classList.toggle('cluster-mode', flags.cluster);
  /* Stage lifecycle: tear down the stage we're leaving BEFORE building the
     one we're entering. A build records each node's pre-stage home; if the
     old stage were torn down after the new build, its stale home would yank
     the shared map/Spotify nodes right back out of the new stage. */
  teardownClusterStage();
  teardownDashboardStage();
  if (dash) { try { window.scrollTo(0, 0); } catch (e) {}
    buildDashboardStage(); fitDashboardStage(); }
  if (clu) { buildClusterStage(); fitClusterStage(); }
  const cui = $('cluster-ui');
  if (cui) cui.hidden = !clu;
  if (clu) refreshClusterLive();
  else stopClusterClock();
  layoutDashMenu(); // dock (or undock) the body-level menu panel
  layoutDashDrawer(); // dock (or undock) the planning drawer
  const pane = $('spotify-pane');
  /* One SpotifyCore session; the skin is per layout — SA cluster mounts
     its own compact widget into the background's boxes. */
  const spotVisible = dash || clu;
  if (pane) pane.hidden = !spotVisible;
  if (spotVisible) mountSpotifySkin(wsThemeId());
  else unmountSpotifySkin();
  if (dash) {
    document.body.classList.remove('radio-off');
    setDashTab('map');
    tickDashClock(); refreshDashWeather(); syncDashTrip(); queueDashLocality();
  }
  /* One passive GPS watch serves the dashboard speedo and the cluster hero
     number alike (and heading/POIs outside nav). Navigation restarts this
     same watch with its own options; endNav hands it back here so the speed
     readout keeps living after a route ends. Never a second watcher. */
  if (speedDisplayActive()) {
    if (watchId === null && 'geolocation' in navigator) {
      try {
        watchId = navigator.geolocation.watchPosition(onPos, onPosErr,
          { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 });
      } catch (e) {}
    }
  } else if (watchId !== null) {
    try { navigator.geolocation.clearWatch(watchId); } catch (e) {} watchId = null;
  }
  if (!dash) {
    const sp = $('speedo'); if (sp) sp.hidden = true;
    resetWanted();
  }
  if (map && map.resize) { try { map.resize(); } catch (e) {} }
  syncDashPadding();
  try { applyDashboardMapPaint(); } catch (e) {}
  syncModeSelector();
  return dash;
}

function setAppMode(mode) {
  const next = mode === 'dashboard' ? 'dashboard' : mode === 'cluster' ? 'cluster' : 'normal';
  const flags = modeBodyFlags(next);
  if (next === appMode &&
      document.body.classList.contains('dashboard-mode') === flags.dashboard &&
      document.body.classList.contains('cluster-mode') === flags.cluster) {
    syncModeSelector();
    return dashboardLayoutActive();
  }
  appMode = next;
  try { localStorage.setItem(APP_MODE_KEY, appMode); } catch (e) {}
  return applyAppMode();
}
window.WayStation = window.WayStation || {};
window.WayStation.setAppMode = setAppMode;
window.WayStation.getAppMode = () => appMode;
window.WayStation.dashboardActive = dashboardLayoutActive;
window.WayStation.clusterActive = clusterLayoutActive;

/* ---------------- car-mode bridge (?car=1) ----------------
   The Android Auto native shell renders this exact dashboard inside a
   WebView on the car Surface (see android/). It drives the car through
   this tiny bridge — no second dashboard, no native UI rewrite:

   - setVisibleArea / setStableArea: rects forwarded from the host's
     onVisibleAreaChanged / onStableAreaChanged, exposed as CSS vars
     (--car-visible-*, --car-stable-*) so chrome can stay clear of any
     host overlay without redesigning the dashboard.
   - setSpotifyAuth: thin token handoff — the native shell performs the
     Spotify PKCE flow once (Custom Tab on the phone) and hands the
     {access_token, refresh_token, expires_at} JSON here; it lands in the
     exact localStorage key the web auth flow uses, then the core reloads.
   - getState: nav/spotify/theme snapshot polled by the native shell so
     Android Auto knows a navigation session is active.
   - The native shell also injects window.WayStationCarNative (a
     JavascriptInterface); feature-detect it, never assume it. */
function installCarBridge() {
  if (!window.__WAYSTATION_CAR) return;
  const root = document.documentElement;
  function setAreaVars(prefix, r) {
    if (!r) return;
    try {
      root.style.setProperty('--car-' + prefix + '-left', r.left + 'px');
      root.style.setProperty('--car-' + prefix + '-top', r.top + 'px');
      root.style.setProperty('--car-' + prefix + '-right', r.right + 'px');
      root.style.setProperty('--car-' + prefix + '-bottom', r.bottom + 'px');
    } catch (e) {}
  }
  window.WayStationCar = {
    isCar: function () { return true; },
    setVisibleArea: function (r) { setAreaVars('visible', r); },
    setStableArea: function (r) { setAreaVars('stable', r); },
    setSpotifyAuth: function (json) {
      try {
        const auth = (typeof json === 'string') ? JSON.parse(json) : json;
        if (!auth || !auth.refresh_token) return false;
        localStorage.setItem('vcn.spotify.auth', JSON.stringify(auth));
        if (window.SpotifyCore && SpotifyCore.reloadAuth) SpotifyCore.reloadAuth();
        return true;
      } catch (e) { return false; }
    },
    isSpotifyConnected: function () {
      return !!(window.SpotifyCore && SpotifyCore.isConnected && SpotifyCore.isConnected());
    },
    // Host stop-navigation (Android Auto): end the route, the voice and the
    // driving state exactly like the in-app stop. Navigation state stays
    // in JS — the native side only forwards the request.
    stopNavigation: function () {
      try {
        if (typeof navActive !== 'undefined' && navActive &&
            typeof endNav === 'function') endNav();
        return true;
      } catch (e) { return false; }
    },
    getState: function () {
      let theme = null, nav = false;
      try { theme = (typeof wsThemeId === 'function') ? wsThemeId() : null; } catch (e) {}
      try { nav = (typeof navActive !== 'undefined') ? !!navActive : false; } catch (e) {}
      return { car: true, theme: theme, navActive: nav,
               spotify: this.isSpotifyConnected() };
    },
  };
  try { document.body.classList.add('car-mode'); } catch (e) {}
  try {
    root.style.setProperty('--car-visible-left', '0px');
    root.style.setProperty('--car-visible-top', '0px');
    root.style.setProperty('--car-visible-right', '100%');
    root.style.setProperty('--car-visible-bottom', '100%');
  } catch (e) {}
}

/* ---------------- dashboard car chrome: top status bar + bottom menu --------
   The head-unit bars from the visual benchmark: live weather + clock up top,
   MAP / RADIO / PHONE / VEHICLE / SETTINGS tabs plus zoom in the bottom bar.
   PHONE drops back to the phone UI; RADIO toggles the music widget. */
const DASH_WX_SVG = {
  sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.5 4.5l2 2M17.5 17.5l2 2M19.5 4.5l-2 2M6.5 17.5l-2 2"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 18a4.5 4.5 0 1 1 .8-8.93A6 6 0 0 1 19.5 11 3.75 3.75 0 0 1 18.5 18H7z"/></svg>',
  rain: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 14a4.5 4.5 0 1 1 .8-8.93A6 6 0 0 1 19.5 7 3.75 3.75 0 0 1 18.5 14H7z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/></svg>',
  snow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 14a4.5 4.5 0 1 1 .8-8.93A6 6 0 0 1 19.5 7 3.75 3.75 0 0 1 18.5 14H7z"/><path d="M12 17v4M10 19l4-4M14 19l-4-4"/></svg>',
  fog: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10h16M6 14h14M4 18h16M8 6h10"/></svg>',
  storm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 13a4.5 4.5 0 1 1 .8-8.93A6 6 0 0 1 19.5 6 3.75 3.75 0 0 1 18.5 13H7z"/><path d="M12 13l-3 6h5l-2 4" stroke-linejoin="round"/></svg>'
};
function dashWxIcon(code) {
  const c = Number(code);
  if (c === 0 || c === 1) return DASH_WX_SVG.sun;
  if (c === 2 || c === 3) return DASH_WX_SVG.cloud;
  if (c === 45 || c === 48) return DASH_WX_SVG.fog;
  if ((c >= 51 && c <= 57) || (c >= 61 && c <= 65) || (c >= 80 && c <= 82)) return DASH_WX_SVG.rain;
  if ((c >= 71 && c <= 77) || c === 85 || c === 86) return DASH_WX_SVG.snow;
  if (c >= 95) return DASH_WX_SVG.storm;
  return DASH_WX_SVG.cloud;
}
function tickDashClock() {
  if (!document.body.classList.contains('dashboard-mode')) return;
  try {
    const dateEl = $('dash-date'), timeEl = $('dash-time');
    if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-IE',
      { weekday: 'short', day: '2-digit', month: 'short', timeZone: 'Europe/Dublin' })
      .replace(/,/g, '').toUpperCase();
    if (timeEl) timeEl.textContent = new Date().toLocaleTimeString('en-IE',
      { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Dublin' });
  } catch (e) {}
}
function initDashClock() {
  tickDashClock();
  setInterval(tickDashClock, 5000);
}
let dashWxLast = '';
async function refreshDashWeather() {
  if (!document.body.classList.contains('dashboard-mode')) return;
  let lat = null, lng = null;
  if (typeof userPos !== 'undefined' && userPos) { lng = userPos[0]; lat = userPos[1]; }
  else if (map) { try { const c = map.getCenter(); lat = c.lat; lng = c.lng; } catch (e) {} }
  /* Fall back to Dublin when the map has no center (e.g. WebGL unavailable). */
  if (lat === null) { lat = 53.3498; lng = -6.2603; }
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(3) +
      '&longitude=' + lng.toFixed(3) + '&current=temperature_2m,weather_code&timezone=Europe%2FDublin');
    if (!r.ok) throw new Error('wx http ' + r.status);
    const j = await r.json();
    const temp = Math.round(j.current.temperature_2m);
    const key = temp + '|' + j.current.weather_code;
    if (key === dashWxLast) return;
    dashWxLast = key;
    paintDashWeather(temp, j.current.weather_code);
    try { localStorage.setItem(WX_CACHE_KEY, JSON.stringify({ t: temp, code: j.current.weather_code, ts: Date.now() })); } catch (e) {}
  } catch (e) {
    /* A failed fetch must not strand the dash on '--°C': show last-known
       and retry once shortly instead of waiting for the 10-minute tick. */
    paintDashWeatherCache();
    scheduleDashWeatherRetry();
  }
}
function paintDashWeather(temp, code) {
  const t = $('dash-temp'), ic = $('dash-wxicon');
  if (t) t.textContent = temp + '°C';
  if (ic) ic.innerHTML = dashWxIcon(code);
  /* The VC cluster hero header shares the same weather feed. */
  const ct = $('cluster-temp'), ci = $('cluster-wxicon');
  if (ct) ct.textContent = temp + '°C';
  if (ci) ci.innerHTML = dashWxIcon(code);
}
function paintDashWeatherCache() {
  try {
    const c = JSON.parse(localStorage.getItem(WX_CACHE_KEY) || 'null');
    if (c && typeof c.t === 'number') paintDashWeather(c.t, c.code);
  } catch (e) {}
}
let dashWxRetry = null;
function scheduleDashWeatherRetry() {
  if (dashWxRetry) return;
  dashWxRetry = setTimeout(() => { dashWxRetry = null; refreshDashWeather(); }, 30000);
}
function initDashWeather() {
  /* Paint last-known immediately (6h freshness) so a cold boot never
     shows the '--°C' placeholder while the first fetch is in flight. */
  try {
    const c = JSON.parse(localStorage.getItem(WX_CACHE_KEY) || 'null');
    if (c && typeof c.t === 'number' && Date.now() - c.ts < 6 * 3600 * 1000) paintDashWeather(c.t, c.code);
  } catch (e) {}
  refreshDashWeather();
  setInterval(refreshDashWeather, 10 * 60 * 1000);
}
function setDashTab(name) {
  document.querySelectorAll('#dash-bottombar [data-dtab]')
    .forEach(b => b.classList.toggle('on', b.dataset.dtab === name));
}
function syncDashCompass() {
  const el = $('dash-compass');
  if (!el || !map) return;
  try { el.style.transform = 'rotate(' + (-map.getBearing()) + 'deg)'; } catch (e) {}
}
/* Bottom-bar trip readout, fed from the same numbers as the drive HUD. */
function syncDashTrip(remainSec) {
  const eta = $('dash-eta'), dst = $('dash-dest'), sub = $('dash-sub');
  if (!eta || !dst) return;
  if (navActive && typeof remainSec === 'number') {
    const mins = Math.max(1, Math.round(remainSec / 60));
    eta.style.display = '';
    eta.innerHTML = '<span class="eta-label">Arrive in</span><span class="eta-time">' + mins + ' min</span>';
    const label = (typeof dest !== 'undefined' && dest && dest.label) ? dest.label : '';
    dst.textContent = (label || 'EN ROUTE').slice(0, 28);
    if (sub) sub.textContent = ''; /* destination owns the plate during nav */
  } else {
    /* Idle: no "Arrive in —" placeholder. VC/SA/RDR2 show compass only;
       GTA V's pause-menu bar does the same — the ETA pill returns with
       the route. Other themes keep their placeholder. */
    const isVC = document.body.classList.contains('theme-vice-city');
    const isSA = document.body.classList.contains('theme-san-andreas');
    const isRDR2 = document.body.classList.contains('theme-rdr2');
    const isGTAV = document.body.classList.contains('theme-gta-v');
    const compassOnly = isVC || isSA || isRDR2 || isGTAV;
    eta.innerHTML = compassOnly ? '' : '<span class="eta-label">Arrive in</span><span class="eta-time">—</span>';
    eta.style.display = compassOnly ? 'none' : '';
    /* dst (locality plate) is owned by syncDashLocality when not navigating —
       don't wipe it here; just restore the county subtitle if nav cleared it. */
    if (sub && !sub.textContent && dashCounty) sub.textContent = dashCounty;
  }
}

/* Bottom-bar locality plate: reverse-geocode the map centre (debounced,
   ~100m grid) so the chrome names the current town like the benchmark. */
let dashLocTimer = null, dashLocKey = '', dashCounty = '';
function queueDashLocality() {
  clearTimeout(dashLocTimer);
  dashLocTimer = setTimeout(syncDashLocality, 1200);
}
async function syncDashLocality() {
  const el = $('dash-dest');
  if (!el) return;
  if (!document.body.classList.contains('dashboard-mode')) return;
  if (typeof navActive !== 'undefined' && navActive) return; /* nav shows the destination */
  /* If the map failed (e.g. no WebGL), fall back to the default Dublin center
     so the plate still names the city instead of showing a blank dash. */
  let c;
  try {
    c = (window.map && map.getCenter) ? map.getCenter() : { lat: 53.3498, lng: -6.2603 };
  } catch (e) { c = { lat: 53.3498, lng: -6.2603 }; }
  const key = c.lat.toFixed(3) + ',' + c.lng.toFixed(3);
  if (key === dashLocKey) return;
  dashLocKey = key;
  /* Fallback: if reverse-geocode fails but we're near the default Dublin
     center, show DUBLIN rather than a blank plate. */
  const nearDublin = Math.hypot(c.lat - 53.3498, c.lng - (-6.2603)) < 0.2;
  try {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=json&lat=' +
      c.lat.toFixed(5) + '&lon=' + c.lng.toFixed(5) + '&zoom=16');
    if (!r.ok) throw new Error('geo ' + r.status);
    const j = await r.json(), a = (j && j.address) || {};
    /* Prefer the finest named place: neighbourhood-level first, then the
       town/village, then city/municipality — county only as a last resort,
       so the plate names the town you're in, not the county. */
    const name = (a.suburb || a.neighbourhood || a.quarter || a.town ||
      a.village || a.hamlet || a.city || a.municipality || a.city_district ||
      a.county || '')
      /* Ireland quirk: towns often exist in Nominatim only as "<Town> ED"
         (electoral division) under city_district — trim the suffix so the
         plate says CLANE, not CLANE ED. Likewise "County Kildare" -> KILDARE. */
      .replace(/\s+ED$/i, '').replace(/^county\s+/i, '');
    /* Natural case here — each theme's CSS owns the casing (GTA V renders
       this plate in script, which must not be uppercased). The county goes
       to #dash-sub for themes that show a region line (GTA V). */
    const sub = $('dash-sub');
    if (name && (typeof navActive === 'undefined' || !navActive)) {
      el.textContent = name.slice(0, 28);
      dashCounty = a.county || '';
      if (sub) sub.textContent = dashCounty;
    }
    else if (nearDublin) {
      el.textContent = 'DUBLIN';
      dashCounty = 'County Dublin';
      if (sub) sub.textContent = dashCounty;
    }
  } catch (e) {
    if (nearDublin && el.textContent.trim() === '—') el.textContent = 'DUBLIN';
  }
}

/* ---------------- Spotify: theme-independent core + dashboard skin ----------------
   Core (spotify-core.js) owns auth, tokens, playback state and controls —
   it knows nothing about Vice City. The per-theme skin mounted into
   #spotify-stage owns every pixel; the Vice City art lives in
   themes/vice-city and is mounted only for that theme. Swaps are
   presentational — the SpotifyCore session is never touched.

   OAuth redirects reload the page, so the UI/map state is stashed in
   sessionStorage before leaving and restored after the callback — the
   map never visibly resets. Same-origin session reuse means dashboard
   mode never forces a second login. */
const SPOTIFY_CLIENT_ID = 'e15ad96d357849999f72380200c0e37d';
const SPOTIFY_REDIRECT_URI = 'https://ciaranf3308-star.github.io/vice-city-navigator/';
const SPOTIFY_SCOPES = [
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
];
const SPOTIFY_PREAUTH = 'vcn.spotify.preAuth';
let pendingSpotifyView = null;
let spotifySkinId = null;

/* Mount the skin declared by the theme (theme.spotify.skin), falling back
   to the plain default skin. Only mounts while the dashboard layout is
   active — in normal mode no player exists anywhere. */
function mountSpotifySkin(themeId) {
  if (!window.SpotifySkins || !window.SpotifyCore || !$('spotify-stage')) return;
  /* One SpotifyCore session; the skin is chosen per layout (SA cluster
     mounts its own compact widget for the background's boxes). */
  if (!dashboardLayoutActive() && !clusterLayoutActive()) { unmountSpotifySkin(); return; }
  let want = 'default';
  try {
    const theme = window.VCNThemes && VCNThemes.get(themeId);
    const skinId = theme && theme.spotify && theme.spotify.skin;
    if (skinId && SpotifySkins.get(skinId)) want = skinId;
  } catch (e) {}
  /* San Andreas cluster uses its own compact widget built for the
     container boxes painted in the cluster background art — the
     dashboard keeps the full .sasp skin. */
  if (clusterLayoutActive() && themeId === 'san-andreas' &&
      SpotifySkins.get('san-andreas-cluster')) {
    want = 'san-andreas-cluster';
  }
  if (want === spotifySkinId) return;
  unmountSpotifySkin();
  const skin = SpotifySkins.get(want);
  if (skin) {
    try {
      skin.mount($('spotify-stage'), SpotifyCore); spotifySkinId = want;
      const pane = $('spotify-pane');
      if (pane) pane.dataset.skin = want; // tags the pane with the active skin for theming hooks
      document.body.dataset.spotskin = want; // HUD chrome clears wide floating skins
    }
    catch (e) { console.error('[ws] spotify skin mount failed', e); }
  }
}

function unmountSpotifySkin() {
  const prev = spotifySkinId && window.SpotifySkins && SpotifySkins.get(spotifySkinId);
  if (prev && prev.unmount) { try { prev.unmount(); } catch (e) {} }
  spotifySkinId = null;
  const stage = $('spotify-stage');
  if (stage) stage.innerHTML = '';
  const pane = $('spotify-pane');
  if (pane) delete pane.dataset.skin;
  delete document.body.dataset.spotskin;
}

function saveSpotifyPreAuth() {
  try {
    const s = { uiMode };
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
  if (!window.SpotifyCore) return;
  SpotifyCore.onBeforeRedirect(saveSpotifyPreAuth);
  let hadCallback = false;
  try {
    hadCallback = await SpotifyCore.init({
      clientId: SPOTIFY_CLIENT_ID,
      redirectUri: SPOTIFY_REDIRECT_URI,
      scopes: SPOTIFY_SCOPES,
    });
  } catch (e) { /* init is best-effort; menu shows connect state */ }
  if (hadCallback) {
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(SPOTIFY_PREAUTH) || 'null'); } catch (e) {}
    try { sessionStorage.removeItem(SPOTIFY_PREAUTH); } catch (e) {}
    if (s) pendingSpotifyView = s; // applied once the map finishes loading
  }
  syncSpotifyMenu();
  try {
    SpotifyCore.on('auth', syncSpotifyMenu);
    // Auth/token failures were completely silent — the menu just sat on
    // "Not connected" with no explanation. Surface them.
    SpotifyCore.on('error', err => {
      if (!err) return;
      if (err.where === 'authorize' || err.where === 'token') {
        toast('Spotify sign-in failed: ' + (err.message || 'unknown error'));
        syncSpotifyMenu();
      }
    });
  } catch (e) {}
  if (dashboardLayoutActive()) mountSpotifySkin(wsThemeId());
}

/* Menu is the only Spotify surface in normal mode: status + connect. */
function syncSpotifyMenu() {
  const statusEl = $('spotify-status');
  const connectBtn = $('spotify-connect');
  const disconnectBtn = $('spotify-disconnect');
  if (!statusEl || !connectBtn || !disconnectBtn || !window.SpotifyCore) return;
  const connected = SpotifyCore.isConnected();
  statusEl.textContent = connected ? 'Connected' : 'Not connected';
  connectBtn.hidden = connected;
  disconnectBtn.hidden = !connected;
}

/* Presentation-mode selector (Display section): normal / dashboard / cluster,
   mutually exclusive. Dashboard Preview is preserved as the dashboard option. */
function syncModeSelector() {
  const radios = document.querySelectorAll('input[name="appmode"]');
  radios.forEach(r => { r.checked = r.value === appMode; });
}

function wireSpotifyMenu() {
  const connectBtn = $('spotify-connect');
  const disconnectBtn = $('spotify-disconnect');
  const modeRadios = document.querySelectorAll('input[name="appmode"]');
  if (connectBtn) connectBtn.addEventListener('click', () => {
    if (window.SpotifyCore) SpotifyCore.connect();
  });
  if (disconnectBtn) disconnectBtn.addEventListener('click', () => {
    if (window.SpotifyCore) SpotifyCore.disconnect();
    syncSpotifyMenu();
  });
  modeRadios.forEach(r => r.addEventListener('change', () => {
    if (r.checked) setAppMode(r.value);
  }));
  const clusterExit = $('cluster-mode-exit');
  if (clusterExit) clusterExit.addEventListener('click', () => setAppMode('normal'));
  let rsT = null;
  window.addEventListener('resize', () => {
    // Refit the 1920×720 dashboard canvas after resizes; debounced and
    // map-safe (fitDashboardStage only zooms, then map.resize()).
    clearTimeout(rsT);
    rsT = setTimeout(() => {
      if (appMode === 'dashboard') {
        fitDashboardStage();
        if (map && map.resize) { try { map.resize(); } catch (e) {} }
      } else if (appMode === 'cluster') {
        fitClusterStage();
      }
    }, 150);
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

  // dashboard car chrome: bottom-bar zoom replaces the floating #map-tools
  $('dash-zoom-in').addEventListener('click', () => map && map.zoomIn());
  $('dash-zoom-out').addEventListener('click', () => map && map.zoomOut());
  $('dash-locate').addEventListener('click', () => locateUser(true));
  document.querySelectorAll('#dash-bottombar [data-dtab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.dtab;
      if (t === 'phone') { setAppMode('normal'); return; } // back to the phone
      if (t === 'radio') { // toggle the music widget for a full-bleed map
        const off = document.body.classList.toggle('radio-off');
        setDashTab(off ? 'map' : 'radio');
        try { syncDashPadding(); } catch (e) {}
        return;
      }
      if (t === 'settings') { openMenu(); setDashTab(t); return; }
      const dashMode = document.body.classList.contains('dashboard-mode');
      const dismissing = !$('menu-panel').hidden || document.body.classList.contains('radio-off');
      closeMenu();
      document.body.classList.remove('radio-off');
      setDashTab('map');
      // Dashboard hides the floating search pill on every theme (hero
      // compositions), so the MAP tab is the explicit entry point to
      // route planning / search there.
      if (t === 'map' && dashMode && !dismissing) openPlanning('search');
    });
  });
  initDashClock();
  initDashWeather();

  // explore chrome
  $('menu-btn').addEventListener('click', toggleMenu);
  $('menu-close').addEventListener('click', closeMenu);
  $('search-bar').addEventListener('click', () => openPlanning('search'));

  // planning drawer
  $('drawer-close').addEventListener('click', closeDrawer);
  $('drawer-handle').addEventListener('click', closeDrawer);

  // POI card thumbnail: never an empty frame. If the blip art fails to
  // load (missing/failed asset), hide the <img>; a fresh successful load
  // shows it again. Shared — every theme benefits.
  const poiBlip = $('poi-blip');
  if (poiBlip) {
    poiBlip.addEventListener('error', () => { poiBlip.style.display = 'none'; });
    poiBlip.addEventListener('load', () => { poiBlip.style.display = ''; });
  }

  // drive HUD
  $('drive-menu-btn').addEventListener('click', toggleMenu);
  $('drive-search-btn').addEventListener('click', () => openPlanning('search'));
  const mEnd = $('maneuver-end');
  if (mEnd) mEnd.addEventListener('click', () => { if (typeof endNav === 'function') endNav(); });
  /* SA dashboard: the floating drive pill is gone — the locality plate
     opens search so the function is not stranded. */
  const dDest = $('dash-dest');
  if (dDest) dDest.addEventListener('click', () => {
    if (document.body.classList.contains('dashboard-mode') &&
        document.body.classList.contains('theme-san-andreas')) openPlanning('search');
  });

  // menu: theme selector
  buildThemeSelector();

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

  // menu: force update — pull latest from repo, clear caches, reload
  const forceBtn = $('force-update');
  const verEl = $('app-version');
  function syncAppVersion() {
    if (!verEl) return;
    fetch('sw.js', { cache: 'no-store' }).then(r => r.text()).then(t => {
      const m = t.match(/ws-theme-(v\d+)/);
      verEl.textContent = m ? 'Version ' + m[1] : '—';
    }).catch(() => { verEl.textContent = '—'; });
  }
  syncAppVersion();
  if (forceBtn) forceBtn.addEventListener('click', async () => {
    forceBtn.disabled = true;
    forceBtn.textContent = 'Updating…';
    try {
      // 1. Ask the service worker to check for a new version
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update().catch(() => {});
      }
      // 2. Clear all WayStation caches so fresh files are fetched
      if ('caches' in window) {
        const names = await caches.keys();
        await Promise.all(names.filter(n => n.startsWith('ws-')).map(n => caches.delete(n)));
      }
      // 3. Reload — bypassing HTTP cache to get the new shell
      location.reload();
    } catch (e) {
      forceBtn.disabled = false;
      forceBtn.textContent = 'Force update';
      toast('Update failed — try again.');
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
  $('voice-preview').addEventListener('click', () => {
    if (window.VCNVoice) VCNVoice.preview();
  });

  // menu: live traffic (single master toggle)
  if (window.VCNTraffic) {
    const tt = $('traffic-toggle'), th = $('traffic-key-hint');
    tt.checked = VCNTraffic.isOn();
    th.hidden = VCNTraffic.hasKey();
    tt.addEventListener('change', e => {
      const r = VCNTraffic.setOn(e.target.checked);
      if (!r.ok && r.reason === 'no-key') {
        e.target.checked = false;
        th.hidden = false;
        toast('Live traffic needs a TomTom API key — see TRAFFIC_SETUP.md.');
      } else {
        toast(e.target.checked ? 'Live traffic on.' : 'Live traffic off.');
      }
    });
  }
  $('endpoint-url').addEventListener('change', e => {
    if (window.VCNVoice) {
      VCNVoice.setConfig({ endpoint: e.target.value.trim() });
      toast('Voice server saved.');
    }
  });

  setUiMode('explore');
}

/* ---------------- boot ---------------- */
initAppMode();
wireSearch();
wireVoiceSearch();
wireSavedPlaces();
wireMarkerSheet();
wireControls();
wireSpotifyMenu();
initMap();
applyAppMode();
initSpotify();
installCarBridge(); // ?car=1: Android Auto WebView bridge (no-op otherwise)

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
