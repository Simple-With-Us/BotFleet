import { test, expect, type Page } from '@playwright/test';

// Visual coverage for the marks the Muse Code / MiniMax / quotas fix
// changed.  The fixture mounts the real `ProviderMark` switch (see
// src/components/ProviderIcons.tsx), so the snapshot pins the SVG that
// actually ships in the engine rail rather than the leaf marks mounted out
// of context.
//
// There is no visual-tests/ directory; this follows tests/e2e/visual.spec.ts.

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

  // EngineQuotasPanel renders in the picker header (ModelPicker.tsx:851-854).
  const panel = page.getByTestId('provider-icons-quotas-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Engine Quotas')).toBeVisible();


  // The expanded panel is where the fix actually lives:  the old UI said
  // "(93% / 3% for 5h / w)" and these are the words that replaced it.
  const expanded = page.getByTestId('provider-icons-quotas-panel');
  await expect(expanded.getByRole('button', { name: /Engine Quotas/ })).toBeVisible();
  // Scope to the Muse Code block:  the MiniMax fixture below it has its own
  // Weekly row, so an unscoped text match is ambiguous.
  const museBlock = expanded.getByTestId('engine-quota-muse');
  await expect(museBlock.getByText('5-Hour')).toBeVisible();
  await expect(museBlock.getByText('Weekly').first()).toBeVisible();
  await expect(museBlock.getByText('93% left', { exact: true })).toBeVisible();
  await expect(museBlock.getByText('3% left', { exact: true })).toBeVisible();
  // The one thing the packed chip could not say:  which window runs out first.
  await expect(museBlock.getByText(/Weekly is nearly spent/)).toBeVisible();

  // Screenshot settings (maxDiffPixelRatio, threshold, animations, caret)
  // come from playwright.config's expect.toHaveScreenshot.
  await expect(board).toHaveScreenshot('provider-icons-marks.png');
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