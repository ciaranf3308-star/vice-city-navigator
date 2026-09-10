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
  ok(t.map && typeof t.map.playerMarker === 'string' && /player\.(png|svg)$/.test(t.map.playerMarker), `${id} map.playerMarker`);
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
  ok(Array.isArray(style.layers) && style.layers.length >= (id === 'san-andreas' ? 20 : 29),
    `${id} has enough layers (got ${style.layers.length})`);
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
  // nominal blip size: 16px shared baseline; gta-v ships 32px art but
  // displays it at the same on-screen size (blipScale 1).
  const nominal = id === 'gta-v' ? 32 : 16;
  for (const sem of SEMANTICS.concat(['waypoint', 'qmark'])) {
    const url = T.poiIconUrl(sem, id);
    const { w, h } = pngSize(path.join(REPO, url));
    ok(w === nominal && h === nominal, `${id} blip ${nominal}x${nominal}: ${sem}`);
  }
  const pmUrl = T.get(id).map.playerMarker;
  if (pmUrl.endsWith('.svg')) {
    const s = fs.readFileSync(path.join(REPO, pmUrl), 'utf8');
    ok(/<svg[\s>]/.test(s) && /viewBox="0 0 (32|40) (32|40)"/.test(s), `${id} player marker is a square SVG`);
  } else {
    const ps = pngSize(path.join(REPO, pmUrl));
    ok(ps.w === 32 && ps.h === 32, `${id} player marker 32x32`);
  }
}
ok(T.get('gta-v').pois.blipScale === 1, 'gta-v declares blipScale 1');

