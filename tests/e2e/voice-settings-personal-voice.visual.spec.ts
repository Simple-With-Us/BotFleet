import { test, expect, type Page } from '@playwright/test';

// Personal Voice denial after Add Voice ID submits a personal: identifier.
// The card is the real VoiceSettings component via
// /?fixture=voice-settings-personal (see src/main.tsx). The desktop stub in
// the fixture reports personalVoice false with requires-macos-14. There is
// no visual-tests/ directory; this follows tests/e2e/visual.spec.ts.
const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 } as const;

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

test.use({ viewport: { width: 800, height: 1100 }, locale: 'en-US' });

test('visual: Personal Voice denial after a personal: voice id is submitted', async ({ page }) => {
  const config = {
    composio: { configured: false },
    box: { configured: false },
    vps: { configured: false, sshAlias: '' },
    rooms: { turnTimeoutMinutes: 30 },
    tts: { provider: 'minimax', configured: true, ready: true, voice: 'standard-default' },
  };

  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes('/api/tts/custom-voice') && method === 'POST') {
      const body = route.request().postDataJSON() as { voiceId?: string; label?: string };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          voice: { id: body.voiceId, label: body.label || body.voiceId },
        }),
      });
      return;
    }
    if (url.includes('/api/tts/voices') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ voices: [] }),
      });
      return;
    }
    if (url.includes('/api/config') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(config),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/?fixture=voice-settings-personal');
  await pinFonts(page);

  const board = page.getByTestId('voice-settings-board');
  await expect(board).toBeVisible();
  const capabilities = page.getByTestId('personal-voice-capabilities');
  await expect(capabilities).toHaveAttribute('data-ready', 'true');
  await expect(capabilities).toHaveAttribute('data-personal-voice', 'false');
  await expect(capabilities).toHaveAttribute('data-reason', 'requires-macos-14');

  // Voices have settled, so the picker is not still on "Loading voices…".
  await expect(board.getByRole('combobox', { name: "Assistant's voice" })).toBeVisible();
  await expect(board.getByText('Loading voices…')).toHaveCount(0);

  await board.getByRole('button', { name: 'Add Voice ID' }).click();
  await board.getByRole('textbox', { name: 'Custom Voice ID' }).fill('personal:fixture-voice');
  await board.getByRole('button', { name: 'Add Voice' }).click();

  const denial = 'Personal Voices need macOS 14 or later, or an iPhone';
  await expect(board.getByRole('alert').filter({ hasText: denial })).toBeVisible();
  // The id is refused, not written onto the bot. The picker stays on the
  // workspace default instead of selecting the personal: row.
  await expect(board.getByRole('combobox', { name: "Assistant's voice" })).toHaveValue('');
  await expect(board.getByText('Apple Personal Voice: fixture-voice')).toHaveCount(0);

  await expect(board).toHaveScreenshot('personal-voice-denied.png', stableShot);
});
