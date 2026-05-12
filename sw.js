const CACHE_NAME = 'digitalmarket-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json',
  '/404.html',
  '/terms.html',
  '/privacy.html'
];

// Install: pre-cache static shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: remove stale caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: network-first for Firebase/APIs, cache-first for static assets
self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Always go network-first for Firebase, EmailJS, reCAPTCHA, fonts
  if (
    url.includes('firebase') ||
    url.includes('googleapis') ||
    url.includes('emailjs') ||
    url.includes('recaptcha') ||
    url.includes('gstatic.com') ||
    url.includes('cdnjs')
  ) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for same-origin static assets
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) return cached;
        return fetch(e.request).then(res => {
          if (!res || res.status !== 200 || res.type === 'opaque') return res;
          const clone = res.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
          return res;
        }).catch(() => caches.match('/404.html'));
      })
    );
  }
});
