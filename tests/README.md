# Smoke tests — digitalmarketstore.shop

Playwright end-to-end smoke tests that guard the critical user paths against
regressions. They run automatically on every push via
`.github/workflows/e2e.yml`, and you can run them locally too.

## What's covered
Each test runs on **desktop Chrome, Android (Pixel 7), and iPhone 13**:

1. Home loads, products render from Firestore, no unexpected console errors
2. Firebase initializes (auth + firestore + functions available)
3. Clicking a product opens its detail with real content
4. Add-to-cart updates the cart count
5. Search filters the product grid
6. Language toggle switches to Arabic **RTL document-wide** (the `<html dir>` fix)
7. No horizontal overflow on the homepage
8. Checkout is **login-gated** for signed-out users (can't reach paid checkout)

## Run locally
```bash
cd tests
npm install
npx playwright install chromium webkit   # one-time
npm test                                  # all 3 device profiles
npx playwright test --project=desktop-chrome   # just desktop
npm run report                            # open the HTML report
```
The config starts a static server (`python -m http.server`) over the built site
in the repo root, runs the suite, then tears it down. Tests hit **live Firebase**,
so transient network blips are absorbed by `retries`.

## Adding a test
Drop another `test(...)` into `smoke.spec.js`. Keep assertions on
**user-observable invariants** (what the buyer sees), not internal implementation
details, so the suite stays stable across browser engines.
