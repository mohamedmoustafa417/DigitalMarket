const CACHE_NAME = 'digitalmarket-v9';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json',
  '/404.html',
  '/terms.html',
  '/privacy.html'
];

// CDN assets to cache after first load (fonts, icons, libraries)
const CDN_CACHE = 'digitalmarket-cdn-v4';
const CDN_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'browser.sentry-cdn.com'
];

// Install: pre-cache static shell immediately
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate: remove ALL stale caches so users always get fresh content
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ── Firebase / EmailJS / reCAPTCHA: always network-first, no caching ──
  if (
    url.hostname.includes('firebase') ||
    url.hostname.includes('firestore') ||
    url.hostname.includes('firebaseapp') ||
    url.hostname.includes('googleapis') && url.pathname.includes('recaptcha') ||
    url.hostname.includes('emailjs') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('sentry.io')
  ) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // ── CDN assets (fonts, FA icons, Chart.js, DOMPurify): cache-first, long TTL ──
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    e.respondWith(
      caches.open(CDN_CACHE).then(cache =>
        cache.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => {
            if (res && res.status === 200) cache.put(e.request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // ── Same-origin GET: stale-while-revalidate ──
  // Serve from cache instantly, refresh in background so next visit is fresh
  if (e.request.method === 'GET') {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(e.request).then(cached => {
          const fetchPromise = fetch(e.request).then(res => {
            if (res && res.status === 200 && res.type !== 'opaque') {
              cache.put(e.request, res.clone());
            }
            return res;
          }).catch(() => cached || caches.match('/404.html'));

          // Return cached immediately if available, otherwise wait for network
          return cached || fetchPromise;
        })
      )
    );
  }
});

// ── Push notification handler (future use) ──
self.addEventListener('push', e => {
  if (!e.data) return;
  const data = e.data.json();
  e.waitUntil(
    self.registration.showNotification(data.title || 'DigitalMarket', {
      body: data.body || '',
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: data.tag || 'dm-notif',
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow(e.notification.data.url || '/')
  );
});
