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
  for (const sem of SEMANTICS.concat(['waypoint', 'qmark'])) {
    const url = T.poiIconUrl(sem, id);
    const { w, h } = pngSize(path.join(REPO, url));
    ok(w === 16 && h === 16, `${id} blip 16x16: ${sem}`);
  }
  const ps = pngSize(path.join(REPO, T.get(id).map.playerMarker));
  ok(ps.w === 32 && ps.h === 32, `${id} player marker 32x32`);
}

/* ---------- service worker classification ---------- */
const swSrc = fs.readFileSync(path.join(REPO, 'sw.js'), 'utf8');
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

/* ---------- POI importance ordering + inverse sort key ---------- */
const placesSrc = fs.readFileSync(path.join(REPO, 'places.js'), 'utf8');
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
