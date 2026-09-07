# Google Places API (New) — setup for ambient POIs

Ambient Vice City blips (garages, petrol stations, restaurants, hotels, … appearing
automatically as you drive) are powered by **Places API (New) Nearby Search**.
Without a key, the map works exactly as before — just with no automatic POIs.

## 1. Create the key

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → APIs & Services → Library.
2. Enable **Places API (New)** on your project (billing must be enabled — Nearby Search is a billed SKU).
3. Go to APIs & Services → **Credentials** → Create Credentials → **API key**.

## 2. Restrict the key (recommended by Google)

Edit the key and set both restrictions:

- **Application restrictions → Websites (HTTP referrers)**, add:
  - `https://ciaranf3308-star.github.io/*`
- **API restrictions → Restrict key**, select only:
  - **Places API (New)**

This means the key only works from the live site and only for Places — safe to ship in the PWA.

## 3. Install the key

Open `places-config.js` in the repo root and paste the key:

```js
apiKey: 'AIzaSy…your-key…',
```

Commit and push. The site picks it up on next load (no rebuild needed).

## How it works

- On the first GPS fix, the app calls `POST https://places.googleapis.com/v1/places:searchNearby`
  with `X-Goog-Api-Key` and a minimal field mask
  (`places.id,places.location,places.primaryType,places.types,places.displayName`).
- Five grouped requests per refresh (driving / food / useful / shopping / leisure),
  2500 m radius, up to 20 results each. All requested place types were verified
  against Google's current Table A (2026-09-07).
- It re-queries only after you've moved ~750 m from the last query centre —
  never on every GPS update.
- POIs are cached in memory + `localStorage` for 24 h, so driving back through
  an area doesn't re-fetch.
- Blips are the authentic Vice City PNGs (plus `fuel` and `parking` drawn in the
  same pixel-art style for types the original game never had).
- Zoom tiers: 12+ driving/hospital/police, 14+ useful POIs, 16+ full set
  (bars, clubs, cinema). Tap any blip for a Vice City place card with
  **Set destination**, which feeds the existing OSRM routing.
