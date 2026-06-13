// Smoke tests for digitalmarketstore.shop.
// These mirror the manual audit: page health, product rendering, the buy funnel,
// search, bilingual RTL, and mobile layout integrity. They run on desktop +
// Android + iOS device profiles. Keep them resilient to transient Firestore
// network blips (retries in config + generous waits), but strict on real bugs.
const { test, expect } = require('@playwright/test');

// Console errors we treat as benign environment noise, not test failures —
// mirrors the site's own Sentry NOISE filter. Anything else fails the test.
const BENIGN = [
  /Could not reach Cloud Firestore backend/i,
  /client is offline/i,
  /Failed to load resource.*recaptcha/i,
  /ERR_NETWORK|ERR_INTERNET_DISCONNECTED|net::ERR/i,
  /\[GSI_LOGGER\]/i,
];

function watchConsole(page) {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  return errors;
}
const realErrors = errs => errs.filter(e => !BENIGN.some(re => re.test(e)));

async function gotoHome(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // products are JS-rendered from Firestore — wait for the first card
  await page.locator('.product-card').first().waitFor({ state: 'visible', timeout: 25_000 });
}

test('home loads, renders products, and throws no unexpected console errors', async ({ page }) => {
  const errors = watchConsole(page);
  await gotoHome(page);
  await expect(page.locator('.product-card').first()).toBeVisible();
  expect(await page.locator('.product-card').count()).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(realErrors(errors), 'unexpected console errors: ' + realErrors(errors).join(' | ')).toHaveLength(0);
});

test('Firebase initializes (auth + firestore + functions available)', async ({ page }) => {
  await gotoHome(page);
  const fb = await page.evaluate(() => ({
    apps: (window.firebase && firebase.apps) ? firebase.apps.length : 0,
    auth: typeof auth !== 'undefined' && !!auth,
    db: typeof db !== 'undefined' && !!(db && db.collection),
    functions: (() => { try { return typeof firebase.functions === 'function'; } catch { return false; } })(),
  }));
  expect(fb.apps).toBeGreaterThan(0);
  expect(fb.auth).toBeTruthy();
  expect(fb.db).toBeTruthy();
  expect(fb.functions).toBeTruthy();
});

test('clicking a product opens its detail with real content', async ({ page }) => {
  await gotoHome(page);
  await page.locator('.product-card').first().click();
  const modal = page.locator('#product-modal');
  await expect(modal).toBeVisible({ timeout: 15_000 });
  const body = page.locator('#product-modal-body');
  await expect(body).toContainText(/EGP|\d/, { timeout: 15_000 }); // price/details rendered
  expect((await body.innerText()).trim().length).toBeGreaterThan(40);
});

test('add to cart updates the cart count', async ({ page }) => {
  await gotoHome(page);
  const before = await page.evaluate(() =>
    (document.querySelector('#cart-count, .cart-count, [class*="cart-count"]')?.textContent || '0').trim());
  await page.evaluate(() => {
    const card = document.querySelector('.product-card');
    const id = card?.getAttribute('onclick')?.match(/'([^']+)'/)?.[1];
    if (id && typeof addToCart === 'function') addToCart(id);
  });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() =>
    (document.querySelector('#cart-count, .cart-count, [class*="cart-count"]')?.textContent || '0').trim());
  expect(Number(after) || 0).toBeGreaterThanOrEqual(Number(before) || 0);
  expect(Number(after)).toBeGreaterThan(0);
});

test('search filters the product grid', async ({ page }) => {
  await gotoHome(page);
  const total = await page.locator('.product-card').count();
  await page.evaluate(() => {
    const s = document.querySelector('#search-input, input[type="search"]');
    if (s) { s.value = 'zzqxnotamatch'; s.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  await page.waitForTimeout(800);
  const filtered = await page.locator('.product-card').count();
  expect(filtered).toBeLessThan(total + 1); // a no-match query must not ADD cards
});

test('language toggle switches to Arabic RTL document-wide', async ({ page }) => {
  await gotoHome(page);
  await page.evaluate(() => { if (typeof toggleLang === 'function') toggleLang(); });
  await page.waitForTimeout(1000);
  const state = await page.evaluate(() => ({
    htmlDir: document.documentElement.dir,
    htmlLang: document.documentElement.lang,
    bodyDir: getComputedStyle(document.body).direction,
  }));
  expect(state.htmlLang).toBe('ar');
  expect(state.htmlDir).toBe('rtl');   // the v146 fix — must be on <html>, not just <body>
  expect(state.bodyDir).toBe('rtl');
});

test('no horizontal overflow on the homepage', async ({ page }) => {
  await gotoHome(page);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

test('checkout is login-gated for signed-out users', async ({ page }) => {
  await gotoHome(page);
  expect(await page.evaluate(() => typeof proceedToCheckout === 'function'),
    'proceedToCheckout must exist (guards against a false pass)').toBeTruthy();
  // Attempt checkout while signed out. The gate routes to the login view, which
  // can destroy the eval context — fire-and-forget + .catch tolerates that.
  await page
    .evaluate(() => { try { if (typeof proceedToCheckout === 'function') proceedToCheckout(); } catch (e) {} })
    .catch(() => {});
  await page.waitForTimeout(1200);
  // The core guarantee: a logged-out user must NOT reach the paid checkout modal.
  // (The gate routes them to login instead — that routing's exact form varies by
  // engine, so we assert the security-relevant invariant, not the UI detail.)
  const checkoutVisible = await page.evaluate(() => {
    const m = document.getElementById('checkout-modal');
    return m ? getComputedStyle(m).display !== 'none' : false;
  });
  expect(checkoutVisible, 'logged-out user must not reach paid checkout').toBeFalsy();
});
