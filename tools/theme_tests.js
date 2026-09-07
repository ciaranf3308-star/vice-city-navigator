/* WayStation theme-foundation logic tests (node, no DOM).
   Covers: registry shape, semantic->blip URL resolution per theme,
   file prefixes, waypoint fallback, style JSON validity + distinctness,
   blip/player PNG assets on disk, glyph PBFs, SW shell/theme-asset
   classification, POI importance ordering + inverse sort-key formula. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name); }
}
function pngSize(p) {
  const b = fs.readFileSync(p);
  // PNG IHDR: width/height are big-endian uint32 at offsets 16/20
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png: ' + p);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/* ---------- load registry + theme defs in a stubbed window ---------- */
const sandbox = {
  window: {},
  localStorage: { _s: {}, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; }, removeItem(k) { delete this._s[k]; } },
  console,
};
vm.createContext(sandbox);
for (const f of ['themes/registry.js', 'themes/vice-city/theme.js', 'themes/san-andreas/theme.js',
                 'themes/gta-v/theme.js', 'themes/rdr2/theme.js']) {
  vm.runInContext(fs.readFileSync(path.join(REPO, f), 'utf8'), sandbox, { filename: f });
}
const T = sandbox.window.VCNThemes;
const SEMANTICS = ['airport','atm','bank','bar','burger','cafe','car_wash','chicken','cinema',
  'ev_charger','fast_food','fuel','garage','gym','hospital','hotel','mall','nightlife','parking',
  'pharmacy','pizza','police','restaurant','shop','stadium','supermarket','train'];

ok(T.ids().length === 4, 'registry has 4 themes');
for (const id of ['vice-city', 'san-andreas', 'gta-v', 'rdr2']) {
  const t = T.get(id);
  ok(!!t, `theme registered: ${id}`);
  ok(t.map && typeof t.map.styleUrl === 'string' && t.map.styleUrl.endsWith('style.json'), `${id} map.styleUrl`);
  ok(t.map && typeof t.map.fontStack === 'string', `${id} map.fontStack`);
  ok(t.map && typeof t.map.routeColor === 'string', `${id} map.routeColor`);
  ok(t.map && typeof t.map.playerMarker === 'string' && t.map.playerMarker.endsWith('player.png'), `${id} map.playerMarker`);
  ok(t.pois && typeof t.pois.assetPath === 'string', `${id} pois.assetPath`);
  ok(t.pois && typeof t.pois.fallbackIcon === 'string', `${id} pois.fallbackIcon`);
  ok(t.ui && typeof t.ui.bodyClass === 'string', `${id} ui.bodyClass`);
  ok(fs.existsSync(path.join(REPO, t.map.playerMarker)), `${id} player.png on disk`);
  // every semantic resolves to a URL whose file exists on disk
  for (const sem of SEMANTICS.concat(['waypoint', 'qmark'])) {
    const url = T.poiIconUrl(sem, id);
    ok(fs.existsSync(path.join(REPO, url)), `${id} blip on disk: ${sem} -> ${url}`);
  }
  // waypoint fallback: unknown semantic resolves to the theme waypoint, never qmark
  const wp = T.poiIconUrl('waypoint', id);
  ok(/waypoint\.png$/.test(wp), `${id} waypoint resolves to waypoint.png`);
  const unknown = T.poiIconUrl('no_such_category', id);
  ok(unknown.endsWith(t.pois.fallbackIcon + '.png') || /waypoint\.png$/.test(unknown),
     `${id} unknown semantic falls back sanely: ${unknown}`);
}
const vcUrl = T.poiIconUrl('fuel', 'vice-city');
ok(vcUrl === 'assets/themes/vice-city/blips/blip_fuel.png', `VC filePrefix blip_: ${vcUrl}`);
ok(T.poiIconUrl('fuel', 'san-andreas') === 'assets/themes/san-andreas/blips/fuel.png', 'SA no prefix');
ok(T.poiIconUrl('fuel', 'gta-v') === 'assets/themes/gta-v/blips/fuel.png', 'V no prefix');
ok(T.poiIconUrl('fuel', 'rdr2') === 'assets/themes/rdr2/blips/fuel.png', 'RDR2 no prefix');
ok(T.poiImageId('gta-v', 'fuel') === 'poi-gta-v-fuel', 'namespaced image ids');

