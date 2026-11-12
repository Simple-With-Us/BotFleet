import { test, expect, type Page } from '@playwright/test';

// Shared-context dialog sentence in TeamMapPage.  The fixture mounts the real
// dialog via /?fixture=team-map-context (see src/main.tsx).  GET
// /api/section-context is fulfilled here because that route is the bot
// server, which this lane does not run.  The header sentence is the
// component's own copy.  There is no visual-tests/ directory; this follows
// tests/e2e/visual.spec.ts.
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

test.use({ viewport: { width: 1000, height: 800 }, locale: 'en-US', timezoneId: 'UTC' });

test('visual: Team Map shared-context dialog', async ({ page }) => {
  await page.route('**/api/section-context**', (route) => {
    if (route.request().method() !== 'GET') {
      return route.fallback();
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        section: 'ops',
        label: 'Operations',
        text: '',
        updatedAt: null,
        maxBytes: 24000,
      }),
    });
  });

  await page.goto('/?fixture=team-map-context');
  await pinFonts(page);

  const dialog = page.getByRole('dialog', { name: 'Operations shared context' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/start of each turn\.\s+Only you can edit it\./)).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Operations shared context' })).toBeVisible();

  await expect(dialog).toHaveScreenshot('team-map-shared-context.png', stableShot);
});
