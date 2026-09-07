# WayStation Asset Sources

Every visual asset in WayStation is local — nothing is hotlinked at
runtime. This file records the exact source, original filename,
WayStation filename, conversion, and license/source notes for each
asset, per the project brief.

## 2026-09-07 — Full-fidelity typography + GTA V blip pass

This pass replaces every theme's approximate fonts with the actual
game typefaces (or the closest documented match) and replaces GTA V's
generic pixel-art blips with the v-hud HUD icon set. It supersedes the
"no game-extracted textures" note below for GTA V fonts/blips.

### GTA V fonts (actual game files)

- Source: `https://github.com/gennariarmando/v-hud` (MIT License),
  `resources/VHud/fonts/` — the v-hud author extracted these from
  GTA V's Scaleform files.
- Original → WayStation:
  - `Chalet-LondonNineteenSixty.ttf` → `fonts/chalet-london.woff2`
    (UI body, map place labels, `fonts/gta-v/` SDF glyphs)
  - `ChaletComprime-CologneSixtyScale.ttf` → `fonts/chalet-comprime.woff2`
    (condensed display titles)
  - `SignPainter-HouseScript.ttf` → `fonts/signpainter.woff2`
    (street-name labels on the map via `fonts/SignPainter/` SDF glyphs —
    GTA V renders road names in this script)
  - `PricedownGTA.ttf` → `fonts/pricedown-gta.woff2`
    (V's HUD money typeface; wired as a family, used for numerals)
- Conversion: TTF → woff2 via fontTools/brotli; SDF glyph PBFs
  (256 ranges, 0–65535) via fontnik from the TTFs.
- License note: the v-hud repo is MIT-licensed; the typefaces
  themselves are Rockstar's, extracted by the mod author. Shipped as
  game-authenticity assets for a personal project.

### GTA V blips (v-hud HUD icon set)

- Source: same v-hud repo, `resources/VHud/blips/` — 63 `radar_*.dds`
  files (64×64 DXT, white V-style HUD pictograms; SA naming because
  v-hud is a GTA V HUD for San Andreas).
- WayStation filenames: `assets/themes/gta-v/blips/<semantic>.png`
  (29 files, 32×32 RGBA) + `assets/themes/gta-v/player.png` (32×32,
  from `radar_player.dds`).
- Conversion: DDS → PNG via Pillow; white icon re-composited with a
  soft dark outline (GTA V's blips are white with a dark edge) at 2×
  the other themes' nominal size; `pois.blipScale: 0.5` in
  `themes/gta-v/theme.js` keeps on-screen size consistent
  (`places.js` multiplies the shared icon-size expression).
- SA-stem → semantic mapping:
  airport←airyard, atm/bank←cash, bar←datedrink, burger←burgershot,
  car_wash←spray, chicken←chicken, fast_food←diner, garage←modgarage,
  gym←gym, hospital←hospital, hotel←savegame, mall/shop←tshirt,
  nightlife←datedisco, pizza←pizza, police←police, restaurant←datefood,
  waypoint←waypoint, qmark←qmark; cafe/cinema/ev_charger/fuel/parking/
  pharmacy/stadium/supermarket/train fall back to the qmark icon (no
  corresponding V-style pictogram exists).
- Replaces the generic pixel-art set from the multi-theme foundation
  (old notes below retained for history).

### San Andreas fonts (documented game typefaces)

Per the GTA Wiki font table, SA uses Pricedown (mission text/HUD),
Bank Gothic (menu items), and Beckett (menu titles).
- `Bank Gothic` (menu items, HUD labels, map glyphs):
  `https://fonts.cdnfonts.com/css/bank-gothic`
  (ufonts.com rip, "BankGothic Medium") → `fonts/bank-gothic.woff`
  and `fonts/san-andreas/` SDF glyphs (fontnik, woff→TTF via fontTools).
  Freeware listing; metric-compatible with the SA menu face.
- `Beckett` (menu screen titles — MAP/BRIEF/STATS blackletter):
  `https://www.dafont.com/beckett.font` (`BECKETT_.TTF`, freeware) →
  `fonts/beckett.woff2`.
- Pricedown: existing `fonts/pricedown-bl.woff` (authentic, unchanged).

### RDR2 / Frontier fonts (actual game typefaces)

- `RDR Lino` (the RDR2 map serif — "SAINT DENIS" lettering — and menu
  serif): served as a webfont by the fan site
  `https://github.com/aulonajvazi/rdr2` via
  `https://db.onlinewebfonts.com/t/ab21a97b9cae2e116d8d1473baefc9f0.ttf`
  ("RDR Lino Regular"; community rip of the in-game font, also in the
  mods.club "all RDR2 fonts" pack as RDRLino-Regular) →
  `fonts/rdr-lino.woff2` and `fonts/frontier/` SDF glyphs (fontnik).
  Map place labels also gain `text-letter-spacing: 0.18` to match the
  game's tracked-out capitals.
- `Kirsty` (RDR2 title slab — "ARTHUR MORGAN", money, presents cards;
  identified via GTAForums font research):
  `https://www.dafont.com/kirsty.font` (`Kirsty Rg.otf`, freeware) →
  `fonts/kirsty.woff2`.
- Replaces the previous `Rye` approximation for UI display type.

### Map glyph stack summary (after this pass)

- `fonts/PricedownBl/` — Vice City (unchanged, authentic)
- `fonts/Oswald/`, `fonts/PricedownBl,Oswald/` — VC fallbacks (unchanged)
- `fonts/san-andreas/` — regenerated from Bank Gothic
- `fonts/gta-v/` — regenerated from Chalet London Nineteen Sixty
- `fonts/SignPainter/` — new, SignPainter HouseScript (V road labels)
- `fonts/frontier/` — regenerated from RDR Lino
- `themes/gta-v/style.json` road layers use `["SignPainter"]`;
  all other label layers use their theme's single stack.

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

## 2026-09-07 — RDR2 / Frontier blip artwork (authentic community pack)

### Source
- Repo: https://github.com/femga/rdr3_discoveries (community RDR3/RDR2 research repo — NOT retail discs)
- Catalogue: `useful_info_from_rpfs/textures/blips/README.md` — lists every blip texture hashname + hash, with preview images and per-icon downloads
- Pack used: the **no-background** transparent PNG set:
  `https://femga.com:8080/images/samples/ui_textures_no_bg/blips.zip`
  (individual: `https://femga.com:8080/images/samples/ui_textures_no_bg/blips/<hashname>.png`)
  Texture dictionary: BLIPS (-437533031). All icons 32x32 RGBA white line art on a
  soft dark halo (authentic RDR2 minimap rendering); downscaled to 16x16 LANCZOS so
  on-map scale matches the other themes (`icon-size` multiplier 2.2–3.4 in places.js
  is tuned for 16px natives).
- License/source note: community-redistributed extracted UI textures, same class of
  source as the Vice City ClassicHud assets. Personal-use project.

### Files replaced (semantic name → RDR2 blip hashname [texture hash])
- `assets/themes/rdr2/blips/atm.png` ← blip_cash_bag [688589278] (money bag = cash)
- `assets/themes/rdr2/blips/bank.png` ← blip_proc_bank [-2128054417]
- `assets/themes/rdr2/blips/bar.png` ← blip_saloon [1879260108]
- `assets/themes/rdr2/blips/burger.png` ← blip_shop_butcher [-1665418949] (butcher's cleaver = meat)
- `assets/themes/rdr2/blips/cafe.png` ← blip_supply_icon_food [412928073] (frying pan = diner cookery)
- `assets/themes/rdr2/blips/chicken.png` ← blip_supplies_food [-1852063472] (chicken leg)
- `assets/themes/rdr2/blips/cinema.png` ← blip_ambient_theatre [-417940443] (theatre masks)
- `assets/themes/rdr2/blips/fast_food.png` ← blip_donate_food [-1236018085] (tinned/quick fare)
- `assets/themes/rdr2/blips/garage.png` ← blip_stable [-73168905] (stable = horse garage)
- `assets/themes/rdr2/blips/hospital.png` ← blip_shop_doctor [-1739686743] (doctor's bag)
- `assets/themes/rdr2/blips/hotel.png` ← blip_hotel_bed [-211556852]
- `assets/themes/rdr2/blips/nightlife.png` ← blip_mg_drinking [1242464081] (whiskey glass)
- `assets/themes/rdr2/blips/parking.png` ← blip_ambient_hitching_post [1220803671]
- `assets/themes/rdr2/blips/pharmacy.png` ← blip_plant [-675651933] (herbs = apothecary)
- `assets/themes/rdr2/blips/police.png` ← blip_ambient_sheriff [-693644997]
- `assets/themes/rdr2/blips/qmark.png` ← blip_rc [-1822497728] (authentic "?" stranger icon)
- `assets/themes/rdr2/blips/restaurant.png` ← blip_grub [935247438] (knife & fork)
- `assets/themes/rdr2/blips/shop.png` ← blip_shop_store [1475879922]
- `assets/themes/rdr2/blips/supermarket.png` ← blip_shop_market_stall [819673798]
- `assets/themes/rdr2/blips/train.png` ← blip_ambient_train [-250506368]
- `assets/themes/rdr2/blips/waypoint.png` ← blip_code_waypoint [960467426]
- `assets/themes/rdr2/player.png` ← blip_player [-523921054] (authentic white teardrop player marker, kept at native 32x32)

### Semantics that kept the existing placeholder (no 1899 analogue in the RDR2 set)
- `airport.png`, `car_wash.png`, `ev_charger.png`, `fuel.png`, `gym.png`,
  `mall.png`, `pizza.png`, `stadium.png` — no period equivalent exists in the
  RDR2 blip catalogue (1899: no flight, automobiles, gyms, malls, stadiums, or
  distinct pizza iconography). Existing generic pixel-art placeholders retained.

### Fonts
- The femga/rdr3_discoveries repo contains no HUD font files (TTF/OTF/WOFF) —
  RDR2's actual HUD fonts are proprietary Rockstar assets and are not
  redistributed there. No `assets/themes/rdr2/fonts/` directory was created;
  the theme keeps its Rye open-font rendering (`fontStack: 'frontier'`).

## 2026-09-07 — San Andreas blip artwork (authentic community pack)

### Source
- Repo: https://github.com/lolipalooza/ClassicHud (community SA HUD mod —
  NOT retail discs). Note: the paths `resources/radar/sa_blips.txd`,
  `resources/radar/sa_radar.txd`, `resources/data/sa_hud.dat`,
  `resources/data/sa_hudColor.dat` do **not** exist in this repo; the
  equivalent real assets live at:
  - `Resources/models/ClassicHud/SanAndreas/hud.txd` — SA radar blips
    (`radar_*` textures), player marker (`radar_centre`), `radardisc`,
    `skipicon`, weapon `site*` icons
  - `Resources/models/ClassicHud/SanAndreas/fonts.txd` — SA bitmap font
    sheets (`font1`, `font2`, 512x512 DXT3)
  - `Resources/models/ClassicHud/SanAndreas/fonts.dat` — font metrics
- Conversion: `txd2png.py` (RenderWare D3D9 native parser: rasterFormat +
  DXT FourCC, DXT1/3/5, 8888/565/1555/4444) → 69 textures decoded, 62 of
  them 16x16 `radar_*` icons with true 1-bit alpha. Script lived in /tmp;
  not committed.
- Cross-check: https://github.com/J33sus/GTA-SA-Menu/tree/master/images/mapicons
  inspected — holds 15 of the same radar icons as small PNGs
  (radar_ammugun, radar_barbers, radar_burgerShot, radar_emmetGun,
  radar_Flag, radar_girlfriend, radar_modGarage, radar_pizza,
  radar_propertyG, radar_saveGame, radar_school, radar_spray,
  radar_tattoo, radar_truck, radar_tshirt). The TXD extraction is a
  superset (62 icons) with cleaner provenance, so it was used instead.
- License: community-redistributed SA mod assets for this personal project
  (same standing as the Vice City ClassicHud extraction).

### Replacements (19 blips + player; 16x16, dropped in 1:1, no stretching)
WayStation semantic → ClassicHud `hud.txd` texture:
- `airport.png` ← `radar_airYard` (plane)
- `atm.png` ← `radar_cash` (green $)
- `bar.png` ← `radar_dateDrink` (cocktail glass)
- `burger.png` ← `radar_burgerShot` (burger)
- `cafe.png` ← `radar_diner` (milkshake cup)
- `car_wash.png` ← `radar_spray` (Pay'n'Spray = SA's car repaint/wash)
- `chicken.png` ← `radar_chicken` (Cluckin' Bell chicken)
- `fast_food.png` ← `radar_burgerShot` (second copy — generic fast-food chains)
- `garage.png` ← `radar_modGarage` (wrench)
- `gym.png` ← `radar_gym` (dumbbell)
- `hospital.png` ← `radar_hostpital` (red cross; SA's own misspelling)
- `nightlife.png` ← `radar_dateDisco` (vinyl record)
- `pizza.png` ← `radar_pizza` (pizza slice)
- `police.png` ← `radar_police` (blue badge)
- `qmark.png` ← `radar_qmark` (question mark)
- `restaurant.png` ← `radar_dateFood` (fork & knife)
- `shop.png` ← `radar_tshirt` (clothing store)
- `stadium.png` ← `radar_race` (trophy cup)
- `waypoint.png` ← `radar_waypoint` (red crosshair)
- `player.png` ← `radar_centre` (SA's authentic white radar triangle,
  16x16 → 32x32 NEAREST to match existing player.png size)

### Placeholders kept (10 semantics — no suitable SA source icon exists)
- `bank.png` — no SA bank blip (SA's `$` went to atm; bank stays pixel-art)
- `cinema.png`, `hotel.png`, `mall.png`, `parking.png`, `pharmacy.png`,
  `supermarket.png`, `train.png`, `fuel.png` — SA has no radar icons for
  these categories
- `ev_charger.png` — anachronistic for SA; intentionally kept pixel-art

### Fonts
- No TTF/OTF in ClassicHud or J33sus — only bitmap font sheets
  (`fonts.txd`: `font1`/`font2`). Downloaded to /tmp for inspection only;
  not shipped. Theme keeps its Archivo Narrow Bold open-font rendering.
- SA's classic font is Pricedown (same family as Vice City's title font),
  but no community TTF/OTF source was found; not added.

### hud.dat / hudColor.dat
- Not present in the ClassicHud repo (only `classichud.dat` INI-style
  config exists) — no color findings to report.

### Unused authentic SA icons (available for future mapping)
`radar_ammugun`, `radar_emmetGun`, `radar_barbers`, `radar_tattoo`,
`radar_school`, `radar_impound`, `radar_boatyard`, `radar_bulldozer`,
`radar_truck`, `radar_runway`, `radar_light`, `radar_fire`,
`radar_propertyG`/`radar_propertyR`, `radar_saveGame`, `radar_girlfriend`,
`radar_Flag`, `radar_enemyAttack`, `radar_north`, `radardisc`, gang icons
(`radar_gangB/G/N/P/Y`), mission contact letters (`radar_BIGSMOKE`,
`radar_CATALINAPINK`, `radar_CESARVIAPANDO`, `radar_CJ`,
`radar_LocoSyndicate`, `radar_MADDOG`, `radar_MCSTRAP`, `radar_OGLOC`,
`radar_RYDER`, `radar_SWEET`, `radar_THETRUTH`, `radar_TORENO`,
`radar_TorenoRanch`, `radar_WOOZIE`, `radar_ZERO`, `radar_CRASH1`,
`radar_triads`, `radar_triadsCasino`, `radar_mafiaCasino`).
