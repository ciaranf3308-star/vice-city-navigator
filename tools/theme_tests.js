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
// JPEG SOFn: width/height are big-endian uint16 5/7 bytes past the marker
function jpgSize(p) {
  const b = fs.readFileSync(p);
  if (b.readUInt16BE(0) !== 0xffd8) throw new Error('not a jpeg: ' + p);
  let o = 2;
  while (o < b.length) {
    if (b[o] !== 0xff) throw new Error('bad jpeg: ' + p);
    const m = b[o + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { h: b.readUInt16BE(o + 5), w: b.readUInt16BE(o + 7) };
    }
    o += 2 + b.readUInt16BE(o + 2);
  }
  throw new Error('no SOF in jpeg: ' + p);
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
ok(swSrc.includes("ws-shell-v53"), 'SW shell cache v53');
ok(swSrc.includes("ws-theme-v14"), 'SW theme cache v14');

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
const vLabelFonts = new Set(vStyle.layers.filter(l => /label-/.test(l.id)).map(l => l.layout['text-font'][0]));
ok(vLabelFonts.size === 1 && vLabelFonts.has('SignPainter'), 'V labels all use SignPainter stack (script everywhere)');
const vLay = id => vStyle.layers.find(l => l.id === id);
ok(vLay('v-land').paint['background-color'] === '#101010', 'V pause-menu land is near-black');
ok(vLay('v-water').paint['fill-color'] === '#2c3a42', 'V pause-menu water is dark slate');
ok(vLay('v-road-motorway').paint['line-color'] === '#9a9a9a', 'V pause-menu motorways are thin pale lines');
ok(vLay('v-label-place').paint['text-halo-color'] === '#000000', 'V labels keep black halos on the dark map');
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

/* ---------- GTA V Spotify skin: the supplied art IS the widget ---------- */
const gvSkinJs = fs.readFileSync(path.join(REPO, 'themes/gta-v/spotify-skin.js'), 'utf8');
const gvSkinCss = fs.readFileSync(path.join(REPO, 'themes/gta-v/spotify-skin.css'), 'utf8');
{
  const { w, h } = pngSize(path.join(REPO, 'themes/gta-v/spotify/hud.png'));
  ok(w === 1155 && h === 1362, 'GV spotify hud.png is the supplied 1155x1362 art');
}
const gvHudPng = path.join(REPO, 'themes/gta-v/spotify/hud.png');
ok(pngAlphaAt(gvHudPng, 230, 640) > 200, 'GV album frame interior opaque (art layers over the hud)');
ok(!fs.existsSync(path.join(REPO, 'themes/gta-v/spotify/header.png')), 'GV chopped crops are gone');
ok(gvSkinJs.includes("register('gta-v'"), 'GV skin registers as gta-v');
ok(gvSkinJs.includes('data-lyrics-stage'), 'GV lyric stage hook present');
ok(gvSkinJs.includes('setLyricsRenderer') && gvSkinJs.includes('clearLyrics'), 'GV lyric renderer hooks present');
ok(/\.gvsp-art\s*\{[^}]*left:\s*6\.49%[^}]*top:\s*35\.61%[^}]*width:\s*26\.84%[^}]*height:\s*22\.76%/.test(gvSkinCss),
  'GV art rect matches the hud frame opening');
ok(gvSkinJs.includes('hud.png'), 'GV skin overlays the single hud art');
const gvSkinJsCode = stripComments(gvSkinJs), gvSkinCssCode = stripComments(gvSkinCss);
for (const banned of ['miniviz', 'stagepeek', 'fullstage', 'gvsp-viz', 'spectrum', 'spotify-close', 'background-size: cover', 'vcsp-']) {
  ok(!gvSkinJsCode.includes(banned) && !gvSkinCssCode.includes(banned), `GV skin has no ${banned}`);
}
ok(gvSkinJsCode.includes('gvsp-') && gvSkinCssCode.includes('.gvsp'), 'GV skin uses gvsp- prefix');
ok(gvSkinCssCode.includes('#7CFF6B') && gvSkinCssCode.includes('#05070a'), 'GV skin neon-green on dark panel');
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
ok(indexSrc.includes('id="voice-preview"'), 'voice preview button in menu');
ok(!indexSrc.includes('Gemini free tier'), 'no stale Gemini copy in voice settings');
ok(indexSrc.includes('id="spotify-connect"') && indexSrc.includes('id="spotify-disconnect"'), 'menu connect/disconnect');
ok(indexSrc.includes('id="spotify-status"'), 'menu Spotify status');
ok(indexSrc.includes('themes/vice-city/spotify-skin.js'), 'VC skin script path');
ok(indexSrc.includes('themes/vice-city/spotify-skin.css'), 'VC skin css path');

