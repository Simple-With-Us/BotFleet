import { test, expect, type Page } from '@playwright/test';

// The Call button's Personal Voice denial, rendered by the real
// CallTargetButton via /?fixture=call-button (see src/main.tsx and
// src/components/CallButtonVisualFixture.tsx).
// - requires-macos-14: a Mac older than macOS 14.  The button label and the
//   Call Unavailable popover both name macOS 14.
// - non-apple (&reason=non-apple): no reason code, so the popover says
//   Personal Voice speaks on Apple devices.
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

test.use({ viewport: { width: 600, height: 400 }, locale: 'en-US' });

const config = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: '' },
  rooms: { turnTimeoutMinutes: 30 },
  tts: { provider: 'minimax', configured: true, ready: true, voice: 'fixture-hosted-voice' },
};

async function stubApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/api/config') && route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

test('visual: Call button on a Mac older than macOS 14 says Personal Voice needs macOS 14', async ({ page }) => {
  await stubApi(page);
  await page.goto('/?fixture=call-button');
  await pinFonts(page);

  const board = page.getByTestId('call-button-board');
  await expect(board).toBeVisible();
  const button = board.getByRole('button', {
    name: 'Personal Voice needs macOS 14 or later, or an iPhone',
  });
  await expect(button).toBeVisible();
  await button.click();

  const popover = board.getByRole('group', { name: 'Call Unavailable' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Apple Personal Voice needs macOS 14 or later, or an iPhone.');
  await expect(popover).toContainText('Pick another voice to make calls on this computer.');
  await expect(board).toHaveScreenshot('call-button-personal-voice-macos-14.png', stableShot);
});

test('visual: Call button on a host that cannot speak Personal Voice says it speaks on Apple devices', async ({
  page,
}) => {
  await stubApi(page);
  await page.goto('/?fixture=call-button&reason=non-apple');
  await pinFonts(page);

  const board = page.getByTestId('call-button-board');
  await expect(board).toBeVisible();
  const button = board.getByRole('button', { name: 'Personal Voice needs a Mac or iPhone' });
  await expect(button).toBeVisible();
  await button.click();

  const popover = board.getByRole('group', { name: 'Call Unavailable' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Apple Personal Voice speaks on Apple devices (Mac and iPhone).');
  await expect(board).toHaveScreenshot('call-button-personal-voice-non-apple.png', stableShot);
});
