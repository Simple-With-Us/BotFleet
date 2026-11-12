import { test, expect, type Locator, type Page } from '@playwright/test';

// Agent settings → Always allowed revoke list.  Fixture:
// /?fixture=settings-always-allow&state=empty|populated
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
  viewport: { width: 560, height: 480 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

/** Stored grant keys include config fingerprints; mask them, assert via getByRole labels. */
function alwaysAllowKeyMask(fixture: Locator): Locator[] {
  return [fixture.locator('.font-mono')];
}

test('visual: always allowed empty state', async ({ page }) => {
  await page.goto('/?fixture=settings-always-allow&state=empty');
  await pinFonts(page);

  const fixture = page.getByTestId('settings-always-allow-fixture');
  await expect(fixture).toBeVisible();
  await expect(fixture.getByText('Nothing standing yet.')).toBeVisible();

  await expect(fixture).toHaveScreenshot('settings-always-allow-empty.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});

test('visual: always allowed populated revoke list', async ({ page }) => {
  await page.goto('/?fixture=settings-always-allow&state=populated');
  await pinFonts(page);

  const fixture = page.getByTestId('settings-always-allow-fixture');
  await expect(fixture).toBeVisible();
  await expect(fixture.getByRole('button', { name: /Remove provider-tool:/ })).toHaveCount(2);

  await expect(fixture).toHaveScreenshot('settings-always-allow-populated.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
    mask: alwaysAllowKeyMask(fixture),
  });
});
