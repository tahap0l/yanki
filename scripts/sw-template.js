/* Yankı service worker — derlemede scripts/pwa-plugin.ts tarafından üretilir. */
const VERSION = '__VERSION__';
const SHELL = `yanki-shell-${VERSION}`;
const MEDIA = 'yanki-media-v1';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('yanki-shell-') && k !== SHELL) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // yalnız kendi kaynaklarımız; Spotify, Google, YouTube istekleri hiç işlenmez
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  // sayfa gezintisi: önce ağ (OAuth dönüş parametreleri dahil), çevrimdışıysa kabuk
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        const c = await caches.open(SHELL);
        return (await c.match(new URL('index.html', scope).href, { ignoreVary: true })) || (await c.match(scope.href, { ignoreVary: true })) || Response.error();
      }
    })());
    return;
  }

  // demo sesleri: ilk çalışta önbelleğe, sonra önbellekten (aralık istekleri tam yanıttan karşılanır)
  if (url.pathname.includes('/demo/')) {
    event.respondWith((async () => {
      const c = await caches.open(MEDIA);
      const key = url.origin + url.pathname;
      let res = await c.match(key, { ignoreVary: true });
      if (!res) {
        try {
          res = await fetch(key);
          if (res.ok && res.status === 200) await c.put(key, res.clone());
        } catch {
          return Response.error();
        }
      }
      const range = req.headers.get('range');
      if (!range || res.status !== 200) return res;
      const buf = await res.arrayBuffer();
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const size = buf.byteLength;
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (m && !m[1] && m[2]) { start = size - parseInt(m[2], 10); end = size - 1; }
      end = Math.min(end, size - 1);
      return new Response(buf.slice(start, end + 1), {
        status: 206,
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        },
      });
    })());
    return;
  }

  // uygulama kabuğu: önbellek, yoksa ağ (katalog: önce ağ)
  if (url.pathname.endsWith('catalog.json')) {
    event.respondWith(fetch(req).then(async (res) => {
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone());
      return res;
    }).catch(async () => (await caches.match(url.href, { ignoreVary: true })) || Response.error()));
    return;
  }
  // modül betikleri CORS kipinde istenir (Origin başlığı); Vary eşleşmesi önbelleği ıskalatmasın
  event.respondWith(caches.match(url.href, { ignoreVary: true, ignoreSearch: true }).then((hit) => hit || fetch(req)));
});