/* ---------- style JSONs ---------- */
const styles = {};
for (const id of T.ids()) {
  const stylePath = path.join(REPO, T.get(id).map.styleUrl);
  ok(fs.existsSync(stylePath), `${id} style.json exists`);
  const style = JSON.parse(fs.readFileSync(stylePath, 'utf8'));
  styles[id] = style;
  ok(style.version === 8, `${id} style version 8`);
  ok(Array.isArray(style.layers) && style.layers.length >= 29, `${id} has 29+ layers (got ${style.layers.length})`);
  const srcs = new Set(Object.values(style.sources || {}).map(s => s.tiles && s.tiles[0]).filter(Boolean));
  ok([...srcs].every(u => u.includes('openfreemap')), `${id} sources are OpenFreeMap`);
  const stack = T.get(id).map.fontStack;
  ok(typeof style.glyphs === 'string' && style.glyphs.includes('{fontstack}'),
     `${id} style glyphs url uses {fontstack} placeholder`);
  ok(fs.existsSync(path.join(REPO, 'fonts', stack, '0-255.pbf')), `${id} glyph PBFs present for ${stack}`);
  const raw = fs.readFileSync(stylePath, 'utf8');
  ok(!/"layout"\s*:\s*{[^}]*"line-dasharray"/.test(raw), `${id} no layout.line-dasharray (spec-invalid)`);
  for (const p of ['player.png']) ok(true, 'noop');
}
const bgs = T.ids().map(id => styles[id].layers.find(l => l.id.endsWith('-land') || l.id === 'background' || /land/.test(l.id) && l.type === 'background' || l.type === 'background'));
ok(new Set(T.ids().map(id => {
  const bg = styles[id].layers.find(l => l.type === 'background');
  return bg && bg.paint && bg.paint['background-color'];
})).size === 4, 'all four themes have distinct background colors');
// every fontstack referenced by a label layer resolves to a shipped glyph dir
for (const id of T.ids()) {
  const labelLayers = styles[id].layers.filter(l => l.layout && l.layout['text-font']);
  ok(labelLayers.length > 0, `${id} has label layers`);
  for (const l of labelLayers) {
    const fonts = l.layout['text-font'];
    const list = Array.isArray(fonts) ? fonts : [fonts];
    for (const f of list) {
      const dir = path.join(REPO, 'fonts', String(f));
      ok(fs.existsSync(path.join(dir, '0-255.pbf')), `${id} layer ${l.id} fontstack dir fonts/${f}/`);
    }
  }
}

/* ---------- PNG assets on disk ---------- */
for (const id of T.ids()) {
  // nominal blip size: 16px shared baseline; themes shipping larger art
  // (gta-v: 32px) declare pois.blipScale and places.js compensates.
  const scale = (T.get(id).pois && T.get(id).pois.blipScale) || 1;
  const nominal = Math.round(16 / scale);
  for (const sem of SEMANTICS.concat(['waypoint', 'qmark'])) {
    const url = T.poiIconUrl(sem, id);
    const { w, h } = pngSize(path.join(REPO, url));
    ok(w === nominal && h === nominal, `${id} blip ${nominal}x${nominal}: ${sem}`);
  }
  const ps = pngSize(path.join(REPO, T.get(id).map.playerMarker));
  ok(ps.w === 32 && ps.h === 32, `${id} player marker 32x32`);
}
ok(T.get('gta-v').pois.blipScale === 0.5, 'gta-v declares blipScale 0.5');

