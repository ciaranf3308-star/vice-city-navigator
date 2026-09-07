/* ============================================================
   WayStation — live traffic (TomTom).
   ------------------------------------------------------------
   Three features, one master toggle ("Live traffic" in the menu):

     1. Traffic flow overlay — TomTom raster flow tiles
        (relative-delay style: green/yellow/red only where
        traffic differs from free-flow) as a MapLibre raster
        layer tucked under the label layers.
     2. Traffic incidents — Incident Details v5 for the current
        map bbox, rendered as alert-triangle markers. Tap one
        for a small card with its description and delay.
     3. Traffic-aware routing — calculateRoute v1 with
        traffic=true. The TomTom response is converted into the
        OSRM route shape the app already consumes, so
        buildSteps / drawRoute / voice guidance work unchanged.
        The engine's maneuvers stay the authoritative route
        facts (the voice rewrite never alters them).

   Provider order: OSRM is the default engine AND the silent
   fallback — any TomTom routing failure falls back to OSRM
   for that request. Nothing here touches the voice pipeline.

   Quota discipline (free tier: 2,500 req/day):
     - Flow tiles are browser-cached like map tiles.
     - Incidents refresh at most every incidentRefreshMs AND
       only after the map moved incidentMinMoveMeters, with a
       daily hard cap — only while the toggle is ON.
     - Routing calls TomTom only on explicit route requests
       while the toggle is ON.

   Endpoint shapes verified against developer.tomtom.com
   (2026-09-08): Traffic API v4 flow tiles, Incident Details
   v5, Routing API v1 calculateRoute.

   Key lives in traffic-config.js (TOMTOM_TRAFFIC_CONFIG).
   Without a key the toggle refuses with a pointer to
   TRAFFIC_SETUP.md instead of failing silently.
   ============================================================ */
'use strict';

