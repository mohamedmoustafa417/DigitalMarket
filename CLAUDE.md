# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Build / run / test

There is **no build step**. `index.html` is the entire SPA — edit and commit.

### Deploy (in this order)
```powershell
# From repo root
.\DEPLOY.ps1
```
The script: installs Firebase CLI if missing, logs you in via browser,
`npm install`s the `functions/` deps, then deploys rules + indexes + storage
+ Cloud Functions.

To deploy ONE function only:
```
firebase deploy --only functions:mirrorPublicProfile --project digitalmarket-38db5 --force
```

To deploy ONLY rules (fastest):
```
firebase deploy --only firestore:rules,storage --project digitalmarket-38db5
```

### Test (runtime audit via Puppeteer)
There is no unit test framework. Functional verification is via **headless
browser**:
```
cd C:\Users\LapTop\Downloads\Claude\runtime-audit
node check-12.js   # 12-item manual checklist with screenshots
node pre-launch.js # comprehensive pre-launch audit
```
GitHub Action `.github/workflows/runtime-audit.yml` runs the same audit
every Monday + on every push to `index.html`. Auto-opens a GitHub Issue
labelled `bug/runtime-audit` if any check fails.

### Local edit workflow
The canonical source is `C:\Users\LapTop\Downloads\Claude\index_improved.html`.
Every commit copies it to `deploy/index.html`:
```powershell
Copy-Item "..\index_improved.html" "index.html" -Force
```
Always edit `index_improved.html`, never `deploy/index.html` directly.

---

## Hosting + branch setup

- Hosted on **GitHub Pages**, custom domain `digitalmarketstore.shop` (CNAME in repo root).
- **Default branch: `master`** (was changed from `main` mid-development;
  GitHub Pages serves whichever is set as default). Always push to BOTH
  branches:
  ```
  git push origin master
  git checkout main; git merge master --ff-only; git push origin main; git checkout master
  ```
- Service Worker version (`CACHE_NAME` in `sw.js`) MUST be bumped on every
  meaningful change or users get stale cached HTML. Increment `v6` → `v7`,
  etc.

---

## Architecture in one paragraph

Single-file vanilla-JS SPA (~11,500 lines) + Firebase backend (Firestore +
Auth + Storage + 10 Cloud Functions). All UI state, routing, rendering
lives in `index.html`. No bundler, no framework. Features were added in
~11 successive rounds; each round wraps existing functions via IIFE patches
rather than modifying earlier code. The patching is the **single most
important pattern** in this codebase — see below.

---

## The IIFE patching pattern — must understand this

Every feature added after the initial implementation uses this shape:

```js
(function patchFeatureName() {
  const orig = window.someFunction;
  if (typeof orig !== 'function') return;
  window.someFunction = async function(...args) {
    await orig.apply(this, args);   // ALWAYS call orig first
    // new behavior here
  };
})();
```

**Critical implications:**
- Order of `<script>` execution determines the patch chain.
- ANY new patch MUST call `orig.apply(this, arguments)` or the chain breaks
  silently (e.g., commit `febfdb0` fixed a case where pagination bypassed
  the chain and made Buy Now / Quick View / Tier badges disappear on >24
  products).
- Never patch the same function twice in separate IIFEs without explicit
  reason. `febfdb0` also merged a double-wrap of `navigate()` that was
  defeating View Transitions.
- When debugging "feature X doesn't work after change Y", suspect the
  patch chain first.

---

## Public-profile mirror — privacy split

A non-obvious pattern from commit `915f0d7`:

- `/users/{uid}` is **sign-in-required** for read. It contains sensitive
  data: KYC fields (`kycName`, `kycIdNum`, `kycIdPhoto` URL, `kycSelfie`
  URL, `kycDob`, `kycAddress`), bank info, phone, `tin`, `twoFactorEnabled`.
- `/publicProfiles/{uid}` is **world-readable** and contains ONLY safe
  fields: `name`, `shopName`, `bio`, `avatarUrl`, `verified`, `totalSales`,
  `tier`, `ratingAvg`, `ratingCount`, `instapay`.
- The `mirrorPublicProfile` Cloud Function (Firestore trigger on
  `/users/{uid}` write) auto-syncs safe fields from one to the other.
- **Storefront viewing code** (`openStorefront`) must read from
  `/publicProfiles` first; fall back to `/users` only for signed-in users.
- **Never** add a new field to `/users` without deciding whether it's
  sensitive. If safe, add it to the `PUBLIC_FIELDS` array in
  `functions/index.js`.

---

## Firestore rules — allowlist for /users update

Self-update on `/users` uses an **allowlist** (`.hasOnly([...])`), not a
denylist. Adding a new self-writable field requires updating
`firestore.rules` AND redeploying:
```
firebase deploy --only firestore:rules --project digitalmarket-38db5
```
Self-write allowed for: name, shopName, shopDesc, bio, avatarUrl, photoURL,
instapay, phone, bank, accountNum, accountHolder, tin, twoFactorEnabled,
loyaltyPoints, updatedAt.

EVERYTHING else (verified, role, disabled, kycStatus, totalSales, tier,
ratingAvg, ratingCount, etc.) is managed by admin or Cloud Functions only.

---

## XSS defense pattern

Every interpolation of dynamic data into HTML strings MUST go through
`sanitize()` (DOMPurify with `ALLOWED_TAGS:[]` — strips ALL tags, leaves
text). Current ratio in `index.html`: **258 `sanitize()` calls** vs 166
`.innerHTML =` sites — sanitize is used more often than innerHTML, which
is correct.

When adding new HTML rendering, use the existing pattern:
```js
el.innerHTML = `<div>${sanitize(userInput)}</div>`;
```

