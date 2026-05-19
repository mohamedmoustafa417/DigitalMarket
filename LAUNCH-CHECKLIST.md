# DigitalMarket — Pre-Launch Audit & Runbook

> Status: **READY TO INVITE REAL BUYERS** (gated only on Kashier payment-gateway approval).
> Last updated after commit `3d3d997`. SW cache: `v40`.
> Every section below is a **completed** audit unless explicitly marked
> ⚠️ DEFERRED.

---

## 🟢 1. Email (DONE)

- ✅ Domain `digitalmarketstore.shop` verified at Resend
- ✅ DKIM + SPF + bounce-MX records live at Namecheap
- ✅ PrivateEmail MX records preserved (`support@` inbox still receives)
- ✅ All transactional email flows through **one** pipeline (Cloud Function → Resend)
  - `order_submitted` → buyer confirmation + admin notification
  - `order_approved` → download links email
  - `order_rejected` → rejection notice with reason
  - `refunded` → refund confirmation
- ✅ Failures land in `/emailFailures` Firestore collection (admin UI surfaces them)
- ✅ Buyer email **hashed** in Cloud Logging (GDPR — no raw PII in logs)
- ✅ `processEmailCampaigns` hardened: timeout 540s, memory 512MiB,
  transactional `queued→sending` claim (no double-send on overlap)

**Operational:**
- Resend free tier: 3,000 sends/month, 100/day. Upgrade before exceeding.
- API key stored in Firebase Secret Manager (`RESEND_KEY`).
- To rotate: `firebase functions:secrets:set RESEND_KEY` → redeploy any
  function using `EMAIL_SECRETS`.

---

## 🟢 2. Payment proof flow (DONE — pending Kashier)

