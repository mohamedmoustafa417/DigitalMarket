# DigitalMarket

A bilingual (English / Arabic) digital marketplace for buying and selling
digital products — ebooks, templates, courses, fonts, etc. Built as a
**single-file SPA** with Firebase backend, deployed on **GitHub Pages** with
a custom domain at https://digitalmarketstore.shop.

---

## Quick reference

| | |
|---|---|
| **Live URL** | https://digitalmarketstore.shop |
| **GitHub repo** | https://github.com/mohamedmoustafa417/DigitalMarket |
| **Firebase project** | `digitalmarket-38db5` |
| **Hosting** | GitHub Pages (custom domain via CNAME) |
| **Backend** | Firebase (Firestore + Auth + Storage + Cloud Functions) |
| **Plan** | Blaze (pay-as-you-go) — required for Cloud Functions + MFA |

---

## Tech stack

```
Frontend     vanilla JS + HTML + CSS (no framework, no build step)
SDK          Firebase Web SDK 10.12.0 (compat mode)
Auth         Firebase Auth — Email + Google + Apple + Phone MFA
DB           Cloud Firestore — 22 collections with security rules
Storage      Firebase Storage — product files + KYC docs + payment proofs
Functions    9 Cloud Functions (Node 22, 2nd gen)
Charts       Chart.js 4 (deferred load)
Errors       Sentry browser SDK (deferred 2s post-load)
Analytics    Google Analytics 4 (with cookie consent gate)
Security     DOMPurify, reCAPTCHA v3, CSP, rate-limit lockout, fraud velocity
PWA          Service Worker v6 (offline support + stale-while-revalidate)
CI           GitHub Actions: sitemap regen (daily) + runtime audit (weekly)
```

---

## File structure

```
deploy/
├── index.html                          # The entire SPA (~11K lines)
├── 404.html                            # Personalized 404 with popular products
├── terms.html / privacy.html           # Legal pages
├── manifest.json                       # PWA manifest
├── sw.js                               # Service Worker
├── robots.txt / sitemap.xml            # SEO
├── favicon.svg
├── cv_thumbnail.svg                    # Product thumbnail (CV pack)
├── social_media_thumbnail.svg          # Open Graph image
├── thumbnails/                         # Per-product SVG thumbnails
│   ├── budget_tracker_thumbnail.svg
│   ├── content_calendar_thumbnail.svg
│   ├── freelancing_course_thumbnail.svg
│   ├── invoice_templates_thumbnail.svg
│   ├── productivity_ebook_thumbnail.svg
│   └── youtube_templates_thumbnail.svg
├── icons/
│   ├── icon-192.png
│   └── icon-512.png
├── firebase.json                       # Firebase project config
├── .firebaserc                         # Project alias
├── firestore.rules                     # Firestore security rules (22 collections)
├── firestore.indexes.json              # Composite indexes (11 indexes)
├── storage.rules                       # Storage security rules
├── functions/
│   ├── index.js                        # 9 Cloud Functions
│   └── package.json                    # Node 22 runtime
├── .github/workflows/
│   ├── sitemap.yml                     # Daily sitemap auto-regen
│   └── runtime-audit.yml               # Weekly Puppeteer audit + auto-issue
├── DEPLOY.ps1                          # One-click deploy script (Windows)
└── .gitignore                          # Excludes node_modules, firebase.exe, etc.
```

---

## Features (80+)

### Auth & accounts
- Email/password registration with email verification
- Google + Apple sign-in (Firebase OAuth)
- Phone-based MFA (2FA)
- Forgot password flow
- Brute-force lockout (5 attempts → 15min ban)
- Banned-user enforcement (`disabled: true` → auto sign-out)
- Seller KYC verification (ID + selfie, admin review queue)

### Marketplace
- Product browsing with category + tag filters
- Live search autocomplete with thumbnails + fuzzy match
- Trending products (by viewCount)
- Featured products
- Flash sales with countdown
- Recently Viewed carousel
- Related products on detail page
- Seller storefronts with stats + follow
- Q&A on products (seller can answer)
- Reviews (verified purchase only, with rating aggregation)
- Wishlist with localStorage + share link
- Save for Later (separate from wishlist)
- Product comparison (up to 3 side-by-side)

