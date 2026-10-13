import { test, expect, type Page } from '@playwright/test';

// No-command installer sentence in EngineSetup.  The fixture mounts the real
// card via /?fixture=engine-setup (see src/main.tsx).  There is no
// visual-tests/ directory; this follows tests/e2e/visual.spec.ts.
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

test.use({ viewport: { width: 800, height: 600 }, locale: 'en-US' });

test('visual: EngineSetup no-command installer sentence', async ({ page }) => {
  await page.goto('/?fixture=engine-setup');
  await pinFonts(page);

  const board = page.getByTestId('engine-setup-board');
  await expect(board).toBeVisible();
  // NBSP + space is the sentence gap.  \\s covers that character.
  await expect(board.getByText(/There isn’t a one-line installer for this platform\.\s+Use the setup guide below\./)).toBeVisible();
  await expect(board.getByRole('link', { name: 'View setup guide' })).toBeVisible();

  await expect(board).toHaveScreenshot('engine-setup-no-command.png', stableShot);
});