/* ---------- service worker classification ---------- */
const swSrc = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'styles.css'), 'utf8');
const swBox = { self: { addEventListener() {} }, caches: undefined, console };
vm.createContext(swBox);
vm.runInContext(swSrc + '\nthis.__sw = { isShell, isThemeAsset, SHELL };', swBox, { filename: 'sw.js' });
const SW = swBox.__sw;
ok(Array.isArray(SW.SHELL) && SW.SHELL.length > 40, 'SW SHELL precache list non-trivial');
for (const p of SW.SHELL) {
  if (p === './') continue;
  ok(fs.existsSync(path.join(REPO, p)), `SW shell file exists: ${p}`);
}
ok(SW.isShell('/vice-city-navigator/index.html'), 'isShell: app root path');
ok(SW.isShell('/app.js'), 'isShell: local app.js');
ok(SW.isThemeAsset('/vice-city-navigator/themes/gta-v/style.json'), 'isThemeAsset: V style');
ok(SW.isThemeAsset('/themes/rdr2/style.json'), 'isThemeAsset: RDR style (local)');
ok(SW.isThemeAsset('/assets/themes/san-andreas/blips/fuel.png'), 'isThemeAsset: SA blip');
ok(SW.isThemeAsset('/fonts/frontier/0-255.pbf'), 'isThemeAsset: frontier glyphs');
ok(!SW.isThemeAsset('/vice-city-navigator/themes/vice-city/style.json'), 'VC style is shell, not on-demand');
ok(!SW.isShell('/assets/themes/gta-v/blips/fuel.png'), 'V blip not in eager shell');
ok(SW.isThemeAsset('/fonts/SignPainter/0-255.pbf'), 'isThemeAsset: SignPainter glyphs');
ok(SW.isThemeAsset('/fonts/chalet-london.woff2'), 'isThemeAsset: Chalet woff2');
ok(SW.isThemeAsset('/fonts/rdr-lino.woff2'), 'isThemeAsset: RDR Lino woff2');
ok(!SW.isThemeAsset('/fonts/pricedown-bl.woff'), 'VC UI font stays shell, not theme-asset');
ok(swSrc.includes("ws-shell-v36"), 'SW shell cache v36');
ok(swSrc.includes("ws-theme-v10"), 'SW theme cache v10');

/* ---------- per-theme typography (game-authentic fonts) ---------- */
for (const f of ['bank-gothic.woff', 'beckett.woff2', 'chalet-london.woff2',
    'chalet-comprime.woff2', 'signpainter.woff2', 'pricedown-gta.woff2',
    'rdr-lino.woff2', 'kirsty.woff2']) {
  ok(fs.existsSync(path.join(REPO, 'fonts', f)), `UI font on disk: fonts/${f}`);
}
for (const fam of ['Bank Gothic', 'Beckett', 'Chalet London', 'Chalet Comprime',
    'SignPainter', 'Pricedown GTA', 'RDR Lino', 'Kirsty']) {
  ok(cssSrc.includes(`font-family:'${fam}'`), `styles.css @font-face: ${fam}`);
}
ok(/body\.theme-san-andreas\{[^}]*--vcfont:'Beckett'/.test(cssSrc), 'SA display font: Beckett');
ok(/body\.theme-san-andreas\{[^}]*--vclabel:'Bank Gothic'/.test(cssSrc), 'SA label font: Bank Gothic');
ok(/body\.theme-gta-v\{[^}]*--vcfont:'Chalet Comprime'/.test(cssSrc), 'V display font: Chalet Comprime');
ok(/body\.theme-gta-v\{[^}]*--vclabel:'Chalet London'/.test(cssSrc), 'V label font: Chalet London');
ok(/body\.theme-rdr2\{[^}]*--vcfont:'Kirsty'/.test(cssSrc), 'RDR2 display font: Kirsty');
ok(/body\.theme-rdr2\{[^}]*--vclabel:'RDR Lino'/.test(cssSrc), 'RDR2 label font: RDR Lino');
// map glyph stacks regenerated from the authentic typefaces
ok(fs.existsSync(path.join(REPO, 'fonts', 'SignPainter', '0-255.pbf')), 'SignPainter glyph stack on disk');
const vStyle = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/gta-v/style.json'), 'utf8'));
const vRoadFonts = new Set(vStyle.layers.filter(l => /label-road/.test(l.id)).map(l => l.layout['text-font'][0]));
ok(vRoadFonts.size === 1 && vRoadFonts.has('SignPainter'), 'V road labels use SignPainter stack');
const vPlaceFonts = new Set(vStyle.layers.filter(l => /label-place$/.test(l.id)).map(l => l.layout['text-font'][0]));
ok(vPlaceFonts.size === 1 && vPlaceFonts.has('gta-v'), 'V place labels use Chalet (gta-v) stack');
const vcStyle = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/vice-city/style.json'), 'utf8'));
const vcRoadFonts = new Set(vcStyle.layers.filter(l => /label-road/.test(l.id)).map(l => l.layout['text-font'][0]));
ok(vcRoadFonts.size === 1 && vcRoadFonts.has('PricedownBl'), 'VC road labels use Pricedown stack');
const saStyle = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/san-andreas/style.json'), 'utf8'));
const saRoadFonts = new Set(saStyle.layers.filter(l => /label-road/.test(l.id)).map(l => l.layout['text-font'][0]));
ok(saRoadFonts.size === 1 && saRoadFonts.has('san-andreas'), 'SA road labels use Bank Gothic (san-andreas) stack');
const rdrStyle = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/rdr2/style.json'), 'utf8'));
const rdrPlace = rdrStyle.layers.find(l => /label-place$/.test(l.id));
ok(rdrPlace && rdrPlace.layout['text-letter-spacing'] === 0.18, 'RDR2 place labels tracked out');