### Cart & checkout
- Cross-tab cart sync
- Coupon system (% off, fixed amount, expiry, usage limit)
- Multi-currency display (EGP/USD/EUR/SAR/AED/GBP)
- BNPL info panel (Tabby/Tamara/ValU for carts ≥ EGP 100)
- Free products (zero-price orders skip payment proof)
- Express "Buy Now" button (skip cart)
- Loyalty points (earn 1pt per EGP, redeem for discounts)
- Order receipt modal + "Customers also bought"
- Downloadable HTML invoice (browser print-to-PDF)
- Bulk download for multi-file orders
- 7-day refund window with admin approval

### Seller tools
- Product CRUD + bulk CSV upload
- 6-tier creator commission (5% → 2.5% based on totalSales)
- Tier badges on product cards (Silver+)
- Affiliate program with click tracking + share buttons
- Bulk product status changes
- Sales dashboard with 4 charts:
  - Monthly revenue (6 months)
  - Daily orders (30 days)
  - Top 5 products
  - Order status doughnut
- Notify buyers of product updates (version history)
- Scheduled product launch (auto-publish at date)
- Achievement badges (First Sale, 10/50/100/200 Sales, Top Rated)
- Buyer-seller direct messaging

### Admin
- Product moderation queue
- User management + verification + banning
- Coupon CRUD
- Collections (curated product bundles)
- Email campaigns (queue → batched via Cloud Function)
- KYC review queue
- Platform payment settings
- Commission rate config
- Bulk product approval

### Localization & accessibility
- English ↔ Arabic with RTL flip
- 6-currency selector (rates configurable)
- Keyboard shortcuts (H/C/O/W/?/Esc/D/L)
- Skip-to-content link
- Reduced-motion media query support
- Font size controls (small/medium/large/xlarge)
- ARIA labels on all interactive icons
- Focus management in modals (auto-focus first input)
- Inline validation with hint text

### Performance & resilience
- Service Worker with stale-while-revalidate
- Offline reload support
- WebP detection + auto srcset on product images
- Lazy loading on all images
- Connection failure banner (after 8s SDK check + 15s Firestore probe)
- Skeleton loaders with 12s timeout fallback
- Firestore product cache in localStorage (5-min TTL)
- Sentry deferred 2s for better FCP

### Trust & safety
- DOMPurify sanitization (258+ call sites)
- Content Security Policy (CSP)
- reCAPTCHA v3 on signup
- DMCA takedown form (with attestation)
- Report product/order/seller
- Client-side fraud velocity guards:
  - 5 orders/min, 10 reviews/hr, 15 Q&A/hr, 20 reports/day
- AI-powered content moderation (regex flagging)
- Banned-user auto sign-out on every page load

### Marketing & engagement
- Newsletter signup with Firestore-stored subscribers
- Exit-intent popup with 10% off code
- Real-time "X people viewing this product"
- Recently sold ticker
- Sold count badge on cards
- "X people bought this" on product detail
- Recommendations: "Customers also bought" on receipt
- Referral program (5% commission, 30-day cookie)
- Smart pricing recommendation in seller form (median by category)
- AI product description writer (template-based, OpenAI-ready)

### SEO
- Title + meta description + canonical
- Open Graph + Twitter Card meta tags
- hreflang for EN/AR
- JSON-LD: Organization + WebSite + FAQPage (per product)
- Per-product slug URLs (history.replaceState)
- Sitemap.xml auto-regen via GitHub Actions
- robots.txt

### Optional integrations (toggleable via admin panel)
- Microsoft Clarity heatmaps (free)
- Tawk.to live chat (free)

---

## Firestore data model (22 collections)

