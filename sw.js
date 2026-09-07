/* Vice City Navigator service worker — caches the app shell only.
   Map tiles, routing and search always go to the network. */
const CACHE = 'vcn-shell-v18';
const BLIPS = ['airYard','barbers','burgerShot','cash','chicken','dateDisco','dateDrink',
  'dateFood','diner','fuel','girlfriend','gym','hostpital','modGarage','north','parking',
  'pizza','police','propertyG','qmark','race','runway','saveGame','school','spray','tattoo','waypoint'];
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'places-config.js', 'places.js',
  'discovery.js', 'voice.js', 'supabase-config.js', 'themes/vice-city.js',
  'spotify-core.js', 'spotify/skins.js', 'spotify/skin-vice-city.js',
  'spotify/skin-vice-city.css', 'assets/spotify/vice_city_synthwave_music_widget.png',
  'vice-city-style.json',
  'manifest.webmanifest', 'icon.svg',
  'fonts/pricedown-bl.woff',
  'assets/player_arrow.png',
  ...BLIPS.map(b => `assets/blips/blip_${b}.png`)
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname;
  const isShell = path === '/' || SHELL.some(p => p !== './' && (path === '/' + p || path.endsWith('/' + p)));
  if (e.request.method === 'GET' && isShell) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      }))
    );
  }
});