/* ---------- POI importance ordering + inverse sort key ---------- */
const placesSrc = fs.readFileSync(path.join(REPO, 'places.js'), 'utf8');
ok(placesSrc.includes('blipScale'), 'places.js honors pois.blipScale');
ok(placesSrc.includes('iconSizeExpr'), 'places.js scales POI icon-size per theme');
const impMatch = placesSrc.match(/const IMPORTANCE_BY_SEMANTIC = \{([\s\S]*?)\};/);
ok(!!impMatch, 'IMPORTANCE_BY_SEMANTIC table found');
const impBox = {};
vm.createContext(impBox);
vm.runInContext('this.__imp = ' + impMatch[0].replace('const IMPORTANCE_BY_SEMANTIC =', '') + ';', impBox);
const IMP = impBox.__imp;
ok(IMP.airport === 100, 'airport importance 100');
ok(IMP.bar === 20, 'bar importance 20');
ok(IMP.airport > IMP.hospital && IMP.hospital > IMP.fuel && IMP.fuel > IMP.restaurant && IMP.restaurant > IMP.bar,
   'importance ordering airport > hospital > fuel > restaurant > bar');
// inverse key: higher importance -> lower sortKey -> wins MapLibre collisions
const key = imp => 100 - imp;
ok(placesSrc.includes('sortKey: 100 - imp'), 'renderPois uses inverted sortKey');
ok(key(IMP.airport) < key(IMP.bar), 'airport sortKey lower than bar (wins collisions)');
ok(key(IMP.hospital) < key(IMP.fuel), 'hospital sortKey lower than fuel');

/* ---------- Spotify dashboard mode + Vice City skin rebuild ---------- */
const vcSkinJs = fs.readFileSync(path.join(REPO, 'themes/vice-city/spotify-skin.js'), 'utf8');
const vcSkinCss = fs.readFileSync(path.join(REPO, 'themes/vice-city/spotify-skin.css'), 'utf8');
const appSrc = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

// art crops exist at 2x with expected dimensions
const crops = { 'header.png': [960, 346], 'album.png': [560, 666], 'stage.png': [960, 714], 'tube.png': [960, 30] };
for (const [f, [ew, eh]] of Object.entries(crops)) {
  const { w, h } = pngSize(path.join(REPO, 'themes/vice-city/spotify', f));
  ok(w === ew && h === eh, `VC spotify crop ${f} ${ew}x${eh}`);
}
// album frame interior must be transparent (art sits UNDER the frame)
function pngAlphaAt(p, x, y) {
  const buf = fs.readFileSync(p);
  let pos = 8, w, h, bitDepth, colorType;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  ok(colorType === 6 && bitDepth === 8, 'album.png is 8-bit RGBA');
  const raw = require('zlib').inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  let prev = Buffer.alloc(stride), off = 0;
  for (let row = 0; row < h; row++) {
    const filter = raw[off++];
    const cur = raw.subarray(off, off + stride); off += stride;
    const recon = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? recon[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = cur[i];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      recon[i] = v;
    }
    if (row === y) return recon[x * bpp + 3];
    prev = recon;
  }
  throw new Error('row out of range');
}
const albumPng = path.join(REPO, 'themes/vice-city/spotify/album.png');
ok(pngAlphaAt(albumPng, 280, 232) === 0, 'album frame interior transparent (art shows through)');
ok(pngAlphaAt(albumPng, 280, 600) > 200, 'album dark band opaque (readable text)');

