import { test, expect, type Page } from '@playwright/test';

// The Usage Monitor quota cells under Settings → Usage → Engine Quotas,
// including the plain empty placeholder when a configured engine has no
// reported limits.  The fixture mounts the real UsageMonitorQuotaGrid via
// /?fixture=usage-monitor-quota-grid (see src/main.tsx).

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
  viewport: { width: 560, height: 520 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-10T15:00:00Z'));
});

test('visual: empty usage grid placeholder names the engine', async ({ page }) => {
  await page.goto('/?fixture=usage-monitor-quota-grid');
  await pinFonts(page);

  const empty = page.getByTestId('quota-grid-empty');
  await expect(empty).toBeVisible();
  await expect(empty.getByText('No usage limits reported yet for Claude.')).toBeVisible();

  await expect(empty).toHaveScreenshot('usage-monitor-quota-grid-empty.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});

test('visual: populated usage grid still renders quota cells', async ({ page }) => {
  await page.goto('/?fixture=usage-monitor-quota-grid');
  await pinFonts(page);

  const populated = page.getByTestId('quota-grid-populated');
  await expect(populated).toBeVisible();
  await expect(populated.getByText('Weekly')).toBeVisible();
  await expect(populated.getByText('72% remaining')).toBeVisible();

  await expect(populated).toHaveScreenshot('usage-monitor-quota-grid-populated.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});
