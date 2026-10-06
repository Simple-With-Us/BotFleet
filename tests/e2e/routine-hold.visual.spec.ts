import { test, expect, type Page } from '@playwright/test';

// RoutineDetails in its hold state.  A run the dispatcher refused to start sits
// QUEUED, and the panel has to say why — otherwise a held run is
// indistinguishable from a stuck scheduler, which is the state this change set
// removed.  The fixture mounts the real panel via /?fixture=routine-hold (see
// src/main.tsx) with a fixed run, so nothing here mocks a route.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Animations are disabled on the
// call so the avatar's idle motion cannot land mid-frame; the mascot is not
// animated in this state anyway (queued is not running or waiting).
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

// The Runs On row and the header date read the host, so pin the clock and the
// user agent.  The panel formats its own times in America/Chicago regardless,
// but the header omits the year when the run is in the current one — without a
// fixed clock the baseline would start failing on New Year's Day.
const FIXED_NOW = new Date('2026-06-15T13:00:00Z');
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
  viewport: { width: 900, height: 1000 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: RoutineDetails explains why a run is held', async ({ page }) => {
  await page.clock.install({ time: FIXED_NOW });
  await page.goto('/?fixture=routine-hold');
  await pinFonts(page);

  const panel = page.getByTestId('routine-details');
  await expect(panel).toBeVisible();

  // The whole point of the panel: queued, with the reason spelled out.
  await expect(panel.getByText('queued', { exact: true })).toBeVisible();
  const hold = panel.getByText(/DeepSeek Harness could not start 3 times in a row/);
  await expect(hold).toBeVisible();
  await expect(panel.getByText('Holding', { exact: true })).toBeVisible();
  await expect(panel.getByText('Engine: dsh · deepseek-v4')).toBeVisible();

  // A held run is not an error: the danger panel stays out of it.
  await expect(panel.getByText('Last 7 Days')).toBeVisible();

  await expect(panel).toHaveScreenshot('routine-details-held.png', stableShot);
});
