import { test, expect, type Page } from '@playwright/test';

// The Sign in needed card.  The fixture mounts the real card via
// /?fixture=sign-in-card&state=open|error|done (see src/main.tsx).  There
// is no password field.  An action error stays in the card.  This follows
// tests/e2e/*.visual.spec.ts, not a top-level visual-tests/ directory.
// Regenerate baselines with
// `pnpm run e2e:update tests/e2e/sign-in-card.visual.spec.ts`, no `--`.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  The DejaVu pin keeps a
// baseline stable across machines.
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
  viewport: { width: 640, height: 480 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

async function openCard(page: Page, state: 'open' | 'error' | 'done') {
  await page.goto(`/?fixture=sign-in-card&state=${state}`);
  await pinFonts(page);
  const card = page.getByTestId('sign-in-card');
  await expect(card.getByText('Sign in needed')).toBeVisible();
  await expect(card.locator('input')).toHaveCount(0);
  return card;
}

test('visual: an open sign-in card has Open, Done, and Cancel, and no password field', async ({ page }) => {
  const card = await openCard(page, 'open');
  await expect(card.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Done' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancel' })).toBeVisible();
  await expect(card.getByText('BotFleet never sees the password.')).toBeVisible();
  await expect(card).toHaveScreenshot('sign-in-card-open.png', stableShot);
});

test('visual: a sign-in error stays in the card', async ({ page }) => {
  const card = await openCard(page, 'error');
  await expect(card.getByRole('alert')).toContainText('The computer could not be opened.');
  await expect(card.getByRole('button', { name: 'Hide this message' })).toBeVisible();
  await expect(card).toHaveScreenshot('sign-in-card-error.png', stableShot);
});

test('visual: a finished sign-in card drops the actions', async ({ page }) => {
  const card = await openCard(page, 'done');
  await expect(card.getByText('The bot will check the screen.')).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(card).toHaveScreenshot('sign-in-card-done.png', stableShot);
});
