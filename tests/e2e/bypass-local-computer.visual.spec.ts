import { test, expect, type Page } from '@playwright/test';

// Bypass Including This Mac, the second switch under Bypass Permissions, and
// the warning that stands in front of turning it on.  The fixture mounts the
// real control and the real LocalComputerAutoWarning via
// /?fixture=bypass-local-computer&state=off|on|disabled|warning
// (see src/main.tsx).  This follows the repo's visual convention
// (tests/e2e/*.visual.spec.ts with a /?fixture= harness), not a top-level
// visual-tests/ directory.  Regenerate baselines with
// `pnpm run e2e:update tests/e2e/bypass-local-computer.visual.spec.ts`, no `--`.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  There is no timestamp in this
// control, so the shot is not masked.  Animations are disabled and the
// DejaVu Sans font pin keeps a baseline stable across machines.  The warning's
// confirm button takes focus on open; it is blurred before the shot so the
// focus ring cannot differ between machines.
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
  viewport: { width: 640, height: 520 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

async function openState(page: Page, state: 'off' | 'on' | 'disabled' | 'warning') {
  await page.goto(`/?fixture=bypass-local-computer&state=${state}`);
  await pinFonts(page);
  const fixture = page.getByTestId('bypass-local-computer-fixture');
  await expect(fixture).toBeVisible();
  await expect(fixture).toHaveAttribute('data-fixture-state', state);
  return fixture;
}

test('visual: the switch is off while Bypass Permissions is on', async ({ page }) => {
  const fixture = await openState(page, 'off');
  const toggle = fixture.getByRole('switch', { name: 'Bypass Including This Mac' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(fixture.getByText('Off.')).toBeVisible();
  await expect(fixture.getByText('Turn on Bypass Permissions first')).toHaveCount(0);

  await expect(page.getByTestId('bypass-local-computer-card')).toHaveScreenshot(
    'bypass-local-computer-off.png',
    stableShot,
  );
});

test('visual: the switch is on and names the unattended desktop', async ({ page }) => {
  const fixture = await openState(page, 'on');
  const toggle = fixture.getByRole('switch', { name: 'Bypass Including This Mac' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(fixture.getByText('Nothing this bot does on this Mac asks.')).toBeVisible();

  await expect(page.getByTestId('bypass-local-computer-card')).toHaveScreenshot(
    'bypass-local-computer-on.png',
    stableShot,
  );
});

test('visual: the switch is disabled until Bypass Permissions is on', async ({ page }) => {
  const fixture = await openState(page, 'disabled');
  const toggle = fixture.getByRole('switch', { name: 'Bypass Including This Mac' });
  await expect(toggle).toBeDisabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(fixture.getByText('Turn on Bypass Permissions first')).toBeVisible();

  await expect(page.getByTestId('bypass-local-computer-card')).toHaveScreenshot(
    'bypass-local-computer-disabled.png',
    stableShot,
  );
});

test('visual: turning the switch on stops on the Mac warning', async ({ page }) => {
  const fixture = await openState(page, 'warning');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Allow Bypass Including This Mac?' })).toBeVisible();
  await expect(dialog.getByText(/Nothing this bot does on this Mac will ask again/)).toBeVisible();
  await expect(fixture.getByRole('switch', { name: 'Bypass Including This Mac' })).toHaveAttribute('aria-checked', 'false');
  await page.evaluate(() => {
    const focused = document.activeElement;
    if (focused instanceof HTMLElement) focused.blur();
  });

  await expect(dialog).toHaveScreenshot('bypass-local-computer-warning.png', stableShot);
});
