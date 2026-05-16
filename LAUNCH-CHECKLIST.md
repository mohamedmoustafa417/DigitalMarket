# Pre-Launch Checklist

Everything that needs to happen between **"code is ready"** (we are here)
and **"safe to invite real users"**. Sorted by priority. Payment gateway
(Paymob/Stripe) is out of scope per your decision.

---

## 🔴 MUST DO (site cannot operate properly without these)

### 1. Pick + connect a transactional email provider
**Why:** Right now every email the backend sends — order approval, refund
notification, abandoned cart reminder, admin campaigns, KYC decision —
is silently dropped. Users will think your site is broken.

**Action:**
- [ ] Sign up at **https://resend.com** (recommended — 3,000 emails/mo free,
      modern API) OR **https://sendgrid.com** (legacy — 100/day free).
- [ ] Verify sender domain (`digitalmarketstore.shop`) — Resend/SendGrid
      give you DNS records (TXT/CNAME) to add at your domain registrar.
      This typically takes 15 min DNS propagation.
- [ ] Get an API key.
- [ ] Set it as a Firebase secret + redeploy:
      ```
      firebase functions:secrets:set RESEND_KEY
      # paste the key when prompted, hit enter
      firebase deploy --only functions
      ```
- [ ] Test: place a test order, change its status to `approved` in
      Firestore Console — verify the buyer receives the email.

**Time:** ~45 min including DNS propagation.

---

### 2. Fill in real legal page content
**Why:** `terms.html` and `privacy.html` exist but contain placeholder /
generic content. Required for GDPR + just for buyer trust.

**Action:**
- [ ] **terms.html**: edit to include your real business name, Egyptian
      VAT registration number (if applicable), governing law (Egyptian law),
      dispute resolution, refund window (7 days — match the code).
- [ ] **privacy.html**: list every data type you collect (email, phone, KYC
      docs, payment info), retention periods, GDPR rights (access, delete,
      portability), DPO contact, sub-processors used (Firebase/Google).
- [ ] Add a **Cookie Policy** section to privacy.html — what GA + Sentry
      collect, that consent banner gates loading.
- [ ] Generate from a template if you don't have legal counsel:
      https://www.termly.io or https://www.iubenda.com (paid).

**Time:** 1–2 hours.

---

### 3. Set up customer support inbox
**Why:** `support@digitalmarketstore.shop` is referenced 8 times in the app
(footer, refund flow, DMCA, error toasts). If it doesn't actually receive
mail, every escalation lands in the void.

**Action:**
- [ ] Create the inbox via your domain registrar / hosting (Cloudflare,
      Google Workspace, Zoho — Zoho Mail Lite is free for 5 users).
- [ ] Add MX records.
- [ ] Set up an **auto-responder** for first response within X hours.
- [ ] Test: send mail from a Gmail account, confirm it arrives.

**Time:** 30 min.

---

### 4. Seed real product catalog
**Why:** 8 demo products from 1 admin account looks like a beta. Network
effects don't activate below ~50 products from ~10+ sellers.

**Action:**
- [ ] Recruit 10–20 friendly first sellers (creators in your network).
- [ ] Each uploads 3–5 products via the existing flow.
- [ ] As admin, batch-approve via `/admin` → Products → bulk approve.
- [ ] Verify each product page renders correctly with the new SVG aspect
      ratios (no awkward cropping).

**Time:** Ongoing recruiting — but **don't launch publicly until ≥30 live
products** or organic discovery will feel sparse.

---

### 5. Verify your admin account
**Why:** Several flows (KYC review, refund approve, coupon CRUD, email
campaigns, product moderation) need an account with `role: 'admin'`.

**Action:**
- [ ] Log into the live site with your account.
- [ ] In Firebase Console → Firestore → `users/{your-uid}` → manually
      change `role` from `buyer` (or `seller`) to `admin`.
- [ ] Refresh the site. Confirm `/admin` view loads.

**Time:** 5 min.

---

## 🟡 SHOULD DO (significantly improves operation)

### 6. Sentry alert rules
**Why:** Sentry currently *captures* errors but won't notify you of spikes.
A regression could ship and you'd never know unless you check the Sentry
dashboard manually.

**Action:**
- [ ] https://sentry.io → Project → Alerts → New Alert Rule
- [ ] "When the number of new issues created" > 5 in 1 hour → Send email.
- [ ] Optionally: "When any new issue has 10+ events" → Send email.

**Time:** 10 min.

---

### 7. Uptime monitoring
**Why:** GitHub Pages is reliable but Firebase outages happen. Get
notified immediately if either is down.

**Action:**
- [ ] https://uptimerobot.com — free for 50 monitors.
- [ ] Add monitor for `https://digitalmarketstore.shop` (HTTP 200, every 5 min).
- [ ] Add monitor for `https://firestore.googleapis.com/v1/projects/digitalmarket-38db5/databases/(default)/documents/settings/payment`
      (HTTP 200 — proves Firestore is reachable).
- [ ] Email yourself on failure.

**Time:** 15 min.

---

### 8. Submit sitemap to search engines
**Why:** Without this Google can take weeks to discover your products.
The sitemap.xml is already generated (and auto-regen'd daily via GitHub
Actions). You just need to tell search engines it exists.