// styles.css: dashboard full-screen map, floating Spotify overlay, no sidebar
ok(/body\.dashboard-mode #map\{[^}]*width:1920px[^}]*height:720px/.test(cssSrc), 'dashboard map fills the full canvas');
ok(/body\.dashboard-mode #spotify-pane\{[\s\S]*?pointer-events:none/.test(cssSrc), 'dashboard Spotify pane is a transparent overlay (no reserved column)');
ok(!cssSrc.includes('[data-skin='), 'shell no longer needs per-skin stage selectors (every skin floats)');
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
ok(/body\.dashboard-mode #spotify-stage\{[\s\S]*?left:0;right:0;top:0;bottom:0/.test(cssSrc), 'Spotify stage is a full-canvas layer; every skin widget positions itself');
ok(cssSrc.includes('#search-bar{right:740px}') && cssSrc.includes('#maneuver-card{right:740px}'), 'HUD chrome clears the larger tilted widgets');
ok(cssSrc.includes('[data-spotskin="vice-city"] #search-bar{right:900px}'), 'VC chrome clears the wide tilted VC widget');
ok(appSrc.includes('right: 900'), 'camera padding accounts for the larger VC widget');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city #dash-topbar') === true, 'VC bar chrome is always-on in dashboard mode, like the original');
// dashboard car chrome: every theme gets top/bottom bars, always visible in dashboard mode (driving or exploring)
for (const id of ['vice-city', 'san-andreas', 'gta-v', 'rdr2']) {
  ok(cssSrc.includes(`body.dashboard-mode.theme-${id} #dash-topbar`), `${id} dashboard top bar chrome`);
  ok(cssSrc.includes(`body.dashboard-mode.theme-${id} #dash-bottombar`), `${id} dashboard bottom bar chrome`);
}
ok(appSrc.includes("classList.toggle('nav-driving'"), 'nav-driving class toggles with drive mode');
ok(appSrc.includes('nav-driving') && /setUiMode/.test(appSrc), 'drive-mode chrome state lives in setUiMode');
ok(cssSrc.includes('body.dashboard-mode.nav-driving #maneuver-card'), 'drive HUD clears the top bar on every theme');
ok(cssSrc.includes('body.dashboard-mode.nav-driving #drive-bar'), 'drive trip bar clears the bottom bar on every theme');
ok(!cssSrc.includes('.dash-skyline') && !indexSrc.includes('dash-skyline'), 'old skyline img fully retired in favour of the authored top bar strip');
ok(/theme-san-andreas #dash-topbar\{[^}]*#e8a33d/.test(cssSrc), 'SA chrome uses gold, not neon');
ok(/theme-gta-v #dash-topbar\{[^}]*#7CFF6B/.test(cssSrc), 'GTA V chrome uses pause-menu neon green');
ok(/theme-rdr2 #dash-topbar\{[^}]*menu_bar\.png/.test(cssSrc), 'RDR2 chrome uses the engraved double-rule seam, not neon');
ok(!/theme-rdr2 #dash-(topbar|bottombar)\{[^}]*#ff71ce/.test(cssSrc), 'RDR2 bar shells carry no neon pink');
// VC visual quality pass: neon console bars per the benchmark
ok(indexSrc.includes('class="dash-palm"'), 'top bar has a neon palm beside the wordmark');
ok(indexSrc.includes('dashboard/topbar.jpg') || cssSrc.includes('dashboard/topbar.jpg'), 'VC top bar uses the authored neon bar strip (asset pack #4)');
/* ---------- VC asset-pack polish: authored chrome ---------- */
const vctop = jpgSize(path.join(REPO, 'themes/vice-city/dashboard/topbar.jpg'));
ok(vctop && vctop.w >= 2000 && vctop.h >= 140, 'VC top bar art: full-width authored strip (asset pack #4)');
const vcbot = jpgSize(path.join(REPO, 'themes/vice-city/dashboard/bottombar.jpg'));
ok(vcbot && vcbot.w >= 2000 && vcbot.h >= 80, 'VC bottom bar art: full-width authored strip (asset pack #4)');
const mfr = pngSize(path.join(REPO, 'assets/themes/vice-city/dashboard/maneuver-frame.png'));
ok(mfr && mfr.w === 1650 && mfr.h === 565, 'VC maneuver HUD frame present at authored size (asset pack #3)');
ok(fs.existsSync(path.join(REPO, 'themes/vice-city/dashboard/bottombar.jpg')),
  'VC bottom bar HUD strip present (asset pack #2)');
ok(cssSrc.includes('maneuver-frame.png'), 'VC maneuver card uses the authored HUD frame');
ok(/theme-vice-city #maneuver-card\{[^}]*aspect-ratio/.test(cssSrc),
  'VC maneuver card keeps the frame\'s authored aspect ratio');
ok(!/theme-vice-city #maneuver-card\{[^}]*clip-path:polygon/.test(cssSrc),
  'VC maneuver card drops the generic CSS chamfer for the authored frame');
ok(indexSrc.includes('class="dash-north"'), 'bottom bar compass shows the N marker');
ok(indexSrc.includes('id="next-stats"'), 'maneuver card has a trip stats row slot');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city #next-stats'), 'VC dashboard styles the maneuver stats row');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city #maneuver-arrow svg'), 'VC dashboard recolors the maneuver arrow pink');
ok(cssSrc.includes('ns-min'), 'maneuver stats row highlights minutes in pink');
ok(appSrc.includes("next-stats"), 'updateBanner feeds the maneuver stats row');
ok(/theme-vice-city \.dash-tabs button\.on\{[^}]*#ff71ce/.test(cssSrc), 'VC active tab is flat hot-pink neon text');
ok(!/theme-(san-andreas|gta-v|rdr2) #dash-(topbar|bottombar)\{[^}]*clip-path:polygon\(0 0,100% 0,100% 50%/.test(cssSrc),
   'non-VC themes do not reuse the VC angular silhouette on the bar shells');
ok(!/function syncDashLocality\(\)[\s\S]{0,400}theme-vice-city/.test(appSrc), 'bottom-bar locality plate is theme-agnostic');
ok(cssSrc.includes('clip-path:polygon(0 0,100% 0,100% 42%'), 'VC bars use the angular neon-tube silhouette');
ok(indexSrc.includes('dash-tag'), 'bottom bar carries the script tagline');
ok(appSrc.includes('queueDashLocality'), 'locality plate reverse-geocodes the map centre');
ok(cssSrc.includes('dashboard/topbar.jpg'), 'top bar paints the authored strip inside the neon shell');
/* ---------- bespoke bar silhouettes: every theme gets its own bar heights,
   layouts and drive-HUD clearances, not one shared silhouette ---------- */
const barHeights = {
  'vice-city': ['76px', '88px'],
  'san-andreas': ['72px', '84px'],
  'gta-v': ['56px', '64px'],
  'rdr2': ['72px', '72px'],
};
for (const [id, [top, bottom]] of Object.entries(barHeights)) {
  ok(new RegExp(`theme-${id} #dash-topbar\\{[^}]*height:${top}`).test(cssSrc), `${id} top bar is ${top} tall`);
  ok(new RegExp(`theme-${id} #dash-bottombar\\{[^}]*height:${bottom}`).test(cssSrc), `${id} bottom bar is ${bottom} tall`);
  ok(cssSrc.includes(`body.dashboard-mode.theme-${id}.nav-driving #maneuver-card`),
    `${id} maneuver card clears its own top bar height`);
  ok(cssSrc.includes(`body.dashboard-mode.theme-${id}.nav-driving #drive-bar`),
    `${id} drive trip bar clears its own bottom bar height`);
}
ok(/theme-vice-city #dash-topbar \.dash-chrome::after/.test(cssSrc), 'VC top bar wears a chrome divider strip');
ok(!/theme-vice-city \.dash-tabs button\{[^}]*linear-gradient/.test(cssSrc), 'VC tabs are flat neon text, not chunky buttons');
ok(/theme-san-andreas \.dash-tabs button\.on\{[^}]*linear-gradient\(180deg,#f2c14e/.test(cssSrc),
  'SA active tab wears the full orange menu selection bar');
ok(/theme-gta-v \.dash-tabs button\{[^}]*border-left:1px solid/.test(cssSrc), 'V tab strip uses hairline separators');
ok(/theme-gta-v \.dash-tag\{display:none\}/.test(cssSrc), 'V drops the 80s script tagline');
ok(/theme-rdr2 \.dash-tag\{display:none\}/.test(cssSrc), 'RDR2 drops the 80s script tagline');
ok(/theme-rdr2 \.dash-brand\{[^}]*margin:0 auto/.test(cssSrc), 'RDR2 centers its ornate title plate');
ok(/theme-rdr2 \.dash-tabs button\.on::after/.test(cssSrc), 'RDR2 active tab gets the gold diamond marker');
/* ---------- dashboard-mode settings: car-scale menu panel ---------- */
ok(/body\.dashboard-mode #menu-panel\{[^}]*width:min\(540px,94vw\)/.test(cssSrc),
  'dashboard settings panel is car-scale (540px), not phone-sized');
ok(/body\.dashboard-mode #menu-panel\{[^}]*z-index:60/.test(cssSrc),
  'dashboard settings panel paints above the dash stage');
for (const id of ['san-andreas', 'gta-v', 'rdr2']) {
  ok(cssSrc.includes(`body.dashboard-mode.theme-${id} #menu-panel`),
    `${id} settings panel docks clear of its own bar heights`);
}
ok(/body\.dashboard-mode \.menu-section input\[type="checkbox"\]\{[^}]*width:36px/.test(cssSrc),
  'dashboard settings checkboxes are car-size touch targets');
ok(/body\.dashboard-mode \.vc-title\{[^}]*font-size:52px/.test(cssSrc),
  'dashboard settings title is car-legible');
/* The menu panel stays at body level (never shrinks with the stage zoom),
   so layoutDashMenu() docks it against the LIVE stage rect in real pixels
   — fixed stage-coordinate offsets would land on the dash bars whenever
   the stage is letterboxed or zoomed below 1. */
ok(!/DASH_STAGE_NODES = \[[^\]]*'menu-panel'/.test(appSrc),
  'menu panel is not reparented into the scaled dash stage');
for (const [id, top, bottom] of [['vice-city', 76, 88], ['san-andreas', 72, 84], ['gta-v', 56, 64], ['rdr2', 72, 72]]) {
  ok(new RegExp(`'${id}':\\s*\\{\\s*top:\\s*${top},\\s*bottom:\\s*${bottom}\\s*\\}`).test(appSrc),
    `DASH_BAR_HEIGHTS: ${id} bars ${top}/${bottom}px (stage coordinates)`);
}
ok(/function layoutDashMenu\(\)/.test(appSrc) && appSrc.includes('getBoundingClientRect()'),
  'layoutDashMenu docks the panel to the live stage rect');
ok(appSrc.includes('r.width / DASH_W'), 'layoutDashMenu scales bar clearance by the live stage zoom');
ok(appSrc.includes('layoutDashMenu(); // re-dock the body-level menu panel to the new stage rect'),
  'stage refit re-docks the menu panel');
ok(appSrc.includes('layoutDashMenu(); // bar heights changed with the theme'),
  'theme switch re-docks the menu panel');
ok(appSrc.includes('layoutDashMenu(); // dock (or undock) the body-level menu panel'),
  'app-mode switch docks/undocks the menu panel');

/* ---------- dashboard route-setting: search bar + planning drawer ---------- */
/* The explore search bar used to sit at top:12px in stage coordinates —
   directly behind the opaque dash top bar (z-index 25 > explore-ui 10),
   so dashboard users had no visible way to set a route. It now drops
   below the per-theme bar heights, and the planning drawer docks to the
   live stage rect in real pixels like the menu panel. */
for (const [id, top] of [['vice-city', 88], ['san-andreas', 84], ['gta-v', 68], ['rdr2', 84]]) {
  ok(new RegExp(`body\\.dashboard-mode\\.theme-${id} #search-bar\\{top:calc\\(${top}px`).test(cssSrc),
    `dashboard search bar clears the ${id} top bar (${top}px)`);
}
ok(/body\.dashboard-mode #menu-btn\{display:none\}/.test(cssSrc),
  'dashboard hides the floating menu button behind the bar (bottom-bar tabs open the menu)');
ok(!/DASH_STAGE_NODES = \[[^\]]*'drawer'/.test(appSrc),
  'planning drawer is not reparented into the scaled dash stage');
ok(/function layoutDashDrawer\(\)/.test(appSrc) && appSrc.includes('getBoundingClientRect()'),
  'layoutDashDrawer docks the drawer to the live stage rect');
ok(appSrc.includes('layoutDashDrawer(); // and the planning drawer'),
  'stage refit and theme switch re-dock the planning drawer');
ok(appSrc.includes('layoutDashDrawer(); // dock the drawer to the live stage rect in dashboard mode'),
  'opening planning re-docks the drawer');

/* ---------- bespoke dashboard bar assets (authentic game-UI textures) ---------- */
const dashAssets = [
  ['vice-city', 'vc-logo.png'],
  ['vice-city', 'bar-texture.jpg'],
  ['san-andreas', 'menu-bgmap.jpg'],
  ['gta-v', 'topbar-skyline.jpg'],
  ['gta-v', 'bottombar-skyline.jpg'],
  ['rdr2', 'menu_header_1a.png'],
  ['rdr2', 'menu_bar.png'],
  ['rdr2', 'title_divider.png'],
  ['rdr2', 'selection_box_bg_1a.png'],
];
for (const [theme, file] of dashAssets) {
  const rel = `assets/themes/${theme}/dashboard/${file}`;
  ok(fs.existsSync(path.join(REPO, rel)), `dashboard bar asset on disk: ${rel}`);
  ok(fs.statSync(path.join(REPO, rel)).size > 0, `dashboard bar asset non-empty: ${rel}`);
  ok(cssSrc.includes(`assets/themes/${theme}/dashboard/${file}`), `styles.css references ${rel}`);
}
// theme-scoped usage: each asset is only wired into its own theme's chrome
ok(/theme-vice-city[^{]*\.dash-logo\{[^}]*vc-logo\.png/.test(cssSrc), 'VC wordmark is the authentic in-game logo');
/* ---------- VC map matches the hero target ---------- */
const vcStyle2 = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/vice-city/style.json'), 'utf8'));
const vcPaint = id => vcStyle2.layers.find(l => l.id === id).paint;
ok(vcPaint('vc-land')['background-color'] === '#a9aabe', 'VC land: deeper cool gray (hero contrast)');
ok(vcPaint('vc-water')['fill-color'] === '#48a8e8', 'VC water: vivid blue (hero)');
ok(vcPaint('vc-parks')['fill-color'] === '#6cab7f', 'VC parks: deeper green (hero contrast)');
ok(vcPaint('vc-buildings')['fill-color'] === '#b7b7c7', 'VC buildings: separated from land (hero contrast)');
ok(vcPaint('vc-road-minor')['line-color'] === '#eef0f6', 'VC minor roads: white streets (hero)');
ok(vcPaint('vc-road-primary')['line-color'] === '#1d1d36', 'VC arterials: stronger dark navy (hero contrast)');
ok(vcPaint('vc-road-motorway')['line-color'] === '#0e0e22', 'VC motorways: near-black navy (hero contrast)');
ok(/theme-san-andreas #dash-topbar \.dash-chrome\{[^}]*menu-bgmap\.jpg/.test(cssSrc), 'SA top bar uses the engraved state-map texture');
ok(/theme-san-andreas #dash-bottombar \.dash-chrome\{[^}]*menu-bgmap\.jpg/.test(cssSrc), 'SA bottom bar uses the engraved state-map texture');
ok(/theme-gta-v #dash-topbar \.dash-chrome\{[^}]*topbar-skyline\.jpg/.test(cssSrc), 'V top bar uses the v-hud skyline strip');
ok(/theme-gta-v #dash-bottombar \.dash-chrome\{[^}]*bottombar-skyline\.jpg/.test(cssSrc), 'V bottom bar uses the v-hud skyline strip');
ok(/theme-gta-v \.dash-tabs button\.on\{[^}]*box-shadow:inset 0 -3px 0 #7CFF6B/.test(cssSrc), 'V active tab uses the pause-menu green underline');
ok(/theme-rdr2 #dash-dest\{[^}]*border-image-source:url\('assets\/themes\/rdr2\/dashboard\/menu_header_1a\.png'\)/.test(cssSrc),
   'RDR2 destination plate uses the ornate menu-header frame');
ok(/theme-rdr2 #dash-topbar\{[^}]*menu_bar\.png/.test(cssSrc), 'RDR2 top bar seam uses the authentic double-rule');
ok(/theme-rdr2 \.dash-dest::before/.test(cssSrc) && cssSrc.includes('title_divider.png'), 'RDR2 destination plate is flanked by divider ornaments');
ok(/theme-gta-v \.dash-logo\{[^}]*'SignPainter'/.test(cssSrc), 'V wordmark is a SignPainter script accent');
ok(/theme-gta-v #dash-dest\{[^}]*'SignPainter'/.test(cssSrc), 'V destination plate is a SignPainter script accent');
ok(/theme-gta-v \.dash-tabs button\{[^}]*var\(--vcfont\)/.test(cssSrc) && !/theme-gta-v \.dash-tabs button\{[^}]*SignPainter/.test(cssSrc), 'V tabs stay in Chalet (functional text)');
ok(/theme-rdr2 #dash-topbar \.dash-chrome\{[^}]*selection_box_bg_1a\.png/.test(cssSrc), 'RDR2 bars wear the grunge panel texture');
// service worker: VC dashboard art is shell-precached (default theme), the
// other themes' dashboard art rides the on-demand theme-asset cache
ok(swSrc.includes('assets/themes/vice-city/dashboard/vc-logo.png'), 'SW precaches the VC bar logo');
ok(swSrc.includes('assets/themes/vice-city/dashboard/bar-texture.jpg'), 'SW precaches the VC bar texture');
ok(SW.isThemeAsset('/assets/themes/san-andreas/dashboard/menu-bgmap.jpg'), 'isThemeAsset: SA dashboard art');
ok(SW.isThemeAsset('/assets/themes/gta-v/dashboard/topbar-skyline.jpg'), 'isThemeAsset: V dashboard art');
ok(SW.isThemeAsset('/assets/themes/rdr2/dashboard/menu_header_1a.png'), 'isThemeAsset: RDR2 dashboard art');
const vcSkinSrc = fs.readFileSync(path.join(REPO, 'themes/vice-city/spotify-skin.css'), 'utf8');
ok(vcSkinSrc.includes('width: 720px'), 'VC widget scaled down for hero integration');
ok(vcSkinSrc.includes('rotate(6deg)'), 'VC widget carries its 6-degree tilt');
// every theme widget: explicit larger size, ~6-7 degree tilt, no-overlap idle states
const skinSpecs = [
  ['vice-city', 'vcsp', 'rotate(6deg)', 'width: 720px'],
  ['san-andreas', 'sasp', 'rotate(-6deg)', 'width: 600px'],
  ['gta-v', 'gvsp', 'rotate(6.5deg)', 'width: 540px'],
  ['rdr2', 'rdsp', 'rotate(-6.5deg)', 'width: 600px'],
];
for (const [theme, cls, tilt, size] of skinSpecs) {
  const css = fs.readFileSync(path.join(REPO, `themes/${theme}/spotify-skin.css`), 'utf8');
  const js = fs.readFileSync(path.join(REPO, `themes/${theme}/spotify-skin.js`), 'utf8');
  ok(css.includes(tilt), `${theme}: widget tilted ${tilt}`);
  ok(css.includes(size), `${theme}: widget sized up (${size})`);
  ok(css.includes(`.${cls}.is-idle`), `${theme}: disconnected idle owns its stage (no overlaps)`);
  ok(js.includes("root.classList.toggle('is-idle'"), `${theme}: render toggles the is-idle class`);
}
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
ok(vPaint('v-land')['background-color'] === '#101010', 'V land: near-black pause map');
ok(vPaint('v-water')['fill-color'] === '#2c3a42', 'V water: dark slate');
for (const id of ['v-parks', 'v-grass', 'v-golf', 'v-gardens', 'v-recreation', 'v-park-areas', 'v-playing-fields'])
  ok(/^(#1a2415|#1d2818)$/.test(vPaint(id)['fill-color']), `V ${id}: near-black green`);
ok(vPaint('v-woods')['fill-color'] === '#141c10', 'V woods: near-black green');
for (const id of ['v-road-minor', 'v-road-primary', 'v-road-motorway'])
  ok(/^#[89]/.test(vPaint(id)['line-color']), `V ${id}: pale road core on black`);
ok(vPaint('v-label-road-major')['text-color'] === '#d8d8d8', 'V road labels: pale grey');
ok(vPaint('v-label-place')['text-halo-color'] === '#000000', 'V place labels: black halo');
ok(T.get('gta-v').map.routeColor === '#a86fd6', 'V route stays purple (as in-game)');
/* ---------- route glow (hero treatment) ---------- */
const appSrc2 = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
ok(appSrc2.includes("id: 'vcn-route-glow'"), 'route glow layer exists');
ok(appSrc2.includes("'line-blur'"), 'route glow uses line-blur');
ok(T.get('vice-city').map.routeGlowColor === '#ffd200', 'VC route glow: saturated hero yellow halo');
ok(T.get('vice-city').map.routeGlowOpacity === 0.5, 'VC route glow: visible halo opacity');
/* ---------- VC dashboard hero match: declutter + hierarchy ---------- */
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city #drive-bar{display:none}'),
  'VC dashboard hides the floating drive-bar pill');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city .dash-zoom{display:none}'),
  'VC dashboard hides the bottom-bar zoom/locate buttons');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city .player-arrow'),
  'VC dashboard player arrow is larger and more luminous');
ok(/body\.dashboard-mode\.theme-vice-city #next-stats\{[^}]*top:60%/.test(cssSrc),
  'VC maneuver stats row sits in the frame lower box');
ok(/body\.dashboard-mode\.theme-vice-city \.banner-text\{[^}]*height:42%/.test(cssSrc),
  'VC maneuver distance+road sit in the frame upper box');
ok(appSrc2.includes("roadName(next) || instrText(next)"),
  'VC maneuver card shows the clean road name (voice text untouched)');
ok(cssSrc.includes('width:132px;height:62px'),
  'VC top-bar logo box matches the fixed script art aspect');



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
// GTA V got its own bigger-label pass (places x1.6, roads x1.4); other
// themes keep the uniform x1.2 values.
const labelExpect = {
  'vice-city':   { townMin: 21, cityMin: 24, village: 14.5, hamlet: 12, major17min: 15 },
  'san-andreas': { townMin: 21, cityMin: 24, village: 14.5, hamlet: 12, major17min: 15 },
  'rdr2':        { townMin: 21, cityMin: 24, village: 14.5, hamlet: 12, major17min: 15 },
  'gta-v':       { townMin: 34, cityMin: 38, village: 23, hamlet: 19, major17min: 21 },
};
for (const [id, prefix] of [['vice-city', 'vc'], ['gta-v', 'v'], ['san-andreas', 'sa'], ['rdr2', 'rdr']]) {
  const exp = labelExpect[id];
  const st = styles[id];
  const lay = n => st.layers.find(l => l.id === n);
  const place = lay(`${prefix}-label-place`).layout['text-size'];
  const major = lay(`${prefix}-label-road-major`).layout['text-size'];
  const minor = lay(`${prefix}-label-road-minor`).layout['text-size'];
  const town = textSizeAt(place, 'town', 14);
  const city = textSizeAt(place, 'city', 14);
  ok(town >= exp.townMin, `${id}: town label >= ${exp.townMin}px (got ${town})`);
  ok(city >= exp.cityMin, `${id}: city label >= ${exp.cityMin}px (got ${city})`);
  // exact scaled match values lock the pass in (declutter bands preserved)
  ok(textSizeAt(place, 'village', 14) === exp.village, `${id}: village label == ${exp.village}px (got ${textSizeAt(place, 'village', 14)})`);
  ok(textSizeAt(place, 'hamlet', 14) === exp.hamlet, `${id}: hamlet label == ${exp.hamlet}px (got ${textSizeAt(place, 'hamlet', 14)})`);
  for (const z of [12, 14, 16]) {
    const tz = textSizeAt(place, 'town', z);
    const rm = textSizeAt(major, null, z), rn = textSizeAt(minor, null, z);
    ok(tz / rm >= 1.4, `${id}: town dominates major roads at z${z} (${tz.toFixed(1)} vs ${rm.toFixed(1)})`);
    if (z >= 14) ok(tz / rn >= 1.4, `${id}: town dominates minor roads at z${z} (${tz.toFixed(1)} vs ${rn.toFixed(1)})`);
  }
  ok(textSizeAt(major, null, 17) >= exp.major17min, `${id}: major roads still readable zoomed in (got ${textSizeAt(major, null, 17).toFixed(1)})`);
}
const vcRoad = styles['vice-city'].layers.find(l => l.id === 'vc-label-road-major').paint['text-color'];
const vcPlace = styles['vice-city'].layers.find(l => l.id === 'vc-label-place').paint['text-color'];
ok(vcRoad !== vcPlace, 'VC: road labels a different tone from place labels');


/* ---------- Spotify skins: single-hud overlays, art-registered openings ---------- */
const HUD_EXPECTED = {
  'gta-v':       { w: 1155, h: 1362, art: ['6.49%', '35.61%', '26.84%', '22.76%'], over: true },
  'san-andreas': { w: 1254, h: 1254, art: ['5.18%', '30.70%', '40.67%', '39.07%'], over: false },
  'rdr2':        { w: 1254, h: 1254, art: ['15.55%', '27.91%', '29.11%', '28.71%'], over: false },
};
for (const [theme, exp] of Object.entries(HUD_EXPECTED)) {
  const hudP = path.join(REPO, 'themes', theme, 'spotify/hud.png');
  const { w, h } = pngSize(hudP);
  ok(w === exp.w && h === exp.h, `${theme}: hud.png is the supplied ${exp.w}x${exp.h} art`);
  for (const crop of ['header.png', 'album.png', 'stage.png']) {
    ok(!fs.existsSync(path.join(REPO, 'themes', theme, 'spotify', crop)), `${theme}: chopped ${crop} is gone`);
  }
  const css = fs.readFileSync(path.join(REPO, 'themes', theme, 'spotify-skin.css'), 'utf8');
  const [l, t, sw, sh] = exp.art;
  const esc = x => x.replace('.', '\\.');
  const re = new RegExp(`\\.[a-z]+-art\\s*\\{[^}]*left:\\s*${esc(l)}[^}]*top:\\s*${esc(t)}[^}]*width:\\s*${esc(sw)}[^}]*height:\\s*${esc(sh)}`);
  ok(re.test(css), `${theme}: art rect matches the hud opening (${exp.art.join(' ')})`);
  const js = fs.readFileSync(path.join(REPO, 'themes', theme, 'spotify-skin.js'), 'utf8');
  ok(js.includes('hud.png') && !js.includes('header.png'), `${theme}: skin overlays the single hud`);
}
// vice-city: the opening is the hud's own cut-out, declared in CSS
// (measured: x 0.0753-0.3936, y 0.3425-0.6924 of the 1448x1086 hud)
ok(/\.vcsp-art\s*\{[^}]*left:\s*7\.5%[^}]*top:\s*34\.3%[^}]*width:\s*31\.9%[^}]*height:\s*35%/.test(vcSkinCssCode),
  'vice-city: art opening matches the hud cut-out');
ok(/\.vcsp-art-idle\s*\{[^}]*left:\s*7\.5%/.test(vcSkinCssCode),
  'vice-city: idle placeholder fills the same opening');

/* ---------- navigation voice: OpenAI-primary for EVERY theme ---------- */
const voiceFn = fs.readFileSync(path.join(REPO, 'supabase/functions/navigation-voice/index.ts'), 'utf8');
const voiceClient = fs.readFileSync(path.join(REPO, 'voice.js'), 'utf8');
const appJsCode = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
ok(voiceFn.includes('OpenAI-primary voice for EVERY theme'), 'voice function: OpenAI-primary for every theme');
// Every theme profile: cached audio -> OpenAI rewrite -> OpenAI TTS.
// Gemini is never attempted first for any of them.
const THEME_VOICES = {
  'vice-city': 'shimmer',
  'san-andreas': 'onyx',
  'gta-v': 'ash',
  'rdr2': 'fable',
};
for (const [theme, voice] of Object.entries(THEME_VOICES)) {
  const block = new RegExp(`'${theme}':\\s*\\{[^}]*?\\}`, 's');
  const m = voiceFn.match(block);
  ok(!!m, `${theme}: voice profile block exists`);
  const src = m ? m[0] : '';
  ok(/provider:\s*'openai'/.test(src), `${theme} voice profile: provider openai (Gemini never attempted)`);
  ok(src.includes(`voice: '${voice}'`), `${theme} voice profile: ${voice} voice`);
  ok(src.includes(`ttsModel: 'gpt-4o-mini-tts'`), `${theme} voice profile: gpt-4o-mini-tts`);
  ok(src.includes(`rewriteModel: 'gpt-4o-mini'`), `${theme} voice profile: gpt-4o-mini rewrite`);
  ok(/cacheAudio:\s*true/.test(src), `${theme} voice profile: server audio cache on`);
  ok(/personaVersion:\s*'v4'/.test(src), `${theme} voice profile: persona version v4`);
}
// No shipped profile opts into the explicit gemini-first slot, so the
// normal path can never run Gemini — before OpenAI or at all.
const personasBlock = (voiceFn.match(/const PERSONAS[^=]*=\s*\{([\s\S]*?)\n\};/) || [])[1] || '';
ok(personasBlock.length > 0, 'PERSONAS map found in the edge function');
ok(!/provider:\s*'gemini-first'/.test(personasBlock), 'no voice profile opts into gemini-first');
ok((voiceFn.match(/await geminiRewrite\(/g) || []).length === 1, 'geminiRewrite reachable only from the explicit opt-in branch');
ok((voiceFn.match(/await geminiSpeak\(/g) || []).length === 1, 'geminiSpeak reachable only from the explicit opt-in branch');
// Shared rewrite hard rules: route facts are sacred, brevity is mandatory.
const ruleCopies = voiceFn.split('RULES: preserve ').length - 1;
ok(ruleCopies === 4, `rewrite RULES block present in all four profiles (found ${ruleCopies})`);
for (const rule of ['roundabout maneuver and', 'exit facts', 'EVERY road and street name',
  'EVERY distance', 'destination', 'maneuver order', 'never invent landmarks or',
  'never swap directions', 'omit or add maneuvers', 'No emojis, no hashtags']) {
  ok(voiceFn.includes(rule), `rewrite rule present: "${rule}"`);
}
// Global brevity pass (v3): the mandatory instruction sits in EVERY theme
// rewrite prompt, client and server alike.
const BREVITY_RULES = ['BREVITY IS MANDATORY', '3–9 words', 'max 12 words',
  'max 18 words', 'Give the maneuver immediately',
  'Character should come from word choice and cadence',
  'preserve the necessary navigation facts',
  'If character makes the instruction longer, cut the character',
  'The ONLY data you have is the source instruction text',
  'never invent or add landmarks'];
ok(voiceFn.split('BREVITY IS MANDATORY').length - 1 === 4,
  'BREVITY IS MANDATORY in all four server rewrite prompts');
// Prompt assertions below run against the source with adjacent JS string
// literals joined, so phrases spanning a '+ ... +' line break still match.
const voicePrompts = voiceFn.replace(/'\s*\+\s*'/g, '');
for (const rule of BREVITY_RULES) {
  ok(voicePrompts.includes(rule), `server rewrite rule present: "${rule}"`);
}
// Per-theme TTS persona markers (the exact delivery spec for each voice).
for (const marker of ['late-70s nightclub energy', 'Never bubbly, breathless']) {
  ok(voiceFn.includes(marker), `VC TTS persona marker present: "${marker}"`);
}
for (const marker of ['Heavy warm baritone', 'AAVE', 'South Central', 'Calm authority', 'cartoon-gangster']) {
  ok(voiceFn.includes(marker), `SA TTS persona marker present: "${marker}"`);
}
for (const marker of ['mildly cynical', 'slightly rough edge', 'announcer-like']) {
  ok(voiceFn.includes(marker), `GTA V TTS persona marker present: "${marker}"`);
}
for (const marker of ['old-soul delivery', 'Never booming', 'cartoon-cowboy']) {
  ok(voiceFn.includes(marker), `RDR2 TTS persona marker present: "${marker}"`);
}
// Server audio cache: keyed by profile + persona version + normalized
// instruction + mode + profanity + TTS model + voice.
ok(voiceFn.includes("VOICE_CACHE_BUCKET = 'voice-cache'"), 'voice cache bucket: voice-cache');
ok(/canonical = \['v3', profile, personaVersion, mode, profanity \? 'p1' : 'p0', normalized, ttsModel, voice\]/.test(voiceFn),
  'voice cache key: profile + persona version + mode + profanity + normalized instruction + tts model + voice');
ok(voiceFn.includes('crypto.subtle.digest'), 'voice cache key: sha256-hashed');
ok(voiceFn.includes('ensureVoiceCacheBucket'), 'voice cache bucket self-provisions on first use');
// The active theme's personaVersion rides in the request and into the key.
ok(/personaVersion/.test(voiceFn) && voiceFn.includes('body.personaVersion'),
  'server reads personaVersion from the request for the cache key');
// Global server deadline sits below the client timeout and covers disconnects.
const serverDeadline = Number((voiceFn.match(/SERVER_DEADLINE_MS = (\d+)/) || [])[1]);
const clientTimeout = Number((voiceClient.match(/FETCH_TIMEOUT_MS = (\d+)/) || [])[1]);
ok(Number.isFinite(serverDeadline) && Number.isFinite(clientTimeout) && serverDeadline < clientTimeout,
  `server deadline (${serverDeadline}ms) below client timeout (${clientTimeout}ms)`);
ok(/deadlineScope\(req\)/.test(voiceFn) && /req\.signal/.test(voiceFn),
  'server deadline combines the client-disconnect signal');
// Brevity pass: rewrite outputs are capped at the API level as well.
ok(/max_tokens: 60/.test(voiceFn), 'OpenAI rewrite output capped at 60 tokens');
ok(/maxOutputTokens: 60/.test(voiceFn), 'Gemini rewrite output capped at 60 tokens');
// Client: the active theme's voice block drives every request.
ok(/const inflight = new Map\(\)/.test(voiceClient), 'voice client: controller-backed in-flight map');
ok(/const dup = inflight\.get\(key\);\s*\n?\s*if \(dup\) return dup\.promise;/.test(voiceClient),
  'voice client: concurrent generation deduplicated via a shared promise');
ok(/FIRST_SPEAK_GRACE_MS = 5000/.test(voiceClient),
  'voice client: route-start announcements may wait 5s for the persona voice');
ok(/opts && opts\.awaitThemed/.test(voiceClient) && /Promise\.race\(\[fetchTts\(text\), delay\(FIRST_SPEAK_GRACE_MS\)/.test(voiceClient),
  'voice client: awaitThemed races generation against the grace timeout');
ok(voiceClient.includes('speakText: (text, opts) => speakInternal(text, opts)'),
  'voice client: speakText passes options through');
ok(/preview\(\) \{/.test(voiceClient), 'voice client: one-tap preview() method exists');
ok(appJsCode.includes("speak(`Starting navigation.") && appJsCode.includes('{ awaitThemed: true }'),
  'app.js: route start waits briefly for the persona voice');
ok(appJsCode.includes("speak(`New route.") && appJsCode.includes('{ awaitThemed: true }'),
  'app.js: reroute announcement waits briefly for the persona voice');
ok(appJsCode.includes("VCNVoice.preview()"), 'app.js: voice preview button is wired');
ok(voiceClient.includes('onThemeChanged'), 'voice client: onThemeChanged aborts stale theme generation');
ok(appJsCode.includes('VCNVoice.onThemeChanged'), 'app.js: theme switch notifies the voice client');
ok(/routeEpoch\+\+/.test(voiceClient), 'voice client: reroute/theme bumps the generation epoch');
ok(/rec\.epoch !== routeEpoch/.test(voiceClient), 'voice client: stale in-flight results are dropped');
ok(/p\.profile.*p\.personaVersion.*p\.ttsModel.*p\.ttsVoice/.test(voiceClient),
  'voice client cache key: profile + persona version + tts model + tts voice');
ok(voiceClient.includes('personaVersion: profile.personaVersion'),
  'voice client sends the theme personaVersion with every request');
ok(/PREGEN_DEPTH = 5/.test(voiceClient) && /slice\(0, PREGEN_DEPTH\)/.test(voiceClient),
  'voice client pregenerates 5 upcoming instructions');
ok(voiceClient.includes('synthSpeak(text);\n    fetchTts(text);'),
  'voice client: immediate maneuver speaks deterministic browser voice, never waits for AI');
// Theme configs carry the full OpenAI-primary profile (source of truth).
for (const [theme, voice] of Object.entries(THEME_VOICES)) {
  const cfg = fs.readFileSync(path.join(REPO, 'themes', theme, 'theme.js'), 'utf8');
  ok(/provider:\s*'openai'/.test(cfg), `${theme} theme config: provider openai`);
  ok(cfg.includes(`profile: '${theme}'`), `${theme} theme config: profile id`);
  ok(cfg.includes(`ttsVoice: '${voice}'`), `${theme} theme config: ${voice} voice`);
  ok(cfg.includes(`ttsModel: 'gpt-4o-mini-tts'`), `${theme} theme config: gpt-4o-mini-tts`);
  ok(/personaVersion:\s*'v4'/.test(cfg), `${theme} theme config: persona version v4`);
  // Brevity pass, client side: the theme's own rewrite prompt carries the
  // same mandatory instruction + word-count ceilings as the server mirror.
  const ri = T.get(theme).voice.rewriteInstructions;
  for (const rule of BREVITY_RULES) {
    ok(ri.includes(rule), `${theme} client prompt carries: "${rule}"`);
  }
  ok(/quick [\w-]+ callouts/.test(T.get(theme).voice.ttsInstructions),
     `${theme} client TTS delivery: quick callouts, not monologues`);
}
// Distinct personality markers per theme — four recognisable voices, not
// four versions of one GPS voice.
const THEME_MARKERS = {
  'vice-city': ['Left here, sugar', 'Straight ahead, handsome'],
  'san-andreas': ['homie', 'fool'],
  'gta-v': ['Take the next right.', 'Straight ahead.'],
  'rdr2': ['Right at the next road.', 'Easy now. Left here.'],
};
for (const [theme, markers] of Object.entries(THEME_MARKERS)) {
  const ri = T.get(theme).voice.rewriteInstructions;
  for (const m of markers) ok(ri.includes(m), `${theme} client prompt keeps its voice: "${m}"`);
  // The server mirror must carry the same personality markers — the Edge
  // Function renders the persona, so its wording has to match the theme's.
  const block = new RegExp(`'${theme}':\\s*\\{[^}]*?\\}`, 's');
  const src = (voiceFn.match(block) || [])[0] || '';
  for (const m of markers) ok(src.includes(m), `${theme} server prompt mirrors the voice: "${m}"`);
}
// Key hygiene: no OpenAI secret material in the client or repo
ok(!/sk-(proj-)?[A-Za-z0-9]{20,}/.test(voiceClient), 'voice client ships no OpenAI key');
ok(!/sk-(proj-)?[A-Za-z0-9]{20,}/.test(voiceFn), 'edge function ships no hardcoded OpenAI key');

/* ---------- live traffic (TomTom) ---------- */
vm.runInContext(fs.readFileSync(path.join(REPO, 'traffic-config.js'), 'utf8'), sandbox, { filename: 'traffic-config.js' });
vm.runInContext(fs.readFileSync(path.join(REPO, 'traffic.js'), 'utf8'), sandbox, { filename: 'traffic.js' });
const TTC = vm.runInContext('TOMTOM_TRAFFIC_CONFIG', sandbox);
const TR = sandbox.window.VCNTraffic;
ok(!!TR && typeof TR.routeFromTomTom === 'function', 'traffic module loads as window.VCNTraffic');
ok(TTC && TTC.apiKey === 'PUT_YOUR_TOMTOM_KEY_HERE', 'traffic config ships the placeholder, not a real key');
ok(!/['"]sk-|api[_-]?key['"]\s*:\s*['"][A-Za-z0-9]{16,}/.test(
  fs.readFileSync(path.join(REPO, 'traffic-config.js'), 'utf8').replace('PUT_YOUR_TOMTOM_KEY_HERE', '')),
  'traffic config: no real key material anywhere');
ok(TR.hasKey() === false, 'traffic: hasKey() false with the placeholder');
ok(TR.isOn() === false, 'traffic: off until explicitly enabled');
const noKeyRes = TR.setOn(true);
ok(noKeyRes && noKeyRes.ok === false && noKeyRes.reason === 'no-key', 'traffic: toggle refuses without a key');
ok(TR.isOn() === false, 'traffic: still off after the refused enable');
ok(TR.flowTileUrl().indexOf('traffic/map/4/tile/flow/relative-delay/{z}/{x}/{y}.png') >= 0,
  'traffic: flow tiles use v4 relative-delay style');
ok(fs.existsSync(path.join(REPO, 'TRAFFIC_SETUP.md')), 'TRAFFIC_SETUP.md exists');
ok(fs.readFileSync(path.join(REPO, 'TRAFFIC_SETUP.md'), 'utf8').indexOf('https://ciaranf3308-star.github.io/*') >= 0,
  'TRAFFIC_SETUP.md documents the github.io referrer restriction');
const indexHtml = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
ok(indexHtml.indexOf('id="traffic-toggle"') >= 0, 'menu: single "Live traffic" toggle in index.html');
ok(indexHtml.indexOf('traffic-config.js') >= 0 && indexHtml.indexOf('traffic.js') >= 0,
  'index.html loads the traffic config + module');
ok(indexHtml.indexOf('id="incident-card"') >= 0, 'index.html has the incident card element');
ok(appSrc.indexOf('VCNTraffic.shouldRouteWithTraffic') >= 0, 'app.js: routes consult the traffic toggle');
ok(appSrc.indexOf('VCNTraffic.route(') >= 0, 'app.js: traffic-aware routing call');
ok(/tomtom routing failed/.test(appSrc) && /tomtom reroute failed/.test(appSrc),
  'app.js: TomTom failures fall back to OSRM silently (plan + reroute)');
ok(appSrc.indexOf('VCNTraffic.rehydrate()') >= 0, 'app.js: traffic overlays rehydrate after theme switch');
ok(SW.SHELL.indexOf('traffic.js') >= 0 && SW.SHELL.indexOf('traffic-config.js') >= 0,
  'SW precaches traffic.js + traffic-config.js');
// incident parser fixtures (Incident Details v5 shapes)
const incFixture = { incidents: [
  { type: 'Jam', geometry: { type: 'Point', coordinates: [-6.26, 53.35] },
    properties: { id: 'a1', iconCategory: 6, magnitudeOfDelay: 3,
      events: [{ description: 'Queue on M50', code: 0 }], from: 'J1', to: 'J2',
      length: 1200, delay: 480, roadNumbers: ['M50'] } },
  { type: 'RoadWorks', geometry: { type: 'LineString',
      coordinates: [[-6.3, 53.3], [-6.28, 53.32], [-6.26, 53.34]] },
    properties: { id: 'b2', iconCategory: 9, magnitudeOfDelay: 2, events: [], roadNumbers: [] } },
  { type: 'RoadClosed', geometry: null, properties: { id: 'c3' } }, // dropped: no geometry
]};
const incs = TR.parseIncidents(incFixture);
ok(incs.length === 2, 'traffic: incident parser drops the geometry-less entry');
ok(incs[0].description === 'Queue on M50', 'traffic: incident description comes from events');
ok(incs[0].delaySec === 480 && incs[0].roadNames[0] === 'M50', 'traffic: incident delay + road numbers');
ok(incs[0].category === 'Jam' && incs[0].severity.color === '#FB0000',
  'traffic: jam category + major severity colour');
ok(incs[1].description === 'Traffic incident', 'traffic: description fallback when no events');
ok(incs[1].lng === -6.28 && incs[1].lat === 53.32, 'traffic: LineString marker at segment midpoint');
ok(TR.parseIncidents({}).length === 0 && TR.parseIncidents(null).length === 0,
  'traffic: incident parser tolerates empty payloads');
// TomTom maneuver -> OSRM maneuver spot checks
ok(JSON.stringify(TR.mapManeuver('TURN_LEFT')) === JSON.stringify({ type: 'turn', modifier: 'left' }),
  'traffic: TURN_LEFT -> turn/left');
ok(TR.mapManeuver('MAKE_UTURN').modifier === 'uturn', 'traffic: MAKE_UTURN -> uturn');
ok(TR.mapManeuver('ROUNDABOUT_CROSS').type === 'roundabout', 'traffic: ROUNDABOUT_CROSS -> roundabout');
ok(TR.mapManeuver('TAKE_EXIT').type === 'off ramp', 'traffic: TAKE_EXIT -> off ramp');
ok(TR.mapManeuver('ARRIVE').type === 'arrive', 'traffic: ARRIVE -> arrive');
ok(TR.mapManeuver('BOGUS_FUTURE_CODE').type === 'continue',
  'traffic: unknown maneuver codes degrade to continue');
// calculateRoute -> OSRM-shaped route fixtures
const tomFixture = {
  routes: [{
    summary: { lengthInMeters: 5000, travelTimeInSeconds: 600, trafficDelayInSeconds: 120 },
    legs: [{ points: [{ latitude: 53.35, longitude: -6.26 }, { latitude: 53.36, longitude: -6.25 }] }],
    guidance: { instructions: [
      { maneuver: 'DEPART', street: 'Main St', roadNumbers: ['R1'],
        routeOffsetInMeters: 0, travelTimeInSeconds: 0, point: { latitude: 53.35, longitude: -6.26 } },
      { maneuver: 'TURN_LEFT', street: 'Side Rd', roadNumbers: [],
        routeOffsetInMeters: 3000, travelTimeInSeconds: 360, point: { latitude: 53.355, longitude: -6.255 } },
      { maneuver: 'ARRIVE', street: 'Side Rd', roadNumbers: [],
        routeOffsetInMeters: 5000, travelTimeInSeconds: 600, point: { latitude: 53.36, longitude: -6.25 } },
    ] },
  }],
};
const conv = TR.routeFromTomTom(tomFixture);
ok(conv.distance === 5000 && conv.duration === 600, 'traffic: converter keeps route totals');
ok(conv.geometry.coordinates[0][0] === -6.26 && conv.geometry.coordinates[0][1] === 53.35,
  'traffic: converter geometry in [lon,lat]');
ok(conv.legs[0].steps.length === 3, 'traffic: one OSRM-shaped step per guidance instruction');
ok(conv.legs[0].steps[0].maneuver.type === 'depart', 'traffic: DEPART step maps to depart');
ok(conv.legs[0].steps[1].maneuver.location[0] === -6.255, 'traffic: step maneuver.location is [lon,lat]');
ok(conv.legs[0].steps[1].name === 'Side Rd', 'traffic: step keeps the street name');
ok(conv.legs[0].steps[0].ref === 'R1', 'traffic: step keeps road numbers as ref');
ok(conv.legs[0].steps[0].distance === 3000 && conv.legs[0].steps[0].duration === 360,
  'traffic: step distance/duration derived from instruction offsets');
ok(conv.legs[0].steps[2].distance === 0 && conv.legs[0].steps[2].duration === 0,
  'traffic: final step consumes the remaining offsets');
ok(conv.trafficDelaySec === 120, 'traffic: converter keeps trafficDelayInSeconds');
let threw = false;
try { TR.routeFromTomTom({}); } catch (e) { threw = true; }
ok(threw, 'traffic: converter throws on empty payload (caller falls back to OSRM)');


/* ---------- kinetic karaoke lyric engine (lyrics.js) ---------- */
vm.runInContext(fs.readFileSync(path.join(REPO, 'lyrics.js'), 'utf8'), sandbox, { filename: 'lyrics.js' });
const LY = sandbox.window.WSLyrics;
ok(!!LY && typeof LY.render === 'function' && typeof LY.destroy === 'function', 'lyrics: WSLyrics exposes render/destroy');
ok(typeof LY.setOffset === 'function' && LY.getOffset() === 600, 'lyrics: default offset 600ms (within the +500-800 concept)');
ok(LY.setOffset(50) === 50 && LY.getOffset() === 50, 'lyrics: offset tunable');
ok(LY.setOffset(-5) === 0 && LY.setOffset(99999) === 5000, 'lyrics: offset clamped to [0,5000]');
LY.setOffset(600);
const U = LY.util;

// LRC parsing: timestamps, sort order, metadata + note-lines skipped
const lrcLines = U.parseLRC('[ti:Title]\n[ar:Artist]\n[00:12.34]second line\n[00:05.00]first line\n[00:20.00]\n[00:25.10]\u266A\n[01:02.500]millis line');
ok(lrcLines.length === 3, 'lyrics: parseLRC keeps 3 real lines, drops tags/empties/notes');
ok(lrcLines[0].t === 5000 && lrcLines[0].text === 'first line', 'lyrics: parseLRC sorts by time');
ok(lrcLines[1].t === 12340, 'lyrics: parseLRC centiseconds -> ms');
ok(lrcLines[2].t === 62500, 'lyrics: parseLRC milliseconds -> ms');
const multi = U.parseLRC('[00:01.00][00:02.00]repeated');
ok(multi.length === 2 && multi[0].t === 1000 && multi[1].t === 2000, 'lyrics: parseLRC expands multi-tag lines');

// Deterministic compositions: same seed -> identical, replay-stable
const specA = U.composeSpec('track-abc', 3, 'hello world');
const specB = U.composeSpec('track-abc', 3, 'hello world');
ok(JSON.stringify(specA) === JSON.stringify(specB), 'lyrics: composition deterministic per track+line');
const specC = U.composeSpec('track-abc', 4, 'hello world');
ok(JSON.stringify(specA) !== JSON.stringify(specC), 'lyrics: composition varies per line');
const specD = U.composeSpec('track-xyz', 3, 'hello world');
ok(JSON.stringify(specA) !== JSON.stringify(specD), 'lyrics: composition varies per track');
ok(specA.family >= 0 && specA.family <= 4, 'lyrics: composition picks 1 of 5 type families');
ok(['left','center','right'].includes(specA.align) && ['up','mid','low'].includes(specA.vpos), 'lyrics: composition varies alignment/placement');
ok(['upper','title','lower','as-is'].includes(specA.casing), 'lyrics: composition varies casing');
ok(U.sizeClass('BABY') === 'xl', 'lyrics: short emotional lines may go HUGE');
ok(U.sizeClass('a'.repeat(100)) === 'sm', 'lyrics: long lines shrink');
ok(U.applyCase('hello world', 'upper') === 'HELLO WORLD', 'lyrics: upper casing');
ok(U.applyCase('hELLo', 'title') === 'Hello', 'lyrics: title casing');

// Artistic word progress across line start -> next line start
let wp = U.wordProgress(1000, 0, 4000, 4);
ok(wp.active === 1, 'lyrics: word progress distributes words across the line window');
wp = U.wordProgress(0, 0, 4000, 4);
ok(wp.active === 0 && wp.p === 0, 'lyrics: word progress starts at word 0');
wp = U.wordProgress(99999, 0, 4000, 4);
ok(wp.active === 3 && wp.p === 1, 'lyrics: word progress clamps at the final word');
wp = U.wordProgress(20000, 0, 60000, 4); // 60s gap capped at the 12s window
ok(wp.p === 1, 'lyrics: word window capped so long gaps do not crawl');
ok(U.wordProgress(1000, 0, 4000, 0).active === -1, 'lyrics: wordless lines have no active word');

// Active line lookup
const tl = [{ t: 1000, text: 'a' }, { t: 5000, text: 'b' }, { t: 9000, text: 'c' }];
ok(U.activeLineIndex(tl, 500) === -1, 'lyrics: no active line before the first timestamp');
ok(U.activeLineIndex(tl, 5000) === 1, 'lyrics: active line at exact timestamp');
ok(U.activeLineIndex(tl, 20000) === 2, 'lyrics: active line holds past the last timestamp');

// Payload classification: never fake sync
let cls = U.classifyPayload({ syncedLyrics: '[00:01.00]la\n[00:05.00]la la' });
ok(cls.mode === 'karaoke' && cls.lines.length === 2, 'lyrics: synced payload -> karaoke');
cls = U.classifyPayload({ plainLyrics: 'line one\nline two' });
ok(cls.mode === 'ambient' && cls.plain.length === 2, 'lyrics: unsynced payload -> ambient, never fake karaoke');
cls = U.classifyPayload({ instrumental: true });
ok(cls.mode === 'instrumental', 'lyrics: instrumental flagged');
cls = U.classifyPayload(null);
ok(cls.mode === 'none', 'lyrics: missing payload -> none');
cls = U.classifyPayload({ syncedLyrics: '[00:01.00]la' });
ok(cls.mode === 'karaoke', 'lyrics: sparse synced lines still karaoke, not ambient');

// Skin wiring: every theme routes its lyric stage through the engine
for (const [skinFile, themeId, stageCls] of [
  ['themes/vice-city/spotify-skin.js', 'vice-city', 'vcsp-lyrics'],
  ['themes/san-andreas/spotify-skin.js', 'san-andreas', 'sasp-lyrics'],
  ['themes/gta-v/spotify-skin.js', 'gta-v', 'gvsp-lyrics'],
  ['themes/rdr2/spotify-skin.js', 'rdr2', 'rdsp-lyrics'],
]) {
  const src = fs.readFileSync(path.join(REPO, skinFile), 'utf8');
  ok(src.includes(`WSLyrics.render(box, core, s && s.item, '${themeId}')`), `lyrics: ${themeId} skin routes stage to WSLyrics`);
  ok(src.includes(`q('.${stageCls}')`), `lyrics: ${themeId} skin keeps its own stage element`);
}

// Theme styling hooks exist for all four themes
const cssAll = fs.readFileSync(path.join(REPO, 'styles.css'), 'utf8');
for (const tid of ['vice-city', 'san-andreas', 'gta-v', 'rdr2']) {
  ok(cssAll.includes(`.wslyr-${tid}`), `lyrics: theme skin hooks for ${tid}`);
  for (let fi = 0; fi < 5; fi++) {
    ok(cssAll.includes(`.wslyr-${tid} .f${fi}`), `lyrics: ${tid} defines type family f${fi}`);
  }
}
for (const k of ['wslyr-in-spring', 'wslyr-in-blur', 'wslyr-in-pop', 'wslyr-in-sweep', 'wslyr-in-snap', 'wslyr-in-flicker']) {
  ok(cssAll.includes(k), `lyrics: entrance animation ${k} defined`);
}
ok(cssAll.includes('wslyr-ghost') && cssAll.includes('prefers-reduced-motion'), 'lyrics: ghost fade + reduced-motion guard');

// Shell wiring
const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
ok(html.includes('<script src="lyrics.js"></script>'), 'lyrics: index.html loads lyrics.js');
const sw = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
ok(sw.includes("'lyrics.js'"), 'lyrics: service worker precaches lyrics.js');

/* ---------- car mode (?car=1): Android Auto WebView adapter ---------- */
const carJs = fs.readFileSync(path.join(REPO, 'car.js'), 'utf8');
ok(/get\('car'\) === '1'/.test(carJs) && carJs.includes('window.__WAYSTATION_CAR = true'),
  'car: ?car=1 plants the car flag before app.js boots');
ok(html.indexOf('<script src="car.js"></script>') !== -1 &&
   html.indexOf('<script src="car.js"></script>') < html.indexOf('<script src="app.js"></script>'),
  'car: index.html loads car.js before app.js');
ok(appSrc.includes('if (window.__WAYSTATION_CAR)') && appSrc.includes("appMode = 'dashboard';"),
  'car: car mode forces dashboard mode for the session');
ok(/function installCarBridge\(\)/.test(appSrc) && appSrc.includes('installCarBridge(); // ?car=1'),
  'car: WayStationCar bridge installed at boot');
for (const m of ['setVisibleArea', 'setStableArea', 'setSpotifyAuth', 'isSpotifyConnected', 'getState']) {
  ok(new RegExp(m + ':\\s*function').test(appSrc), `car: bridge exposes ${m}`);
}
ok(appSrc.includes('--car-visible-') && appSrc.includes('--car-stable-'),
  'car: visible/stable areas exposed as CSS variables');
const spCore = fs.readFileSync(path.join(REPO, 'spotify-core.js'), 'utf8');
ok(/function reloadAuth\(\)/.test(spCore) && spCore.includes('reloadAuth,'),
  'car: SpotifyCore exposes reloadAuth for the native token handoff');
ok(sw.includes("'car.js'"), 'car: service worker precaches car.js');

/* ---------- android/ car shell (personal/internal test build) ---------- */
const AND = path.join(REPO, 'android');
const manifest = fs.readFileSync(path.join(AND, 'app/src/main/AndroidManifest.xml'), 'utf8');
ok(manifest.includes('android:name=".WayStationCarAppService"'), 'android: CarAppService declared');
ok(manifest.includes('androidx.car.app.CarAppService'), 'android: CarAppService intent action');
ok(manifest.includes('androidx.car.app.category.NAVIGATION'), 'android: NAVIGATION category');
ok(manifest.includes('androidx.car.app.ACCESS_SURFACE'), 'android: ACCESS_SURFACE declared');
ok(manifest.includes('com.google.android.gms.car.application'), 'android: car application metadata');
ok(manifest.includes('@xml/automotive_app_desc'), 'android: automotive_app_desc referenced');
ok(manifest.includes('waystation') && manifest.includes('spotify-callback'), 'android: Spotify deep-link scheme');
for (const p of ['android.permission.INTERNET',
                 'android.permission.ACCESS_COARSE_LOCATION',
                 'android.permission.ACCESS_FINE_LOCATION',
                 'androidx.car.app.NAVIGATION_TEMPLATES',
                 'androidx.car.app.ACCESS_SURFACE']) {
  ok(manifest.includes(p), `android: manifest permission ${p}`);
}
const desc = fs.readFileSync(path.join(AND, 'app/src/main/res/xml/automotive_app_desc.xml'), 'utf8');
ok(desc.includes('<uses name="template"'), 'android: automotive_app_desc declares template');
ok(!desc.includes('<uses name="navigation"'), 'android: automotive_app_desc has no navigation uses (category covers it)');
const appGradle = fs.readFileSync(path.join(AND, 'app/build.gradle'), 'utf8');
ok(appGradle.includes('androidx.car.app:app:1.7.0'), 'android: Car App Library app:1.7.0');
ok(appGradle.includes('androidx.car.app:app-projected:1.7.0'), 'android: Car App Library app-projected:1.7.0');
const svc = fs.readFileSync(path.join(AND, 'app/src/main/java/com/waystation/auto/WayStationCarAppService.kt'), 'utf8');
ok(svc.includes('HostValidator.ALLOW_ALL_HOSTS_VALIDATOR'), 'android: permissive host validator (internal build)');
const screen = fs.readFileSync(path.join(AND, 'app/src/main/java/com/waystation/auto/WayStationScreen.kt'), 'utf8');
ok(screen.includes('NavigationTemplate.Builder()'), 'android: NavigationTemplate keeps host chrome minimal');
ok(screen.includes('setSurfaceCallback'), 'android: SurfaceCallback registered via AppManager');
ok(screen.includes('navigationStarted()') && screen.includes('navigationEnded()'),
  'android: NavigationManager session start/end signals');
ok(screen.includes('onStopNavigation') && screen.includes('renderer.stopNavigation()'),
  'android: host stop-navigation forwarded into the JS app');
ok(screen.includes('setMapActionStrip') && screen.includes('Action.PAN'),
  'android: map action strip with Action.PAN (enables SurfaceCallback touch)');
ok(screen.includes('setPanModeListener'), 'android: pan mode listener wired');
ok(screen.includes('requestPermissions') && screen.includes('Enable location'),
  'android: runtime location permission flow with Enable location action');
const rend = fs.readFileSync(path.join(AND, 'app/src/main/java/com/waystation/auto/CarWebViewRenderer.kt'), 'utf8');
ok(rend.includes('?dashboard=1&car=1'), 'android: WebView loads the car dashboard URL');
ok(rend.includes('createVirtualDisplay'), 'android: VirtualDisplay from the SurfaceContainer');
ok(rend.includes('Presentation('), 'android: Presentation hosts the WebView');
ok(rend.includes('javaScriptEnabled = true'), 'android: WebView JS enabled');
for (const m of ['onSurfaceAvailable', 'onSurfaceDestroyed', 'onVisibleAreaChanged',
                 'onStableAreaChanged', 'onClick', 'onScroll', 'onScale', 'onFling']) {
  ok(screen.includes(m) || rend.includes(m), `android: SurfaceCallback ${m} handled`);
}
ok(rend.includes('dispatchTouchEvent'), 'android: touch forwarded as synthetic MotionEvents');
ok(rend.includes('WayStationCar.setVisibleArea('), 'android: visible area forwarded into JS');
ok(rend.includes('WayStationCar.setSpotifyAuth('), 'android: Spotify token handoff into the page');
ok(rend.includes('setGeolocationEnabled(true)'), 'android: WebView geolocation enabled');
ok(rend.includes('onGeolocationPermissionsShowPrompt') && rend.includes('WAYSTATION_ORIGIN'),
  'android: geolocation prompt gated to the WayStation origin');
ok(rend.includes('locationPermissionGranted?.invoke()'), 'android: geolocation only after native permission granted');
ok(rend.includes('fun stopNavigation()') && rend.includes('WayStationCar.stopNavigation()'),
  'android: renderer stopNavigation bridge into JS');
ok(rend.includes('virtualDisplay?.release()') && rend.includes('presentation?.dismiss()'),
  'android: surface teardown releases VirtualDisplay + Presentation');
ok(/stopNavigation:\s*function/.test(appSrc) && appSrc.includes('endNav()'),
  'car: bridge stopNavigation ends the route/voice/driving state via endNav()');
const wf = fs.readFileSync(path.join(REPO, '.github/workflows/android.yml'), 'utf8');
ok(wf.includes('assembleDebug') && wf.includes('upload-artifact'),
  'android: CI workflow builds the debug APK and uploads it');
const spotKt = fs.readFileSync(path.join(AND, 'app/src/main/java/com/waystation/auto/SpotifyAuthManager.kt'), 'utf8');
ok(spotKt.includes('accounts.spotify.com/authorize') && spotKt.includes('code_challenge'),
  'android: native Spotify PKCE flow (Custom Tab)');
ok(spotKt.includes('expires_at'), 'android: handoff token matches the web auth shape');
ok(fs.existsSync(path.join(AND, 'gradlew')), 'android: gradle wrapper script present');
ok(fs.existsSync(path.join(AND, 'gradle/wrapper/gradle-wrapper.jar')), 'android: gradle wrapper jar present');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
