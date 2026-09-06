'use strict';

// HADJ Dialysis Intelligence — Service Worker (P3, avis expert : "offline-first").
//
// Scope strictement limité au coquille applicative (le HTML lui-même) : après une
// première visite réussie, la page se recharge même sans réseau du tout (pas
// seulement backend injoignable). Les données cliniques (flotte, audit) sont
// gérées séparément côté page via IndexedDB (voir HADJ-ASSISTANT.html) — jamais
// mises en cache ici, pour ne jamais servir une réponse API authentifiée périmée
// à l'aveugle.
//
// Politique : réseau d'abord, repli cache si offline. Aucune interception des
// requêtes API/POST — seule la navigation vers "/" est concernée.

const CACHE_NAME = 'hadj-shell-v1';
const SHELL_URL = '/';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.add(SHELL_URL))
      .catch(() => {})   // pas de réseau au moment de l'install → pas grave, on retentera au fetch
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;                 // jamais toucher aux POST/PUT/DELETE (login, audit, secrets…)

  const url = new URL(req.url);
  const isShellNav = req.mode === 'navigate' || url.pathname === '/';
  if (!isShellNav) return;                            // laisse passer /api/*, /docs, etc. sans interception

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(SHELL_URL, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(SHELL_URL))
  );
});
