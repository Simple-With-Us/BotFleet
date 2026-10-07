import { test, expect, type Page } from '@playwright/test';
import { z } from 'zod';

// Voice settings, rendered by the real VoiceSettings component via
// /?fixture=voice-settings-personal (see src/main.tsx and
// src/components/VoiceSettingsVisualFixture.tsx).
// - Personal Voice denial after Add Voice ID submits a personal: identifier.
//   The desktop stub reports personalVoice false with requires-macos-14.
// - The per-device pickers (&variant=per-device): this Mac speaks its own
//   Personal Voice, and the iPhone's Personal Voice is shown greyed with the
//   reason.
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

test.use({ viewport: { width: 800, height: 1100 }, locale: 'en-US' });

const config = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: '' },
  rooms: { turnTimeoutMinutes: 30 },
  tts: { provider: 'minimax', configured: true, ready: true, voice: 'standard-default' },
};

test('visual: Personal Voice denial after a personal: voice id is submitted', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes('/api/tts/custom-voice') && method === 'POST') {
      // Same boundary as POST /api/tts/custom-voice: reject a body that is
      // not the voiceId/label object instead of trusting a cast.
      let raw: unknown;
      try {
        raw = route.request().postDataJSON();
      } catch {
        await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
        return;
      }
      const parsedBody = z
        .object({
          voiceId: z.string().min(1),
          label: z.string().optional(),
        })
        .strict()
        .safeParse(raw);
      if (!parsedBody.success) {
        await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
        return;
      }
      const body = parsedBody.data;
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
    if (url.includes('/api/tts/custom-voice/') && method === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, deleted: true }),
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
  await expect(board.getByRole('combobox', { name: "Assistant's voice on this Mac" })).toBeVisible();
  await expect(board.getByText('Loading voices…')).toHaveCount(0);

  await board.getByRole('button', { name: 'Add Voice ID' }).click();
  await board.getByRole('textbox', { name: 'Custom Voice ID' }).fill('personal:fixture-voice');
  await board.getByRole('button', { name: 'Add Voice' }).click();

  const denial = 'Personal Voices need macOS 14 or later, or an iPhone';
  await expect(board.getByRole('alert').filter({ hasText: denial })).toBeVisible();
  // The id is refused, not written onto the bot.  The picker stays on the
  // workspace default instead of selecting the personal: row, and the typed
  // id stays in the still-open form.
  await expect(board.getByRole('combobox', { name: "Assistant's voice on this Mac" })).toHaveValue('');
  await expect(board.getByRole('textbox', { name: 'Custom Voice ID' })).toHaveValue('personal:fixture-voice');
  await expect(board.getByText('Apple Personal Voice: fixture-voice')).toHaveCount(0);

  await expect(board).toHaveScreenshot('personal-voice-denied.png', stableShot);
});

test('visual: a Personal Voice on this Mac and the iPhone\'s own, side by side', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    if (url.includes('/api/tts/voices') && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ voices: [{ id: 'minimax-warm', label: 'Warm Narrator' }] }),
      });
      return;
    }
    if (url.includes('/api/config') && method === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/?fixture=voice-settings-personal&variant=per-device');
  await pinFonts(page);

  const board = page.getByTestId('voice-settings-board');
  await expect(board).toBeVisible();
  const capabilities = page.getByTestId('personal-voice-capabilities');
  await expect(capabilities).toHaveAttribute('data-ready', 'true');
  await expect(capabilities).toHaveAttribute('data-personal-voice', 'true');

  const mac = board.getByRole('combobox', { name: "Assistant's voice on this Mac" });
  const iphone = board.getByRole('combobox', { name: "Assistant's voice on iPhone" });
  // This Mac lists its own Personal Voice and speaks it here.
  await expect(mac).toHaveValue('personal:fixture-mac-voice');
  await expect(mac.locator('option[value="personal:fixture-mac-voice"]')).toHaveText(/Jay/);
  await expect(board.getByText('It plays on-device on this Mac.')).toBeVisible();
  await expect(board.getByText('Loading Personal Voices on this Mac…')).toHaveCount(0);
  // The iPhone keeps its own Personal Voice: shown, greyed, with the reason.
  await expect(iphone).toHaveValue('personal:fixture-iphone-voice');
  await expect(iphone.locator('option[value="personal:fixture-iphone-voice"]')).toBeDisabled();
  await expect(iphone.locator('option[value="minimax-warm"]')).toHaveCount(1);
  await expect(iphone.locator('option[value="personal:fixture-mac-voice"]')).toHaveCount(0);
  await expect(board.getByText(/Personal Voice from your iPhone\.\s+Choose it on the iPhone\./).first()).toBeVisible();

  await expect(board).toHaveScreenshot('voice-settings-per-device.png', stableShot);
});
