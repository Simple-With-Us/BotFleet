import { test, expect, type Page } from '@playwright/test';

// Host & CLI Integration card.  The fixture mounts the real card via
// /?fixture=host-cli-integration (see src/main.tsx).  There is no
// visual-tests/ directory; this follows tests/e2e/computer-panel.visual.spec.ts.
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

test.use({ viewport: { width: 800, height: 720 }, locale: 'en-US', timezoneId: 'UTC' });

test('visual: HostCliIntegrationCard default toggles', async ({ page }) => {
  await page.goto('/?fixture=host-cli-integration');
  await pinFonts(page);

  const board = page.getByTestId('host-cli-integration-board');
  await expect(board).toBeVisible();
  const card = page.locator('#setting-computers-cli-credentials');
  await expect(card).toBeVisible();
  await expect(card.getByText('Host & CLI Integration', { exact: true })).toBeVisible();
  await expect(card.getByText('Share Host CLI Credentials with Local & Cloud VMs', { exact: true })).toBeVisible();
  await expect(card.getByText('Host Shell Execution with VM Screen (Hybrid Mode)', { exact: true })).toBeVisible();

  await expect(card).toHaveScreenshot('host-cli-integration-default.png', stableShot);
});
