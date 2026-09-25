/**
 * Service worker: hace que la app se pueda instalar y funcione sin
 * conexión (todo el "backend" es este mismo dispositivo — los datos ya
 * viven en localStorage, esto solo cachea los archivos de la app).
 *
 * Estrategia "red primero" para los archivos propios: con conexión
 * siempre se carga la última versión publicada (un arreglo llega en la
 * primera apertura, no en la segunda) y se guarda en caché; sin conexión,
 * o si la red tarda más de NETWORK_TIMEOUT_MS (señal débil en el
 * gimnasio), se usa la copia guardada. No hace falta subir un número de
 * versión a mano cada vez que se cambia el código.
 *
 * No se intercepta nada de otro origen.
 */

const CACHE_NAME = 'gimnasio-shell-v6';
const NETWORK_TIMEOUT_MS = 3000;

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
  './js/icons.js',
  './fonts/inter-variable-latin.woff2',
  './fonts/oswald-variable-latin.woff2',
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
      const network = fetch(event.request).then((response) => {
        if (response.ok) cache.put(event.request, response.clone());
        return response;
      });
      network.catch(() => { /* el rechazo se maneja abajo; evita el aviso de promesa sin capturar */ });
      const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS));
      try {
        const response = await Promise.race([network, timeout]);
        if (response) return response;
      } catch (e) { /* sin conexión: seguimos con la caché */ }
      const cached = await cache.match(event.request, { ignoreSearch: true });
      return cached || network; // sin copia guardada, esperamos a la red aunque tarde
    })
  );
});
