/* ============================================================
   Vice City Navigator — ambient POIs from Google Places API (New)
   ------------------------------------------------------------
   As the player moves, nearby real-world businesses are fetched
   with Nearby Search (New) and rendered as authentic Vice City
   radar blips. No user search required.

   Pipeline: GPS fix / 750 m movement -> searchNearby (5 category
   groups) -> cache (memory + localStorage, 24 h TTL) -> GeoJSON
   source -> zoom-tiered symbol layers -> tap for VC place card.

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
    { id: 'driving',  types: ['gas_station', 'electric_vehicle_charging_station', 'car_repair', 'car_wash', 'parking', 'airport'] },
    { id: 'food',     types: ['restaurant', 'fast_food_restaurant', 'cafe', 'coffee_shop', 'bakery'] },
    { id: 'useful',   types: ['hospital', 'pharmacy', 'police', 'bank', 'atm'] },
    { id: 'shopping', types: ['supermarket', 'grocery_store', 'shopping_mall', 'convenience_store', 'department_store'] },
    { id: 'leisure',   types: ['bar', 'pub', 'night_club', 'movie_theater', 'gym', 'hotel'] },
  ];

  /* Zoom tiers (suggested behaviour):
       essential: zoom 12+  (driving services, hospital, police, airport)
       useful:    zoom 14+  (food, pharmacy, bank/atm, shopping, hotel, gym)
       leisure:   zoom 16+  (bars, pubs, clubs, cinema) */
  const TIER_BY_TYPE = {
    gas_station: 'essential', electric_vehicle_charging_station: 'essential',
    car_repair: 'essential', car_wash: 'essential', parking: 'essential',
    airport: 'essential', hospital: 'essential', police: 'essential',
    pharmacy: 'useful', bank: 'useful', atm: 'useful',
    restaurant: 'useful', fast_food_restaurant: 'useful', bakery: 'useful',
    cafe: 'useful', coffee_shop: 'useful',
    supermarket: 'useful', grocery_store: 'useful', shopping_mall: 'useful',
    convenience_store: 'useful', department_store: 'useful',
    gym: 'useful', hotel: 'useful',
    bar: 'leisure', pub: 'leisure', night_club: 'leisure', movie_theater: 'leisure',
  };

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
  function tierForType(primaryType, types) {
    const candidates = [primaryType, ...(types || [])].filter(Boolean);
    for (const t of candidates) {
      const tier = TIER_BY_TYPE[t];
      if (tier) return tier;
    }
    return 'useful';
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
        tier: tierForType(primaryType, types),
        fetchedAt: now,
      });
      added++;
    }
    return added;
  }

  /* ---------------- refresh gating ---------------- */
  let map = null, hooks = {};
  let lastQueryCenter = null;
  let refreshInFlight = false;
  let keyWarned = false;

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
    const minMove = cfg().refreshDistanceMeters || 750;
    if (lastQueryCenter && haversine(lastQueryCenter, lnglat) < minMove) return;
    refreshInFlight = true;
    try {
      lastQueryCenter = lnglat.slice();
      let total = 0;
      for (const group of POI_GROUPS) {
        try { total += await searchGroup(group, lnglat); }
        catch (e) { console.warn('[vcn-pois] group failed:', group.id, e.message); }
      }
      renderPois();
      persistCache();
      console.info(`[vcn-pois] refreshed: ${total} places around ${lnglat[1].toFixed(4)},${lnglat[0].toFixed(4)}`);
    } finally {
      refreshInFlight = false;
    }
  }

  /* ---------------- map rendering ---------------- */
  const LAYERS = [
    { id: 'vcn-poi-essential', tier: 'essential', minzoom: 12, size: [12, 2.4, 16, 3.2] },
    { id: 'vcn-poi-useful',    tier: 'useful',    minzoom: 14, size: [14, 2.0, 16, 2.8] },
    { id: 'vcn-poi-leisure',   tier: 'leisure',   minzoom: 16, size: [16, 1.8, 18, 2.6] },
  ];
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
    for (const L of LAYERS) {
      map.addLayer({
        id: L.id, type: 'symbol', source: 'vcn-pois', minzoom: L.minzoom,
        filter: ['==', ['get', 'tier'], L.tier],
        layout: {
          'icon-image': ['concat', 'poi-', ['get', 'blip']],
          'icon-size': ['interpolate', ['linear'], ['zoom'], L.size[0], L.size[1], L.size[2], L.size[3]],
          'icon-anchor': 'center',
          'icon-allow-overlap': false,
          'icon-ignore-placement': false,
          'icon-padding': 2,
        },
      });
    }
  }
  function renderPois() {
    if (!map || !map.getSource('vcn-pois')) return;
    const now = Date.now(), ttl = ttlMs();
    const features = [];
    for (const rec of memCache.values()) {
      if (now - rec.fetchedAt > ttl) continue;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [rec.lng, rec.lat] },
        properties: {
          placeId: rec.placeId, name: rec.displayName,
          type: rec.primaryType || '', blip: rec.blip, tier: rec.tier,
        },
      });
    }
    map.getSource('vcn-pois').setData({ type: 'FeatureCollection', features });
  }

  /* ---------------- place card ---------------- */
  function prettyType(t) {
    if (!t) return 'Place';
    return t.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  }
  function showCard(props) {
    const card = document.getElementById('poi-card');
    const userPos = hooks.getUserPos ? hooks.getUserPos() : null;
    document.getElementById('poi-blip').src = blipUrl(props.blip || 'qmark');
    document.getElementById('poi-name').textContent = props.name || 'Unnamed place';
    document.getElementById('poi-type').textContent = prettyType(props.type);
    document.getElementById('poi-dist').textContent =
      (userPos && hooks.formatDist) ? hooks.formatDist(haversine(userPos, [props.lng, props.lat])) : '';
    card.hidden = false;
    document.getElementById('poi-go').onclick = () => {
      card.hidden = true;
      if (hooks.setDestination) hooks.setDestination({
        label: props.name, lnglat: [props.lng, props.lat], blip: props.blip || 'waypoint',
      });
    };
  }
  function wireCard() {
    document.getElementById('poi-close').addEventListener('click', () => {
      document.getElementById('poi-card').hidden = true;
    });
    const layerIds = LAYERS.map(l => l.id);
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
      ensureLayers();
      preloadBlipImages();
      renderPois();   // show cached POIs immediately
      wireCard();
    },
    maybeRefresh,
    renderPois,
    cacheSize: () => memCache.size,
  };
})();
