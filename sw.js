const CACHE_NAME = 'digitalmarket-v132';
const STATIC_ASSETS = [
  '/',
  '/favicon.svg',
  '/manifest.json',
  '/404.html',
  '/terms.html',
  '/privacy.html',
  '/refund.html',
  '/help.html'
];
// NOTE: '/index.html' deliberately excluded — it resolves to '/' on GitHub
// Pages and pre-caching both doubles storage + risks revalidation divergence.

const CDN_CACHE = 'digitalmarket-cdn-v6';
const CDN_ORIGINS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net',
  'browser.sentry-cdn.com',
  // Firebase SDKs + reCAPTCHA runtime — version-hashed URLs, safe to
  // cache-first; saves ~5 network roundtrips on every repeat visit.
  'www.gstatic.com'
];

// Hosts that MUST always be network-only — never cached. Signed download
// URLs, auth tokens, and any cross-user response would otherwise be served
// to the wrong buyer.
function isNeverCacheHost(url) {
  const h = url.hostname;
  return (
    h.includes('firebase') ||
    h.includes('firestore') ||
    h.includes('firebaseapp') ||
    h.endsWith('googleapis.com') ||                // ALL Google APIs incl. signed Storage URLs
    h.endsWith('googleusercontent.com') ||
    h.includes('emailjs') ||
    h.includes('sentry.io') ||
    h.includes('google-analytics.com') ||
    h.includes('googletagmanager.com')
  );
}

// Per-request bypass — even on cacheable hosts, NEVER cache a request that
// carries an Authorization header or a signing/auth query param.
function hasAuthSignal(req, url) {
  if (req.headers.has('authorization')) return true;
  const qp = url.search.toLowerCase();
  return qp.includes('token=')
      || qp.includes('alt=media')
      || qp.includes('x-goog-')
      || qp.includes('googleaccessid=')
      || qp.includes('signature=');
}

// Install: pre-cache static shell.
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_ASSETS))
    // INTENTIONALLY no skipWaiting() — the page must opt-in via postMessage
    // (`{type:'SKIP_WAITING'}`) so it can show a "new version available"
    // toast first. This fixes the mid-session chunk/patch-chain mismatch
    // where v26 HTML was loaded into a tab running v25 JS.
  );
});

// Allow the page to ask for an update.
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// Activate: remove stale caches + enable navigation preload.
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== CDN_CACHE)
          .map(k => caches.delete(k))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // ── Hard bypass: non-GET, non-https, range requests, sensitive params ──
  if (req.method !== 'GET')                   return;             // POST/PUT/DELETE → browser handles
  if (url.protocol !== 'https:'
      && url.protocol !== 'http:')            return;             // chrome-extension etc.
  if (req.headers.has('range'))               return;             // partial content can't be cached as-is
  if (isNeverCacheHost(url))                  return;             // Firebase, signed-URL hosts, analytics
  if (hasAuthSignal(req, url))                return;             // auth-carrying URL

  // ── CDN assets: cache-first with quota-safe put ──
  if (CDN_ORIGINS.some(o => url.hostname.includes(o))) {
    e.respondWith((async () => {
      const cache = await caches.open(CDN_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.status === 200 && res.type === 'basic' || res.type === 'cors') {
          try { await cache.put(req, res.clone()); } catch {}    // ignore quota errors
        }
        return res;
      } catch (e) {
        return cached || Response.error();
      }
    })());
    return;
  }

  // ── Same-origin navigation: prefer preload response when available ──
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const preload = await e.preloadResponse;
        if (preload) return preload;
      } catch {}
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req, { ignoreSearch: true });
      try {
        const net = await fetch(req);
        if (net && net.ok && net.type === 'basic') {
          try { await cache.put(req, net.clone()); } catch {}
        }
        return net;
      } catch {
        return cached || (await caches.match('/404.html'));
      }
    })());
    return;
  }

  // ── Same-origin static GET: stale-while-revalidate, with hard guards ──
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const fetchPromise = fetch(req).then(res => {
      // Only cache: 200, same-origin basic responses, with no auth/cookie
      // sensitivity. Reject opaque, redirect, and Vary:* responses.
      if (res && res.status === 200 && res.type === 'basic') {
        try { cache.put(req, res.clone()); } catch {}
      }
      return res;
    }).catch(() => cached);
    return cached || fetchPromise;
  })());
});

// ── Push notification handler ──
self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); }
  catch { data = { title: 'DigitalMarket', body: String(e.data.text?.() || '').slice(0,140) }; }
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
  e.waitUntil(self.clients.openWindow(e.notification.data?.url || '/'));
});
