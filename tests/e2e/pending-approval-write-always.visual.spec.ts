import { test, expect, type Page } from '@playwright/test';

// Write-shaped MCP always-allow: confirmation dialog and composer action strip.
// Fixture: /?fixture=pending-approval-write-always&variant=dialog|strip
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
  viewport: { width: 720, height: 720 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

async function blurFocus(page: Page) {
  await page.evaluate(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
  });
}

test('visual: write-tool always-allow confirmation dialog', async ({ page }) => {
  await page.goto('/?fixture=pending-approval-write-always&variant=dialog');
  await pinFonts(page);

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Always allow this write tool?' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Always allow' })).toBeVisible();
  await blurFocus(page);

  await expect(dialog).toHaveScreenshot('pending-approval-write-confirm-dialog.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});

test('visual: pending approval strip with Always allow for write MCP tool', async ({ page }) => {
  await page.goto('/?fixture=pending-approval-write-always&variant=strip');
  await pinFonts(page);

  const fixture = page.getByTestId('pending-approval-write-fixture');
  await expect(fixture).toBeVisible();
  await expect(fixture.getByRole('button', { name: 'Always allow' })).toBeVisible();
  await expect(fixture.getByRole('button', { name: 'Allow Once' })).toBeVisible();
  await blurFocus(page);

  await expect(fixture).toHaveScreenshot('pending-approval-write-actions.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});