```
products            { name, price, category, sellerId, status, downloadUrl, ... }
orders              { buyerId, sellerIds, items, total, status, proof, ... }
users               { name, role, totalSales, tier, kycStatus, ... }   ← public read
reviews             { productId, buyerId, rating, comment }            ← verified-buyer only
qa                  { productId, askerId, question, answer, answererId }
notifications       { userId, type, message, read }
follows             { followerId, sellerId }                           ← O(1) doc id
disputes            { buyerId, sellerId, orderId, status }
reports             { reporterId, type, target, status }
payouts             { sellerId, amount, status }
coupons             { code, discount, type, usageCount, expiresAt }
settings            { paymentInfo, flashSale, commission }
newsletter          { email, subscribedAt }                            ← public create
affiliates          { sellerId, clicks, sales, earned }
collections         { name, productIds }                               ← admin curated
messages/{thread}   { participants, productId, lastMessage }
messages/{thread}/msgs/{id}    { senderId, text, createdAt }
kycRequests         { userId, status, name, idNum, idPhoto, selfie }
abandonedCarts      { userId, items, notified }
campaigns           { subject, body, target, status, recipientCount }
presence            { productId, userId, expiresAt }                   ← TTL-cleaned
users/{uid}/pointsLog/{id}     { type, pts, reason }
```

---

## Cloud Functions (Node 22, 2nd gen)

| Function | Trigger | Purpose |
|---|---|---|
| `onOrderStatusChange` | Firestore `orders/{id}` write | When status → approved: issue download token, license keys, loyalty points; send email |
| `cleanExpiredDownloads` | Scheduled daily 00:00 UTC | Mark `downloadExpired: true` after 30 days |
| `onProductFileDelete` | Storage `products/{seller}/*` delete | Clear `downloadUrl` on referencing product docs |
| `onNewReview` | Firestore `reviews/{id}` write | Recalculate `ratingAvg` + `ratingCount` on product |
| `generateSitemap` | HTTPS callable | Returns fresh XML with all approved product URLs |
| `abandonedCartReminder` | Scheduled daily 10:00 Cairo | Email buyers whose cart idle ≥ 24h |
| `processEmailCampaigns` | Scheduled every 5 min | Dispatch queued campaigns in batches of 50 |
| `cleanupPresence` | Scheduled every 5 min | Delete expired `presence` docs (TTL) |
| `onKYCApproval` | Firestore `kycRequests/{id}` write | Mirror admin decision to user doc + notify |

---

## Setup (from scratch)

1. **Clone** the repo
   ```
   git clone https://github.com/mohamedmoustafa417/DigitalMarket.git
   cd DigitalMarket
   ```

2. **Install Node.js LTS** from https://nodejs.org/

3. **One-click deploy** (Windows):
   ```
   .\DEPLOY.ps1
   ```
   This auto-installs Firebase CLI, prompts you to log in, then deploys
   rules + indexes + storage + functions.

4. **Manual deploy** (cross-platform):
   ```
   npm install -g firebase-tools
   firebase login
   cd functions && npm install && cd ..
   firebase deploy --only firestore:rules,firestore:indexes,storage,functions
   ```

5. **Enable in Firebase Console** (one-time manual):
   - Authentication → Sign-in providers → enable Email, Google, Apple, Phone
   - Authentication → Settings → enable SMS Multi-Factor Authentication
   - Add `digitalmarketstore.shop` to Authorized domains

6. **GitHub Pages** is wired automatically — any push to `master` deploys
   within 1–2 min. Default branch is `master` (was switched from `main`).

---

## Architecture decisions

### Why single-file SPA?
- **Zero build step** — direct git push to deploy
- **No bundler complexity** — every script tag visible in source
- **Service Worker caches one file** — second-visit load is essentially free
- **Trade-off:** 622 KB initial download, but with SW + cache headers,
  only first visit pays the cost

### Why Firebase?
- **No backend server to maintain** — Firestore + Cloud Functions cover all
  server-side logic (order processing, email, scheduled jobs)
- **Built-in auth** with Google/Apple/Phone + 2FA
- **Real-time** out of the box (used for messaging + presence + order status)
- **Free tier** covers up to ~1K daily active users; Blaze plan auto-scales

