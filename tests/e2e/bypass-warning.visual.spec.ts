import { test, expect, type Page } from '@playwright/test';

// The Permission Bypass confirmation dialog, the last stop before a bot runs
// commands, file edits and routine proposals with no confirmation card.  The
// fixture mounts the real BypassPermissionsWarning, open, via
// /?fixture=bypass-warning&variant=standard|dangerous|busy (see src/main.tsx),
// so nothing here mocks a route.  This follows the repo's visual convention
// (tests/e2e/*.visual.spec.ts with a /?fixture= harness), not a top-level
// visual-tests/ directory.  Regenerate baselines with
// `pnpm run e2e:update tests/e2e/bypass-warning.visual.spec.ts`, no `--`.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Animations are disabled and the
// DejaVu Sans font pin keeps a baseline stable across machines.  The confirm
// button takes focus on open; it is blurred before the shot so the focus ring
// cannot differ between machines.
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
  viewport: { width: 640, height: 640 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

async function openDialog(page: Page, variant: 'standard' | 'dangerous' | 'busy') {
  await page.goto(`/?fixture=bypass-warning&variant=${variant}`);
  await pinFonts(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  return dialog;
}

test('visual: a standard model gets the plain confirmation', async ({ page }) => {
  const dialog = await openDialog(page, 'standard');
  await expect(dialog.getByRole('heading', { name: 'Enable Permission Bypass for Fixer?' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Enable Permission Bypass' })).toBeEnabled();
  await expect(dialog.getByText('I Understand the Risks')).toHaveCount(0);

  await expect(dialog).toHaveScreenshot('bypass-warning-standard.png', stableShot);
});

test('visual: a lightweight model gets the high-risk callout and the explicit button', async ({ page }) => {
  const dialog = await openDialog(page, 'dangerous');
  await expect(dialog.getByRole('heading', { name: 'High-Risk Model: Permission Bypass Warning' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'I Understand the Risks, Enable Bypass' })).toBeEnabled();

  await expect(dialog).toHaveScreenshot('bypass-warning-dangerous.png', stableShot);
});

test('visual: while applying, both buttons are disabled and the confirm button says so', async ({ page }) => {
  const dialog = await openDialog(page, 'busy');
  await expect(dialog.getByRole('button', { name: 'Applying…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeDisabled();

  await expect(dialog).toHaveScreenshot('bypass-warning-busy.png', stableShot);
});
