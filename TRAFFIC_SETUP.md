# Live traffic setup (TomTom, 2 minutes)

WayStation's Live traffic toggle gives you three things:

1. **Traffic flow overlay** — TomTom raster tiles in `relative-delay` style.
   Roads are painted only where traffic differs from free-flow
   (green / yellow / red), sitting quietly under the map labels.
2. **Incident markers** — jams, road works and closures near your map,
   as alert-triangle markers. Tap one for a card with its description,
   delay and affected stretch.
3. **Traffic-aware routing** — routes use TomTom's calculateRoute with
   live traffic, so ETAs and turn lists reflect real conditions. The
   route is normalized into the same shape as OSRM, so the turn list,
   rerouting and voice guidance behave exactly as before.

OSRM stays the default engine **and** the silent fallback: if TomTom
ever fails (bad key, outage), the app just plans via OSRM — routing
never breaks because of traffic.

## Getting a key (free, no credit card)

1. Sign up at <https://developer.tomtom.com/> — the free plan gives
   you **2,500 requests/day**, which is plenty for this.
2. In the dashboard, open your app and copy the **API key**.
3. Restrict it to your site: add an HTTP referrer (or key domain)
   restriction for `https://ciaranf3308-star.github.io/*` so nobody
   else's site can burn your quota.
4. Open `traffic-config.js` in this repo and paste the key as the
   value of `TOMTOM_TRAFFIC_CONFIG.apiKey`
   (replacing `PUT_YOUR_TOMTOM_KEY_HERE`).
5. Commit + push (GitHub Pages redeploys automatically), reload the
   app, then flip **Live traffic** ON in the menu's Display section.

Without a key, the toggle refuses and points you here instead of
failing silently.

## Quota behavior

- **Flow tiles** are cached by the browser like map tiles — a driving
  session costs a few dozen requests.
- **Incidents** refresh at most every **3 minutes**, and only after the
  map has moved ~1.5 km since the last refresh — only while the toggle
  is ON. There's also a daily cap of 160 incident refreshes (tweakable
  in `traffic-config.js`).
- **Routing** costs 1 request per route plan / reroute, only while the
  toggle is ON.

## Turning it off

Menu → Display → uncheck **Live traffic**. The overlay and markers
disappear and routing goes back to plain OSRM. Your choice is
remembered on the device.