// skin contract + removed generic UI
ok(vcSkinJs.includes("register('vice-city'"), 'VC skin registers as vice-city');
ok(vcSkinJs.includes('data-lyrics-stage'), 'lyric stage hook present');
ok(vcSkinJs.includes('setLyricsRenderer') && vcSkinJs.includes('clearLyrics'), 'lyric renderer hooks present');
const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');
const vcSkinJsCode = stripComments(vcSkinJs), vcSkinCssCode = stripComments(vcSkinCss);
for (const banned of ['miniviz', 'stagepeek', 'fullstage', 'vcsp-viz', 'spectrum', 'spotify-close', 'background-size: cover']) {
  ok(!vcSkinJsCode.includes(banned) && !vcSkinCssCode.includes(banned), `VC skin has no ${banned}`);
}
ok(/\.vcsp\s*\{[^}]*background:\s*transparent/.test(vcSkinCss), 'VC skin root transparent');
ok(/\.vcsp\s*\{[^}]*position:\s*absolute[^}]*translate:\s*0\s*-50%/.test(vcSkinCssCode), 'VC widget is one floating object (absolute, vertically centered)');
ok(vcSkinJs.includes("hud.png"), 'VC skin overlays the supplied concept art');
ok(/\.vcsp-hud\s*\{[^}]*inset:\s*0/.test(vcSkinCssCode), 'VC hud is one full-bleed skin layer');
ok(/\.vcsp\s*\{[^}]*aspect-ratio:\s*1448\s*\/\s*1086/.test(vcSkinCssCode), 'VC widget matches the concept art proportions');
ok(/\.vcsp-art\s*\{[^}]*left:\s*7\.5%/.test(vcSkinCssCode), 'VC album art sits in the art opening, under the hud');
ok(/\.vcsp-lyrics\s*\{[^}]*left:\s*41%/.test(vcSkinCssCode), 'VC lyric stage sits on the sunset, beside the album');
ok(!vcSkinCssCode.includes('.vcsp-logo') && !vcSkinJs.includes('vcsp-logo'), 'no chopped logo — it is part of the hud');
ok(/\.vcsp-controls\s*\{[^}]*background:\s*none/.test(vcSkinCssCode), 'VC controls float on the art (no background slab)');
ok(vcSkinCssCode.includes('.vcsp-idle') && !vcSkinCssCode.includes('vcsp-connect-pill'), 'VC idle/connect lives inside the widget, no generic card');
ok(vcSkinJs.includes('vcsp-idle') && !vcSkinJsCode.includes('vcsp-connect\'') && !vcSkinJsCode.includes('vcsp-connect"'), 'VC skin JS renders the in-widget idle state');

/* ---------- GTA V Spotify skin ---------- */
const gvSkinJs = fs.readFileSync(path.join(REPO, 'themes/gta-v/spotify-skin.js'), 'utf8');
const gvSkinCss = fs.readFileSync(path.join(REPO, 'themes/gta-v/spotify-skin.css'), 'utf8');
const gvCrops = { 'header.png': [960, 287], 'album.png': [560, 560], 'stage.png': [960, 471] };
for (const [f, [ew, eh]] of Object.entries(gvCrops)) {
  const { w, h } = pngSize(path.join(REPO, 'themes/gta-v/spotify', f));
  ok(w === ew && h === eh, `GV spotify art ${f} ${ew}x${eh}`);
}
const gvAlbumPng = path.join(REPO, 'themes/gta-v/spotify/album.png');
ok(pngAlphaAt(gvAlbumPng, 280, 280) > 200, 'GV album opening opaque black (art layers over the frame)');
ok(gvSkinJs.includes("register('gta-v'"), 'GV skin registers as gta-v');
ok(gvSkinJs.includes('data-lyrics-stage'), 'GV lyric stage hook present');
ok(gvSkinJs.includes('setLyricsRenderer') && gvSkinJs.includes('clearLyrics'), 'GV lyric renderer hooks present');
ok(gvSkinJs.includes('x0: 0.12') && gvSkinJs.includes('x1: 0.88'), 'GV art opening fractions 0.12/0.88 (inside the opaque frame)');
ok(!gvSkinJs.includes('tube.png'), 'GV skin has no tube (no tube art shipped)');
const gvSkinJsCode = stripComments(gvSkinJs), gvSkinCssCode = stripComments(gvSkinCss);
for (const banned of ['miniviz', 'stagepeek', 'fullstage', 'gvsp-viz', 'spectrum', 'spotify-close', 'background-size: cover', 'vcsp-']) {
  ok(!gvSkinJsCode.includes(banned) && !gvSkinCssCode.includes(banned), `GV skin has no ${banned}`);
}
ok(gvSkinJsCode.includes('gvsp-') && gvSkinCssCode.includes('.gvsp'), 'GV skin uses gvsp- prefix');
ok(gvSkinCssCode.includes('#7CFF6B') && gvSkinCssCode.includes('#0d1117'), 'GV skin neon-green on dark panel');
ok(gvSkinCssCode.includes("'SignPainter'") && gvSkinCssCode.includes("'Chalet London'"), 'GV skin SignPainter script + Chalet London');
ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(gvSkinJsCode) && !/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(gvSkinCssCode), 'GV skin has no emojis');