- ✅ Buyer uploads payment screenshot at checkout step 3
- ✅ Screenshot stored in `/proofs/{uid}/{ts}.jpg` (Storage)
- ✅ 5 MB max, image/* only, SVG blocked
- ✅ CSP `img-src 'blob:'` allowed (was the cause of "could not read image" bug)
- ✅ Admin reviews + clicks Approve / Reject in `/view-admin` orders tab

**When Kashier approves your merchant application:**
1. Drop their SDK script tag in `<head>`
2. Replace the InstaPay/Bank dropdown options with a Kashier hosted-checkout
   call inside `onPayMethodChange()`
3. Add a webhook Cloud Function to receive payment-success callbacks
4. Auto-approve orders on webhook fire (instead of admin manual approve)

---

## 🟢 3. Security — Firestore rules

Every collection has explicit, audited rules in `firestore.rules`. Highlights:

| Collection | Read | Write notes |
|---|---|---|
| `/users` | sign-in required | Self-update **allowlist** (12 fields). No self-promote to admin / verified / role. KYC fields admin-only. |
| `/publicProfiles` | public | Admin-only write (CF `mirrorPublicProfile` syncs safe fields). |
| `/products` | approved or owner | Seller can't self-approve. Status confined to `{pending, draft}` for sellers. |
| `/orders` | buyer + sellers + admin | Status writes admin-only. Seller can only add `sellerNote`. Buyer cannot modify. |
| `/reviews` | public | Rating must be 1–5 int. Must have approved order for the product (rule-enforced). |
| `/coupons` | public | `usageCount` increment-only (`==old+1`). Stops bypass. |
| `/pointsLog` | self | Buyer can ONLY write `redeem` entries with negative pts. CF settles balance. |
| `/notifications` | self | Sellers can only notify themselves (anti-spam). |
| `/payouts` | self + admin | Status changes admin-only. |
| `/messages` | participants | Participants list immutable on update. |
| `/kycRequests` | self + admin | Admin reviews. |
| `/emailFailures` | admin | CF-written (admin SDK bypasses rules). |
| `/downloadLog` | admin | Append-only audit by CF. |
| `/uploadViolations` | admin | MIME-mismatch deletions logged. |
| `/abandonedCarts` | self + admin | Used by CF + admin Nudge UI. |
| `/presence` | public read, self/admin write | Doc-ID must = uid. |

---

## 🟢 4. Security — Storage rules

| Path | Read | Write |
|---|---|---|
| `/proofs/{uid}/*` | uploader + admin | Self, 2 MB, image/* (no SVG) |
| `/products/{seller}/*` | any auth | Owner, 200 MB, broad MIME (no SVG) — quota enforced |
| `/kyc/{uid}/*` | uploader + admin | Self, 5 MB, image/* (no SVG) |

- ✅ **SVG XSS** vector closed (was a `<script>`-in-SVG-via-avatar risk)
- ✅ **Per-seller upload quota** 10 GiB enforced by `onProductFileFinalized` CF
- ✅ **MIME magic-byte verification** — uploads with declared `image/jpeg`
  that don't match `FF D8 FF` are auto-deleted and logged

---

## 🟢 5. Download security

The 30-day `downloadExpired` flag is now **authoritative** (was cosmetic):

- ✅ Front-end **only** calls `downloadFile` Cloud Function (no raw Storage URLs)
- ✅ Buyer must present: Firebase ID token + order's `downloadToken` + productId
- ✅ CF validates: token timing-safe, buyer matches, status `approved`,
  expiry not passed, product is in the order
- ✅ Returns a **5-minute V4 signed URL** with `Content-Disposition: attachment`
- ✅ Every successful download logged to `/downloadLog` (IP + uid + timestamp)
- ✅ SW NEVER caches signed-URL responses (`*.googleapis.com` + Authorization
  header + token=/X-Goog-/signature= query params all bypass cache)

---

## 🟢 6. Cloud Functions (13 deployed)

All Node 22, 2nd gen. Confirmed via `firebase functions:list`:

| Function | Trigger | Region | Purpose |
|---|---|---|---|
| `onOrderStatusChange` | Firestore `orders/{id}` write | us-central1 | Order-lifecycle email + token issue + loyalty + tier (transactional, idempotent) |
| `cleanExpiredDownloads` | Daily 00:00 UTC | us-central1 | Marks expired (`downloadExpired:true`) |
| `onProductFileDelete` | Storage delete | us-east1 | Cleans product `downloadUrl` + decrements seller quota |
| `onProductFileFinalized` | Storage upload | us-east1 | MIME magic check + seller quota tally |
| `onProductDocDelete` | Firestore `products/{id}` delete | us-central1 | Cascades Storage object delete |
| `onNewReview` | Firestore `reviews/{id}` write | us-central1 | Recomputes product ratingAvg + ratingCount |
| `mirrorPublicProfile` | Firestore `users/{uid}` write | us-central1 | Syncs safe fields to /publicProfiles |
| `onKYCApproval` | Firestore `kycRequests/{id}` write | us-central1 | Mirrors admin decision to user doc |
| `abandonedCartReminder` | Daily 10:00 Cairo | us-central1 | Sends recovery emails (only on success flips `notified`) |
| `processEmailCampaigns` | Every 5 min | us-central1 | Admin campaign dispatcher with transactional claim |
| `emailHealthCheck` | HTTPS callable | us-central1 | Admin can send test email |
| `generateSitemap` | HTTPS callable | us-central1 | Admin-only sitemap utility |
| `downloadFile` | HTTPS onRequest | us-central1 | Signed-URL download proxy with auth + audit |

**Idempotency:** `onOrderStatusChange` has an `approvalProcessedAt` guard so
admin re-toggling pending↔approved cannot re-issue tokens / re-bump tier /
re-award points.

**Race-safe:** Seller tier update wrapped in `db.runTransaction`.
Loyalty redeem + earn settled in one transaction with balance check.

---

## 🟢 7. Front-end — what shipped

- ✅ Service Worker v40 — opt-in updates ("New version available" toast),
  no signed-URL caching, navigation preload, quota-safe `cache.put`
- ✅ Multi-step **checkout wizard** (Review → Payment → Confirm)
- ✅ **Inbox view** — all conversations with real-time unread badge
- ✅ **Customer-support thread** — buyer ↔ admin via shared messages schema
- ✅ **Wishlist** — v2 cards + inline "Move to Cart" button
- ✅ **Admin dashboards**:
  - Orders (real-time)
  - Products / Users / Settings / Coupons / Announcements
  - Disputes / Payouts / Reports / Collections
  - **Abandoned Carts** (one-click Nudge)
  - **Stats** (30-day KPIs + daily chart + top sellers/products + status mix)
  - **Email Failures** (CF-written queue)
  - **Review Moderation** (rating filter + cascade-aware delete)
- ✅ **Seller dashboards**: Products / Orders / Settings / Affiliate /
  Notify Buyers / **Stats** (revenue trend + top items)
- ✅ All prices flow through **one** `formatPrice` helper

---

## 🟢 8. UX polish landed

- ✅ Toast v2: dedup, max-4 visible, dismiss button, pause-on-hover, proper
  ARIA roles (alert vs status)
- ✅ Skeleton shimmer loaders + `dmEmpty` + `dmBtnLoading` helpers
- ✅ Product card v2: stacked badges with RTL mirroring, bigger price tag,
  rating pill, hover lift gated to `(hover: hover)` devices
- ✅ Product-detail modal: hero price + trust badges + rating summary
- ✅ Visible keyboard focus indicators (was `outline:none`)
- ✅ Cart-count + inbox-count have `aria-live="polite"`
- ✅ Combobox ARIA pattern on search autocomplete
- ✅ RTL Arabic: search/chevron/stepper icons mirror; cart badge re-anchored;
  table cells honor RTL alignment; tour arrow flips
- ✅ iOS safe-area-inset on all fixed-bottom elements
- ✅ `100dvh` modals (don't get cut off behind iOS URL bar)
- ✅ Hover-stuck-on-touch fixed (cards no longer permanently zoomed after tap)
- ✅ Reduced-motion gated for hero, view transitions, mesh gradients

---

## 🟢 9. Observability

- ✅ **Sentry**: release tagged (`digitalmarket@v30`), `beforeSend` scrubs
  password/OTP/KYC/card/bank/email from breadcrumbs, drops ResizeObserver
  + non-Error rejection noise, `setUser({id})` on auth (UID only, no PII).
- ✅ **GA4** (G-1V97FVKRRJ) — consent-gated, fires `view_item`,
  `add_to_cart`, `purchase`, `search`, `pwa_install_accepted`.
- ✅ **GitHub Actions**:
  - `runtime-audit.yml` — weekly + on push to index.html, Puppeteer smoke
    + auto-issue creation
  - `sitemap.yml` — daily, Firestore REST → sitemap.xml
- ✅ Email-failure queue is admin-visible
- ✅ Download audit log is admin-readable
- ✅ Upload-violation log captures MIME mismatches

---

## 🟢 10. Kashier compliance pack

- ✅ `/refund.html` — Egyptian Consumer Protection Law 181/2018 compliant
- ✅ `terms.html` §6 — explicit SMM ban (followers/likes/views/SMM-panels for
  IG/TikTok/FB/YT/X/LinkedIn/Telegram/Snap)
- ✅ Footer 4-column block: About (categories sold + what's prohibited),
  Contact (mobile / WhatsApp / email / address), Marketplace links, Legal
- ✅ Real contact details: +20 115 001 5688 · 44 Helmy Hassan St., from
  Makram Ebeid, 8th Zone, Nasr City, Cairo, Egypt
- ✅ JSON-LD `Organization` schema carries the same phone + structured address

---

## ⚠️ DEFERRED / NEXT-ROUND

These are real items still on the list. None blocks launch:

1. **Kashier SDK integration** — waiting on merchant approval. ~1 hour of
   work once their docs are accessible (replace pay-method dropdown +
   add webhook CF).
2. **Down-arrow image transformer / Cloudinary** — product images served
   raw. Lighthouse LCP would improve with a CDN-transform layer.
3. **`productBuyers/{productId}` denormalized index** — the product-update
   buyer-notification scan is currently capped at 2000 most-recent orders.
   At >5k orders/month it'll start missing tail buyers.
4. **SendGrid fallback** — `sendEmail` already supports it, but
   `SENDGRID_KEY` secret isn't set. Optional resilience.
5. **CF-side support-thread email** — when a buyer opens a support thread
   right now, the admin only sees it next time they open Inbox. A simple
   `onMessageCreated` CF could ping admin's email on `kind:'support'`.
6. **Lighthouse pass** — full Core Web Vitals run with fixes.

---

## 🛠 Operational runbook

### Deploying

```powershell
# Site only (HTML changes pushed to GitHub Pages via master)
cd C:\Users\LapTop\Downloads\Claude\deploy
Copy-Item ..\index_improved.html index.html -Force
# bump CACHE_NAME in sw.js
git add -A; git commit -m "..."
git push origin master
git checkout main; git merge master --ff-only; git push origin main; git checkout master
```

```powershell
# Cloud Functions
npx firebase-tools@latest deploy --only functions:NAME --project digitalmarket-38db5 --non-interactive --force
```

```powershell
# Rules
npx firebase-tools@latest deploy --only firestore:rules,storage --project digitalmarket-38db5 --non-interactive --force
```

### Monitoring

- **Sentry**: https://o4511384678694912.sentry.io/projects/4511384696258560
- **Firebase Console**: https://console.firebase.google.com/project/digitalmarket-38db5
- **GA4**: property G-1V97FVKRRJ
- **Resend dashboard**: https://resend.com/domains
- **Site live**: https://digitalmarketstore.shop/

### Common debug paths

| Symptom | First place to look |
|---|---|
| Buyer didn't get download email | `/emailFailures` admin tab |
| "Could not read image" on upload | CSP `blob:` (already fixed); user must hard-reload |
| Permission-denied from client | `firestore.rules` for that collection match block |
| Storefront stuck loading | CF logs for `mirrorPublicProfile` |
| Stale UI on returning users | Did you bump `CACHE_NAME`? |
| Sentry quota exhausted | `tracesSampleRate` = 0.2; bump down if needed |
| Cold-start latency | Functions are 2nd-gen, min instances = 0 (cheap, ~3s cold) |
