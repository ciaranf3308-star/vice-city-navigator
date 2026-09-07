/* ============================================================
   Vice City Navigator — ambient POIs from Google Places API (New)
   ------------------------------------------------------------
   As the player moves, nearby real-world businesses are fetched
   with Nearby Search (New) and rendered as authentic Vice City
   radar blips. No user search required.

   Pipeline: GPS fix / 750 m movement -> searchNearby (5 category
   groups) -> cache (memory + localStorage, 24 h TTL) -> GeoJSON
   source -> single symbol layer with importance-based,
   zoom-band visibility -> tap for VC place card.

   Visibility is a pure render rule over the cache: zooming out
   never triggers new Google fetches, and zooming back in
   restores cached POIs immediately.

   Table A place types verified against the official Places API
   type table (2026-09-07). Only Table A values are used in
   `includedTypes` filters.
   ============================================================ */
'use strict';

(function () {
  const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
  const FIELD_MASK = 'places.id,places.location,places.primaryType,places.types,places.displayName';
  const LS_KEY = 'vcn-poi-cache-v1';

  /* Category groups — one Nearby Search request per group so no single
     category can crowd the others out (maxResultCount is per request). */
  const POI_GROUPS = [
    { id: 'driving',  types: ['gas_station', 'electric_vehicle_charging_station', 'car_repair', 'car_wash', 'parking', 'airport', 'train_station'] },
    { id: 'food',     types: ['restaurant', 'fast_food_restaurant', 'cafe', 'coffee_shop', 'bakery'] },
    { id: 'useful',   types: ['hospital', 'pharmacy', 'police', 'bank', 'atm'] },
    { id: 'shopping', types: ['supermarket', 'grocery_store', 'shopping_mall', 'convenience_store', 'department_store'] },
    { id: 'leisure',   types: ['bar', 'pub', 'night_club', 'movie_theater', 'gym', 'hotel', 'stadium'] },
  ];

  /* Importance-based visibility (GTA-style declutter).
     Every POI scores 0-100 from its Google type; specific
     subtypes win over generic types (same rule as blip art).
     Render bands below pick a minimum importance per zoom and
     cap how many POIs may show in the viewport at wider zooms.
     "Major" is inferred from type alone — the field mask
     deliberately stays minimal, so e.g. every airport scores
     100 (airports are rare enough that type is signal enough). */
  const IMPORTANCE_BY_TYPE = {
    airport: 100,
    hospital: 90,
    shopping_mall: 85,
    department_store: 80, train_station: 80,
    stadium: 75,
    police: 70,
    gas_station: 60, electric_vehicle_charging_station: 60, car_repair: 60,
    car_wash: 55, parking: 55,
    supermarket: 50, pharmacy: 50,
    hotel: 50, motel: 50, hostel: 50, guest_house: 50, inn: 50,
    grocery_store: 45, bank: 45,
    atm: 40, convenience_store: 40,
    gym: 35, fitness_center: 35, sports_club: 35,
    restaurant: 30, fast_food_restaurant: 30,
    cafe: 30, coffee_shop: 30, bakery: 30,
    pizza_restaurant: 30, hamburger_restaurant: 30, chicken_restaurant: 30,
    bar: 20, pub: 20, night_club: 20, movie_theater: 20,
  };
  const DEFAULT_IMPORTANCE = 30; // unknown types behave like ordinary food/shop POIs

  /* Zoom bands: the further out, the cleaner the map.
       16+   full local set (everything cached)
       14-16 useful local POIs (no food-by-default, no nightlife)
       12-14 essential / high-importance only; low-importance
             members (petrol, garages) lose the cap race in
             dense areas — "if not too dense" falls out
             naturally from importance sorting
       10-12 major landmarks only, small viewport cap
       <10   no ambient POIs at all (county-scale is clean) */
  const ZOOM_BANDS = [
    { minZoom: 16, minImportance: 0,  cap: Infinity },
    { minZoom: 14, minImportance: 50, cap: Infinity },
    { minZoom: 12, minImportance: 60, cap: 50 },
    { minZoom: 10, minImportance: 75, cap: 12 },
  ];
  function bandForZoom(z) {
    for (const b of ZOOM_BANDS) if (z >= b.minZoom) return b;
    return null; // below 10: hide everything
  }

  /* Google place type -> Vice City blip asset (blip_<name>.png).
     Specific subtypes are listed so they win over generic types. */
  const GOOGLE_TYPE_TO_BLIP = {
    /* automotive */
    car_repair: 'modGarage', tire_shop: 'modGarage', car_dealer: 'modGarage',
    car_wash: 'spray',
    gas_station: 'fuel', electric_vehicle_charging_station: 'fuel',
    parking: 'parking', airport: 'airYard',
    /* health & safety */
    hospital: 'hostpital', pharmacy: 'hostpital',
    police: 'police',
    bank: 'cash', atm: 'cash',
    /* food — specific kitchens first */
    pizza_restaurant: 'pizza',
    hamburger_restaurant: 'burgerShot', chicken_restaurant: 'chicken',
    fast_food_restaurant: 'burgerShot',
    cafe: 'diner', coffee_shop: 'diner', bakery: 'diner', tea_house: 'diner',
    ice_cream_shop: 'diner', donut_shop: 'diner',
    restaurant: 'dateFood',
    /* drink & nightlife */
    bar: 'dateDrink', pub: 'dateDrink', irish_pub: 'dateDrink',
    sports_bar: 'dateDrink', cocktail_bar: 'dateDrink', wine_bar: 'dateDrink',
    lounge_bar: 'dateDrink',
    night_club: 'dateDisco', movie_theater: 'dateDisco',
    /* stay & sport */
    hotel: 'saveGame', motel: 'saveGame', hostel: 'saveGame',
    guest_house: 'saveGame', inn: 'saveGame',
    gym: 'gym', fitness_center: 'gym', sports_club: 'gym',
    stadium: 'race',
    /* transport hubs */
    train_station: 'waypoint',
    /* shopping — commerce blip */
    supermarket: 'cash', grocery_store: 'cash', convenience_store: 'cash',
    department_store: 'cash', shopping_mall: 'cash',
  };
  const BLIP_PATH = 'assets/blips/blip_';
  const blipUrl = n => `${BLIP_PATH}${n}.png`;

  /* ---------------- cache ---------------- */
  const memCache = new Map(); // placeId -> record
  function cfg() { return (typeof GOOGLE_PLACES_CONFIG !== 'undefined') ? GOOGLE_PLACES_CONFIG : {}; }
  function ttlMs() { return cfg().cacheTtlMs || 24 * 3600 * 1000; }
  function isFresh(rec) { return rec && (Date.now() - rec.fetchedAt) < ttlMs(); }

  function loadPersistedCache() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return;
      let n = 0;
      for (const rec of arr) {
        if (rec && rec.placeId && isFresh(rec)) { memCache.set(rec.placeId, rec); n++; }
      }
      console.info(`[vcn-pois] restored ${n} cached POIs`);
    } catch (e) { /* storage unavailable or corrupt — start empty */ }
  }
  let persistTimer = null;
  function persistCache() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try {
        const arr = [...memCache.values()].filter(isFresh).slice(0, 2000);
        localStorage.setItem(LS_KEY, JSON.stringify(arr));
      } catch (e) { /* quota or private mode — memory cache still works */ }
    }, 1500);
  }

  /* ---------------- Google API ---------------- */
  function keyReady() {
    const k = (cfg().apiKey || '').trim();
    return cfg().enabled !== false && k && !/PASTE_YOUR/i.test(k);
  }
  function haversine(a, b) {
    const R = 6371000, toR = d => d * Math.PI / 180;
    const dLat = toR(b[1] - a[1]), dLng = toR(b[0] - a[0]);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a[1])) * Math.cos(toR(b[1])) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function blipForPlace(primaryType, types) {
    const candidates = [primaryType, ...(types || [])].filter(Boolean);
    for (const t of candidates) {
      const b = GOOGLE_TYPE_TO_BLIP[t];
      if (b) return b;
    }
    return 'qmark';
  }
  function importanceForType(primaryType, types) {
    const candidates = [primaryType, ...(types || [])].filter(Boolean);
    for (const t of candidates) {
      const imp = IMPORTANCE_BY_TYPE[t];
      if (typeof imp === 'number') return imp;
    }
    return DEFAULT_IMPORTANCE;
  }

  async function searchGroup(group, lnglat) {
    const [lng, lat] = lnglat;
    const body = {
      includedTypes: group.types,
      maxResultCount: 20,
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: cfg().radiusMeters || 2500 } },
      rankPreference: 'DISTANCE',
      languageCode: 'en',
    };
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': cfg().apiKey.trim(),
        'X-Goog-FieldMask': FIELD_MASK,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`places ${res.status}`);
    const data = await res.json();
    const now = Date.now();
    let added = 0;
    for (const p of (data.places || [])) {
      const loc = p.location || {};
      if (typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') continue;
      const placeId = typeof p.id === 'string' ? p.id.replace(/^places\//, '') : null;
      if (!placeId) continue;
      const primaryType = p.primaryType || null;
      const types = Array.isArray(p.types) ? p.types : [];
      memCache.set(placeId, {
        placeId,
        lat: loc.latitude, lng: loc.longitude,
        primaryType, types,
        displayName: (p.displayName && p.displayName.text) || 'Unnamed place',
        blip: blipForPlace(primaryType, types),
        importance: importanceForType(primaryType, types),
        fetchedAt: now,
      });
      added++;
    }
    return added;
  }

  /* ---------------- refresh gating ---------------- */
  let map = null, hooks = {};
  let initialized = false;
  let lastQueryCenter = null;
  let refreshInFlight = false;
  let keyWarned = false;
  let budgetWarnedFor = null;
  let lastRefreshInfo = null; // {at, total, ok, error} — surfaced via status()

  /* ---------------- spend guards ----------------
     Google can't cap quotas on trial projects, so the app caps
     itself two ways:
       1. never refetch ground covered by a query in the last 24 h —
          those POIs are already in the cache, re-asking is pure waste
       2. hard daily budget on refreshes (configurable) — the last
          line of defence so usage can never run away */
  const LS_QUERIES_KEY = 'vcn-poi-queries-v2';
  const LS_BUDGET_KEY = 'vcn-poi-budget-v2';
  let queryHistory = []; // [{lng, lat, at}] — ground already fetched
  let failCooldownUntil = 0; // backoff after a totally failed refresh
  function loadQueryHistory() {
    try {
      const arr = JSON.parse(localStorage.getItem(LS_QUERIES_KEY) || '[]');
      if (Array.isArray(arr)) {
        const cutoff = Date.now() - ttlMs();
        queryHistory = arr.filter(q => q && q.at > cutoff);
      }
    } catch (e) { queryHistory = []; }
  }
  function saveQueryHistory() {
    try { localStorage.setItem(LS_QUERIES_KEY, JSON.stringify(queryHistory.slice(-300))); }
    catch (e) { /* private mode — memory history still works */ }
  }
  function pruneQueryHistory() {
    const cutoff = Date.now() - ttlMs();
    const n = queryHistory.length;
    queryHistory = queryHistory.filter(q => q.at > cutoff);
    if (queryHistory.length !== n) saveQueryHistory();
  }
  function recentlyQueried(lnglat) {
    // a previous query within one search radius covers this point —
    // its POIs are already in the cache
    const r = cfg().radiusMeters || 2500;
    return queryHistory.some(q => haversine([q.lng, q.lat], lnglat) < r);
  }
  function budgetAllows() {
    const max = cfg().maxRefreshesPerDay || 30;
    const today = new Date().toISOString().slice(0, 10);
    let b = null;
    try { b = JSON.parse(localStorage.getItem(LS_BUDGET_KEY) || 'null'); } catch (e) { /* ignore */ }
    if (!b || b.date !== today) b = { date: today, count: 0 };
    if (b.count >= max) return false;
    b.count += 1;
    try { localStorage.setItem(LS_BUDGET_KEY, JSON.stringify(b)); } catch (e) { /* ignore */ }
    return true;
  }

  async function maybeRefresh(lnglat) {
    if (!map || !lnglat) return;
    if (!keyReady()) {
      if (!keyWarned) {
        keyWarned = true;
        console.info('[vcn-pois] no Google Places key — ambient POIs off. See places-config.js / PLACES_SETUP.md.');
      }
      return;
    }
    if (refreshInFlight) return;
    if (Date.now() < failCooldownUntil) return; // backing off after a total failure
    const minMove = cfg().refreshDistanceMeters || 750;
    if (lastQueryCenter && haversine(lastQueryCenter, lnglat) < minMove) return;
    pruneQueryHistory();
    if (recentlyQueried(lnglat)) return; // cache already covers this ground
    if (!budgetAllows()) {
      const today = new Date().toISOString().slice(0, 10);
      if (budgetWarnedFor !== today) {
        budgetWarnedFor = today;
        console.info('[vcn-pois] daily refresh budget reached — ambient POIs paused until tomorrow');
      }
      lastRefreshInfo = { at: Date.now(), total: 0, ok: false, error: 'daily budget reached' };
      return;
    }
    // Only advance the movement gate when we're actually about to fetch —
    // bailing above must not poison the gate with unfetched ground.
    lastQueryCenter = lnglat.slice();
    refreshInFlight = true;
    const info = { at: Date.now(), total: 0, ok: false, error: null };
    try {
      let total = 0, ok = false;
      const errors = [];
      for (const group of POI_GROUPS) {
        try { total += await searchGroup(group, lnglat); ok = true; }
        catch (e) { errors.push(group.id + ':' + e.message); console.warn('[vcn-pois] group failed:', group.id, e.message); }
      }
      info.total = total; info.ok = ok;
      if (!ok) info.error = errors.join(' | ') || 'all groups failed';
      if (ok) {
        // Only mark ground as covered when Google actually answered.
        // A failed refresh must stay retryable — recording it would
        // poison the 24 h history and silently block every later pan.
        queryHistory.push({ lng: lnglat[0], lat: lnglat[1], at: Date.now() });
        saveQueryHistory();
      } else {
        // Nothing answered (bad key, no network): back off a minute so a
        // broken setup can't hammer the API on every pan.
        failCooldownUntil = Date.now() + 60000;
      }
      renderPois();
      persistCache();
      console.info(`[vcn-pois] refreshed: ${total} places around ${lnglat[1].toFixed(4)},${lnglat[0].toFixed(4)}`);
      lastRefreshInfo = info;
    } finally {
      refreshInFlight = false;
    }
  }

  /* ---------------- map rendering ---------------- */
  /* One symbol layer; visibility is computed in JS from the zoom
     band, so zooming is purely a rendering rule over the existing
     cache — no extra Google fetches, and cached POIs reappear
     instantly when zooming back in. */
  const POI_LAYER_ID = 'vcn-poi';
  function preloadBlipImages() {
    const names = [...new Set(Object.values(GOOGLE_TYPE_TO_BLIP).concat(['qmark']))];
    for (const name of names) {
      const id = 'poi-' + name;
      if (map.hasImage(id)) continue;
      map.loadImage(blipUrl(name), (err, img) => {
        if (err) { console.warn('[vcn-pois] blip image failed:', name); return; }
        if (!map.hasImage(id)) map.addImage(id, img, { sdf: false });
        renderPois(); // paint any features that were waiting on this blip
      });
    }
  }
  function ensureLayers() {
    if (map.getSource('vcn-pois')) return;
    map.addSource('vcn-pois', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addLayer({
      id: POI_LAYER_ID, type: 'symbol', source: 'vcn-pois',
      layout: {
        'icon-image': ['concat', 'poi-', ['get', 'blip']],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 10, 2.2, 14, 2.6, 16, 3.0, 18, 3.4],
        'icon-anchor': 'center',
        'icon-allow-overlap': false,
        'icon-ignore-placement': false,
        'icon-padding': 2,
        // higher importance wins any residual icon collisions
        'symbol-sort-key': ['get', 'importance'],
      },
    });
  }
  function renderPois() {
    if (!map || !map.getSource('vcn-pois')) return;
    const now = Date.now(), ttl = ttlMs();
    const band = bandForZoom(map.getZoom());
    let picked = [];
    if (band) {
      // At capped bands only POIs inside the current viewport compete
      // for the limited slots — highest importance wins.
      const bounds = (band.cap !== Infinity && typeof map.getBounds === 'function') ? map.getBounds() : null;
      for (const rec of memCache.values()) {
        if (now - rec.fetchedAt > ttl) continue;
        // older cached records predate importance scoring — derive it
        const imp = (typeof rec.importance === 'number')
          ? rec.importance : importanceForType(rec.primaryType, rec.types);
        if (imp < band.minImportance) continue;
        if (bounds && !bounds.contains([rec.lng, rec.lat])) continue;
        picked.push([imp, rec]);
      }
      picked.sort((a, b) => b[0] - a[0]);
      if (picked.length > band.cap) picked.length = band.cap;
    }
    const features = picked.map(([imp, rec]) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [rec.lng, rec.lat] },
      properties: {
        placeId: rec.placeId, name: rec.displayName,
        type: rec.primaryType || '', blip: rec.blip, importance: imp,
      },
    }));
    map.getSource('vcn-pois').setData({ type: 'FeatureCollection', features });
  }

  /* ---------------- place card ---------------- */
  function prettyType(t) {
    if (!t) return 'Place';
    return t.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  function showCard(props) {
    const detail = document.getElementById('poi-detail');
    const userPos = hooks.getUserPos ? hooks.getUserPos() : null;
    document.getElementById('poi-blip').src = blipUrl(props.blip || 'qmark');
    document.getElementById('poi-name').textContent = props.name || 'Unnamed place';
    document.getElementById('poi-type').textContent = prettyType(props.type);
    document.getElementById('poi-dist').textContent =
      (userPos && hooks.formatDist) ? hooks.formatDist(haversine(userPos, [props.lng, props.lat])) : '';
    // POI detail lives in the planning drawer; the hook opens it.
    // Fallback unhides the detail block if the hook is unavailable.
    if (hooks.openPlanning) hooks.openPlanning('poi');
    else if (detail) detail.hidden = false;
    document.getElementById('poi-go').onclick = () => {
      if (hooks.setDestination) hooks.setDestination({
        label: props.name, lnglat: [props.lng, props.lat], blip: props.blip || 'waypoint',
      });
    };
    document.getElementById('poi-drive').onclick = () => {
      if (hooks.navigateTo) hooks.navigateTo({
        label: props.name, lnglat: [props.lng, props.lat], blip: props.blip || 'waypoint',
      });
    };
  }
  function wireCard() {
    const layerIds = [POI_LAYER_ID];
    const onPoiClick = e => {
      const f = e.features && e.features[0];
      if (!f) return;
      const p = f.properties, c = f.geometry.coordinates;
      showCard({ placeId: p.placeId, name: p.name, type: p.type, blip: p.blip, lng: c[0], lat: c[1] });
    };
    for (const id of layerIds) map.on('click', id, onPoiClick);
  }

  /* ---------------- public API ---------------- */
  window.VCNPlaces = {
    init(m, h) {
      map = m; hooks = h || {};
      loadPersistedCache();
      loadQueryHistory();
      ensureLayers();
      preloadBlipImages();
      renderPois();   // show cached POIs immediately
      wireCard();
      initialized = true;
      // re-evaluate visibility on pan/zoom — purely a render rule,
      // the cache is untouched so zooming back in is instant
      map.on('moveend', renderPois);
    },
    maybeRefresh,
    renderPois,
    cacheSize: () => memCache.size,
    /* Diagnostic snapshot for the ?poi-debug panel and console probing. */
    status() {
      let budget = null;
      try { budget = JSON.parse(localStorage.getItem(LS_BUDGET_KEY) || 'null'); } catch (e) { /* ignore */ }
      return {
        initialized,
        keyReady: !!keyReady(),
        cacheSize: memCache.size,
        lastRefresh: lastRefreshInfo,
        budgetToday: budget && budget.date === new Date().toISOString().slice(0, 10) ? budget.count : 0,
        queryHistory: queryHistory.length,
        layerOnMap: !!(map && map.getSource('vcn-pois')),
        layerExists: !!(map && typeof map.getLayer === 'function' && map.getLayer('vcn-poi')),
        zoom: map ? +map.getZoom().toFixed(2) : null,
        featuresInSource: (() => {
          try { const s = map.getSource('vcn-pois'); return s && s._data ? s._data.features.length : null; }
          catch (e) { return 'err:' + e.message; }
        })(),
        blipImages: (() => {
          try {
            const names = [...new Set(Object.values(GOOGLE_TYPE_TO_BLIP).concat(['qmark']))];
            const missing = names.filter(n => !map.hasImage('poi-' + n));
            return { total: names.length, missing };
          } catch (e) { return { error: String(e && e.message || e) }; }
        })(),
        cooldownMsLeft: Math.max(0, failCooldownUntil - Date.now()),
      };
    },
  };
})();
