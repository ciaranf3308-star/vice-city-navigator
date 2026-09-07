/* Vice City Navigator service worker — caches the app shell only.
   Map tiles, routing and search always go to the network. */
const CACHE = 'vcn-shell-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js',
  'manifest.webmanifest', 'icon.svg'
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
