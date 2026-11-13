/* Service worker de /carga/: solo guarda el cascarón estático (página, manifest, iconos y librerías propias de vendor/)
   para poder instalar la app y abrirla rápido. Nunca toca Supabase (REST, auth, realtime), nada de otro origen ni nada
   que no sea GET: esas peticiones ni se interceptan. Solo se guarda una respuesta correcta (res.ok) de este mismo sitio
   (tipo 'basic'): nunca una respuesta opaca ni un error. */
const VERSION = 'v2';                       // súbelo si cambia la lista de archivos del cascarón o una librería de vendor/
const CACHE = 'statistics-carga-' + VERSION;
const CASCARON = ['./', 'manifest.webmanifest', 'iconos/icono-192.png', 'iconos/icono-512.png',
  'iconos/icono-maskable-512.png', 'iconos/apple-touch-icon.png', 'iconos/favicon-32.png', 'iconos/favicon.svg', 'iconos/logo.svg',
  'vendor/xlsx.full.min.js', 'vendor/chart.umd.min.js', 'vendor/supabase.min.js'];
const guardable = res => !!res && res.ok && res.type === 'basic';

self.addEventListener('install', e => {
  // Cada archivo por separado: si uno falla, se guardan los demás.
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(CASCARON.map(u =>
    fetch(u, { cache: 'no-cache' }).then(res => guardable(res) ? c.put(u, res) : null).catch(() => {}))))
    .then(() => self.skipWaiting()));      // el cascarón es red-primero: activar ya no deja la página mezclada con versión vieja
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('statistics-carga-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;                                     // Supabase, fuentes y todo lo ajeno: directo a la red
  if (!url.pathname.startsWith(new URL('./', location.href).pathname)) return;   // solo /carga/
  if (url.pathname.endsWith('/sw.js')) return;
  // Red primero: una versión nueva publicada se ve de inmediato; sin conexión, la copia guardada.
  e.respondWith(fetch(req).then(res => {
    if (guardable(res)) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true })
    .then(r => r || (req.mode === 'navigate' ? caches.match('./') : undefined))
    .then(r => r || Response.error())));
});
