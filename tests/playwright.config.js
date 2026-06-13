// Playwright config for digitalmarketstore.shop smoke tests.
// Serves the built site (repo root, one level up from /tests) on :8099 and runs
// the suite against it in desktop + mobile projects. CI runs this on every push.
const { defineConfig, devices } = require('@playwright/test');

const PORT = process.env.PORT || 8099;
const BASE = `http://127.0.0.1:${PORT}`;

module.exports = defineConfig({
  testDir: '.',
  timeout: 45_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 2 : 1,          // tolerate transient Firestore network blips
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-android', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-ios',     use: { ...devices['iPhone 13'] } },
  ],
  // Playwright launches the static server itself, then tears it down.
  webServer: {
    command: `python -m http.server ${PORT} --directory ..`,
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
