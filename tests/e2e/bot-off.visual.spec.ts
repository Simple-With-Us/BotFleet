import { test, expect, type Page } from '@playwright/test';

// The bot On/Off switch, drawn.  The fixture mounts the real sidebar rows
// (BotListItem), the Bot Profile On/Off card and the disabled composer under a
// fixed store via /?fixture=bot-off (see src/main.tsx), so nothing here mocks a
// route.  This follows the repo's visual convention (tests/e2e/*.visual.spec.ts
// with a /?fixture= harness) and the DejaVu Sans font pin that keeps a
// baseline stable across machines.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Animations are disabled so the
// mascots' idle motion cannot land mid-frame.
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
  viewport: { width: 520, height: 900 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

test('visual: an Off bot is dimmed and labelled, the switch reads Off, and the composer is disabled', async ({ page }) => {
  await page.goto('/?fixture=bot-off');
  await pinFonts(page);

  const fixture = page.getByTestId('bot-off-fixture');
  await expect(fixture).toBeVisible();

  // Sidebar: one VISIBLE Off label per density, only on the Off bot's row.  The
  // icon-only row hides its name line (and the label in it) and shows a compact
  // one on the avatar instead, so count what is actually drawn.
  const rows = fixture.getByLabel('Sidebar rows');
  await expect(rows.locator('[data-testid="bot-off-badge"]:visible')).toHaveCount(2);
  await expect(rows.getByText('Scout').first()).toBeVisible();
  await expect(rows.getByText('Atlas').first()).toBeVisible();
  // The Off bot's avatar is dimmed through its data hook; the On bot's is not.
  await expect(rows.locator('[data-off="true"]')).toHaveCount(2);

  // Bot Profile card: one switch per state.
  const switches = fixture.getByRole('switch', { name: 'Bot On/Off' });
  await expect(switches).toHaveCount(2);
  await expect(switches.nth(0)).toHaveAttribute('aria-checked', 'true');
  await expect(switches.nth(1)).toHaveAttribute('aria-checked', 'false');
  await expect(fixture.getByText('Nothing new starts for this bot.')).toBeVisible();

  // Composer: the notice and the one way out, no text box.
  const composer = fixture.getByTestId('bot-off-composer');
  await expect(composer.getByText('This bot is off.')).toBeVisible();
  await expect(composer.getByRole('button', { name: 'Turn On Scout' })).toBeVisible();
  await expect(composer.locator('textarea')).toHaveCount(0);

  await expect(fixture).toHaveScreenshot('bot-off-states.png', stableShot);
});
