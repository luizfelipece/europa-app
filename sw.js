const CACHE = 'eu26-v43-1';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'data.js', 'config.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'tickets/088226858150.bin', 'tickets/130f63299557.bin', 'tickets/1ac334e72308.bin', 'tickets/224b1c3a3e5f.bin', 'tickets/2b65a6ef7018.bin', 'tickets/2d1ca4faa6cb.bin', 'tickets/3b54dda39f7e.bin', 'tickets/3dfabd94a850.bin', 'tickets/3e3792305b06.bin', 'tickets/428d0f80ba6c.bin', 'tickets/46e5a7b0034f.bin', 'tickets/5a6fc87b9e0c.bin', 'tickets/61082b8e9729.bin', 'tickets/63007758b9bf.bin', 'tickets/641f1ee830e7.bin', 'tickets/6f864422e9f7.bin', 'tickets/716f33d5f9a6.bin', 'tickets/721baa7ec03d.bin', 'tickets/7af2e3f3bb14.bin', 'tickets/7b33e8195f7b.bin', 'tickets/9e0e5a3411f2.bin', 'tickets/a6f7375df633.bin', 'tickets/b4149b2fee46.bin', 'tickets/b92fa8923d5c.bin', 'tickets/c948e3ab832b.bin', 'tickets/d5884c8f7d39.bin', 'tickets/ddfb0c190a9f.bin', 'tickets/e6d53bfdc2ad.bin', 'tickets/fcf0201f9803.bin', 'tickets/fd90ae423216.bin'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => fetch(f, { cache: 'reload' }).then(r => { if (!r.ok) throw new Error(f); return c.put(f, r); }))))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting(); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(r => r || fetch(e.request).then(resp => {
    if (resp.ok) { const cp = resp.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); }
    return resp;
  }).catch(() => caches.match('index.html'))));
});