(function () {
  var LS_ON = 'vcn.traffic-on-v1';
  var LS_QUOTA = 'vcn.traffic-quota-v1';
  var PLACEHOLDER = 'PUT_YOUR_TOMTOM_KEY_HERE';

  var FLOW_BASE = 'https://api.tomtom.com/traffic/map/4/tile/flow';
  var INCIDENTS_URL = 'https://api.tomtom.com/traffic/services/5/incidentDetails';
  var ROUTING_BASE = 'https://api.tomtom.com/routing/1/calculateRoute';
  var FLOW_STYLES = ['relative-delay', 'relative', 'relative0', 'absolute', 'reduced-sensitivity'];

  var INCIDENT_FIELDS =
    '{incidents{type,geometry{type,coordinates},' +
    'properties{id,iconCategory,magnitudeOfDelay,events{description,code},from,to,length,delay,roadNumbers}}}';

  var map = null;
  var trafficOn = false;
  var wired = false; // click handler wired (reset on rehydrate)
  var iconReady = false;
  var memIncidents = [];
  var lastCenter = null;
  var lastIncidentFetch = 0;
  var lastDelaySec = 0;

  function cfg() {
    return (typeof TOMTOM_TRAFFIC_CONFIG !== 'undefined' && TOMTOM_TRAFFIC_CONFIG) || {};
  }
  function apiKey() {
    var k = cfg().apiKey;
    return (typeof k === 'string') ? k.trim() : '';
  }
  function hasKey() {
    var k = apiKey();
    return !!k && k !== PLACEHOLDER && k.length >= 10;
  }
  function flowStyle() {
    var s = cfg().flowStyle;
    return FLOW_STYLES.indexOf(s) >= 0 ? s : 'relative-delay';
  }
  function flowTileUrl() {
    return FLOW_BASE + '/' + flowStyle() + '/{z}/{x}/{y}.png?key=' + encodeURIComponent(apiKey());
  }
  function isOn() { return trafficOn && hasKey(); }

  /* ---------------- TomTom maneuver -> OSRM maneuver ----------------
     instrText() in app.js speaks from {type, modifier, name, ref},
     so every TomTom maneuver code maps into that vocabulary.
     Unknown/future codes degrade to 'continue' (forward-compatible,
     per TomTom's guidance deprecation policy). */
  function mapManeuver(code) {
    switch (code) {
      case 'DEPART': return { type: 'depart', modifier: 'out' };
      case 'ARRIVE': case 'ARRIVE_LEFT': case 'ARRIVE_RIGHT':
      case 'WAYPOINT_REACHED': case 'WAYPOINT_LEFT': case 'WAYPOINT_RIGHT':
        return { type: 'arrive', modifier: '' };
      case 'STRAIGHT': case 'FOLLOW':
      case 'SWITCH_PARALLEL_ROAD': case 'SWITCH_MAIN_ROAD': case 'TAKE_FERRY':
        return { type: 'continue', modifier: '' };
      case 'KEEP_RIGHT': return { type: 'fork', modifier: 'right' };
      case 'KEEP_LEFT': return { type: 'fork', modifier: 'left' };
      case 'BEAR_RIGHT': return { type: 'turn', modifier: 'slight right' };
      case 'BEAR_LEFT': return { type: 'turn', modifier: 'slight left' };
      case 'TURN_RIGHT': return { type: 'turn', modifier: 'right' };
      case 'TURN_LEFT': return { type: 'turn', modifier: 'left' };
      case 'SHARP_RIGHT': return { type: 'turn', modifier: 'sharp right' };
      case 'SHARP_LEFT': return { type: 'turn', modifier: 'sharp left' };
      case 'MAKE_UTURN': case 'TRY_MAKE_UTURN': return { type: 'turn', modifier: 'uturn' };
      case 'ENTER_MOTORWAY': case 'ENTER_FREEWAY': case 'ENTER_HIGHWAY':
      case 'ENTRANCE_RAMP': return { type: 'on ramp', modifier: '' };
      case 'TAKE_EXIT': case 'MOTORWAY_EXIT_LEFT': case 'MOTORWAY_EXIT_RIGHT':
        return { type: 'off ramp', modifier: '' };
      case 'ROUNDABOUT_CROSS': case 'ROUNDABOUT_RIGHT': case 'ROUNDABOUT_LEFT':
      case 'ROUNDABOUT_BACK': return { type: 'roundabout', modifier: '' };
      default: return { type: 'continue', modifier: '' };
    }
  }

  /* TomTom calculateRoute -> OSRM-shaped route {geometry, legs, distance,
     duration} so the app's buildSteps/drawRoute/voice work unchanged.
     Extra: trafficDelaySec from the summary. */
  function routeFromTomTom(data) {
    var r = data && data.routes && data.routes[0];
    if (!r || !r.summary) throw new Error('no route');
    var ins = (r.guidance && r.guidance.instructions) || [];
    if (!ins.length) throw new Error('no guidance');
    var coords = [];
    (r.legs || []).forEach(function (leg) {
      (leg.points || []).forEach(function (p) { coords.push([p.longitude, p.latitude]); });
    });
    if (!coords.length) throw new Error('no geometry');
    var totalLen = r.summary.lengthInMeters;
    var totalTime = r.summary.travelTimeInSeconds; // traffic-aware when traffic=true
    var steps = ins.map(function (g, i) {
      var next = ins[i + 1];
      var mm = mapManeuver(g.maneuver);
      var loc = [g.point.longitude, g.point.latitude];
      var roadNumbers = Array.isArray(g.roadNumbers) ? g.roadNumbers.join(' ') : '';
      return {
        maneuver: { location: loc.slice(), type: mm.type, modifier: mm.modifier },
        name: g.street || '',
        ref: roadNumbers,
        distance: Math.max(0, (next ? next.routeOffsetInMeters : totalLen) - g.routeOffsetInMeters),
        duration: Math.max(0, (next ? next.travelTimeInSeconds : totalTime) - g.travelTimeInSeconds),
      };
    });
    return {
      geometry: { coordinates: coords },
      legs: [{ steps: steps }],
      distance: totalLen,
      duration: totalTime,
      trafficDelaySec: r.summary.trafficDelayInSeconds || 0,
    };
  }

  async function route(from, to) {
    // from/to are [lon, lat]; TomTom wants lat,lon in the path.
    var url = ROUTING_BASE + '/' + from[1] + ',' + from[0] + ':' + to[1] + ',' + to[0] +
      '/json?key=' + encodeURIComponent(apiKey()) +
      '&traffic=true&travelMode=car&instructionsType=text&language=en-GB';
    var res = await fetch(url);
    if (!res.ok) throw new Error('tomtom_route_' + res.status);
    var converted = routeFromTomTom(await res.json());
    lastDelaySec = converted.trafficDelaySec || 0;
    return converted;
  }
  function lastDelaySec_() { return lastDelaySec; }
  function shouldRouteWithTraffic() { return isOn(); }

  /* ---------------- incidents ---------------- */
  function categoryName(c) {
    switch (c) {
      case 1: return 'Accident';
      case 2: return 'Fog';
      case 3: return 'Dangerous conditions';
      case 4: return 'Rain';
      case 5: return 'Ice';
      case 6: return 'Jam';
      case 7: return 'Lane closed';
      case 8: return 'Road closed';
      case 9: return 'Road works';
      case 10: return 'Wind';
      case 11: return 'Flooding';
      case 14: return 'Broken-down vehicle';
      default: return 'Traffic incident';
    }
  }
  function severity(mag) {
    switch (mag) {
      case 1: return { color: '#FFA236', label: 'Minor delay' };
      case 2: return { color: '#FF7A00', label: 'Moderate delay' };
      case 3: return { color: '#FB0000', label: 'Major delay' };
      case 4: return { color: '#B30000', label: 'Closure' };
      default: return { color: '#FFC105', label: 'Incident' };
    }
  }
  function firstPoint(geom) {
    var c = geom && geom.coordinates;
    if (!c) return null;
    var mid;
    if (geom.type === 'Point') return [c[0], c[1]];
    if (geom.type === 'LineString' && c.length) { mid = c[Math.floor(c.length / 2)]; return [mid[0], mid[1]]; }
    if (geom.type === 'MultiLineString' && c.length && c[0].length) {
      mid = c[0][Math.floor(c[0].length / 2)]; return [mid[0], mid[1]];
    }
    if (geom.type === 'Polygon' && c.length && c[0].length) {
      // centroid of the outer ring — good enough for a marker
      var ring = c[0], sx = 0, sy = 0;
      ring.forEach(function (p) { sx += p[0]; sy += p[1]; });
      return [sx / ring.length, sy / ring.length];
    }
    return null;
  }
  function parseIncidents(data) {
    var out = [];
    var list = (data && data.incidents) || [];
    for (var i = 0; i < list.length; i++) {
      var inc = list[i] || {};
      var props = inc.properties || {};
      var pt = firstPoint(inc.geometry);
      if (!pt) continue;
      var events = props.events || [];
      var mag = (typeof props.magnitudeOfDelay === 'number') ? props.magnitudeOfDelay : 0;
      out.push({
        id: String(props.id || ''),
        iconCategory: props.iconCategory | 0,
        magnitudeOfDelay: mag,
        category: categoryName(props.iconCategory | 0),
        severity: severity(mag),
        description: (events[0] && events[0].description) || 'Traffic incident',
        delaySec: (typeof props.delay === 'number') ? props.delay : 0,
        lengthM: (typeof props.length === 'number') ? props.length : 0,
        roadNames: Array.isArray(props.roadNumbers) ? props.roadNumbers.slice() : [],
        from: props.from || '',
        to: props.to || '',
        lng: pt[0], lat: pt[1],
      });
    }
    return out;
  }

  function haversine(a, b) {
    var R = 6371000, dLat = (b[1] - a[1]) * Math.PI / 180, dLon = (b[0] - a[0]) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function quotaOk() {
    var c = cfg(), cap = c.maxIncidentRefreshesPerDay || 160;
    var today = new Date().toISOString().slice(0, 10);
    try {
      var q = JSON.parse(localStorage.getItem(LS_QUOTA) || '{}');
      if (q.date !== today) q = { date: today, count: 0 };
      if (q.count >= cap) return false;
      q.count++;
      localStorage.setItem(LS_QUOTA, JSON.stringify(q));
      return true;
    } catch (e) { return true; }
  }
  function incidentBbox() {
    // Clamp to a sane box: the API caps bboxes at 10,000 km^2 and we
    // only care about what's near the player anyway.
    var center = map.getCenter();
    var b = map.getBounds();
    var span = 0.8; // degrees
    var w = Math.min(b.getEast() - b.getWest(), span);
    var h = Math.min(b.getNorth() - b.getSouth(), span);
    return (center.lng - w / 2) + ',' + (center.lat - h / 2) + ',' +
           (center.lng + w / 2) + ',' + (center.lat + h / 2);
  }
  async function maybeRefreshIncidents(force) {
    if (!isOn() || !map) return;
    var now = Date.now();
    var c = cfg();
    var center = map.getCenter();
    var moved = !lastCenter || haversine([lastCenter.lng, lastCenter.lat], [center.lng, center.lat]) > (c.incidentMinMoveMeters || 1500);
    var stale = (now - lastIncidentFetch) > (c.incidentRefreshMs || 180000);
    if (!force && !(moved && stale)) return;
    if (!quotaOk()) return;
    lastCenter = { lng: center.lng, lat: center.lat };
    lastIncidentFetch = now;
    try {
      var url = INCIDENTS_URL + '?key=' + encodeURIComponent(apiKey()) +
        '&bbox=' + incidentBbox() +
        '&fields=' + encodeURIComponent(INCIDENT_FIELDS) +
        '&language=en-GB&timeValidityFilter=present';
      var res = await fetch(url);
      if (!res.ok) throw new Error('incidents_' + res.status);
      memIncidents = parseIncidents(await res.json());
      renderIncidents();
    } catch (e) { /* best-effort: stale markers stay, nothing breaks */ }
  }

  /* ---------------- map layers ---------------- */
  var ALERT_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
    '<path d="M24 5 L45 41 H3 Z" fill="#fff"/></svg>';
  function ensureIcon() {
    if (iconReady || !map || !map.hasImage) return;
    try {
      var img = new Image();
      img.onload = function () {
        try {
          if (!map.getImage('vcn-incident-alert')) {
            map.addImage('vcn-incident-alert', img, { sdf: true });
            iconReady = true;
            renderIncidents();
          }
        } catch (e) { /* style reloaded mid-flight; rehydrate() retries */ }
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(ALERT_SVG);
    } catch (e) { /* no Image (node test env) */ }
  }
  function ensureFlowLayer() {
    if (!map || map.getSource('vcn-traffic-flow')) return;
    map.addSource('vcn-traffic-flow', { type: 'raster', tiles: [flowTileUrl()], tileSize: 256 });
    var before = null;
    try {
      var layers = (map.getStyle() && map.getStyle().layers) || [];
      for (var i = 0; i < layers.length; i++) {
        if (layers[i].type === 'symbol') { before = layers[i].id; break; }
      }
    } catch (e) { /* fall through: append on top */ }
    var def = {
      id: 'vcn-traffic-flow', type: 'raster', source: 'vcn-traffic-flow',
      layout: { visibility: isOn() ? 'visible' : 'none' },
      paint: { 'raster-opacity': (typeof cfg().flowOpacity === 'number') ? cfg().flowOpacity : 0.8 },
    };
    if (before) map.addLayer(def, before); else map.addLayer(def);
  }
  function ensureIncidentLayer() {
    if (!map || map.getSource('vcn-traffic-incidents')) return;
    map.addSource('vcn-traffic-incidents', {
      type: 'geojson', data: { type: 'FeatureCollection', features: [] },
    });
    map.addLayer({
      id: 'vcn-traffic-incidents', type: 'symbol', source: 'vcn-traffic-incidents',
      layout: {
        visibility: isOn() ? 'visible' : 'none',
        'icon-image': 'vcn-incident-alert',
        'icon-size': 0.85,
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: {
        'icon-color': [
          'match', ['get', 'mag'],
          1, '#FFA236', 2, '#FF7A00', 3, '#FB0000', 4, '#B30000',
          '#FFC105',
        ],
      },
    });
  }
  function renderIncidents() {
    if (!map || !map.getSource('vcn-traffic-incidents')) return;
    map.getSource('vcn-traffic-incidents').setData({
      type: 'FeatureCollection',
      features: memIncidents.map(function (inc) {
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [inc.lng, inc.lat] },
          properties: { id: inc.id, mag: inc.magnitudeOfDelay },
        };
      }),
    });
  }
  function applyVisibility() {
    if (!map) return;
    var v = isOn() ? 'visible' : 'none';
    try {
      if (map.getLayer('vcn-traffic-flow')) map.setLayoutProperty('vcn-traffic-flow', 'visibility', v);
      if (map.getLayer('vcn-traffic-incidents')) map.setLayoutProperty('vcn-traffic-incidents', 'visibility', v);
    } catch (e) { /* layer dropped by a style swap; rehydrate() restores */ }
  }
  function wireCard() {
    var card = document.getElementById('incident-card');
    if (!card) return;
    var close = document.getElementById('incident-close');
    if (close) close.addEventListener('click', function () { card.hidden = true; });
    if (wired || !map) return;
    wired = true;
    map.on('click', 'vcn-traffic-incidents', function (e) {
      var f = e.features && e.features[0];
      if (!f) return;
      var inc = null;
      for (var i = 0; i < memIncidents.length; i++) {
        if (memIncidents[i].id === f.properties.id) { inc = memIncidents[i]; break; }
      }
      if (!inc) return;
      document.getElementById('incident-title').textContent = inc.category;
      document.getElementById('incident-desc').textContent = inc.description;
      var bits = [inc.severity.label];
      if (inc.delaySec > 0) bits.push(Math.round(inc.delaySec / 60) + ' min delay');
      if (inc.lengthM > 0) bits.push((inc.lengthM >= 1000 ? (inc.lengthM / 1000).toFixed(1) + ' km' : Math.round(inc.lengthM) + ' m'));
      if (inc.roadNames.length) bits.push(inc.roadNames.join(' / '));
      document.getElementById('incident-meta').textContent = bits.join(' · ');
      card.hidden = false;
    });
  }

  /* ---------------- public API ---------------- */
  function init(m) {
    map = m;
    ensureIcon();
    ensureFlowLayer();
    ensureIncidentLayer();
    renderIncidents();
    applyVisibility();
    wireCard();
    try { map.on('moveend', function () { maybeRefreshIncidents(false); }); } catch (e) {}
    if (isOn()) maybeRefreshIncidents(true);
  }
  function rehydrate() {
    // setStyle drops every custom source/layer/image — rebuild them.
    iconReady = false; wired = false;
    ensureIcon();
    ensureFlowLayer();
    ensureIncidentLayer();
    renderIncidents();
    applyVisibility();
    wireCard();
  }
  function setOn(on) {
    if (on && !hasKey()) return { ok: false, reason: 'no-key' };
    trafficOn = !!on;
    try { localStorage.setItem(LS_ON, trafficOn ? '1' : '0'); } catch (e) {}
    applyVisibility();
    if (trafficOn) maybeRefreshIncidents(true);
    return { ok: true };
  }
  function restore() {
    try { trafficOn = localStorage.getItem(LS_ON) === '1'; } catch (e) { trafficOn = false; }
    return trafficOn;
  }

  window.VCNTraffic = {
    init: init,
    rehydrate: rehydrate,
    restore: restore,
    isOn: isOn,
    setOn: setOn,
    hasKey: hasKey,
    shouldRouteWithTraffic: shouldRouteWithTraffic,
    route: route,
    lastDelaySec: lastDelaySec_,
    maybeRefreshIncidents: maybeRefreshIncidents,
    // pure + documented for tests (no DOM/map needed)
    flowTileUrl: flowTileUrl,
    mapManeuver: mapManeuver,
    routeFromTomTom: routeFromTomTom,
    parseIncidents: parseIncidents,
  };
})();