**Action:**
- [ ] **Google Search Console** (https://search.google.com/search-console):
      - Add property `digitalmarketstore.shop`
      - Verify via DNS TXT record OR by uploading the verification meta
        tag (give me the tag and I'll add it to `index.html`)
      - Submit sitemap: `https://digitalmarketstore.shop/sitemap.xml`
- [ ] **Bing Webmaster Tools** (https://www.bing.com/webmasters): same flow.

**Time:** 20 min.

---

### 9. Firestore scheduled backups
**Why:** If a Cloud Function bug corrupts data, you need a snapshot to
restore from.

**Action:**
- [ ] Firebase Console → Firestore → Backups → Schedule backups
- [ ] Daily, 30-day retention. Free for projects under ~10 GB.

**Time:** 5 min.

---

### 10. GA4 conversion events
**Why:** GA4 tracks page views by default. You want to track *business*
events: purchase, signup, add-to-cart.

**Action:**
- [ ] GA4 → Admin → Events → Mark as conversion:
      - `purchase` (already fires in `submitOrder`)
      - `sign_up` (need to add — let me know and I'll wire it)
      - `add_to_cart` (need to add)
      - `view_item` (already fires)
- [ ] Configure goals so you can see funnel.

**Time:** 15 min + 5 min code (I add the events).

---

## 🟢 NICE TO HAVE (polish, not blocking)

### 11. Lighthouse production audit
- [ ] Run Lighthouse from Chrome DevTools on production. Target: ≥90 on
      all four categories (Performance / Accessibility / Best Practices / SEO).
- [ ] Share the report — I'll fix anything ≥10 points below target.

### 12. Cross-browser smoke test
- [ ] Safari (macOS + iOS) — known quirk: backdrop-filter prefix needed (already done)
- [ ] Firefox — known quirk: scrollbar style different (low impact)
- [ ] Edge — should be Chrome-identical
- [ ] Samsung Internet — biggest market share for Android in MENA

### 13. PWA install promo
- [ ] After 2 visits, prompt user to "Add to Home Screen" via the install
      event. Currently the PWA works but doesn't suggest install.

### 14. FAQ / Help center page
- [ ] Create `help.html` with answers to: "How do I become a seller?",
      "How long does approval take?", "How do refunds work?", "Why was my
      product rejected?". I can scaffold this if you draft the content.

### 15. Brand assets
- [ ] Higher-quality favicon variants: 16x16, 32x32, 192x192, 512x512 PNG
      (currently only SVG exists)
- [ ] OG image specifically sized 1200x630 (currently the SVG works but
      Twitter/LinkedIn prefer PNG/JPG)
- [ ] Logo variants (light/dark, square/horizontal) for embedding elsewhere

### 16. Onboarding tour for first-time visitors
- [ ] Spotlight tour highlighting: search, currency switch, profile menu,
      wishlist, "Become a seller". I can build this with a simple step-by-step
      overlay (~2hr).

---

## 🔧 OPTIONAL HARDENING

### 17. Two-Factor Auth: nudge sellers to enable it
- [ ] After 5 sales, show a one-time modal: "Protect your earnings —
      enable 2FA". Code already supports it (`setupTwoFactor`); just need
      the nudge logic.

### 18. Rate limiting on Cloud Functions
- [ ] Currently we have client-side velocity guards (5 orders/min, etc.).
      For server-side enforcement, add Firestore-based rate limiting in the
      `onOrderStatusChange` etc. functions.

### 19. Backup of Storage bucket
- [ ] Cloud Storage doesn't have native backups like Firestore.
- [ ] Set up a weekly `gsutil rsync` to a backup bucket OR use the new
      Firebase Backups for Storage (in preview).

### 20. Custom email templates
- [ ] Firebase Authentication → Templates: customize the email-verification
      email, password-reset email, etc. Defaults look like phishing.

---

## 🚀 GO-LIVE DAY CHECKLIST (do these in order)

1. [ ] Items 1–5 above complete
2. [ ] Final hard-refresh + click-test on a fresh incognito window
3. [ ] Verify SW cache version current (currently `v16`)
4. [ ] Items 6, 7, 8 done
5. [ ] Announce on your own channels (Twitter/IG/email)
6. [ ] Watch Sentry + Firebase Console + uptime monitor for first 4 hours
7. [ ] Check support@digitalmarketstore.shop hourly for issues

---

## 📊 What's already DONE (don't re-do these)

- ✅ Code reviewed by `security-review`, `review`, `simplify` skills
- ✅ 2 HIGH security vulns fixed
- ✅ 9 code-quality bugs fixed
- ✅ 36 UX/visual improvements
- ✅ 10 Cloud Functions deployed on Node 22
- ✅ 22 Firestore collections with security rules
- ✅ CSP locked down (with Firebase auth iframe allow-listed)
- ✅ 2FA / Phone MFA enabled in Firebase
- ✅ Google sign-in enabled
- ✅ Custom domain `digitalmarketstore.shop` authorized
- ✅ Service Worker v16 (force-refresh on update)
- ✅ Sentry integrated (just needs alert rules)
- ✅ GA4 integrated (just needs conversion goals)
- ✅ Weekly Puppeteer audit running via GitHub Actions
- ✅ Daily sitemap regen via GitHub Actions
- ✅ Mobile bottom nav + tablet 3-col layout + large-desktop 1400px
- ✅ OLED true-black mode + save-data mode + reduced-motion respect
- ✅ Glassmorphism modals + layered shadows + mesh hero
- ✅ Form draft autosave + undo toasts + friendly auth errors
- ✅ Connection status dot in header
- ✅ Swipe-to-dismiss modals on mobile
- ✅ README.md + CLAUDE.md documentation
