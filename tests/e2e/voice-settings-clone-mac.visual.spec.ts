import { test, expect, type Page } from '@playwright/test';

// Mac voice-clone controls inside the real VoiceSettings card
// (/?fixture=voice-settings-personal with the darwin desktop stub).
const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02, threshold: 0.2 } as const;

const config = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: '' },
  rooms: { turnTimeoutMinutes: 30 },
  tts: {
    provider: 'minimax',
    configured: true,
    ready: true,
    voice: 'jay-wedgeworth-001',
    pronunciations: [],
  },
};

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

async function stubVoiceCloneMic(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const tracks = [{ stop: () => {} }];
    const stream = { getTracks: () => tracks } as MediaStream;
    navigator.mediaDevices.getUserMedia = async () => stream;

    class MockMediaRecorder {
      static isTypeSupported(): boolean {
        return true;
      }

      mimeType = 'audio/webm;codecs=opus';
      state: RecordingState = 'inactive';
      ondataavailable: ((event: BlobEvent) => void) | null = null;

      constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {}

      start(): void {
        this.state = 'recording';
      }

      stop(): void {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob(['fixture'], { type: 'audio/webm' }) } as BlobEvent);
      }

      addEventListener(type: string, listener: () => void): void {
        if (type === 'stop') setTimeout(listener, 0);
      }
    }

    window.MediaRecorder = MockMediaRecorder as typeof MediaRecorder;
  });
}

async function routeVoiceApis(page: Page): Promise<void> {
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
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(config),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
}

function minimalWavBuffer(): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(0, 40);
  return header;
}

test.use({ viewport: { width: 800, height: 1100 }, locale: 'en-US' });

test('visual: Mac voice clone panel — record, recording, and ready states', async ({ page }) => {
  await stubVoiceCloneMic(page);
  await routeVoiceApis(page);

  await page.goto('/?fixture=voice-settings-personal');
  await pinFonts(page);

  const board = page.getByTestId('voice-settings-board');
  await expect(board).toBeVisible();
  await expect(board.getByText('Loading voices…')).toHaveCount(0);

  await board.getByRole('button', { name: 'Clone Audio' }).click();
  await expect(board.getByRole('button', { name: 'Record on This Mac' })).toBeVisible();
  await expect(board).toHaveScreenshot('voice-clone-mac-record.png', stableShot);

  await board.getByRole('button', { name: 'Record on This Mac' }).click();
  await expect(board.getByRole('button', { name: /Stop Recording/ })).toBeVisible();
  await expect(board).toHaveScreenshot('voice-clone-mac-recording.png', {
    ...stableShot,
    mask: [page.getByTestId('clone-record-elapsed')],
  });

  await board.locator('input[aria-label="Audio file for voice clone"]').setInputFiles({
    name: 'fixture-clip.wav',
    mimeType: 'audio/wav',
    buffer: minimalWavBuffer(),
  });
  await expect(board.getByTestId('clone-record-ready')).toContainText('fixture-clip.wav');
  await expect(board).toHaveScreenshot('voice-clone-mac-ready.png', stableShot);
});
