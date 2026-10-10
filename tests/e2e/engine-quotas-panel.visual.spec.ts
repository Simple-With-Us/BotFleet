import { test, expect, type Page } from '@playwright/test';

// Dedicated visual coverage for the EngineQuotasPanel that ships in the
// picker header (ModelPicker.tsx:851-854).  The provider-icons spec captures
// the panel as part of a wider board; this spec takes a focused screenshot
// of the panel detail so a regression to the named windows, bars, or
// "nearly spent" callout cannot hide behind a change to the rail.

const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

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

test.use({ viewport: { width: 640, height: 700 }, locale: 'en-US' });

test('visual: engine quotas panel disclosure', async ({ page }) => {
  // Freeze the clock BEFORE the app loads.  The fixture builds its reset
  // time from Date.now(), and the panel renders a live countdown
  // ("resets in 4h"), so without this the snapshot differs on every run
  // and fails within the hour.  Pinning the clock keeps the countdown
  // visible in the image and makes it deterministic, which is the actual
  // property worth pinning.
  await page.clock.setFixedTime(new Date('2026-10-10T15:00:00Z'));
  await page.goto('/?fixture=provider-icons');
  await pinFonts(page);

  const detail = page.getByTestId('engine-quotas-detail');
  await expect(detail).toBeVisible();

  // The expanded panel is where the fix actually lives: the old UI said
  // "(93% / 3% for 5h / w)" and these are the words that replaced it.
  const museBlock = detail.getByTestId('engine-quota-muse');
  await expect(museBlock.getByText('5-Hour')).toBeVisible();
  await expect(museBlock.getByText('Weekly').first()).toBeVisible();
  await expect(museBlock.getByText('93% left', { exact: true })).toBeVisible();
  await expect(museBlock.getByText('3% left', { exact: true })).toBeVisible();
  // The one thing the packed chip could not say: which window runs out
  // first.
  await expect(museBlock.getByText(/Weekly is nearly spent/)).toBeVisible();

  // Tolerance is inline rather than inherited, matching the other visual specs:
  // a later edit to playwright.config's defaults must not silently tighten or
  // loosen this comparison.
  await expect(detail).toHaveScreenshot('engine-quotas-panel.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});