/* WayStation service worker.
   - App shell (HTML/CSS/JS, default Vice City theme art, UI fonts):
     stale-while-revalidate. The cached shell loads instantly and the
     network refresh lands in the background, so a changed shell file
     is at most one load behind — predictable, no version-bump dance
     for every edit. The CACHE name still bumps on structural changes.
   - Other themes' assets (style JSON, blips, player marker, glyph PBFs):
     cached on demand into a separate cache the first time a theme is
     used. Nothing theme-specific is eagerly precached except the
     default Vice City set.
   Map tiles, routing and search always go to the network. */
const CACHE = 'ws-shell-v43';
const THEME_CACHE = 'ws-theme-v13';
const VC_BLIPS = ['airYard','barbers','burgerShot','cash','chicken','dateDisco','dateDrink',
  'dateFood','diner','fuel','girlfriend','gym','hostpital','modGarage','north','parking',
  'pizza','police','propertyG','qmark','race','runway','saveGame','school','spray','tattoo','waypoint'];
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'places.js', 'places-config.js',
  'traffic.js', 'traffic-config.js',
  'discovery.js', 'voice.js', 'supabase-config.js',
  'themes/registry.js',
  'themes/vice-city/theme.js', 'themes/san-andreas/theme.js',
  'themes/gta-v/theme.js', 'themes/rdr2/theme.js',
  'spotify-core.js', 'spotify/skins.js', 'lyrics.js',
  'themes/vice-city/spotify-skin.js', 'themes/vice-city/spotify-skin.css',
  'themes/vice-city/spotify/hud.png',
  'themes/san-andreas/spotify-skin.js', 'themes/san-andreas/spotify-skin.css',
  'themes/san-andreas/spotify/hud.png',
  'themes/gta-v/spotify-skin.js', 'themes/gta-v/spotify-skin.css',
  'themes/gta-v/spotify/hud.png',
  'themes/rdr2/spotify-skin.js', 'themes/rdr2/spotify-skin.css',
  'themes/rdr2/spotify/hud.png',
  'themes/vice-city/style.json',
  'manifest.webmanifest', 'icon.svg', 'icon-512.png', 'icon-maskable-512.png',
  'fonts/pricedown-bl.woff',
  'assets/themes/vice-city/player.png',
  'assets/themes/vice-city/dashboard/vc-logo.png',
  'assets/themes/vice-city/dashboard/bar-texture.jpg',
  ...VC_BLIPS.map(b => `assets/themes/vice-city/blips/blip_${b}.png`)
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE && k !== THEME_CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
function isShell(path) {
  if (path === '/' || path.endsWith('/vice-city-navigator/')) return true;
  return SHELL.some(p => p !== './' && (path === '/' + p || path.endsWith('/' + p)));
}
/* Theme assets cached on demand (never precached): the non-default
   themes' style JSON, blip/player PNGs and self-hosted glyph PBFs. */
function isThemeAsset(path) {
  return /themes\/(san-andreas|gta-v|rdr2)\/style\.json$/.test(path) ||
         /assets\/themes\/(san-andreas|gta-v|rdr2)\//.test(path) ||
         /fonts\/(san-andreas|gta-v|frontier|SignPainter)\//.test(path) ||
         /fonts\/(bank-gothic\.woff|beckett\.woff2|chalet-(london|comprime)\.woff2|signpainter\.woff2|pricedown-gta\.woff2|rdr-lino\.woff2|kirsty\.woff2)$/.test(path);
}
function staleWhileRevalidate(req) {
  return caches.match(req).then(cached => {
    const network = fetch(req).then(res => {
      if (res && res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => cached);
    return cached || network;
  });
}
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (isShell(path)) {
    e.respondWith(staleWhileRevalidate(e.request));
    return;
  }
  if (isThemeAsset(path)) {
    // Stale-while-revalidate (not cache-first-forever): theme art is
    // replaced over time (authentic blips etc.) and the new bytes must
    // reach users. The cached copy renders instantly; the network copy
    // refreshes it in the background for the next load.
    e.respondWith(
      caches.open(THEME_CACHE).then(c => c.match(e.request).then(cached => {
        const network = fetch(e.request).then(res => {
          if (res && res.ok) c.put(e.request, res.clone());
          return res;
        }).catch(() => cached);
        return cached || network;
      }))
    );
    return;
  }
});
