import { test, expect, type Page } from '@playwright/test';

// Visual coverage for the marks the Muse Code / MiniMax / quotas fix
// changed.  The fixture mounts the real `ProviderMark` switch (see
// src/components/ProviderIcons.tsx), so the snapshot pins the SVG that
// actually ships in the engine rail rather than the leaf marks mounted out
// of context.
//
// There is no visual-tests/ directory; this follows tests/e2e/visual.spec.ts.
const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02, threshold: 0.2 } as const;

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

test.use({ viewport: { width: 640, height: 420 }, locale: 'en-US' });

test('visual: provider marks for muse and mcode through ProviderMark', async ({ page }) => {
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

  await expect(board).toHaveScreenshot('provider-icons-marks.png', stableShot);
});

test('visual: muse mark carries the Meta blue ramp, mcode carries the brand red ramp', async ({ page }) => {
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