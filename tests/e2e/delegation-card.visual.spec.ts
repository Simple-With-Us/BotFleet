import { test, expect, type Page } from '@playwright/test';

// Bot-to-bot delegation card with the live progress row.  The fixture mounts
// DelegationCard via /?fixture=delegation-card.  This follows
// tests/e2e/*.visual.spec.ts, not a top-level visual-tests/ directory.
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
  viewport: { width: 640, height: 280 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: delegation card shows the progress row', async ({ page }) => {
  await page.goto('/?fixture=delegation-card');
  await pinFonts(page);
  const fixture = page.getByTestId('delegation-card-fixture');
  await expect(fixture.getByTestId('delegation-progress')).toContainText('Working');
  await expect(fixture).toHaveScreenshot('delegation-card.png', {
    ...stableShot,
    maxDiffPixels: 0,
  });
});