### Why GitHub Pages (not Firebase Hosting)?
- **Free with custom domain** + Cloudflare-class CDN
- **Atomic git-based deploys** with full version history
- **No build/release pipeline to maintain**

### Why no framework?
- **Solo developer + AI-pair-programming workflow** — frameworks add cognitive overhead
- **Single file makes code searchable** with grep/Ctrl-F
- **Patches via IIFE wrappers** instead of state management refactors

---

## Patching pattern

Every feature added in later rounds uses a non-invasive IIFE wrapper:

```js
(function patchFeatureName() {
  const orig = window.someFunction;
  if (typeof orig !== 'function') return;
  window.someFunction = async function(...args) {
    await orig.apply(this, args);
    // ...new behavior...
  };
})();
```

This means: every round of features is layered on top of the previous one
without modifying the original code. Easy to remove a feature: comment out
its IIFE.

---

## Security model

| Layer | Mechanism |
|---|---|
| Network | HTTPS-only (custom domain via GitHub Pages) |
| Headers | CSP, X-Content-Type-Options, Referrer-Policy |
| Input | DOMPurify on every dynamic HTML insertion |
| Auth | Firebase Auth + 2FA + lockout + reCAPTCHA |
| Firestore | Rules: 22 collections, 36 admin-gated checks, owner-only writes |
| Storage | KYC owner-only read, products max 200MB, proofs max 2MB |
| Fraud | Client-side velocity (5 orders/min, etc.) |
| Privacy | Cookie consent gate before GA + Sentry load |
| Compliance | GDPR cookies, DMCA takedown form, e-Invoice TIN field |

---

## CI / monitoring

**`.github/workflows/sitemap.yml`** — Runs daily at 03:00 UTC. Calls the
`generateSitemap` Cloud Function and commits `sitemap.xml` if changed.

**`.github/workflows/runtime-audit.yml`** — Runs Mondays 04:15 UTC + on every
push to `index.html`. Spins up Puppeteer + Chromium, loads the live site,
runs functional smoke tests, and opens a GitHub Issue if any check fails.

**Sentry** — Captures every uncaught exception. Free tier covers ~5K events/month.

**Google Analytics** — Tracks page views + purchase events + custom events
(`view_item`, `add_to_cart`, `purchase`, `share_referral`, etc.).

**Web Vitals** — LCP/CLS/FID/INP reported to GA4 as custom events.

---

## Known limitations

1. **No real payment gateway yet** — buyers upload proof of payment;
   sellers/admin manually approve. Stripe + Paymob integration is the
   single biggest blocker to scaling.
2. **No SSR** — product pages render client-side; SEO relies on JSON-LD
   schemas + sitemap. For better organic ranking, consider migrating to
   Next.js + Vercel.
3. **Single Firestore region (us-central1)** — adds ~100ms latency for
   MENA users. Firestore auto-replicates reads, but writes are single-region.
4. **No e-Invoice integration yet** — TIN field collects the data, but ETA
   submission flow needs Egyptian Tax Authority sandbox credentials.

---

## Recent commits (10 most recent shown by `git log --oneline`)

```
3301788 feat+ux: 6 polish improvements from comprehensive audit
c6e3d02 fix+ux: resilient skeleton timeout + Firebase failure detection
5696db4 fix: storefront broken because /users/{uid} required sign-in
0b24ddb fix: remove X-Frame-Options meta tag
e460451 fix: Google sign-in CSP + duplicate currency + card visuals
7870133 feat: UI/UX + Tier A/B Pack — 19 features
6a689a8 fix: deep audit — wishlist key bug + a11y + mobile overflow
432e27b fix: 3 user-reported bugs (indexes, sign-in nav, SVG)
0f6dc8f fix: 3 runtime bugs via headless browser audit
ac627fa chore: Firebase deploy config + one-click deploy script
```

---

## License

All rights reserved. Source available for personal review only.

## Contact

- Support: support@digitalmarketstore.shop
- DMCA: use the in-app DMCA notice form (footer link)
- Issues: https://github.com/mohamedmoustafa417/DigitalMarket/issues
