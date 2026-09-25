/**
 * Service worker: hace que la app se pueda instalar y funcione sin
 * conexión (todo el "backend" es este mismo dispositivo — los datos ya
 * viven en localStorage, esto solo cachea los archivos de la app).
 *
 * Estrategia "stale-while-revalidate" para los archivos propios: sirve
 * primero lo que hay en caché (carga instantánea, funciona offline) y en
 * paralelo pide la versión de red para actualizar la caché para la
 * próxima vez — así no hace falta acordarse de subir un número de
 * versión a mano cada vez que se cambia el código.
 *
 * No se intercepta nada de otro origen (fuentes de Google, etc.): si no
 * hay conexión simplemente no cargan, pero la app funciona igual.
 */

const CACHE_NAME = 'gimnasio-shell-v1';

const CORE_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './js/main.js',
  './js/state.js',
  './js/muscleGroups.js',
  './js/parser.js',
  './js/coach.js',
  './js/timer.js',
  './js/charts.js',
  './js/vendor/mammoth.browser.min.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return; // no tocar peticiones externas

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request);
      const network = fetch(event.request)
        .then((response) => { if (response.ok) cache.put(event.request, response.clone()); return response; })
        .catch(() => cached);
      return cached || network;
    })
  );
});
