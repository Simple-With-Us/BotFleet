import { test, expect, type Page, type Locator } from '@playwright/test';

// LinuxLocalControl title casing, Wayland block copy, and action labels.
// The fixture mounts the real section via /?fixture=linux-local-control
// (see src/main.tsx and LinuxLocalControlVisualFixture.tsx).
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Only animation and caret
// handling stay on the call.
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

function localControlSection(page: Page): Locator {
  return page.locator('section[aria-labelledby="linux-local-control-title"]');
}

test.use({
  viewport: { width: 640, height: 900 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: Linux Local Control disabled (Off)', async ({ page }) => {
  await page.goto('/?fixture=linux-local-control&state=off');
  await pinFonts(page);

  const board = page.getByTestId('linux-local-control-board');
  await expect(board).toBeVisible();
  const section = localControlSection(page);
  await expect(section.getByText('Local Control', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Enable Local Control (Beta)' })).toBeVisible();

  await expect(section).toHaveScreenshot('linux-local-control-off.png', stableShot);
});

test('visual: Linux Local Control Wayland safety block', async ({ page }) => {
  await page.goto('/?fixture=linux-local-control&state=wayland');
  await pinFonts(page);

  const section = localControlSection(page);
  await expect(section).toBeVisible();
  await expect(section.getByText('Unavailable on Wayland')).toBeVisible();
  await expect(section.getByText(/This Computer/)).toBeVisible();

  await expect(section).toHaveScreenshot('linux-local-control-wayland.png', stableShot);
});

test('visual: Linux Local Control needs attention', async ({ page }) => {
  await page.goto('/?fixture=linux-local-control&state=needs-attention');
  await pinFonts(page);

  const section = localControlSection(page);
  await expect(section).toBeVisible();
  await expect(section.getByRole('button', { name: 'Try Again' })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Disable Local Control' })).toBeVisible();
  await expect(section.getByText('Bundled Computer Driver')).toBeVisible();

  await expect(section).toHaveScreenshot('linux-local-control-needs-attention.png', stableShot);
});

test('visual: Linux Local Control ready', async ({ page }) => {
  await page.goto('/?fixture=linux-local-control&state=ready');
  await pinFonts(page);

  const section = localControlSection(page);
  await expect(section).toBeVisible();
  await expect(section.getByText('Ready', { exact: true })).toBeVisible();
  await expect(section.getByRole('button', { name: 'Disable Local Control' })).toBeVisible();

  await expect(section).toHaveScreenshot('linux-local-control-ready.png', stableShot);
});
