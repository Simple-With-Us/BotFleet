import { defineConfig } from '@playwright/test';

// Fleet rollout scaffold: chromium-only smoke tests against a local server.
// Point PLAYWRIGHT_BASE_URL at a deployed environment to run against it.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL },
  // Shared screenshot tolerance.  Every current toHaveScreenshot call already
  // passes maxDiffPixelRatio 0.02.  threshold 0.2 is Playwright's per-pixel
  // default, which visual.spec.ts and tv-face-avatar.visual.spec.ts already
  // use by leaving it unset.  Call-site options still override these, so this
  // does not loosen or tighten those specs.
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.02,
      threshold: 0.2,
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'pnpm exec vite preview --port 4173 --host 127.0.0.1',
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
