/* Mon Sport : fonctionnement hors connexion */
const VERSION = 'sport-v0.4.0';
const FILES = ['./', 'index.html', 'cloud.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
const SDK = 'https://www.gstatic.com/firebasejs/';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== 'sport-sdk').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Bibliothèque Firebase : gardée en cache pour démarrer même sans réseau.
  if (req.url.startsWith(SDK)) {
    e.respondWith(caches.open('sport-sdk').then((c) => c.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok) c.put(req, res.clone());
      return res;
    }))));
    return;
  }
  if (url.origin !== location.origin) return;

  // Fichiers de l'appli : d'abord le réseau (pour avoir la dernière version), le cache si pas de réseau.
  e.respondWith(
    caches.open(VERSION).then((cache) =>
      Promise.race([fetch(req, { cache: 'no-cache' }), timeout(4000)])
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => cache.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)))
    )
  );
});

// Toucher la notification de fin de repos ramène dans l'appli.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if ('focus' in c) return c.focus(); }
    return self.clients.openWindow('./');
  }));
});
