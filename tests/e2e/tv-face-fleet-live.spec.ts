import { test, expect, type Page } from '@playwright/test';

const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.04 } as const;

async function pinFonts(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        font-family: "DejaVu Sans", sans-serif !important;
      }
    `,
  });
}

test('visual: TV-Face fleet-live demo shell', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/tv-face/fleet-live.html');
  await pinFonts(page);
  await expect(page.getByRole('heading', { name: 'Live fleet — six bots at once' })).toBeVisible();
  await expect(page.getByText('Director', { exact: true })).toBeVisible();
  await expect(page.getByText('Compiler', { exact: true })).toBeVisible();
  // Desktop preview auto-starts after ~400ms; wait for the grid to settle.
  await page.waitForTimeout(800);
  await expect(page).toHaveScreenshot('tv-face-fleet-live.png', {
    ...stableShot,
    mask: [
      page.locator('#clock'),
      page.locator('.face-wrap'),
      page.locator('#wake'),
    ],
  });
});
