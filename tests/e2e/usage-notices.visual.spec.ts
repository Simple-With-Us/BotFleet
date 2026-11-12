import { test, expect, type Page } from '@playwright/test';

// The two notices at the top of Settings → Usage → Engine Quotas: "N Bots Are
// Being Held" (the dispatcher refuses to start their engine, so scheduled work
// is queued rather than failed) and "Fallback Chains Are Shorter Than They
// Look".  The fixture mounts the real HeldBotsNotice and RedundantChainsNotice
// in the same Card with fixed data via /?fixture=usage-notices (see
// src/main.tsx), so nothing here mocks a route.  This follows the repo's visual
// convention (tests/e2e/*.visual.spec.ts with a /?fixture= harness), not a
// top-level visual-tests/ directory.  Regenerate baselines with
// `pnpm run e2e:update tests/e2e/usage-notices.visual.spec.ts`, no `--`.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Animations are disabled and the
// DejaVu Sans font pin keeps a baseline stable across machines.
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        font-family: "DejaVu Sans", sans-serif !important;
      }
      code, kbd, pre, samp, tt {
        font-family: "DejaVu Sans Mono", monospace !important;
      }
    `,
  });
}

test.use({
  viewport: { width: 600, height: 900 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: several held bots and several short fallback chains use the plural headings', async ({ page }) => {
  await page.goto('/?fixture=usage-notices');
  await pinFonts(page);

  const plural = page.getByTestId('usage-notices-plural');
  await expect(plural).toBeVisible();
  await expect(plural.getByText('2 Bots Are Being Held')).toBeVisible();
  await expect(plural.getByText(/failed to start\s+3 times: DeepSeek Harness is not signed in/)).toBeVisible();
  await expect(plural.getByText("2 Bots' Fallback Chains Are Shorter Than They Look")).toBeVisible();
  // A task override is named, so the operator can tell which chain to fix.
  await expect(plural.getByText('task 9c1e5a77')).toBeVisible();

  await expect(plural).toHaveScreenshot('usage-notices-plural.png', { ...stableShot, maxDiffPixelRatio: 0.02, threshold: 0.2 });
});

test('visual: one held bot and one short fallback chain use the singular headings', async ({ page }) => {
  await page.goto('/?fixture=usage-notices');
  await pinFonts(page);

  const singular = page.getByTestId('usage-notices-singular');
  await expect(singular).toBeVisible();
  await expect(singular.getByText('1 Bot Is Being Held')).toBeVisible();
  // One bot with a bot-level chain and a task override is one bot, not two.
  await expect(singular.getByText("1 Bot's Fallback Chain Is Shorter Than It Looks")).toBeVisible();

  await expect(singular).toHaveScreenshot('usage-notices-singular.png', { ...stableShot, maxDiffPixelRatio: 0.02, threshold: 0.2 });
});
