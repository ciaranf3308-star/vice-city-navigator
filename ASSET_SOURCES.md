# WayStation Asset Sources

Every visual asset in WayStation is local — nothing is hotlinked at
runtime. This file records the exact source, original filename,
WayStation filename, conversion, and license/source notes for each
asset, per the project brief.

## 2026-09-07 — Multi-theme foundation (San Andreas / GTA V / Frontier)

### Note on game-asset extraction

The brief originally asked for textures harvested from community
repositories of extracted game assets (ClassicHud TXDs for San Andreas,
V-Hud references for GTA V, `rdr3_discoveries` for RDR2). The helper
tasked with that extraction was refused by a safety policy, and the
extraction path was not retried. **No game-extracted textures ship in
these three themes.** Instead they ship with original artwork drawn for
the project (pixel-art blips, player markers) and open-licensed fonts
(see below), composed in each game's visual language.

If extracted PNGs become available later, they can replace the
generated art drop-in: name them `<semantic>.png` and place them in
`assets/themes/<theme>/blips/` (each theme's `semanticIconMap` is `{}`,
so file stems equal WayStation semantic category names), plus
`player.png` for the player marker.

The Vice City theme is unaffected: it keeps its authentic extracted
blips and player arrow from the earlier ClassicHud TXD work.

### Generated blip art (original, no source)

- Generator: `tools/build_theme_art.py` (PIL, re-runnable)
- WayStation filenames:
  - `assets/themes/san-andreas/blips/<semantic>.png` (29 files)
  - `assets/themes/gta-v/blips/<semantic>.png` (29 files)
  - `assets/themes/rdr2/blips/<semantic>.png` (29 files)
- `<semantic>` is one of the 27 WayStation categories
  (`airport atm bank bar burger cafe car_wash chicken cinema ev_charger
  fast_food fuel garage gym hospital hotel mall nightlife parking
  pharmacy pizza police restaurant shop stadium supermarket train`)
  plus `waypoint` (destination marker) and `qmark` (fallback icon).
- Conversion: n/a — drawn directly at 16×16 RGBA.
- License: original artwork created for this project.
- Style notes:
  - San Andreas: chunky white pixel pictogram on a black rounded square
    (reads on the tan pause-map ground, echoes SA's stark radar icons).
  - GTA V: white pictogram on a category-colored disc with a white ring
    (echoes V's colored-blip language).
  - Frontier: dark-ink pictogram on a parchment disc with an ink ring
    (echoes RDR2's paper map).

### Generated player markers (original, no source)

- Generator: `tools/build_theme_art.py`
- WayStation filenames:
  - `assets/themes/san-andreas/player.png` (32×32 white arrow, black edge)
  - `assets/themes/gta-v/player.png` (32×32 white wedge, grey edge)
  - `assets/themes/rdr2/player.png` (32×32 ink arrow on parchment disc)
- License: original artwork created for this project.

### Map label fonts (open-licensed, self-hosted as SDF glyph PBFs)

Map labels are rendered from self-hosted MapLibre glyph PBFs
(`fonts/<stack>/{range}.pbf`), generated with fontnik
(`tools` note: `/tmp/fontnik-test` install; `build-glyphs` CLI).

| Theme | Font | Source | Original file | License |
|---|---|---|---|---|
| San Andreas (`san-andreas`) | Archivo Narrow Bold | Google Fonts (`fonts.gstatic.com`, served as static TTF via the css v1 API) | `Archivo Narrow` 700 | SIL Open Font License 1.1 |
| GTA V (`gta-v`) | Inter SemiBold | Google Fonts (same route) | `Inter` 600 | SIL Open Font License 1.1 |
| Frontier (`frontier`) | Rye Regular | Google Fonts (`github.com/google/fonts`, `ofl/rye/Rye-Regular.ttf`) | `Rye-Regular.ttf` | SIL Open Font License 1.1 (Copyright (c) 2010 Sorkin Type Co) |

- Conversion: TTF → SDF glyph PBFs (ranges 0–65535 generated;
  map labels use 0–255) via fontnik `build-glyphs`.
- WayStation filenames: `fonts/san-andreas/0-255.pbf` etc.,
  `fonts/gta-v/0-255.pbf` etc., `fonts/frontier/0-255.pbf` etc.
- Design note: Archivo Narrow Bold gives SA's condensed punch without
  reusing Vice City's Pricedown; Inter SemiBold approximates GTA V's
  clean grotesque map voice; Rye is a period western tuscan for the
  Frontier paper map.

### Map styles (original, built from OpenMapTiles)

- Generator: `tools/build_theme_styles.py` (re-runnable)
- WayStation filenames:
  - `themes/san-andreas/style.json` (29 layers, ids `sa-*`)
  - `themes/gta-v/style.json` (29 layers, ids `v-*`)
  - `themes/rdr2/style.json` (29 layers, ids `rdr-*`)
- Source: OpenMapTiles vector tiles (`https://tiles.openfreemap.org/planet`)
  — real geography in every theme; no fictional game geography.
- Conversion: n/a — authored directly against the vector source.
- License: original style authorship; tile data © OpenMapTiles /
  © OpenStreetMap contributors.
- Each style is independent (not a hue-shift of another theme):
  San Andreas = tan ground, black road network, restrained greens;
  GTA V = pale monochrome Atlas look, white road hierarchy;
  Frontier = warm parchment, hand-inked roads, strong railways,
  restrained water. All three validate with 0 errors against the
  MapLibre style spec.

## Earlier assets (Vice City theme, unchanged)

Documented in prior work: authentic blips extracted from ClassicHud
(Vice City TXD packs) via a TXD parser (`assets/themes/vice-city/blips/blip_*.png`,
27 files, `filePrefix: 'blip_'` in `themes/vice-city/theme.js`);
player arrow from `hud.txd` (`assets/themes/vice-city/player.png`);
PricedownBl/Oswald SDF glyphs (`fonts/PricedownBl`, `fonts/Oswald`);
`vice-city-style.json` (29 layers, ids `vc-*`).

## 2026-09-07 — Vice City Spotify dashboard skin (recomposed art)

### Source artwork
- Supplied by the user (transparent concept PNG, 1448x1086 RGBA):
  `assets/spotify/vice_city_synthwave_music_widget.png`.
  Kept in-repo as the component source; NOT served to clients at runtime.
- Generator: `tools/build_spotify_crops.py` (PIL, re-runnable). Crops the
  4:3 source into portrait-pane pieces at 2x for the ~2:3 dashboard pane:
  - `themes/vice-city/spotify/header.png` (960x346) — neon logo + sun + skyline + tube
  - `themes/vice-city/spotify/album.png` (560x666) — pink neon frame (transparent interior) + dark navy band
  - `themes/vice-city/spotify/stage.png` (960x714) — sunset/palms/skyline lyric stage
  - `themes/vice-city/spotify/tube.png` (960x30) — bottom neon tube
- Album-art placement: the frame's interior opening was measured
  programmatically (pink-pixel bbox, inset by border width); fractions are
  baked into `themes/vice-city/spotify-skin.js` as FRAME. The live album
  `<img>` renders UNDER the frame crop (z-order: art below, frame over it).
- Skin code lives with the theme: `themes/vice-city/spotify-skin.js` /
  `spotify-skin.css`, registered as the `vice-city` skin and selected via
  the theme's `spotify.skin` field. Shared core (`spotify-core.js`) is
  theme-independent.
- License: user-supplied concept art for this personal project.
