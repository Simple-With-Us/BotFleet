import { test, expect, type Page } from '@playwright/test';

// Visual coverage for the marks the Muse Code / MiniMax / quotas fix
// changed.  The fixture mounts the real `ProviderMark` switch (see
// src/components/ProviderIcons.tsx), so the snapshot pins the SVG that
// actually ships in the engine rail rather than the leaf marks mounted out
// of context.
//
// There is no visual-tests/ directory; this follows tests/e2e/visual.spec.ts.

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

test('visual: provider marks for muse and mcode through ProviderMark', async ({ page }) => {
  // Freeze the clock BEFORE the app loads.  The fixture builds its reset time
  // from Date.now(), and the panel renders a live countdown ("resets in 3h
  // 59m"), so without this the snapshot differs on every run and fails within
  // the hour.  A mask over the panel would hide the very content this change
  // added; freezing time keeps the countdown in the picture and makes it
  // deterministic, which is the actual property worth pinning.
  await page.clock.setFixedTime(new Date('2026-10-10T15:00:00Z'));
  await page.goto('/?fixture=provider-icons');
  await pinFonts(page);

  const board = page.getByTestId('provider-icons-board');
  await expect(board).toBeVisible();

  // The two changed cases render real artwork, not monograms:  both are
  // <svg> nodes in the production switch.
  const muse = page.getByTestId('provider-mark-muse').locator('svg');
  await expect(muse).toBeVisible();
  await expect(muse).toHaveAttribute('viewBox', /^-?\d/);

  const mcode = page.getByTestId('provider-mark-mcode').locator('svg');
  await expect(mcode).toBeVisible();
  await expect(mcode).toHaveAttribute('viewBox', '0 0 24 24');

  // Monogram fallback is still text, not an <svg> — this is the regression
  // guard the fix keeps alive.
  const monogram = page.getByTestId('provider-mark-monogram');
  await expect(monogram.locator('svg')).toHaveCount(0);

  // The quota panel's own contents are covered by
  // engine-quotas-panel.visual.spec.ts, which screenshots the panel detail on
  // its own; this spec is about the marks, and only checks the panel mounts.

  // Tolerance is inline rather than inherited, matching the other visual specs:
  // a later edit to playwright.config's defaults must not silently tighten or
  // loosen this comparison.
  await expect(board).toHaveScreenshot('provider-icons-marks.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
    threshold: 0.2,
  });
});

test('visual: muse mark carries the Meta blue ramp, mcode carries the brand red ramp', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-10T15:00:00Z'));
  await page.goto('/?fixture=provider-icons');
  await pinFonts(page);

  // Brand colours are the assertion that survives rasterisation:  a snapshot
  // diff alone cannot say which palette a mark is wearing.
  const museSvg = await page.getByTestId('provider-mark-muse').locator('svg').first().evaluate((root) => root.outerHTML);
  expect(museSvg).toMatch(/#0081fb/i);
  expect(museSvg).toContain('bf-muse-grad-1');

  const mcodeSvg = await page.getByTestId('provider-mark-mcode').locator('svg').first().evaluate((root) => root.outerHTML);
  expect(mcodeSvg).toMatch(/#E5195F/i);
  expect(mcodeSvg).toMatch(/#FF6B35/i);
  // The old navy-to-blue rebrand must not be in the rendered SVG.
  expect(mcodeSvg).not.toMatch(/#0A2540/i);
  expect(mcodeSvg).not.toMatch(/#1E40AF/i);
});