// app mode system
ok(appSrc.includes("get('dashboard')"), 'dashboard URL param read');
ok(appSrc.includes('ws.appMode'), 'app mode persisted');
ok(appSrc.includes('WayStation.setAppMode'), 'setAppMode exposed for hosts');
ok(appSrc.includes('dashboardLayoutActive()'), 'dashboardLayoutActive() exists');
ok(!appSrc.includes('min-width: 900px'), 'no viewport gate: preview forces dashboard mode');
ok(appSrc.includes('dash-stage') && appSrc.includes('1920'), 'fixed 1920x720 dashboard canvas');
ok(appSrc.includes('fitDashboardStage'), 'canvas zoom-to-fit on resize');
ok(indexSrc.includes('Dashboard Preview'), 'menu offers Dashboard Preview');
ok(appSrc.includes('map.resize()'), 'mode switch resizes map (no recreate)');
ok(!appSrc.includes('setSpotifyPane'), 'floating pane logic removed');
ok(!appSrc.includes('music-btn'), 'music buttons removed from app.js');
ok(appSrc.includes('spotify.skin'), 'skin resolved from theme config');

// index.html: menu-only Spotify in normal mode, dashboard mount point
ok(!indexSrc.includes('music-btn') && !indexSrc.includes('drive-music-btn'), 'no player buttons in chrome');
ok(!indexSrc.includes('spotify-close'), 'no close button on pane');
ok(indexSrc.includes('id="dashboard-toggle"'), 'dashboard toggle in menu');
ok(indexSrc.includes('id="spotify-connect"') && indexSrc.includes('id="spotify-disconnect"'), 'menu connect/disconnect');
ok(indexSrc.includes('id="spotify-status"'), 'menu Spotify status');
ok(indexSrc.includes('themes/vice-city/spotify-skin.js'), 'VC skin script path');
ok(indexSrc.includes('themes/vice-city/spotify-skin.css'), 'VC skin css path');