Never do `el.innerHTML = userInput` directly. The Sentry-caught XSS
in commit `2b62a74` came close because a synthetic event provided an
undefined `key` value — defensive guards must check `typeof === 'string'`
before calling string methods.

---

## Cloud Functions inventory (10 functions, Node 22, 2nd-gen)

| Function | Trigger | Region | Purpose |
|---|---|---|---|
| `onOrderStatusChange` | Firestore `orders/{id}` write | us-central1 | Issues download token + license keys + loyalty points on `approved` |
| `cleanExpiredDownloads` | Daily 00:00 UTC | us-central1 | Marks `downloadExpired: true` after 30 days |
| `onProductFileDelete` | Storage `products/{seller}/*` delete | **us-east1** | Clears product `downloadUrl` |
| `onNewReview` | Firestore `reviews/{id}` write | us-central1 | Recalcs `ratingAvg` + `ratingCount` |
| `generateSitemap` | HTTPS callable | us-central1 | Returns XML of approved products |
| `abandonedCartReminder` | Daily 10:00 Cairo | us-central1 | Emails idle carts ≥ 24h |
| `processEmailCampaigns` | Every 5 min | us-central1 | Dispatches queued admin campaigns |
| `cleanupPresence` | Every 5 min | us-central1 | TTL cleanup of `presence` docs |
| `onKYCApproval` | Firestore `kycRequests/{id}` write | us-central1 | Mirrors admin decision to user doc |
| `mirrorPublicProfile` | Firestore `users/{uid}` write | us-central1 | Mirrors safe fields to `/publicProfiles` |

Storage trigger MUST be `us-east1` to match the bucket region; mismatched
regions caused a deploy failure in commit `5c93e52`.

---

## State / data conventions

- **localStorage keys** are all prefixed `dm_` or `dms_`. **Inconsistency
  alert:** wishlist uses `dms_wishlist_v1` (the `s` is a historical typo
  but is now the canonical key). Cart is `dm_cart_v2`. Always grep before
  inventing a new key — commit `6a689a8` fixed a wishlist-share bug caused
  by reading from `dm_wishlist` instead of `dms_wishlist_v1`.
- **Firestore docs** never have `id` as a field — always use the doc ID
  from the snapshot.
- **Currency conversion** uses two parallel systems:
  - `CURRENCIES` + `toggleCurrency()` (original, used by header `#currency-btn`)
  - `DM_CURRENCIES` + `setCurrency()` (newer, with flag emoji)
  Both write to `localStorage.dm_currency` to stay in sync. Both must
  update together. See commit `e460451` for the duplicate-button fix.

---

## CSP / security headers

- CSP `frame-src` must include `digitalmarket-38db5.firebaseapp.com`,
  `accounts.google.com`, `appleid.apple.com` for Firebase OAuth iframes.
  Removing any of these breaks Google/Apple sign-in (commit `e460451`).
- Do NOT add `X-Frame-Options` as a `<meta>` — Chrome ignores it and logs
  a warning. XFO must be an HTTP response header (commit `0b24ddb`).
- All user-input HTML must pass through `sanitize()`. See "XSS defense
  pattern" above.

---

## CI / monitoring

- **Sentry** at `https://e706b2f8f08782cedf4ad1400747ddd9@o4511384678694912.ingest.us.sentry.io/4511384696258560`
  — loaded with a 2s defer so it doesn't compete with FCP.
- **GA4** measurement ID `G-1V97FVKRRJ`. Gated behind cookie consent —
  `localStorage.dm_cookie_consent === 'declined'` sets
  `window['ga-disable-G-1V97FVKRRJ'] = true` BEFORE `gtag('config',...)`
  runs.
- **GitHub Actions:**
  - `.github/workflows/sitemap.yml` — daily 03:00 UTC, regenerates
    `sitemap.xml` from `generateSitemap` Cloud Function.
  - `.github/workflows/runtime-audit.yml` — Mondays 04:15 UTC + on push to
    `index.html`. Puppeteer smoke test, opens Issue on failure.

---

## Common pitfalls

1. **Editing `deploy/index.html` directly** — your changes will be
   overwritten on the next `Copy-Item` sync. Always edit
   `..\index_improved.html`.
2. **Pushing only to `master`** — GitHub Pages serves the default branch
   (master), but if anyone has a stale `main` branch link, force-merge it.
   The script in DEPLOY.ps1 handles both.
3. **Forgetting to bump SW cache version** after a code change — users
   keep seeing the stale version due to stale-while-revalidate.
4. **Adding sensitive fields to /users without updating the rule allowlist
   or the PUBLIC_FIELDS array** — write-fails silently or leaks PII.
5. **Patching a function without calling `orig`** — the entire patch chain
   above yours breaks silently. ALWAYS call `orig.apply(this, arguments)`.

---

## Where to look first when debugging

| Symptom | Likely location |
|---|---|
| Feature X broken after Y change | Patch chain — grep for `window.X = ` (multiple matches = wrapping order matters) |
| Permission-denied from Firestore | `firestore.rules` (check the `match` block for that collection) |
| Storefront stuck on "Loading…" | `openStorefront` reads from `/publicProfiles` (public) → `/users` (signed-in fallback). Check `mirrorPublicProfile` Cloud Function logs. |
| Google sign-in popup opens but never returns | CSP `frame-src` (must include `digitalmarket-38db5.firebaseapp.com`) |
| Stale UI on returning users | Bump `CACHE_NAME` in `sw.js` |
| `auth/operation-not-allowed` | Provider disabled in Firebase Console → enable manually (one-time per provider) |
| Confetti / animation never fires on mobile | `prefers-reduced-motion: reduce` is set on the device — all animations are gated by it |