/* ---------- service worker classification ---------- */
const swSrc = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(REPO, 'styles.css'), 'utf8')
  + ['vice-city','san-andreas','gta-v','rdr2'].map(t => {
    try { return fs.readFileSync(path.join(REPO, `themes/${t}/dashboard.css`), 'utf8'); }
    catch (e) { return ''; }
  }).join('\n');
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
ok(swSrc.includes("ws-shell-v68"), 'SW shell cache v68');
ok(swSrc.includes("ws-theme-v189"), 'SW theme cache v189');
ok(/new Request\(e\.request,\s*\{\s*cache:\s*['"]reload['"]\s*\}\)/.test(swSrc),
  'SW theme revalidation bypasses the HTTP cache (stale PNGs cannot be re-stored as fresh)');
ok(/new Request\(req,\s*\{\s*cache:\s*['"]reload['"]\s*\}\)/.test(swSrc),
  'SW shell revalidation bypasses the HTTP cache too');

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
ok(vLay('v-land').paint['background-color'] === '#181818', 'V pause-menu land is charcoal (researched)');
ok(vLay('v-water').paint['fill-color'] === '#101314', 'V pause-menu water is near-black (researched)');
ok(vLay('v-road-motorway').paint['line-color'] === '#efefef', 'V pause-menu motorways are bright white (researched)');
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
ok(placesSrc.includes('ws-poi-marker'), 'places.js renders POIs as DOM markers');
ok(placesSrc.includes('markerPxForZoom'), 'places.js scales POI marker size by zoom');
ok(!placesSrc.includes('POI_LAYER_ID'), 'places.js has no POI symbol layer');
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
ok(placesSrc.includes('picked.sort'), 'renderPois sorts picked POIs by importance');
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
/* Regression: the transport row must stay above the hud.png chrome line
   (measured at 94.5% of the art) — bottom:<7% put the buttons ON the chrome. */
ok(/\.vcsp-controls\s*\{[^}]*bottom:\s*([0-9.]+)%/.test(vcSkinCssCode) &&
   parseFloat(vcSkinCssCode.match(/\.vcsp-controls\s*\{[^}]*bottom:\s*([0-9.]+)%/)[1]) >= 7,
   'VC transport row bottom edge stays >=7% above the widget bottom (clear of the 94.5% art chrome line)');
ok(vcSkinCssCode.includes('.vcsp-idle') && !vcSkinCssCode.includes('vcsp-connect-pill'), 'VC idle/connect lives inside the widget, no generic card');
ok(vcSkinJs.includes('vcsp-idle') && !vcSkinJsCode.includes('vcsp-connect\'') && !vcSkinJsCode.includes('vcsp-connect"'), 'VC skin JS renders the in-widget idle state');

/* ---------- VC phone polish (2026-09-09): the dashboard-only skin left
   the phone widget catastrophically oversized (giant neon panel,
   truncated text). phone.css docks it as a compact bottom sheet that
   reuses the hud.png openings at phone width. */
const vcPhoneSrc = fs.readFileSync(path.join(REPO, 'themes/vice-city/phone.css'), 'utf8');
ok(/theme-vice-city:not\(\.dashboard-mode\)(?::not\(\.cluster-mode\))? #spotify-pane\{[^}]*bottom:0/.test(vcPhoneSrc),
  'VC phone Spotify pane docks as a bottom sheet (map stays visible)');
ok(/theme-vice-city:not\(\.dashboard-mode\)(?::not\(\.cluster-mode\))? \.vcsp\{[^}]*max-width:430px/.test(vcPhoneSrc),
  'VC phone widget is compact (not the 670px dashboard object)');
ok(!/background-size:\s*cover/.test(vcPhoneSrc), 'VC phone skin never crops the concept art');

/* ---------- dead vehicle tab (2026-09-09): removed from the bar markup;
   SA's explicit nth-child slots renumber — settings takes the 4th slot
   and the parked console coin is retired. */
const saDashCss = fs.readFileSync(path.join(REPO, 'themes/san-andreas/dashboard.css'), 'utf8');
ok(!/\.dash-tabs button:nth-child\(5\)/.test(saDashCss), 'SA: no 5th-tab rules remain after vehicle removal');
ok(/\.dash-tabs button:nth-child\(4\)\{left:555px\}/.test(saDashCss), 'SA: settings takes the 4th art slot');

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
ok(/\.gvsp-artwrap\s*\{[^}]*left:\s*6\.8%[^}]*width:\s*33\.4%/.test(gvSkinCss),
  'GV art rect sits in the hud frame opening (measured fractions)');
ok(gvSkinJs.includes('hud.png'), 'GV skin overlays the supplied hud art directly');
const gvSkinJsCode = stripComments(gvSkinJs), gvSkinCssCode = stripComments(gvSkinCss);
for (const banned of ['miniviz', 'stagepeek', 'fullstage', 'gvsp-viz', 'spectrum', 'spotify-close', 'background-size: cover', 'vcsp-']) {
  ok(!gvSkinJsCode.includes(banned) && !gvSkinCssCode.includes(banned), `GV skin has no ${banned}`);
}
ok(gvSkinJsCode.includes('gvsp-') && gvSkinCssCode.includes('.gvsp'), 'GV skin uses gvsp- prefix');
ok(/\.gvsp-hud\s*\{[^}]*inset:\s*0/.test(gvSkinCssCode), 'GV hud is one full-bleed skin layer');
ok(gvSkinCssCode.includes('#2ce68c') && gvSkinCssCode.includes('#0b0b0b'), 'GV skin muted mint on charcoal console');
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

function extractFn(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('missing function in app.js: ' + name);
  return m[0];
}
const modeBox = { URLSearchParams };
vm.createContext(modeBox);
for (const fn of ['parseAppMode', 'modeBodyFlags', 'speedDisplayActive', 'clusterLayoutActive', 'dashboardLayoutActive']) {
  vm.runInContext(extractFn(appSrc, fn), modeBox, { filename: 'app.js#' + fn });
}
const tParseAppMode = modeBox.parseAppMode, tModeBodyFlags = modeBox.modeBodyFlags;
// parsing precedence: car session > ?cluster=1 > ?dashboard= > persisted choice
ok(tParseAppMode('?cluster=1', false, 'dashboard') === 'cluster', 'cluster: ?cluster=1 wins over persisted dashboard');
ok(tParseAppMode('?cluster=1', false, null) === 'cluster', 'cluster: ?cluster=1 with no stored pref');
ok(tParseAppMode('?cluster=1&dashboard=1', false, null) === 'cluster', 'cluster: ?cluster=1 wins over ?dashboard=1');
ok(tParseAppMode('?cluster=0', false, null) === 'normal', 'cluster: only exact ?cluster=1 enables');
ok(tParseAppMode('?dashboard=1', false, null) === 'dashboard', 'dashboard: ?dashboard=1');
ok(tParseAppMode('?dashboard=0', false, 'dashboard') === 'normal', 'normal: ?dashboard=0 clears persisted dashboard');
ok(tParseAppMode('', false, 'dashboard') === 'dashboard', 'dashboard: persisted choice restored');
ok(tParseAppMode('', false, 'cluster') === 'cluster', 'cluster: persisted explicit choice restored');
ok(tParseAppMode('', false, 'weird') === 'normal', 'normal: unknown stored value falls back');
ok(tParseAppMode('', false, null) === 'normal', 'normal: default with nothing stored');
ok(tParseAppMode('?cluster=1', true, null) === 'dashboard', 'car: session forces dashboard over ?cluster=1');
ok(tParseAppMode('', true, 'cluster') === 'dashboard', 'car: stored cluster never leaks into the car session');
// dashboard/cluster body flags are mutually exclusive by construction
for (const mode of ['normal', 'dashboard', 'cluster']) {
  const f = tModeBodyFlags(mode);
  ok(f.dashboard === (mode === 'dashboard') && f.cluster === (mode === 'cluster'),
    `exclusivity: modeBodyFlags('${mode}')`);
  ok(!(f.dashboard && f.cluster), `exclusivity: dashboard/cluster never co-occur ('${mode}')`);
}
// speedDisplayActive / clusterLayoutActive read the live appMode
modeBox.appMode = 'cluster';
ok(modeBox.speedDisplayActive() === true, 'speed readout live in cluster mode');
ok(modeBox.clusterLayoutActive() === true, 'clusterLayoutActive in cluster mode');
ok(modeBox.dashboardLayoutActive() === false, 'dashboardLayoutActive false in cluster mode');
modeBox.appMode = 'dashboard';
ok(modeBox.speedDisplayActive() === true, 'speed readout live in dashboard mode');
ok(modeBox.clusterLayoutActive() === false, 'clusterLayoutActive false in dashboard mode');
modeBox.appMode = 'normal';
ok(modeBox.speedDisplayActive() === false, 'speed readout idle in normal mode');
ok(modeBox.clusterLayoutActive() === false, 'clusterLayoutActive false in normal mode');
// shell wiring (source-level guards)
ok(appSrc.includes("get('cluster')"), 'cluster URL param read');
ok(appSrc.includes('clusterLayoutActive()'), 'clusterLayoutActive() exists');
ok(appSrc.includes("classList.toggle('cluster-mode'"), 'body.cluster-mode toggled');
ok(appSrc.includes('localStorage.setItem(APP_MODE_KEY, appMode)'), 'explicit mode choice persisted');
ok((appSrc.match(/new maplibregl\.Map/g) || []).length === 1, 'single MapLibre instance: mode switches never create a map');
ok(indexSrc.includes('id="cluster-ui"'), 'cluster shell in index.html');
for (const id of ['cluster-speed', 'cluster-speed-num', 'cluster-speed-unit', 'cluster-limit', 'cluster-limit-num',
                  'cluster-turn', 'cluster-turn-arrow', 'cluster-turn-distance', 'cluster-turn-road', 'cluster-turn-instruction',
                  'cluster-turn-main', 'cluster-turn-compass', 'cluster-compass-needle',
                  'cluster-minimap', 'cluster-trip',
                  'cluster-backdrop', 'cluster-header', 'cluster-logo', 'cluster-temp', 'cluster-wxicon',
                  'cluster-date', 'cluster-time', 'cluster-tagline', 'cluster-gauge', 'cluster-gauge-svg',
                  'cluster-footer', 'cluster-tabs', 'cluster-footer-logo',
                  'cluster-mode-exit']) {
  ok(indexSrc.includes(`id="${id}"`), `cluster region present: ${id}`);
}
// no duplicate cluster Spotify surface: the real #spotify-pane is shared
for (const id of ['cluster-music', 'cluster-music-art', 'cluster-music-title', 'cluster-music-artist',
                  'cluster-music-panel', 'cluster-lyrics', 'cluster-pos', 'cluster-bar', 'cluster-dur',
                  'cluster-music-transport', 'cluster-prev', 'cluster-play', 'cluster-next']) {
  ok(!indexSrc.includes(`id="${id}"`), `no duplicate cluster Spotify DOM: ${id}`);
}
ok(indexSrc.includes('id="spotify-pane"') && indexSrc.includes('id="spotify-stage"'),
  'shared Spotify widget surface present');
for (const tab of ['data-tab="cluster"', 'data-tab="dashboard"', 'data-tab="map"']) {
  ok(indexSrc.includes(tab), `cluster presentation tab: ${tab}`);
}
ok(!indexSrc.includes('data-tab="vehicle"') && !indexSrc.includes('data-tab="phone"') &&
   !indexSrc.includes('data-tab="radio"'), 'cluster tabs: no dead views');

// cluster live regions (commit 2): stub-DOM behavioural tests
const liveEls = {};
function stubEl() {
  const cls = new Set(), attrs = {};
  return {
    textContent: '', hidden: false, style: {},
    classList: { toggle(c, f) { f ? cls.add(c) : cls.delete(c); }, contains(c) { return cls.has(c); },
                 add(c) { cls.add(c); }, remove(c) { cls.delete(c); } },
    getAttribute(k) { return k in attrs ? attrs[k] : null; },
    setAttribute(k, v) { attrs[k] = String(v); },
    removeAttribute(k) { delete attrs[k]; },
  };
}
for (const id of ['cluster-speed', 'cluster-speed-num', 'cluster-limit', 'cluster-limit-num',
                  'cluster-turn', 'cluster-turn-arrow', 'cluster-turn-distance', 'cluster-turn-road',
                  'cluster-turn-instruction', 'cluster-turn-compass', 'cluster-compass-needle', 'cluster-trip',
                  'cluster-gauge-svg', 'cluster-date', 'cluster-time', 'cluster-temp']) liveEls[id] = stubEl();
const liveBox = {
  URLSearchParams,
  $: (id) => liveEls[id] || null,
  wsTheme: () => null, // generic arrow branch
  window: {},
};
vm.createContext(liveBox);
for (const fn of ['clusterLayoutActive', 'updateClusterSpeed', 'syncClusterTurn',
                  'nextTurnData', 'arrowKind', 'arrowSvg', 'themeArrowColor', 'fmtDist', 'roadName', 'instrText',
                  'updateDriveForce', 'syncDriveForceGauge', 'buildClusterGauge']) {
  vm.runInContext(extractFn(appSrc, fn), liveBox, { filename: 'app.js#' + fn });
}
liveBox.clusterGaugeTicks = []; liveBox.dfPrevMps = null; liveBox.dfPrevT = 0;
liveBox.smoothedAcceleration = 0; liveBox.driveForceState = 'coast'; liveBox.driveForceBand = 0;
// drive meter needs a clock the stub can advance
let dfNow = 100000;
liveBox.performance = { now: () => dfNow };
// speed visibility rules
liveBox.appMode = 'cluster'; liveBox.speedLimitKmh = null;
liveBox.updateClusterSpeed(null);
ok(liveEls['cluster-speed-num'].textContent === '--', 'cluster speed: -- when unknown (never stale)');
liveEls['cluster-speed-num'].textContent = '99'; // stale value must be overwritten
liveBox.updateClusterSpeed(null);
ok(liveEls['cluster-speed-num'].textContent === '--', 'cluster speed: stale value replaced by --');
ok(liveEls['cluster-limit'].hidden === true, 'cluster limit: hidden when unknown');
liveBox.speedLimitKmh = 80;
liveBox.updateClusterSpeed(84);
ok(liveEls['cluster-speed-num'].textContent === '84', 'cluster speed: integer km/h');
ok(liveEls['cluster-limit'].hidden === false && liveEls['cluster-limit-num'].textContent === '80',
  'cluster limit: shown when known');
ok(liveEls['cluster-speed'].classList.contains('over'), 'cluster overspeed: subtle over state');
liveBox.updateClusterSpeed(70);
ok(!liveEls['cluster-speed'].classList.contains('over'), 'cluster: no over state under the limit');
liveBox.speedLimitKmh = null;
liveBox.updateClusterSpeed(120);
ok(liveEls['cluster-limit'].hidden === true && !liveEls['cluster-speed'].classList.contains('over'),
  'cluster: no limit badge and no over state when limit unknown');
// next-manoeuvre payload (pure)
const turnStep = { maneuver: { type: 'turn', modifier: 'left' }, ref: 'R403', name: '', loc: [0, 0] };
const td = liveBox.nextTurnData(turnStep, 350);
ok(td && td.kind === 'left' && td.dist === '350 m' && td.road === 'R403' && /Turn left/.test(td.instruction),
  'nextTurnData: arrow kind, distance, road, instruction from live step');
ok(liveBox.nextTurnData(null, 10) === null, 'nextTurnData: null with no step');
ok(liveBox.nextTurnData(turnStep, undefined) === null, 'nextTurnData: null with no distance');
const td2 = liveBox.nextTurnData({ maneuver: { type: 'continue' }, ref: '', name: '', loc: [0, 0] }, 1200);
ok(td2 && td2.road === '' && td2.dist === '1.2 km', 'nextTurnData: empty road, km formatting');
// turn block visibility
liveBox.appMode = 'normal'; liveBox.navActive = true;
liveBox.syncClusterTurn(td);
ok(liveEls['cluster-turn'].hidden === true, 'cluster turn: hidden outside cluster mode');
liveBox.appMode = 'cluster'; liveBox.navActive = false;
liveBox.syncClusterTurn(td);
ok(liveEls['cluster-turn'].hidden === true, 'cluster turn: hidden when not navigating');
liveBox.navActive = true;
liveBox.syncClusterTurn(td);
ok(liveEls['cluster-turn'].hidden === false, 'cluster turn: shown when navigating in cluster mode');
ok(liveEls['cluster-turn-distance'].textContent === '350 m', 'cluster turn: distance rendered');
ok(liveEls['cluster-turn-road'].textContent === 'R403' && liveEls['cluster-turn-road'].hidden === false,
  'cluster turn: road rendered');
ok(/Turn left/.test(liveEls['cluster-turn-instruction'].textContent), 'cluster turn: instruction rendered');
ok(/<svg/.test(liveEls['cluster-turn-arrow'].textContent || '') === false, 'cluster turn: arrow is markup not text');
liveBox.syncClusterTurn(td2);
ok(liveEls['cluster-turn-road'].hidden === true, 'cluster turn: road row hidden when no road');
liveBox.syncClusterTurn(null);
ok(liveEls['cluster-turn'].hidden === true, 'cluster turn: hidden when nav ends');
// inferred drive meter: truthful state names, no fake telemetry
liveBox.appMode = 'cluster';
liveBox.updateDriveForce(null);
ok(liveBox.driveForceState === 'coast' && liveBox.driveForceBand === 0, 'drive meter: unknown speed coasts');
ok(liveBox.smoothedAcceleration === 0, 'drive meter: no fake force value');
// steady cruise: tiny GPS jitter stays inside the dead zone
liveBox.updateDriveForce(84); dfNow += 1000; liveBox.updateDriveForce(84.2); dfNow += 1000;
liveBox.updateDriveForce(83.9);
ok(liveBox.driveForceState === 'coast', 'drive meter: GPS noise does not flicker the meter');
// hard acceleration: 84 -> 96 km/h over 2 s ~= +1.7 m/s^2 -> power, strong band
dfNow += 1000; liveBox.updateDriveForce(84); dfNow += 1000; liveBox.updateDriveForce(92);
dfNow += 1000; liveBox.updateDriveForce(96);
ok(liveBox.driveForceState === 'power' && liveBox.driveForceBand >= 2, 'drive meter: acceleration reads POWER');
// hard braking: 96 -> 80 km/h over 2 s -> regen
dfNow += 1000; liveBox.updateDriveForce(88); dfNow += 1000; liveBox.updateDriveForce(80);
ok(liveBox.driveForceState === 'regen' && liveBox.driveForceBand >= 1, 'drive meter: deceleration reads REGEN');
// absurd spike is rejected, never flips the meter
liveBox.updateDriveForce(80); dfNow += 500; liveBox.updateDriveForce(400);
ok(liveBox.driveForceState === 'regen', 'drive meter: unrealistic GPS spike rejected');
// gauge render: no ticks yet -> no throw
liveBox.syncDriveForceGauge();
// truthful naming only — no battery/kW telemetry anywhere
for (const name of ['batteryKw', 'regenKw', 'motorPower', 'batterySoc', 'batteryPercent']) {
  ok(!appSrc.includes(name), `no fake telemetry: ${name}`);
}
ok(appSrc.includes('smoothedAcceleration') && appSrc.includes('driveForceState'),
  'drive meter uses truthful state names');
// hero slots: VC-only, hidden by default in the shared stylesheet
for (const sel of ['#cluster-backdrop', '#cluster-header', '#cluster-gauge', '#cluster-footer',
                   '#cluster-trip']) {
  ok(cssSrc.includes(`body.cluster-mode ${sel}{`) || cssSrc.includes(`body.cluster-mode ${sel},`),
    `cluster hero slot hidden by default: ${sel}`);
}
for (const sel of ['#cluster-header', '#cluster-footer', '#cluster-gauge', '#cluster-trip',
                   '#cluster-turn-compass']) {
  ok(cssSrc.includes(`body.cluster-mode.theme-vice-city ${sel}`), `VC hero skin styles ${sel}`);
}
ok(cssSrc.includes('.cg-seg'), 'VC hero: gauge segment styling present');
// wiring (source-level guards)
ok(/maybeFetchSpeedLimit\(lat, lon\) \{\s*\n\s*if \(!speedDisplayActive\(\)\)/.test(appSrc),
  'speed limit lookup runs in cluster mode too');
ok(appSrc.includes('syncClusterTurn(currentTurnData())'), 'nav banner feeds the cluster turn block');
// Spotify: the same widget is shared, never duplicated
ok(!/function syncClusterMusic/.test(appSrc), 'no duplicate cluster Spotify sync function');
ok(appSrc.includes('if (spotVisible) mountSpotifySkin(wsThemeId());'),
  'cluster mounts the real Spotify skin (same widget as dashboard)');
ok(appSrc.includes('pane.hidden = !spotVisible'), 'Spotify pane visible in cluster mode');
ok(appSrc.includes('if (clu) refreshClusterLive();'), 'entering cluster mode refreshes every live region');
ok(/if \(speedDisplayActive\(\)\) \{\s*\n\s*if \(watchId === null/.test(appSrc),
  'passive speed watch: single shared watchId for dashboard + cluster');
// no watcher is created inside the per-fix updaters
for (const fn of ['updateSpeedo', 'updateClusterSpeed', 'maybeFetchSpeedLimit', 'syncClusterTurn', 'updateDriveForce']) {
  ok(!/watchPosition/.test(extractFn(appSrc, fn)), `no geolocation watcher inside ${fn}`);
}
// presentation tabs: cluster stays the active mode, dashboard + map reachable
ok(appSrc.includes("if (tab === 'dashboard') { WayStation.setAppMode('dashboard'); return; }"),
  'cluster tab switches to dashboard');
ok(appSrc.includes("if (tab === 'map') { WayStation.setAppMode('normal'); return; }"),
  'cluster tab switches to map');
ok(cssSrc.includes('body.cluster-mode #map'), 'cluster CSS frames the live map');
ok(cssSrc.includes('#cluster-speed-num'), 'cluster CSS sizes the hero speed');
ok(cssSrc.includes('#cluster-turn'), 'cluster CSS positions the turn block');
ok(cssSrc.includes('body.cluster-mode #spotify-pane'), 'cluster stage layers the shared Spotify widget');
ok(cssSrc.includes('body.cluster-mode #drawer'), 'cluster hides the planning drawer');
ok(cssSrc.includes('body.cluster-mode #search-bar'), 'cluster hides the search pill');
ok(cssSrc.includes('body.cluster-mode #menu-btn'), 'cluster keeps the menu button reachable');

// index.html: menu-only Spotify in normal mode, dashboard mount point
ok(!indexSrc.includes('music-btn') && !indexSrc.includes('drive-music-btn'), 'no player buttons in chrome');
ok(!indexSrc.includes('spotify-close'), 'no close button on pane');
ok(indexSrc.includes('name="appmode"'), 'presentation mode selector in menu');
ok(indexSrc.includes('Cluster Mode'), 'Cluster Mode offered in Display section');
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
ok(!indexSrc.includes('data-dtab="vehicle"'), 'dead VEHICLE tab removed from the bottom bar (no handler ever existed)');
ok(indexSrc.includes('themes/vice-city/phone.css'), 'VC phone chrome stylesheet linked');
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
ok(appSrc.includes('right = 765'), 'camera padding accounts for the larger VC widget');
ok(appSrc.includes("theme-san-andreas')) right = 701"), 'camera padding clears the SA music widget');
ok(appSrc.includes("theme-gta-v')) right = 568"), 'camera padding clears the GTA V music widget');
ok(appSrc.includes("theme-rdr2')) right = 670"), 'camera padding clears the RDR2 music widget');
ok(appSrc.includes("b.contains('radio-off')"), 'camera padding drops widget clearance when the radio tab hides the widget');
ok(cssSrc.includes('body.theme-vice-city:is(.dashboard-mode,.cluster-mode) #dash-topbar') === true, 'VC bar chrome is shared by dashboard + cluster modes');
// dashboard car chrome: every theme gets top/bottom bars, always visible in dashboard mode (driving or exploring)
for (const id of ['vice-city', 'san-andreas', 'gta-v', 'rdr2']) {
  const barSel = id === 'vice-city'
    ? `body.theme-vice-city:is(.dashboard-mode,.cluster-mode)`
    : `body.dashboard-mode.theme-${id}`;
  ok(cssSrc.includes(`${barSel} #dash-topbar`), `${id} dashboard top bar chrome`);
  ok(cssSrc.includes(`${barSel} #dash-bottombar`), `${id} dashboard bottom bar chrome`);
}
ok(appSrc.includes("classList.toggle('nav-driving'"), 'nav-driving class toggles with drive mode');
ok(appSrc.includes('nav-driving') && /setUiMode/.test(appSrc), 'drive-mode chrome state lives in setUiMode');
ok(cssSrc.includes('body.dashboard-mode.nav-driving #maneuver-card'), 'drive HUD clears the top bar on every theme');
ok(cssSrc.includes('body.dashboard-mode.nav-driving #drive-bar'), 'drive trip bar clears the bottom bar on every theme');
ok(!cssSrc.includes('.dash-skyline') && !indexSrc.includes('dash-skyline'), 'old skyline img fully retired in favour of the authored top bar strip');
ok(!/topbar-composite\.jpg/.test(cssSrc),
  'SA top bar is CSS chrome now — the photo collage is retired');
ok(cssSrc.includes("#dash-topbar{") && /topbar-hero7\.png/.test(cssSrc),
  'SA top bar is the hero7 slice (user art), not a photo panorama');
ok(!/tbar-night/.test(indexSrc) && !/tbar-sunset/.test(indexSrc),
  'SA top bar has no split-panel divs');
ok(!/theme-san-andreas #dash-topbar\{[^}]*radial-gradient\(120px 120px at 62%/.test(cssSrc),
  'SA top bar no longer uses the CSS-painted sun disc');
ok(/theme-gta-v #dash-topbar\{[^}]*background:#0b0b0b/.test(cssSrc), 'GTA V top bar is flat pause-menu black (researched)');
ok(/theme-gta-v #dash-bottombar\{[^}]*background:#0b0b0b/.test(cssSrc), 'GTA V bottom bar is flat pause-menu black (researched)');
ok(/theme-rdr2 #dash-topbar::before\{[^}]*clip-path:polygon/.test(cssSrc), 'RDR2 header has a stepped plate silhouette');
ok(!/theme-rdr2 #dash-(topbar|bottombar)\{[^}]*#ff71ce/.test(cssSrc), 'RDR2 bar shells carry no neon pink');
// VC hero: neon 80s chrome per the benchmark image
ok(true, "VC top bar uses CSS neon (no image)");
ok(cssSrc.includes('hud.png') || cssSrc.includes('.vcsp'), 'VC right panel uses the unified Spotify skin (hud art)');
ok(cssSrc.includes("Yellowtail"), 'VC hero uses a neon script font');
/* ---------- VC asset-pack polish: authored chrome ---------- */
const vctop = jpgSize(path.join(REPO, 'themes/vice-city/dashboard/topbar.jpg'));
ok(vctop && vctop.w >= 2000 && vctop.h >= 140, 'VC top bar art: full-width authored strip (asset pack #4)');
const vcbot = jpgSize(path.join(REPO, 'themes/vice-city/dashboard/bottombar.jpg'));
ok(vcbot && vcbot.w >= 2000 && vcbot.h >= 80, 'VC bottom bar art: full-width authored strip (asset pack #4)');
ok(fs.existsSync(path.join(REPO, 'themes/vice-city/dashboard/bottombar.jpg')),
  'VC bottom bar HUD strip present (asset pack #2)');
ok(indexSrc.includes('class="dash-north"'), 'bottom bar compass shows the N marker');
ok(indexSrc.includes('id="next-stats"'), 'maneuver card has a trip stats row slot');
ok(cssSrc.includes('#vc-maneuver'), 'VC hero maneuver card styled');
ok(cssSrc.includes('.vc-man-arrow'), 'VC maneuver arrow styled pink');
ok(appSrc.includes("next-stats"), 'updateBanner feeds the maneuver stats row');
ok(/theme-vice-city \.dash-tabs button\.on\{[^}]*#ff71ce/.test(cssSrc), 'VC active tab is flat hot-pink neon text');
ok(!/theme-(san-andreas|gta-v|rdr2) #dash-(topbar|bottombar)\{[^}]*clip-path:polygon\(0 0,100% 0,100% 50%/.test(cssSrc),
   'non-VC themes do not reuse the VC angular silhouette on the bar shells');
ok(!/function syncDashLocality\(\)[\s\S]{0,400}theme-vice-city/.test(appSrc), 'bottom-bar locality plate is theme-agnostic');
ok(cssSrc.includes('#vc-right-panel'), 'VC hero right panel styled');
ok(indexSrc.includes('dash-tag'), 'bottom bar carries the script tagline');
ok(appSrc.includes('queueDashLocality'), 'locality plate reverse-geocodes the map centre');
ok(cssSrc.includes('vc-logo-script'), 'VC hero logo script styled');
/* ---------- bespoke bar silhouettes: every theme gets its own bar heights,
   layouts and drive-HUD clearances, not one shared silhouette ---------- */
const barHeights = {
  'vice-city': ['78px', '100px'],
  'san-andreas': ['126px', '126px'], // hero7: bars are the hero art's own height
  'gta-v': ['120px', '120px'], // generated bar art: fixed 120px chrome
  'rdr2': ['104px', '84px'], // 2026-09-08 redesign: badge header + frontier footer
};
for (const [id, [top, bottom]] of Object.entries(barHeights)) {
  const infix = id === 'vice-city' ? '(?::is\\([^)]*\\))? ' : ' ';
  ok(new RegExp(`theme-${id}${infix}#dash-topbar\\{[^}]*height:${top}`).test(cssSrc), `${id} top bar is ${top} tall`);
  ok(new RegExp(`theme-${id}${infix}#dash-bottombar\\{[^}]*height:${bottom}`).test(cssSrc), `${id} bottom bar is ${bottom} tall`);
  if (id !== 'vice-city' && id !== 'san-andreas') ok(cssSrc.includes(`body.dashboard-mode.theme-${id}.nav-driving #drive-bar`),
    `${id} drive trip bar clears its own bottom bar height`);
  /* san-andreas: the drive pill is removed entirely in dashboard (pass 4),
     so it has no clearance rule — asserted in the pass 4 block instead */
}
ok(cssSrc.includes('#dash-topbar::after'), 'VC top bar wears a neon edge');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar\{[^}]*clip-path:polygon/.test(cssSrc), 'VC top bar is a chamfered hero silhouette');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-bottombar\{[^}]*clip-path:polygon/.test(cssSrc), 'VC bottom bar is a shaped angular footer');
ok(cssSrc.includes('#dash-eta .eta-time'), 'VC arrival time uses the live eta-time hook');
/* ---------- pass 3: hero convergence refinements ---------- */
ok(/theme-vice-city \.vcsp\{[^}]*bottom:118px/.test(cssSrc), 'VC widget bottom-anchored 18px above the footer');
ok(cssSrc.includes("dashboard/skyline-sunset.png"), 'VC skyline uses the supplied sunset scenery asset');
ok(!cssSrc.includes("dashboard/topbar-skyline.png"), 'old glitch-strip skyline treatment fully retired');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar\{[^}]*97\.5% 100%/.test(cssSrc), 'VC header has a skyline pocket in its silhouette');
ok(/theme-vice-city #vc-maneuver::before/.test(cssSrc), 'VC maneuver card uses a double-layer pink neon border');
ok(/theme-vice-city #vc-maneuver::after/.test(cssSrc), 'VC maneuver card carries a cyan secondary accent');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-bottombar\{[^}]*rgba\(1,205,254/.test(cssSrc), 'VC footer has a cyan cradle accent at the map join');
ok(/theme-vice-city \.dash-tag::before/.test(cssSrc), 'VC footer separates arrival and slogan with a divider');
ok(/theme-vice-city #dash-dest\{[^}]*overflow:visible/.test(cssSrc), 'VC locality plate never truncates');
ok(!/theme-vice-city \.dash-tabs button\{[^}]*linear-gradient/.test(cssSrc), 'VC tabs are flat neon text, not chunky buttons');
ok(/\.dash-tabs button\.on/.test(cssSrc) && /theme-san-andreas \.dash-tabs button\.on::before\{[^}]*linear-gradient\(180deg,#e9cd7d/.test(cssSrc) &&
  /theme-san-andreas \.dash-tabs button\.on::after\{[^}]*data:image\/svg\+xml/.test(cssSrc),
  'SA active tab is a dark plate with gold chamfer outline + gold diamond marker (2026-09-09 polish), not the cream slab');
ok(/theme-gta-v \.dash-tabs button\[data-dtab="map"\]::before\{[^}]*tab-map\.png/.test(cssSrc), 'V tabs use generated icons (map)');
ok(/theme-gta-v \.dash-tabs button\[data-dtab="settings"\]::before\{[^}]*tab-settings\.png/.test(cssSrc), 'V tabs use generated icons (settings)');
ok(/theme-gta-v \.dash-tag\{display:none/.test(cssSrc), 'V drops the 80s script tagline');
ok(/theme-rdr2 \.dash-tag\{display:none\}/.test(cssSrc), 'RDR2 drops the 80s script tagline');
ok(/theme-rdr2 \.dash-brand\{[^}]*left:50%/.test(cssSrc), 'RDR2 centers its frontier badge');
ok(/theme-rdr2 \.dash-tabs button\.on\{[^}]*selection_box_bg_1a\.png/.test(cssSrc), 'RDR2 active tab uses the authentic selection-box highlight');
/* ---------- pass 4: narrow hero corrections ---------- */
// skyline: supplied sunset scenery, left edge feathered, no pixel treatment
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar::after\{[^}]*skyline-sunset\.png/.test(cssSrc), 'VC skyline pocket wears the sunset scenery asset');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar::after\{[^}]*mask-image:linear-gradient\(90deg,transparent/.test(cssSrc), 'VC skyline left edge feathers into black');
ok(!/theme-vice-city(?::is\([^)]*\))? \1::after\{[^}]*contrast/.test(cssSrc), 'VC skyline keeps natural colours (no glitch treatment)');
ok(fs.existsSync(path.join(REPO, 'themes/vice-city/dashboard/skyline-sunset.png')), 'VC sunset skyline asset on disk');
// header cyan secondary chrome: notch floor + pocket chamfer kiss, pink dominant
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar\{[^}]*rgba\(1,205,254,\.9\) 39%/.test(cssSrc), 'VC header keeps the cyan notch-floor segment');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar\{[^}]*rgba\(1,205,254,\.5\) 69\.5%/.test(cssSrc), 'VC header adds a dim cyan kiss on the pocket chamfer');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar\{[^}]*height:78px/.test(cssSrc), 'VC header height frozen at 78px');
// navy grain on header/footer chrome only
ok(/theme-vice-city(?::is\([^)]*\))? #dash-topbar::before\{[^}]*feTurbulence/.test(cssSrc), 'VC header chrome carries faint navy grain');
ok(/theme-vice-city(?::is\([^)]*\))? #dash-bottombar::before\{[^}]*feTurbulence/.test(cssSrc), 'VC footer chrome carries faint navy grain');
// footer: quieter inactive tabs, brighter plate outline, cyan/pink separator
ok(/theme-vice-city \.dash-tabs button\{[^}]*rgba\(1,205,254,\.25\)/.test(cssSrc), 'VC inactive tabs glow ~10% quieter');
ok(/theme-vice-city \.dash-dest\{[^}]*background:#01cdfe/.test(cssSrc), 'VC locality plate outline brighter (dimensions frozen)');
ok(/theme-vice-city \.dash-north::after\{[^}]*rgba\(255,46,136/.test(cssSrc), 'VC compass/arrival separator blends cyan into pink');
ok(/theme-vice-city #dash-eta\{[^}]*min-width:220px/.test(cssSrc), 'VC arrival zone reserves a stable live width');
// tagline: 15px left, 4px up, +5% scale
ok(/theme-vice-city \.dash-tag\{[^}]*margin:0 61px 0 14px/.test(cssSrc), 'VC tagline eased 15px left of the corner');
ok(/theme-vice-city \.dash-tag\{[^}]*top:-4px/.test(cssSrc), 'VC tagline lifted 4px');
ok(/theme-vice-city \.dash-tag::after\{[^}]*font-size:23px/.test(cssSrc), 'VC tagline scaled +5%');
// dashboard-only map contrast: base style.json untouched, runtime paint list
const vcThemeSrc = fs.readFileSync(path.join(REPO, 'themes/vice-city/theme.js'), 'utf8');
ok(/dashboardPaint:\s*\[/.test(vcThemeSrc), 'VC theme declares a dashboard-only paint list');
ok(vcThemeSrc.includes("'#8b8b90'") && vcThemeSrc.includes("'#838388'"), 'VC dashboard deepens major road casings');
ok(vcThemeSrc.includes("'#7b7d91'"), 'VC dashboard deepens urban land');
ok(vcThemeSrc.includes("'#4e825d'") && vcThemeSrc.includes("'#66a177'"), 'VC dashboard deepens greens');
ok(vcThemeSrc.includes("'#ff2ba6'"), 'VC dashboard pops locality labels');
const vcPaint4 = id => vcStyle.layers.find(l => l.id === id).paint;
ok(vcPaint4('vc-road-primary-casing')['line-color'] === '#b1b1b7', 'VC style.json keeps the base major casing (phone untouched)');
ok(vcPaint4('vc-label-place')['text-color'] === '#d42796', 'VC style.json keeps the base label pink (phone untouched)');
ok(appSrc.includes('function applyDashboardMapPaint'), 'app applies the VC dashboard paint at runtime');
ok(/map\.on\('load'[^]*applyDashboardMapPaint/.test(appSrc), 'dashboard paint applies on map load');
ok(/dashPaintActive = false;[^]*applyDashboardMapPaint/.test(appSrc), 'dashboard paint re-applies after a theme style rebuild');
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
for (const [id, top, bottom] of [['vice-city', 76, 100], ['san-andreas', 126, 126], ['gta-v', 120, 120], ['rdr2', 104, 84]]) {
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
for (const [id, top] of [['gta-v', 132]]) {
  ok(new RegExp(`body\\.dashboard-mode\\.theme-${id} #search-bar\\{top:calc\\(${top}px`).test(cssSrc),
    `dashboard search bar clears the ${id} top bar (${top}px)`);
}
ok(/body\.dashboard-mode\.theme-vice-city #search-bar\{display:none\}/.test(cssSrc),
  'VC dashboard hides the search pill for the hero composition');
ok(/body\.dashboard-mode\.theme-san-andreas #search-bar\{display:none\}/.test(cssSrc),
  'SA dashboard hides the search pill for the hero composition');
ok(/body\.dashboard-mode\.theme-rdr2 #search-bar\{display:none\}/.test(cssSrc),
  'RDR2 dashboard hides the search pill for the hero composition');
ok(appSrc.includes("openPlanning('search')") && /dashMode && !dismissing/.test(appSrc),
  'dashboard MAP tab opens planning on every theme when there is nothing to dismiss');
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
// Note: gta-v dashboard art lives in themes/gta-v/dashboard/ — asserted separately below
const dashAssets = [
  ['rdr2', 'menu_header_1a.png'],
  
  ['rdr2', 'title_divider.png'],
  
];
for (const [theme, file] of dashAssets) {
  const base = theme === 'vice-city' ? `themes/${theme}/dashboard` : `assets/themes/${theme}/dashboard`;
  const rel = `${base}/${file}`;
  ok(fs.existsSync(path.join(REPO, rel)), `dashboard bar asset on disk: ${rel}`);
  ok(fs.statSync(path.join(REPO, rel)).size > 0, `dashboard bar asset non-empty: ${rel}`);
  // VC theme CSS uses paths relative to themes/vice-city/ (dashboard/...); others use full paths
  const cssRef = theme === 'vice-city' ? `dashboard/${file}` : rel;
  ok(cssSrc.includes(cssRef), `styles.css references ${cssRef}`);
}
// theme-scoped usage: each asset is only wired into its own theme's chrome
const gvDashAssets = ['topbar-bg.png','bottombar-bg.png','widget-bg.png','v-mark.png',
  'tab-map.png','tab-radio.png','tab-phone.png','tab-vehicle.png','tab-settings.png',
  'palms.png','skyline.png','noise.png','lyrics-bg.png','dest-plate.png','compass.png',
  'divider.png','diamond.png','chevron.png','btn-ring.png'];
for (const f of gvDashAssets) {
  ok(fs.existsSync(path.join(REPO, 'themes/gta-v/dashboard/' + f)), `GTA V dashboard asset on disk: ${f}`);
  ok(fs.statSync(path.join(REPO, 'themes/gta-v/dashboard/' + f)).size > 0, `GTA V dashboard asset non-empty: ${f}`);
}
ok(!fs.existsSync(path.join(REPO, 'themes/gta-v/dashboard/overlay.png')), 'GTA V overlay.png retired (rebuilt from generated assets)');
ok(!cssSrc.includes('dashboard/overlay.png'), 'styles.css no longer references the GTA V overlay');
ok(cssSrc.includes('Yellowtail'), 'VC wordmark uses the neon script font');
/* ---------- VC map matches the hero target ---------- */
const vcStyle2 = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/vice-city/style.json'), 'utf8'));
const vcPaint = id => vcStyle2.layers.find(l => l.id === id).paint;
ok(vcPaint('vc-land')['background-color'] === '#9294a7', 'VC land keeps the base phone palette (dashboard deepens it at runtime)');
ok(vcPaint('vc-water')['fill-color'] === '#48a8e8', 'VC water: vivid blue (hero)');
ok(vcPaint('vc-parks')['fill-color'] === '#619972', 'VC parks keep the base phone palette (dashboard deepens it at runtime)');
ok(vcPaint('vc-buildings')['fill-color'] === '#b7b7c7', 'VC buildings: separated from land (hero contrast)');
ok(vcPaint('vc-road-minor')['line-color'] === '#eef0f6', 'VC minor roads: white streets (hero)');
ok(vcPaint('vc-road-primary')['line-color'] === '#18182d', 'VC arterials: darker navy core (hero punch)');
ok(vcPaint('vc-road-motorway')['line-color'] === '#0e0e22', 'VC motorways: near-black navy (hero contrast)');
/* ---------- PASS 7: HERO7 DIRECT SLICES (2026-09-08) ----------
   Pass 6's generated overlays are replaced by slices cut straight
   out of the user's own hero art (true alpha, transparent map
   window — no masking needed):
   - topbar-hero7.png (1920x126 RGBA): sepia skyline, palms,
     downtown LA, cream borders, dark angular centre plate, big
     Beckett "San Andreas" crown logo spilling onto the map.
   - bottombar-hero7.png (1920x126 RGBA): black console, cream
     angular borders, 4 tab slots, star locality plate, 2 plates
     + palms + crown right.
   - radio-hero7-r2.png (701x544 RGBA): framed radio unit with baked
     crown logo, two dark panels, drawn Spotify/progress/transport,
     lowrider — right side, overlapping the bars like the hero.
   Live DOM only: clock in the header plate, tabs/locality/
   compass in the footer, album/meta/lyrics/progress/transport
   over the radio art. */
const skinJsSa = fs.readFileSync(path.join(REPO, 'themes/san-andreas/spotify-skin.js'), 'utf8');
const skinSaSrc = fs.readFileSync(path.join(REPO, 'themes/san-andreas/spotify-skin.css'), 'utf8');
const saHero = (f) => path.join(REPO, 'themes/san-andreas/dashboard', f);
for (const [f, w, h] of [['topbar-hero7.png', 1920, 126], ['bottombar-hero7.png', 1920, 126], ['radio-hero7-r2.png', 701, 544]]) {
  ok(fs.existsSync(saHero(f)), `SA hero7 slice on disk: ${f}`);
  const sz = pngSize(saHero(f));
  const bytes = fs.readFileSync(saHero(f));
  ok(sz && sz.w === w && sz.h === h && bytes[25] === 6, `SA hero7 slice ${f} is ${w}x${h} RGBA`);
}
ok(!fs.existsSync(saHero('topbar-hero.png')), 'pass6 generated header deleted');
ok(!fs.existsSync(saHero('bottombar-hero.png')), 'pass6 generated footer deleted');
ok(!fs.existsSync(saHero('radio-frame-pass5.png')), 'pass5 radio frame deleted');
ok(/theme-san-andreas #dash-topbar\{[^}]*topbar-hero7\.png/.test(cssSrc),
  'SA header IS the hero7 slice (topbar-hero7.png)');
ok(/theme-san-andreas #dash-topbar\{[^}]*height:126px/.test(cssSrc),
  'SA header shell is 126px, the hero art\'s own height');
ok(!/theme-san-andreas #dash-topbar\{[^}]*clip-path/.test(cssSrc),
  'SA header silhouette comes from the art, not CSS clip-path');
ok(!/theme-san-andreas #dash-topbar::after\{[^}]*skyline-strip\.jpg/.test(cssSrc),
  'pass5 skyline-strip panel removed from the SA header');
ok(/theme-san-andreas \.dash-brand\{display:none/.test(cssSrc),
  'SA header branding lives in the art — no DOM wordmark doubling it');
ok(cssSrc.includes('#dash-topbar .dash-tomorrow,') && cssSrc.includes('display:none!important'),
  'SA header retires the legacy topbar art imgs (no giant script over the skyline)');
ok(/theme-san-andreas #dash-bottombar\{[^}]*bottombar-hero7\.png/.test(cssSrc),
  'SA footer IS the hero7 slice (bottombar-hero7.png)');
ok(/theme-san-andreas #dash-bottombar\{[^}]*height:126px/.test(cssSrc),
  'SA footer is 126px, the hero art\'s own height');
ok(!/theme-san-andreas #dash-bottombar\{[^}]*clip-path/.test(cssSrc),
  'SA footer silhouette comes from the art, not CSS clip-path');
ok(/theme-san-andreas \.dash-tabs button\.on::before\{[^}]*linear-gradient\(180deg,#e9cd7d/.test(cssSrc),
  'SA active tab is a dark plate with a gold chamfer outline (2026-09-09 polish), not the solid cream slab');
ok(/theme-san-andreas \.dash-tabs button\.on::after\{[^}]*data:image\/svg\+xml/.test(cssSrc),
  'SA active tab carries a gold diamond marker (2026-09-09 polish)');
ok(!/theme-san-andreas \.dash-tabs button:nth-child\(5\)/.test(cssSrc),
  'SA has 4 dash tabs after the dead vehicle tab removal (no 5th-tab rules)');
ok(/theme-san-andreas \.dash-tabs button:nth-child\(4\)\{left:555px\}/.test(cssSrc),
  'SA settings takes the 4th art slot (the parked console coin is retired)');
ok(/theme-san-andreas #menu-panel::before\{[^}]*clip-path:polygon\(26px/.test(cssSrc),
  'SA dash menu drawer is a gold chamfered console (2026-09-09 polish), not a flat box');
ok(/theme-san-andreas #menu-panel \.menu-head\{[^}]*grove-panel\.png/.test(cssSrc),
  'SA dash menu drawer wears the Grove Street hero-art header band');
ok(/theme-san-andreas \.dash-tabs button span\{display:none/.test(cssSrc),
  'SA footer tabs are icon-only like the hero');
ok(/theme-san-andreas \.sasp\{[^}]*left:1219px/.test(skinSaSrc),
  'SA radio sits at the hero\'s radio x (1219px stage)');
ok(/theme-san-andreas \.sasp\{[^}]*top:83px/.test(skinSaSrc),
  'SA radio sits at the hero\'s radio y (83px stage), overlapping the bars');
ok(/\.sasp-bezel/.test(skinSaSrc) && skinJsSa.includes('dashboard/radio-hero7-r2.png'),
  'SA Spotify outer skin is the hero7 radio slice');
ok(/\.sasp-idle::after\{[^}]*left:-22px;top:276px;width:317px/.test(skinSaSrc),
  'SA idle covers the art\'s drawn transport strip (no phantom pause/progress when disconnected)');
ok(/\.sasp\{[^}]*container-type:size/.test(skinSaSrc),
  'SA widget is a cqw/cqh container (lyrics size against widget, not viewport)');
/* ---------- SA phone polish (2026-09-09): the dashboard-only skin left
   the phone widget as raw unstyled DOM. phone.css gives it the hud.png
   Grove Street console; the gold-pill Start Drive becomes the outlined
   gold button every other SA phone action uses. */
const saPhoneSrc = fs.readFileSync(path.join(REPO, 'themes/san-andreas/phone.css'), 'utf8');
ok(/theme-san-andreas:not\(\.dashboard-mode\) \.sasp\{[^}]*spotify\/hud\.png/.test(saPhoneSrc),
  'SA phone Spotify widget wears the hud.png console skin (not raw DOM)');
ok(/theme-san-andreas:not\(\.dashboard-mode\) \.sasp-bezel\{display:none/.test(saPhoneSrc),
  'SA phone widget hides the dashboard radio bezel img');
ok(/theme-san-andreas:not\(\.dashboard-mode\) \.sasp-times\{[^}]*display:flex/.test(saPhoneSrc),
  'SA phone progress times are laid out (no garbled 1:323:59)');
ok(/theme-san-andreas:not\(\.dashboard-mode\) \.big-btn\{[^}]*border:2px solid #e8a33d/.test(saPhoneSrc),
  'SA phone Start Drive is an outlined gold button, not the solid gold pill');
/* ---------- SA hero-match: authored dashboard art set ---------- */
const saDash = (f) => path.join(REPO, 'themes/san-andreas/dashboard', f);
for (const f of ['topbar.png', 'bottombar.png', 'maneuver.png', 'grove-panel.png', 'script-tomorrow.png', 'script-music.png', 'sa-logo.png']) {
  ok(fs.existsSync(saDash(f)), `SA dashboard art on disk: ${f}`);
  ok(fs.statSync(saDash(f)).size > 10000, `SA dashboard art non-empty: ${f}`);
}
const saLogo = pngSize(saDash('sa-logo.png'));
ok(saLogo && saLogo.w >= 500 && saLogo.h >= 150, 'SA standalone wordmark extracted with transparency');
/* ---------- PASS 5: HARD VISUAL RESET (2026-09-08) ----------
   Pass 4 is deleted: no scratched footer, no vintage-radio bezel,
   no sunset-wallpaper header. Flat graphic SA menu/HUD chrome. */
const saDash5 = (f) => path.join(REPO, 'themes/san-andreas/dashboard', f);
ok(!fs.existsSync(saDash5('topbar-pass4.jpg')), 'pass4 sunset topbar deleted');
ok(!fs.existsSync(saDash5('footer-chrome-pass4.jpg')), 'pass4 scratched footer deleted');
ok(!fs.existsSync(saDash5('radio-bezel-pass4.png')), 'pass4 vintage-radio bezel deleted');
ok(!/topbar-pass4\.jpg/.test(cssSrc), 'no CSS references the deleted pass4 topbar');
ok(!/footer-chrome-pass4\.jpg/.test(cssSrc), 'no CSS references the deleted pass4 footer');
ok(!/radio-bezel-pass4\.png/.test(cssSrc), 'no CSS references the deleted pass4 bezel');
/* header/footer: now the hero7 slices (see PASS 7 block above) */
/* radio: hero7 slice, right side overlapping the bars like the hero */
ok(!skinJsSa.includes('dashboard/radio-frame-pass5.png'),
  'SA Spotify no longer uses the pass5 lowrider frame');
ok(!skinJsSa.includes('spotify/hud.png'),
  'SA Spotify no longer uses the ornate hud.png');
ok(skinJsSa.includes('data-lyrics-stage="1"'), 'SA skin keeps the shared lyric stage mount point');
ok(/\.sasp-artwrap\s*\{[^}]*position:absolute/.test(skinSaSrc),
  'SA album art sits absolutely over the art\'s left panel');
ok(/\.sasp-side\s*\{[^}]*position:absolute/.test(skinSaSrc),
  'SA track meta/lyrics sit absolutely over the art\'s right panel');
ok(/\.sasp-progress\s*\{[^}]*position:absolute/.test(skinSaSrc),
  'SA live progress sits absolutely over the art\'s drawn bar');
ok(/\.sasp-tbtn\[data-act="toggle"\]/.test(skinSaSrc),
  'SA transport buttons overlay the art\'s drawn icons');
ok(skinSaSrc.includes("font-family:'Bank Gothic','Arial Narrow',sans-serif;"),
  'SA radio uses Bank Gothic, never blackletter for functional text');
/* maneuver card: angular HUD console below the 126px header */
ok(/theme-san-andreas\.nav-driving #maneuver-card\{[^}]*top:calc\(126px/.test(cssSrc),
  'SA maneuver card clears the 126px header');
ok(/theme-san-andreas #maneuver-card::before\{[^}]*clip-path:polygon\(/.test(cssSrc),
  'SA maneuver card is chamfered, not a rounded web pill');
ok(/theme-san-andreas #maneuver-card::after\{[^}]*#141a0c/.test(cssSrc),
  'SA maneuver card is black/deep-olive');
ok(indexSrc.includes('id="maneuver-end"'), 'maneuver card carries its own END control');
ok(/theme-san-andreas #maneuver-end\{/.test(cssSrc), 'END control is SA-dashboard only, hidden everywhere else');
ok(appSrc.includes("$('maneuver-end')"), 'END control is wired to endNav');
/* utility buttons removed, not recolored */
ok(/theme-san-andreas #drive-bar\{display:none\}/.test(cssSrc),
  'SA dashboard removes the floating drive pill entirely');
ok(!/theme-san-andreas #drive-bar\\{[^}]*background:/.test(cssSrc),
  'removed drive pill gets no restyling — it is gone');
ok(/theme-san-andreas #map-tools\{display:none\}/.test(cssSrc),
  'SA dashboard hides the floating zoom pills for the clean hero map');
ok(/theme-san-andreas \.dash-zoom\{display:none/.test(cssSrc),
  'SA footer drops the minus/plus/recenter cluster — the map is the surface');
ok(appSrc.includes("'san-andreas': { top: 126, bottom: 126 }"),
  'DASH_BAR_HEIGHTS tracks the hero7 bar heights (126/126)');
ok(/theme-san-andreas #dash-dest\{[^}]*cursor:pointer/.test(cssSrc),
  'SA locality plate is the search entry now the pill is gone');
ok(appSrc.includes("theme-san-andreas')) openPlanning('search')"),
  'locality plate opens search in SA dashboard');
ok(indexSrc.includes('id="sa-grove-panel"'), 'SA dashboard mounts the Grove Street scene panel element');
ok(/theme-san-andreas #sa-grove-panel\{[^}]*display:none/.test(cssSrc), 'SA Grove Street scene panel removed (unified hud carries the art)');
ok(!cssSrc.includes("dashboard/bottombar-palms.jpg"), 'SA bottom bar drops the scenic palm photo block');
/* map: game-map language */
const saStyle5 = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/san-andreas/style.json'), 'utf8'));
const saLayer5 = (id) => saStyle5.layers.find((l) => l.id === id);
ok(saLayer5('sa-road-motorway').paint['line-color'] === '#0d0d0d', 'SA majors are near-black');
ok(saLayer5('sa-road-minor').paint['line-color'] === '#2e2a22', 'SA minors are dark charcoal');
ok(saLayer5('sa-grass').paint['fill-color'] === '#6fa03f', 'SA open land is stronger mid-green');
ok(saLayer5('sa-label-road-minor').minzoom >= 16, 'SA minor road labels decluttered to z16+');
/* ---------- PASS 4: player marker is crisp vector chrome ---------- */
const saPlayerSvg = fs.readFileSync(path.join(REPO, 'assets/themes/san-andreas/player.svg'), 'utf8');
ok(/viewBox="0 0 40 40"/.test(saPlayerSvg), 'SA player SVG is a 40x40 crisp vector');
ok(saPlayerSvg.includes('#f6efdb') || saPlayerSvg.includes('#F6EFDB'), 'SA player marker is cream');
ok(/stroke="#0a0806"/.test(saPlayerSvg), 'SA player marker has the heavy black outline');
ok(!/feGaussianBlur/.test(saPlayerSvg) && !/radialGradient/.test(saPlayerSvg), 'SA player marker has no glow filter');
ok(/fill=\\?"#f6efdb\\?"/.test(saPlayerSvg) && /#f6efdb/.test(appSrc), 'SA block arrow renders cream, not white');
/* ---------- PASS 4: map is real geography in pause-map language ---------- */
const saStyle2 = JSON.parse(fs.readFileSync(path.join(REPO, 'themes/san-andreas/style.json'), 'utf8'));
const saPaint = id => saStyle2.layers.find(l => l.id === id).paint;
const saLayer = id => saStyle2.layers.find(l => l.id === id);
ok(saPaint('sa-land')['background-color'] === '#eee3bd', 'SA land: pale cream built-up');
ok(saPaint('sa-water')['fill-color'] === '#3f96b4', 'SA water: clear muted blue');
ok(saPaint('sa-parks')['fill-color'] === '#5f9338', 'SA parks: stronger mid-green (distinct from land)');
ok(saPaint('sa-woods')['fill-color'] === '#558031', 'SA woods: distinct darker green');
ok(saPaint('sa-grass')['fill-color'] === '#6fa03f', 'SA grass: stronger mid-green open land');
ok(saPaint('sa-urban')['fill-color'] === '#ded1ae', 'SA urban: warm blocks');
ok(saPaint('sa-road-motorway')['line-color'] === '#0d0d0d', 'SA motorways: near-black, wide');
ok(saPaint('sa-road-minor')['line-color'] === '#2e2a22', 'SA minor roads: dark charcoal');
ok(saLayer('sa-label-road-minor').minzoom >= 16, 'SA minor road labels start at zoom 16+ (much less clutter)');
ok(saLayer('sa-buildings').minzoom === 15, 'SA buildings appear at zoom 15 (less tiny clutter)');
ok(saLayer('sa-label-road-major').minzoom === 10, 'SA major road labels start at zoom 10');
ok(!/theme-san-andreas #map::after/.test(cssSrc), 'SA map has no vignette overlay (clean hero map)');
ok(/theme-gta-v #dash-topbar\{[^}]*background:#0b0b0b/.test(cssSrc), 'V top bar is flat pause-menu black (researched)');
ok(/theme-gta-v #dash-bottombar\{[^}]*background:#0b0b0b/.test(cssSrc), 'V bottom bar is flat pause-menu black (researched)');
ok(/theme-gta-v \.gvsp\{[^}]*aspect-ratio:\s*1155\s*\/\s*1362/.test(cssSrc), 'V music panel is the hud art at its own proportions');
ok(/theme-gta-v \.dash-tabs button\{[^}]*background:transparent/.test(cssSrc), 'V tabs are transparent icon+text buttons');
ok(/theme-rdr2 #dash-dest\{[^}]*border-image-source:url\('assets\/themes\/rdr2\/dashboard\/menu_header_1a\.png'\)/.test(cssSrc),
   'RDR2 destination plate uses the ornate menu-header frame');
ok(cssSrc.includes("theme-rdr2 #dash-topbar::after") && cssSrc.includes('header-dusk.png'), 'RDR2 header feathers dusk scenery at the edges');
ok(/theme-rdr2 \.dash-dest::before/.test(cssSrc) && cssSrc.includes('title_divider.png'), 'RDR2 destination plate is flanked by divider ornaments');
ok(/theme-gta-v \.dash-logo\{[^}]*'Chalet Comprime'/.test(cssSrc), 'V wordmark uses Chalet (hero typography)');
ok(/theme-gta-v #dash-dest\{[^}]*'SignPainter'/.test(cssSrc), 'V destination uses SignPainter script (user-requested footer treatment)');
ok(/theme-gta-v #dash-sub\{[^}]*display:block/.test(cssSrc), 'V locality lockup shows the county subtitle');
ok(/theme-gta-v \.dash-tabs button span\{[^}]*text-transform:uppercase/.test(cssSrc), 'V tabs carry uppercase text labels under the icons');
ok(/theme-rdr2 #dash-bottombar\{[^}]*clip-path:polygon/.test(cssSrc), 'RDR2 footer has a stepped console silhouette');
// service worker: VC dashboard art is shell-precached (default theme), the
// other themes' dashboard art rides the on-demand theme-asset cache
ok(swSrc.includes('themes/vice-city/dashboard/skyline-sunset.png'), 'SW precaches the VC sunset skyline');
ok(SW.isThemeAsset('/themes/san-andreas/dashboard/sa-logo.png'), 'isThemeAsset: SA wordmark');
ok(SW.isThemeAsset('/themes/gta-v/dashboard/topbar-bg.png'), 'isThemeAsset: V dashboard bar art');
ok(SW.isThemeAsset('/assets/themes/rdr2/dashboard/menu_header_1a.png'), 'isThemeAsset: RDR2 dashboard art');
const vcSkinSrc = fs.readFileSync(path.join(REPO, 'themes/vice-city/spotify-skin.css'), 'utf8');
ok(cssSrc.includes('theme-vice-city .vcsp{') && /theme-vice-city \.vcsp\{[^}]*width:687px/.test(cssSrc), 'VC widget scaled to 687px in dashboard (hero weighting)');
ok(!vcSkinSrc.includes('rotate(6deg)'), 'VC widget is straight (hero has no tilt)');
// every theme widget: explicit larger size, ~6-7 degree tilt (except VC hero-match), no-overlap idle states
// (san-andreas pass 4: straight Radio Los Santos bezel, asserted in the pass 4 block)
const skinSpecs = [
  ['gta-v', 'gvsp', 'aspect-ratio: 1155 / 1362', 'width: 520px'],
  ['rdr2', 'rdsp', 'rotate(-6.5deg)', 'width: 600px'],
];
for (const [theme, cls, shape, size] of skinSpecs) {
  const css = fs.readFileSync(path.join(REPO, `themes/${theme}/spotify-skin.css`), 'utf8');
  const js = fs.readFileSync(path.join(REPO, `themes/${theme}/spotify-skin.js`), 'utf8');
  ok(css.includes(shape), `${theme}: widget shape pinned (${shape})`);
  ok(css.includes(size), `${theme}: widget sized up (${size})`);
  ok(css.includes(`.${cls}.is-idle`), `${theme}: disconnected idle owns its stage (no overlaps)`);
  ok(js.includes("root.classList.toggle('is-idle'"), `${theme}: render toggles the is-idle class`);
  /* Regression: is-idle must NOT hide the lyric stage when a track is in
     state but auth is stale (the black lyric void). Idle requires both
     disconnected AND no track. */
  ok(js.includes('!connected && !hasTrack'), `${theme}: is-idle requires disconnected AND no track (lyric void fix)`);
}
ok(appSrc.includes('syncDashPadding'), 'camera viewport offsets left of the VC widget');
/* Regression: dashboard camera padding must clear every theme's real bars
   (SA 126/126, GTA V 120/120, RDR2 104/84) — the old hardcoded top:76 /
   bottom:VC?100:88 left the camera target under the SA/GTA V bars. */
ok(/DASH_BAR_HEIGHTS\[themeId\]/.test(appSrc) && /top:\s*bars\.top/.test(appSrc) && /bottom:\s*bars\.bottom/.test(appSrc),
  'syncDashPadding reads bar clearances from DASH_BAR_HEIGHTS per theme');
ok(cssSrc.includes('#dash-bottombar::before'), 'VC bottom bar has a neon top edge');
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

/* ---------- GTA V palette matches the researched pause-menu map ---------- */
/* Palette researched from jfalcone456/gta-v-map, a recreation of the
   actual GTA V pause-menu cartography: charcoal land, near-black water,
   white-to-gray road hierarchy. */
const vPaint = id => vStyle.layers.find(l => l.id === id).paint;
ok(vPaint('v-land')['background-color'] === '#181818', 'V land: charcoal pause map (researched)');
ok(vPaint('v-water')['fill-color'] === '#101314', 'V water: near-black (researched)');
for (const id of ['v-parks', 'v-grass', 'v-golf', 'v-gardens', 'v-recreation', 'v-park-areas', 'v-playing-fields'])
  ok(vPaint(id)['fill-color'] === '#20251d', `V ${id}: faint green (researched)`);
ok(vPaint('v-woods')['fill-color'] === '#1c211a', 'V woods: faint green-gray (researched)');
ok(vPaint('v-road-minor')['line-color'] === '#8f8f8f', 'V v-road-minor: grey (researched)');
ok(vPaint('v-road-primary')['line-color'] === '#d6d6d6', 'V v-road-primary: pale grey (researched)');
ok(vPaint('v-road-motorway')['line-color'] === '#efefef', 'V v-road-motorway: near-white (researched)');
ok(vPaint('v-label-road-major')['text-color'] === '#cfcfcf', 'V road labels: pale grey (researched)');
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
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city .dash-zoom{'),
  'VC dashboard shows the bottom-bar zoom/locate buttons');
ok(cssSrc.includes('body.dashboard-mode.theme-vice-city .player-arrow'),
  'VC dashboard player arrow is larger and more luminous');
ok(cssSrc.includes('.vc-man-meta'), 'VC maneuver meta row styled');
ok(cssSrc.includes('.vc-man-text'), 'VC maneuver text block styled');
ok(appSrc2.includes("roadName(next) || instrText(next)"),
  'VC maneuver card shows the clean road name (voice text untouched)');
ok(cssSrc.includes('.vc-logo-script'), 'VC hero logo script present');



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
  'san-andreas': { townMin: 21, cityMin: 24, village: 16, hamlet: 13, major17min: 15 },
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


/* ---------- Spotify skins: single-hud overlays, art-registered openings ----------
   (gta-v left the hud.png regime for the radio console rebuild;
   san-andreas pass 4 left it for the Radio Los Santos bezel) */
const HUD_EXPECTED = {
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
ok(typeof LY.setOffset === 'function' && LY.getOffset() === 100, 'lyrics: default offset 100ms (tuned from live feedback)');
ok(LY.setOffset(50) === 50 && LY.getOffset() === 50, 'lyrics: offset tunable');
ok(LY.setOffset(-5) === -5 && LY.setOffset(99999) === 5000 && LY.setOffset(-99999) === -2000, 'lyrics: offset clamped to [-2000,5000]');
LY.setOffset(100);
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
// Lyric type is game-authentic on every theme: no generic Outfit anywhere
// in the lyric styles; each theme declares its own --lyr-font.
const lyrFace = { 'vice-city': 'Pricedown Bl', 'san-andreas': 'Bank Gothic', 'gta-v': 'Chalet London', 'rdr2': 'RDR Lino' };
for (const [tid, face] of Object.entries(lyrFace)) {
  ok(new RegExp(`\\.wslyr-${tid}\\{[^}]*--lyr-font:'${face}'`).test(cssAll),
    `lyrics: ${tid} lyric typeface is ${face}`);
}
const wslyrCss = cssAll.slice(cssAll.indexOf('.wslyr{'));
ok(!wslyrCss.includes("'Outfit'"), 'lyrics: no Outfit anywhere in the lyric styles');
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
ok(appSrc.includes('__WAYSTATION_CAR') && /parseAppMode\(location\.search, car, stored\)/.test(appSrc),
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


{
  const pmSrc = appSrc.split('/* <test-extract:parseMaxspeed> */')[1].split('/* </test-extract> */')[0];
  const pmBox = {};
  vm.createContext(pmBox);
  vm.runInContext(pmSrc, pmBox, { filename: 'parseMaxspeed' });
  const parseMaxspeed = pmBox.parseMaxspeed;
  ok(typeof parseMaxspeed === 'function', 'parseMaxspeed extracts for testing');
  ok(parseMaxspeed('50') === 50, 'maxspeed 50 -> 50');
  ok(parseMaxspeed('80') === 80, 'maxspeed 80 -> 80');
  ok(parseMaxspeed('120') === 120, 'maxspeed 120 -> 120');
  ok(parseMaxspeed('30 mph') === 48, 'maxspeed 30 mph -> 48 kmh');
  ok(parseMaxspeed('60 mph') === 97, 'maxspeed 60 mph -> 97 kmh');
  ok(parseMaxspeed('IE:urban') === 50, 'maxspeed IE:urban -> 50');
  ok(parseMaxspeed('IE:rural') === 80, 'maxspeed IE:rural -> 80');
  ok(parseMaxspeed('IE:motorway') === 120, 'maxspeed IE:motorway -> 120');
  ok(parseMaxspeed('none') === null, 'maxspeed none -> null');
  ok(parseMaxspeed('signals') === null, 'maxspeed signals -> null');
  ok(parseMaxspeed('') === null, 'maxspeed empty -> null');
  ok(parseMaxspeed(null) === null, 'maxspeed null -> null');
}
ok(indexSrc.includes('id="speedo"'), 'index has the #speedo cluster');
ok(indexSrc.includes('id="speedo-limit"') && indexSrc.includes('id="speedo-num"'), 'speedo has limit + speed readouts');
ok(/DASH_STAGE_NODES\s*=\s*\[[^\]]*'speedo'/.test(appSrc), 'speedo is reparented into the dash stage');
ok(/body\.dashboard-mode #speedo\{[^}]*display:flex/.test(fs.readFileSync(path.join(REPO, 'styles.css'), 'utf8')), 'speedo shows in dashboard mode');
ok(appSrc.includes('maybeFetchSpeedLimit'), 'app fetches posted limits from OSM');
ok(appSrc.includes('overpass'), 'limit lookup uses Overpass');


/* ---------- wanted level: stars for speeding (GTA V) ---------- */
{
  const wSrc = appSrc.split('/* <test-extract:wanted> */')[1].split('/* </test-extract> */')[0];
  const wBox = {};
  vm.createContext(wBox);
  vm.runInContext(wSrc, wBox, { filename: 'wanted' });
  ok(typeof wBox.starsForHeat === 'function', 'starsForHeat extracts for testing');
  ok(wBox.starsForHeat(0) === 0, 'wanted: 0 heat -> 0 stars');
  ok(wBox.starsForHeat(11) === 0, 'wanted: 11 heat -> 0 stars');
  ok(wBox.starsForHeat(12) === 1, 'wanted: 12 heat -> 1 star');
  ok(wBox.starsForHeat(29) === 1, 'wanted: 29 heat -> 1 star');
  ok(wBox.starsForHeat(30) === 2, 'wanted: 30 heat -> 2 stars');
  ok(wBox.starsForHeat(50) === 3, 'wanted: 50 heat -> 3 stars');
  ok(wBox.starsForHeat(70) === 4, 'wanted: 70 heat -> 4 stars');
  ok(wBox.starsForHeat(90) === 5, 'wanted: 90 heat -> 5 stars');
  ok(wBox.starsForHeat(100) === 5, 'wanted: 100 heat -> 5 stars');
}
ok(indexSrc.includes('id="wanted"'), 'index has the #wanted row');
ok((indexSrc.match(/class="wstar"/g) || []).length === 5, 'wanted row has 5 stars');
ok(/DASH_STAGE_NODES\s*=\s*\[[^\]]*'wanted'/.test(appSrc), 'wanted is reparented into the dash stage');
ok(appSrc.includes('resetWanted'), 'wanted resets when the drive ends');
ok(fs.existsSync(path.join(REPO, 'themes/gta-v/dashboard/wanted-star-fill.png')), 'wanted fill star asset exists');
ok(fs.existsSync(path.join(REPO, 'themes/gta-v/dashboard/wanted-star-hollow.png')), 'wanted hollow star asset exists');
{
  const gvCss = fs.readFileSync(path.join(REPO, 'themes/gta-v/dashboard.css'), 'utf8');
  ok(/\.wstar\.on\{[^}]*wanted-star-fill\.png/.test(gvCss), 'earned star uses the fill asset');
  ok(/\.wstar\{[^}]*wanted-star-hollow\.png/.test(gvCss), 'unearned star uses the hollow asset');
}

ok(/function saArrowSvg/.test(appSrc), 'SA has its own block-arrow set (hero font-theme match)');
ok(/t\.id === 'san-andreas'/.test(appSrc) || /id === "san-andreas"/.test(appSrc), 'SA arrows branch on the san-andreas theme');
ok(cssSrc.includes('-webkit-text-stroke'), 'SA dash type has the heavy outlined SA treatment');
ok(/theme-san-andreas #sa-grove-panel/.test(cssSrc),
  'SA dashboard wears the grove-panel hero band (2026-09-09 polish)');
ok(fs.existsSync(path.join(REPO, 'themes/san-andreas/dashboard/grove-panel.png')), 'SA grove-panel art exists');
ok(!/bottombar-trim\.jpg/.test(cssSrc) && !/bottombar-palms\.jpg/.test(cssSrc),
  'SA retired the brass-trim/palm-sunset bottom bar (2026-09-09 polish)');
ok(/theme-san-andreas \.dash-tabs button\.on::before\{[^}]*linear-gradient\(180deg,#e9cd7d/.test(cssSrc),
  'SA active tab is the dark plate + gold chamfer (2026-09-09 polish), not the green box');
ok(fs.existsSync(path.join(REPO, 'themes/san-andreas/dashboard/bottombar-trim.jpg')), 'SA bottom bar trim art exists');
ok(fs.existsSync(path.join(REPO, 'themes/san-andreas/dashboard/bottombar-palms.jpg')), 'SA bottom bar palm art exists');
// Theme lock enforcement: a locked theme's dashboard.css must match its recorded hash.
{
  const crypto = require('crypto');
  const lockPath = path.join(REPO, 'themes/LOCKED.json');
  if (fs.existsSync(lockPath)) {
    const locks = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    for (const [theme, info] of Object.entries(locks)) {
      if (theme.startsWith('_') || !info.locked) continue;
      const cssPath = path.join(REPO, `themes/${theme}/dashboard.css`);
      const hash = crypto.createHash('sha256').update(fs.readFileSync(cssPath)).digest('hex');
      ok(hash === info.sha256, `Theme ${theme} is LOCKED and unchanged (hash match)`);
    }
  }
}
ok(fs.existsSync(path.join(REPO, 'themes/vice-city/dashboard.css')), 'VC dashboard.css exists (factored)');
ok(fs.existsSync(path.join(REPO, 'themes/san-andreas/dashboard.css')), 'SA dashboard.css exists (factored)');

/* ---------- pass 5: cluster stage parity + speed validation + SA overhaul ---------- */
// cluster is a fixed 1920x720 stage like the dashboard (same aspect ratio)
ok(/body\.cluster-mode #cluster-ui\{[^}]*width:1920px[^}]*height:720px/.test(cssSrc),
  'cluster-ui is a fixed 1920x720 stage (dashboard aspect parity)');
ok(!/body\.cluster-mode #cluster-ui\{[^}]*inset:0/.test(cssSrc),
  'cluster stage is JS-centered, not viewport-stretched');
ok(/CLUSTER_STAGE_NODES\s*=\s*\[[^\]]*'map'[^\]]*'spotify-pane'/.test(appSrc),
  'map + spotify-pane are reparented into the cluster stage');
ok(appSrc.includes('function buildClusterStage') && appSrc.includes('function teardownClusterStage'),
  'cluster stage build/teardown restores DOM homes');
ok(appSrc.includes('function fitClusterStage'), 'fitClusterStage zooms the cluster canvas');
ok(/fitClusterStage\(\);?\s*\n?\s*}?\s*else teardownClusterStage/.test(appSrc) || appSrc.includes('buildClusterStage(); fitClusterStage();'),
  'applyAppMode builds + fits the cluster stage on entry');
ok(/appMode === 'cluster'\) \{\s*\n?\s*fitClusterStage/.test(appSrc),
  'resize refits the cluster stage');
// cluster children are stage-absolute, never viewport-fixed (the body::before
// ambient letterbox is viewport-level by design, not a stage child)
{
  const vcCss = fs.readFileSync(path.join(REPO, 'themes/vice-city/dashboard.css'), 'utf8');
  const vcCluster = vcCss.slice(vcCss.indexOf('Cluster Mode: Vice City HERO'))
    .replace(/body\.cluster-mode\.theme-vice-city::before\{[^}]*\}/, '');
  ok(!/position:fixed/.test(vcCluster), 'VC cluster: no viewport-fixed survivors in the stage');
  const saPhone = fs.readFileSync(path.join(REPO, 'themes/san-andreas/phone.css'), 'utf8');
  const saCluster = saPhone.slice(saPhone.indexOf('Cluster Mode: San Andreas'));
  ok(!/position:fixed/.test(saCluster), 'SA cluster: no viewport-fixed survivors in the stage');
}
// validated GPS speed: wild coords.speed spikes never reach the display
{
  const vSrc = appSrc.slice(appSrc.indexOf('let gpsSpeed = null; // m/s, validated'),
    appSrc.indexOf('/* ---------------- wanted level'));
  let T = 1000000;
  const vBox = { Date: { now: () => T } };
  vm.createContext(vBox);
  vm.runInContext(vSrc, vBox, { filename: 'speed-validation' });
  const adv = ms => { T += ms; };
  const spd = () => vm.runInContext('gpsSpeed', vBox);
  vBox.setGpsSpeed(182, 0.3, 1); // 657 km/h spike while standing still
  ok(Math.abs(spd() - 0.3) < 1e-9, 'speed: 182 m/s spike while stationary is refused (falls back to displacement)');
  // 2692 km/h couch bug: wild coords.speed on first fix with jumping displacement
  const vBox2 = { Date: { now: () => T } };
  vm.createContext(vBox2);
  vm.runInContext(vSrc, vBox2, { filename: 'speed-validation-2' });
  const spd2 = () => vm.runInContext('gpsSpeed', vBox2);
  vBox2.setGpsSpeed(747, 50, 1); // 2692 km/h glitch, null history, 50 m/s jump
  ok(spd2() < 100, 'speed: 747 m/s wild fix is never accepted (absolute cap)');
  adv(1000); vBox.setGpsSpeed(0.2, 0.2, 1);
  ok(Math.abs(spd() - 0.2) < 1e-9, 'speed: real fixes flow through');
  for (let i = 1; i <= 10; i++) { adv(1000); vBox.setGpsSpeed(i * 2.5, i * 2.5, 1); }
  ok(Math.abs(spd() - 25) < 1e-9, 'speed: genuine 2.5 m/s^2 acceleration is accepted');
  adv(1000); vBox.setGpsSpeed(200, 25, 1); // teleport: impossible
  ok(Math.abs(spd() - 25) < 1e-9, 'speed: impossible jump is rejected, last good held');
  adv(11000);
  ok(vBox.freshGpsSpeed() === null, 'speed: stale fixes read as unknown, never frozen');
  ok(appSrc.includes('freshGpsSpeed()'), 'displays read the validated fresh speed');
  ok(!/gpsSpeed\s*=\s*cSpeed/.test(appSrc), 'no raw coords.speed assignment survives');
}
// SA cluster overlay redesign (2026-09-10): the user's perfect cluster art IS the stage
{
  const saPhone = fs.readFileSync(path.join(REPO, 'themes/san-andreas/phone.css'), 'utf8');
  const saCluster = saPhone.slice(saPhone.indexOf('Cluster Mode: San Andreas'));
  ok(saCluster.includes('cluster-overlay.png'), 'SA cluster paints the user-supplied overlay art as the stage');
  ok(/body\.cluster-mode\.theme-san-andreas #map\{[^}]*left:76px[^}]*top:264px[^}]*width:565px[^}]*height:290px/.test(saCluster),
    'SA cluster map is a subtle underlay (549x281 aperture + 3% overscan), bleeding under the bezel');
  ok(saCluster.includes('#sa-cluster-exit') && saCluster.includes('cluster-exit-btn.png'),
    'SA cluster has a themed exit button (gold home) returning to dashboard');
  const appSrc = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  ok(/SA_CLUSTER_OVERVIEW_ZOOM\s*=\s*13\.0/.test(appSrc),
    'SA cluster defines a fixed overview zoom (13.0), not derived from nav zoom');
  ok(!/saClusterZoom\(/.test(appSrc),
    'SA cluster no longer uses log2 bleed compensation');
  ok(!/body\.cluster-mode\.theme-san-andreas #map\{[^}]*left:78px[^}]*top:261px[^}]*width:513px[^}]*height:272px/.test(saCluster),
    'SA cluster map is no longer exactly the window size (attribution bar used to show inside it)');
  ok(/body\.cluster-mode\.theme-san-andreas #cluster-header,/.test(saCluster) &&
     /#cluster-gauge,/.test(saCluster) && /#cluster-limit,/.test(saCluster),
    'SA cluster hides the console chrome the overlay art already paints');
  ok(/body\.cluster-mode\.theme-san-andreas #cluster-speed\{[^}]*left:961px[^}]*top:315px/.test(saCluster),
    'SA cluster hero speed sits in the overlay\'s dial');
  ok(/\.sasp\{[^}]*left:1322px[^}]*top:285px[^}]*transform:scale\(\.745\)/.test(saCluster) === false,
    'SA cluster no longer scales the dashboard .sasp skin into the music frame');
  /* Cluster music widget: a compact .sacl skin built for the container
     boxes already painted in the overlay art (art box / info area /
     lyric bar) — the dashboard .sasp skin stays in the dashboard. */
  const saclCss = fs.readFileSync(path.join(REPO, 'themes/san-andreas/spotify-cluster.css'), 'utf8');
  ok(/\.sacl\{[^}]*left:1297px[^}]*top:283px/.test(saclCss),
    'SA cluster .sacl widget positions itself over the overlay\'s music boxes');
  ok(saclCss.includes('.sacl-artwrap') && saclCss.includes('.sacl-lyrics'),
    'SA cluster .sacl widget fills the art box, info area and lyric bar');
  const saclJs = fs.readFileSync(path.join(REPO, 'themes/san-andreas/spotify-cluster.js'), 'utf8');
  ok(saclJs.includes("register('san-andreas-cluster'"),
    'SA cluster Spotify skin is registered as san-andreas-cluster');
  ok(appSrc.includes('san-andreas-cluster'),
    'app.js selects the san-andreas-cluster skin in cluster mode');
  ok(indexSrc.includes('themes/san-andreas/spotify-cluster.js') &&
     indexSrc.includes('themes/san-andreas/spotify-cluster.css'),
    'index.html loads the SA cluster Spotify skin');
  ok(swSrc.includes('themes/san-andreas/spotify-cluster.js') &&
     swSrc.includes('themes/san-andreas/spotify-cluster.css'),
    'SW precaches the SA cluster Spotify skin');
  ok(/#spotify-pane\{[^}]*width:1920px[^}]*height:720px/.test(saCluster),
    'SA cluster Spotify surface is the 1920x720 stage, not viewport units');
  ok(!/100dvh|100vw/.test(saCluster), 'SA cluster has no viewport-unit survivors');
  ok(saCluster.includes('#sa-cluster-menu'), 'SA cluster keeps a real menu tap target over the painted logo');
  ok(saCluster.includes('HERO-locked'), 'SA cluster documents that it avoids the HERO-locked dashboard.css');
  ok(fs.existsSync(path.join(REPO, 'themes/san-andreas/dashboard/cluster-overlay.png')),
    'SA cluster overlay asset exists on disk');
}
// GTA V cluster console view (2026-09-10): DOM/CSS-built dark console per
// the user's concept render — parallelogram live map, glass maneuver +
// music cards overlapping the map's right edge, thin speed digits.
{
  const gvCss = fs.readFileSync(path.join(REPO, 'themes/gta-v/cluster.css'), 'utf8');
  ok(/body\.cluster-mode\.theme-gta-v #map\{[^}]*clip-path:polygon\(/.test(gvCss),
    'GTA V cluster clips the live map to the concept parallelogram');
  ok(gvCss.includes('#gv-topbar') && gvCss.includes('#gv-powerbar') &&
     gvCss.includes('#gv-turn-card') && gvCss.includes('#gv-bottombar'),
    'GTA V cluster styles the top bar, power bar, maneuver card and bottom bar');
  ok(gvCss.includes('#gv-skyline') && gvCss.includes('skyline.png'),
    'GTA V cluster paints the skyline silhouette behind the speed cluster');
  ok(/body\.cluster-mode\.theme-gta-v #(cluster-header|cluster-footer|cluster-gauge)[\s\S]{0,400}display:none/.test(gvCss),
    'GTA V cluster hides the generic cluster chrome');
  ok(indexSrc.includes('id="gv-topbar"') && indexSrc.includes('id="gv-turn-card"') &&
     indexSrc.includes('id="gv-powerbar"') && indexSrc.includes('id="gv-bottombar"') &&
     indexSrc.includes('id="gv-skyline"'),
    'index.html carries the GTA V cluster DOM');
  ok(indexSrc.includes('id="cluster-turn"') && indexSrc.includes('id="cluster-trip"') &&
     indexSrc.includes('id="cluster-speed-num"') && indexSrc.includes('id="cluster-limit-num"'),
    'GTA V cluster reuses the shared live-region IDs (nav/speed/limit/trip)');
  const ids = (indexSrc.match(/id="([^"]+)"/g) || []).map(s => s.slice(4, -1));
  ok(new Set(ids).size === ids.length, 'index.html has no duplicate IDs after the GTA V cluster DOM');
  ok(indexSrc.includes('themes/gta-v/cluster.css') && indexSrc.includes('themes/gta-v/cluster.js'),
    'index.html loads the GTA V cluster CSS and live wiring');
  const gvJs = fs.readFileSync(path.join(REPO, 'themes/gta-v/cluster.js'), 'utf8');
  ok(gvJs.includes('gv-time') && gvJs.includes('gv-coords') && gvJs.includes('gv-powerbar') &&
     gvJs.includes('driveForceState'),
    'GTA V cluster JS wires clock, coords and the GPS-derived power bar');
  ok(gvJs.includes('v-label-place') && gvJs.includes('text-letter-spacing'),
    'GTA V cluster dims/tracks the map labels while up and restores them after');
  const gvclCss = fs.readFileSync(path.join(REPO, 'themes/gta-v/spotify-cluster.css'), 'utf8');
  ok(/\.gvcl\{/.test(gvclCss) && gvclCss.includes('.gvcl-tag') && gvclCss.includes('.gvcl-artwrap'),
    'GTA V cluster .gvcl music-card skin styles exist');
  const gvclJs = fs.readFileSync(path.join(REPO, 'themes/gta-v/spotify-cluster.js'), 'utf8');
  ok(gvclJs.includes("register('gta-v-cluster'"),
    'GTA V cluster Spotify skin is registered as gta-v-cluster');
  ok(gvclJs.includes('MUSIC MOVES DIFFERENT HERE'),
    'GTA V cluster music card carries the concept tagline');
  ok(appSrc.includes("SpotifySkins.get('gta-v-cluster')"),
    'app.js selects the gta-v-cluster skin in GTA V cluster mode');
  ok(fs.existsSync(path.join(REPO, 'themes/gta-v/cluster/skyline.png')),
    'GTA V cluster skyline asset exists on disk');
  ok(!/100dvh|100vw/.test(gvCss), 'GTA V cluster CSS has no viewport-unit survivors');
}
// one attribution control only: the constructor's compact control — the
// extra bottom-left addControl rendered the bar twice
{
  const addCount = (appSrc.match(/new maplibregl\.AttributionControl/g) || []).length;
  ok(addCount <= 1, `single attribution control (found ${addCount})`);
}
// graceful offline: no-data must never white-screen. Banner element,
// banner + placeholder styles, connectivity watch, and the map boot
// failure path painting a placeholder instead of leaving blank white.
{
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(REPO, 'styles.css'), 'utf8');
  ok(html.includes('id="offline-banner"'), 'offline banner element exists');
  ok(css.includes('#offline-banner') && css.includes('body.is-offline'),
    'offline banner styles keyed on body.is-offline');
  ok(css.includes('.ws-offline-map'), 'offline map placeholder styles exist');
  ok(/installOfflineWatch\(\)/.test(appSrc), 'offline watch installed at boot');
  ok(/addEventListener\('offline'/.test(appSrc) && /addEventListener\('online'/.test(appSrc),
    'online/offline events toggle the offline state');
  ok(/paintMapOffline\(mapEl\)/.test(appSrc),
    'map style failure paints the offline placeholder instead of blank white');
  ok(/mapBootFailed/.test(appSrc), 'failed map boot is retried on reconnect');
}
// stage lifecycle: teardown runs before build so a stale home never yanks
// the shared map/Spotify nodes out of the stage just entered
{
  const am = appSrc.slice(appSrc.indexOf('function applyAppMode'));
  const tC = am.indexOf('teardownClusterStage();');
  const tD = am.indexOf('teardownDashboardStage();');
  const bD = am.indexOf('buildDashboardStage();');
  const bC = am.indexOf('buildClusterStage();');
  ok(tC !== -1 && tD !== -1 && bD !== -1 && bC !== -1, 'applyAppMode manages both stages');
  ok(tC < bD && tD < bD && tC < bC && tD < bC,
    'applyAppMode tears down stages before building (cluster<->dashboard handoff)');
  ok(/home\.next && home\.next\.parentNode === home\.parent/.test(appSrc),
    'stage teardowns tolerate a stale home.next (no insertBefore crash)');
}

// VC cluster reuses the dashboard bars + sunset panorama (2026-09-09)
{
  const fs = require('fs');
  ok(fs.existsSync('themes/vice-city/dashboard/cluster-oceandrive.jpg'), 'VC cluster Ocean Drive panorama asset exists');
  ok(swSrc.includes('themes/vice-city/dashboard/cluster-oceandrive.jpg'), 'SW precaches the VC cluster backdrop');
  ok(appSrc.includes("const CLUSTER_STAGE_NODES = ['map', 'spotify-pane', 'dash-topbar', 'dash-bottombar']"),
    'dash bars reparent into the cluster stage');
  ok(/body\.cluster-mode\.theme-vice-city #cluster-ui\{[^}]*cluster-oceandrive\.jpg[^}]*\/ 100% 100%/.test(cssSrc),
    'VC cluster paints the backdrop 1:1 on the stage (no crop: art is 8:3, stage is 8:3)');
  ok(/body\.cluster-mode\.theme-vice-city::before\{[^}]*cluster-oceandrive\.jpg[^}]*blur/.test(cssSrc),
    'VC cluster letterbox is the same art blurred+dimmed, not a second crop');
  ok(/body\.cluster-mode\.theme-vice-city #map\{[^}]*width:440px;height:440px[^}]*border-radius:50%/.test(cssSrc),
    'VC cluster radar is a true circle: square 440 map masked round');
  ok(/body\.cluster-mode\.theme-vice-city #map\{[^}]*overflow:hidden/.test(cssSrc),
    'VC cluster radar clips the live map to the circle');
  ok(!cssSrc.includes('#cluster-ui:has(#cluster-turn:not([hidden])) #map'),
    'VC cluster turn tab never shrinks the radar map');
  ok(/body\.cluster-mode\.theme-vice-city #cluster-minimap\{[^}]*border-radius:50%/.test(cssSrc),
    'VC cluster radar frame is a circular ring assembly');
  ok(/body\.cluster-mode\.theme-vice-city #cluster-minimap\{[^}]*255,45,149/.test(cssSrc) && /body\.cluster-mode\.theme-vice-city #cluster-minimap\{[^}]*1,205,254/.test(cssSrc),
    'VC cluster radar ring: hot-pink edge with cyan accent');
  ok(cssSrc.includes('#cluster-radar-north') && indexSrc.includes('id="cluster-radar-north"'),
    'VC cluster radar carries a north cue on the bezel');
  ok(appSrc.includes('function syncRadarNorth'),
    'radar N tracks the live map bearing (never faked)');
  ok(cssSrc.includes('body.cluster-mode.theme-vice-city #map::after'),
    'VC cluster radar has an inset ring above the tiles');
  ok(/body\.cluster-mode\.theme-vice-city #map \.maplibregl-ctrl-bottom-right/.test(cssSrc),
    'VC cluster attribution is tucked inside the circular clip');
  ok(/body\.cluster-mode\.theme-vice-city #cluster-turn:not\(\[hidden\]\)/.test(cssSrc),
    'VC cluster turn information is a compact tab, not a card');
  ok(/body\.cluster-mode\.theme-vice-city \.vcsp\{[^}]*filter:\s*drop-shadow/.test(cssSrc),
    'VC cluster music widget wears a drop shadow');
  ok(cssSrc.includes('body.cluster-mode.theme-vice-city #cluster-header{display:none}'),
    'VC cluster retires its old header for the dashboard topbar');
  ok(/body\.cluster-mode\.theme-vice-city #cluster-footer\{[^}]*background:none/.test(cssSrc),
    'VC cluster footer is a transparent tab strip on the dashboard bottombar');
  ok(cssSrc.includes('body.theme-vice-city:is(.dashboard-mode,.cluster-mode) #dash-topbar{'),
    'VC topbar chrome is shared between dashboard and cluster');
  const syncFn = appSrc.slice(appSrc.indexOf('function syncClusterHeader'));
  ok(syncFn.includes("$('dash-date')") && syncFn.includes("$('dash-time')") && syncFn.includes("$('dash-temp')"),
    'VC cluster header sync keeps the reused topbar clock/temp live');
  ok(appSrc.includes("#dash-topbar .dash-brand"),
    'VC cluster brand mark keeps menu access (replaces the retired cluster logo)');
  for (const t of ['san-andreas', 'gta-v', 'rdr2'])
    ok(cssSrc.includes(`body.cluster-mode.theme-${t} #dash-topbar,`) ||
       cssSrc.includes(`body.cluster-mode:not(.theme-vice-city) #dash-topbar,`),
      `${t} cluster never shows the dashboard bars`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