// styles.css: dashboard full-screen map, floating Spotify overlay, no sidebar
ok(/body\.dashboard-mode #map\{[^}]*width:1920px[^}]*height:720px/.test(cssSrc), 'dashboard map fills the full canvas');
ok(/body\.dashboard-mode #spotify-pane\{[\s\S]*?pointer-events:none/.test(cssSrc), 'dashboard Spotify pane is a transparent overlay (no reserved column)');
ok(cssSrc.includes('[data-skin="vice-city"]'), 'floating-skin selector present');
ok(appSrc.includes('pane.dataset.skin'), 'mount tags the pane with the active skin');
ok(appSrc.includes('body.dataset.spotskin'), 'mount exposes the skin on <body> for HUD clearance');
ok(indexSrc.includes('id="dash-topbar"'), 'dashboard top status bar exists');
ok(indexSrc.includes('id="dash-bottombar"'), 'dashboard bottom menu bar exists');
ok(indexSrc.includes('data-dtab="phone"'), 'bottom bar has a PHONE tab');
ok(indexSrc.includes('id="dash-temp"') && indexSrc.includes('id="dash-time"'), 'top bar has weather + clock slots');
ok(indexSrc.includes('id="dash-zoom-in"') && indexSrc.includes('id="dash-zoom-out"') && indexSrc.includes('id="dash-locate"'), 'bottom bar carries zoom + locate');
ok(appSrc.includes("'dash-topbar', 'dash-bottombar'"), 'bars are reparented into the dashboard stage');
ok(/body\.dashboard-mode\.theme-vice-city #map-tools\{display:none\}/.test(cssSrc), 'VC: floating zoom tools hidden (zoom lives in the bottom bar)');
ok(appSrc.includes('open-meteo.com'), 'weather comes from keyless Open-Meteo');
ok(appSrc.includes("setAppMode('normal')"), 'PHONE tab drops back to the phone UI');
ok(appSrc.includes("classList.toggle('radio-off')"), 'RADIO tab toggles the music widget');
ok(cssSrc.includes('top:64px') && cssSrc.includes('bottom:72px'), 'docked skins fit between the dash bars (chrome never covers the widget)');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city #dash-topbar'), 'top bar is Vice City theme chrome only');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city #dash-bottombar'), 'bottom bar is Vice City theme chrome only');
ok(cssSrc.includes('clip-path:polygon(0 0,100% 0,100% 50%'), 'bars use the angular game-HUD silhouette');
ok(indexSrc.includes('dash-tag'), 'bottom bar carries the script tagline');
ok(appSrc.includes('queueDashLocality'), 'locality plate reverse-geocodes the map centre');
ok(indexSrc.includes('dash-scene'), 'top bar uses a crisp vector sunset scene (no stretched raster)');
const vcSkinSrc = fs.readFileSync(path.join(REPO, 'themes/vice-city/spotify-skin.css'), 'utf8');
ok(vcSkinSrc.includes('width: 38cqw'), 'VC widget is the larger size');
ok(appSrc.includes('syncDashPadding'), 'camera viewport offsets left of the VC widget');
ok(cssSrc.includes("themes/vice-city/dashboard/bottombar.jpg"), 'bottom bar uses the generated neon plate');
ok(!cssSrc.includes('#spotify-close'), 'no close-button styles');
ok(/\#spotify-pane\{[\s\S]*?background:transparent/.test(cssSrc), 'pane transparent');

// sw precache follows the move
for (const p of ['themes/vice-city/spotify-skin.js', 'themes/vice-city/spotify-skin.css',
    'themes/vice-city/spotify/hud.png']) {
  ok(SW.SHELL.includes(p), `SW precaches ${p}`);
}
ok(!SW.SHELL.some(p => p.includes('skin-vice-city') || p.includes('synthwave')), 'SW drops old skin paths');

/* ---------- theme switching robustness (no more false "failed to load") ---------- */
ok(appSrc.includes('themeSwitchGen'), 'applyTheme uses a generation guard');
ok(appSrc.includes('fetchThemeStyle'), 'target style JSON fetched+validated before map is touched');
ok(appSrc.includes("setStyle(style, { diff: false })"), 'style applied with full rebuild, never a diff');
ok(!/[^a-zA-Z]themeSwitching[^a-zA-Z]/.test(appSrc.replace(/themeSwitchGen/g, '')), 'brittle themeSwitching flag removed');
ok(appSrc.includes('VCNThemes.setCurrent(id)') && /await loadP;[\s\S]*?VCNThemes\.setCurrent\(id\)/.test(appSrc),
   'theme persisted only after the new style actually loads');
ok(!appSrc.includes('window.map && map.resize'), 'no window.map/map null mismatch on resize guards');

/* ---------- GTA V palette matches the in-game pause map ---------- */
const vPaint = id => vStyle.layers.find(l => l.id === id).paint;
ok(vPaint('v-land')['background-color'] === '#1e1e1e', 'V land: near-black pause map');
ok(vPaint('v-water')['fill-color'] === '#55636b', 'V water: blue-grey');
for (const id of ['v-parks', 'v-grass', 'v-golf', 'v-gardens', 'v-recreation', 'v-park-areas', 'v-playing-fields'])
  ok(/^#2f3b28$|^#35422c$/.test(vPaint(id)['fill-color']), `V ${id}: dark olive`);
ok(vPaint('v-woods')['fill-color'] === '#26331f', 'V woods: deep olive');
for (const id of ['v-road-minor', 'v-road-primary', 'v-road-motorway'])
  ok(/^#[a-b]/.test(vPaint(id)['line-color']), `V ${id}: light grey road core`);
ok(vPaint('v-label-road-major')['text-color'] === '#f0f0f0', 'V road labels: near-white');
ok(vPaint('v-label-place')['text-halo-color'] === '#000000', 'V place labels: black halo');
ok(T.get('gta-v').map.routeColor === '#a86fd6', 'V route stays purple (as in-game)');



/* ---------- label hierarchy: place names must dominate road names ---------- */
// evaluate a match/interpolate text-size expression to a concrete number
function textSizeAt(expr, cls, zoom) {
  if (typeof expr === 'number') return expr;
  if (Array.isArray(expr)) {
    if (expr[0] === 'match') {
      for (let i = 2; i + 1 < expr.length; i += 2) if (expr[i] === cls) return textSizeAt(expr[i + 1], cls, zoom);
      return textSizeAt(expr[expr.length - 1], cls, zoom);
    }
    if (expr[0] === 'interpolate') {
      const stops = expr.slice(3);
      const val = v => (Array.isArray(v) ? textSizeAt(v, cls, zoom) : v);
      for (let i = 0; i + 3 < stops.length; i += 2) {
        if (zoom <= stops[i + 2]) {
          const t = (zoom - stops[i]) / (stops[i + 2] - stops[i]);
          return val(stops[i + 1]) + t * (val(stops[i + 3]) - val(stops[i + 1]));
        }
      }
      return val(stops[stops.length - 1]);
    }
  }
  return 0;
}
for (const [id, prefix] of [['vice-city', 'vc'], ['gta-v', 'v'], ['san-andreas', 'sa'], ['rdr2', 'rdr']]) {
  const st = styles[id];
  const lay = n => st.layers.find(l => l.id === n);
  const place = lay(`${prefix}-label-place`).layout['text-size'];
  const major = lay(`${prefix}-label-road-major`).layout['text-size'];
  const minor = lay(`${prefix}-label-road-minor`).layout['text-size'];
  const town = textSizeAt(place, 'town', 14);
  const city = textSizeAt(place, 'city', 14);
  ok(town >= 18, `${id}: town label >= 18px (got ${town})`);
  ok(city >= 20, `${id}: city label >= 20px (got ${city})`);
  for (const z of [12, 14, 16]) {
    const tz = textSizeAt(place, 'town', z);
    const rm = textSizeAt(major, null, z), rn = textSizeAt(minor, null, z);
    ok(tz / rm >= 1.4, `${id}: town dominates major roads at z${z} (${tz.toFixed(1)} vs ${rm.toFixed(1)})`);
    if (z >= 14) ok(tz / rn >= 1.4, `${id}: town dominates minor roads at z${z} (${tz.toFixed(1)} vs ${rn.toFixed(1)})`);
  }
  ok(textSizeAt(major, null, 17) >= 11, `${id}: major roads still readable zoomed in`);
}
const vcRoad = styles['vice-city'].layers.find(l => l.id === 'vc-label-road-major').paint['text-color'];
const vcPlace = styles['vice-city'].layers.find(l => l.id === 'vc-label-place').paint['text-color'];
ok(vcRoad !== vcPlace, 'VC: road labels a different tone from place labels');


/* ---------- Spotify skin album-frame openings (measured from the crop art) ---------- */
const FRAME_EXPECTED = {
  'gta-v':        [0.12, 0.12, 0.88, 0.88],
  'san-andreas':  [0.07, 0.028, 0.97, 0.905],
  'rdr2':         [0.3047, 0.14, 0.875, 0.86],
};
for (const [theme, exp] of Object.entries(FRAME_EXPECTED)) {
  const js = fs.readFileSync(path.join(REPO, 'themes', theme, 'spotify-skin.js'), 'utf8');
  const m = js.match(/const FRAME = \{ x0: ([\d.]+), y0: ([\d.]+), x1: ([\d.]+), y1: ([\d.]+) \}/);
  ok(!!m, `${theme}: skin declares a FRAME opening`);
  if (m) {
    const got = [1, 2, 3, 4].map(i => parseFloat(m[i]));
    const close = got.every((v, i) => Math.abs(v - exp[i]) < 0.005);
    ok(close, `${theme}: FRAME opening matches measured art (got ${got.join(',')})`);
  }
  // art must size to the opening box (explicit height), not assume a square
  ok(js.includes("'height:' + ((FRAME.y1 - FRAME.y0)"),
    `${theme}: album art fills the measured opening box`);
}
// vice-city: the opening is the hud's own cut-out, declared in CSS
// (measured: x 0.0753-0.3936, y 0.3425-0.6924 of the 1448x1086 hud)
ok(/\.vcsp-art\s*\{[^}]*left:\s*7\.5%[^}]*top:\s*34\.3%[^}]*width:\s*31\.9%[^}]*height:\s*35%/.test(vcSkinCssCode),
  'vice-city: art opening matches the hud cut-out');
ok(/\.vcsp-art-idle\s*\{[^}]*left:\s*7\.5%/.test(vcSkinCssCode),
  'vice-city: idle placeholder fills the same opening');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
