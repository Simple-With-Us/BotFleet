import { test, expect, type Page } from '@playwright/test';

// Automated visual verification for the saved-data notice (board 230ef988,
// audit rows A7 and C3): when BotFleet could not use a bots, rooms, routines
// or settings file, a bar across the top of the app says what happened and
// that nothing was deleted.
//
// Measurements and text, not pixel baselines, on purpose: the committed
// baselines in visual.spec.ts are Linux-only and pin DejaVu Sans, which would
// say more about the font than about the bar.  Placement, wrapping, overflow,
// the two skins' contrast and the dismiss control hold in any font.  Each case
// also saves a screenshot next to the test results so a person can look.
//
// The server is replaced by a mocked GET /api/data-faults; there is no bot
// server behind `vite preview`, the same as the other specs here.

interface Fault {
  file: string;
  kind: string;
  reason: string;
  setAsideAs: string | null;
  omitted: number;
  sections: string[];
  writesRefused: boolean;
  holdsCleanup: boolean;
  at: number;
}

const fault = (overrides: Partial<Fault> = {}): Fault => ({
  file: 'bots.json',
  kind: 'set-aside',
  reason: 'it ends early (it looks cut short)',
  setAsideAs: 'bots.json.corrupt-1790000000000',
  omitted: 0,
  sections: [],
  writesRefused: false,
  holdsCleanup: true,
  at: 1790000000000,
  ...overrides,
});

async function open(
  page: Page,
  options: { faults?: Fault[]; status?: number; skin?: 'studio' | 'midnight'; width?: number; height?: number } = {},
): Promise<void> {
  const { faults = [fault()], status = 200, skin = 'studio', width = 1280, height = 800 } = options;
  await page.setViewportSize({ width, height });
  await page.addInitScript((value) => {
    localStorage.setItem('omb-email-gate', 'skipped');
    localStorage.setItem('omb-skin', value);
  }, skin);
  await page.route('**/api/data-faults', (route) =>
    status === 200
      ? route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ faults }) })
      : route.fulfill({ status, contentType: 'text/html', body: '<!doctype html><title>Not found</title>' }),
  );
  await page.goto('/');
}

const banner = (page: Page) => page.getByTestId('data-fault-banner');

for (const skin of ['studio', 'midnight'] as const) {
  test.describe(`saved-data notice (${skin})`, () => {
    test('says what was set aside, that nothing was deleted, and how to restore it', async ({ page }, testInfo) => {
      await open(page, { skin });
      await expect(banner(page)).toBeVisible();
      await expect(banner(page)).toHaveAttribute('role', 'alert');
      const text = (await banner(page).innerText()).replace(/ /g, ' ');
      expect(text).toContain('Your bot list could not be read.');
      expect(text).toContain('bots.json.corrupt-1790000000000');
      expect(text).toContain('Nothing was deleted.');
      expect(text).toContain('quit BotFleet');
      expect(text).toContain('Automatic cleanup of old workspaces and transcripts stays paused');
      expect(text).not.toMatch(/\bagent/i);
      await banner(page).screenshot({ path: testInfo.outputPath(`notice-${skin}.png`) });
      await page.screenshot({ path: testInfo.outputPath(`page-${skin}.png`) });
    });

    test('is a full-width bar at the very top, above the app, with nothing overflowing', async ({ page }) => {
      await open(page, { skin });
      const box = (await banner(page).boundingBox())!;
      expect(box.y).toBeLessThan(2);
      expect(box.width).toBeGreaterThan(1270);
      const below = (await page.getByTitle('App Settings').boundingBox())!;
      expect(below.y).toBeGreaterThanOrEqual(box.y + box.height - 1);
      const overflow = await page.evaluate(() => ({
        page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        bar: (() => {
          const bar = document.querySelector<HTMLElement>('[data-testid="data-fault-banner"]')!;
          return bar.scrollWidth - bar.clientWidth;
        })(),
      }));
      expect(overflow).toEqual({ page: 0, bar: 0 });
    });

    test('keeps its text readable against the bar behind it', async ({ page }) => {
      for (const urgent of [false, true]) {
        await open(page, { skin, faults: [fault({ writesRefused: urgent, kind: urgent ? 'unreadable' : 'set-aside', setAsideAs: urgent ? null : 'bots.json.corrupt-1790000000000' })] });
        await expect(banner(page)).toBeVisible();
        // The bar's fill is translucent, so composite it over what is behind it the way the browser does.
        // A canvas is used because computed colours can come back in spaces a regex cannot parse.
        const ratio = await banner(page).evaluate((bar) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d', { willReadFrequently: true })!;
          const pixel = (css: string, under?: [number, number, number]): [number, number, number] => {
            context.clearRect(0, 0, 1, 1);
            if (under) {
              context.fillStyle = `rgb(${under.join(',')})`;
              context.fillRect(0, 0, 1, 1);
            }
            context.fillStyle = css;
            context.fillRect(0, 0, 1, 1);
            const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
            return [r!, g!, b!];
          };
          const layers: string[] = [];
          for (let node: Element | null = bar; node; node = node.parentElement) {
            layers.unshift(getComputedStyle(node).backgroundColor);
          }
          let behind: [number, number, number] = [255, 255, 255];
          for (const layer of layers) behind = pixel(layer, behind);
          const text = pixel(getComputedStyle(bar).color, behind);
          const luminance = ([r, g, b]: [number, number, number]) => {
            const channel = (value: number) => {
              const v = value / 255;
              return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
          };
          const [light, dark] = [luminance(behind), luminance(text)].sort((a, b) => b - a);
          return (light! + 0.05) / (dark! + 0.05);
        });
        expect(ratio, `${urgent ? 'error' : 'warning'} bar contrast in ${skin}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    test('reads as an error, not a warning, when changes are not being saved', async ({ page }, testInfo) => {
      await open(page, { skin, faults: [fault({ kind: 'unreadable', reason: 'it could not be read (EACCES)', setAsideAs: null, writesRefused: true })] });
      const urgent = await banner(page).evaluate((bar) => getComputedStyle(bar).backgroundColor);
      await expect(banner(page)).toContainText('changes to it are not being saved');
      await expect(banner(page)).toContainText('Fix or move that file');
      await banner(page).screenshot({ path: testInfo.outputPath(`notice-error-${skin}.png`) });

      await open(page, { skin });
      const calm = await banner(page).evaluate((bar) => getComputedStyle(bar).backgroundColor);
      expect(urgent).not.toBe(calm);
    });
  });
}

test.describe('saved-data notice behaviour', () => {
  test('shows every notice, one paragraph each', async ({ page }, testInfo) => {
    await open(page, {
      faults: [
        fault(),
        fault({ file: 'routines.json', setAsideAs: 'routines.json.corrupt-1790000000001', holdsCleanup: false }),
        fault({ file: 'config.json', kind: 'config-partial', reason: 'x', setAsideAs: null, sections: ['autoUpdate', 'instances.broken'], holdsCleanup: false }),
      ],
    });
    await expect(banner(page).locator('p')).toHaveCount(3);
    await expect(banner(page).locator('p').nth(2)).toContainText('autoUpdate, instances.broken');
    await banner(page).screenshot({ path: testInfo.outputPath('notice-three.png') });
  });

  test('can be dismissed for this visit, and comes back on the next', async ({ page }) => {
    await open(page);
    await expect(banner(page)).toBeVisible();
    await page.getByRole('button', { name: 'Dismiss Saved Data Notice' }).click();
    await expect(banner(page)).toHaveCount(0);
    await page.reload();
    await expect(banner(page)).toBeVisible();
  });

  test('is absent with no notices, and with an older server that has no such route', async ({ page }) => {
    await open(page, { faults: [] });
    await expect(page.getByTitle('App Settings')).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await open(page, { status: 404 });
    await expect(page.getByTitle('App Settings')).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test('wraps on a phone-width window with the dismiss control still in view', async ({ page }, testInfo) => {
    await open(page, { width: 375, height: 800 });
    await expect(banner(page)).toBeVisible();
    const bar = (await banner(page).boundingBox())!;
    const close = (await page.getByRole('button', { name: 'Dismiss Saved Data Notice' }).boundingBox())!;
    expect(bar.width).toBeLessThanOrEqual(375);
    expect(close.x + close.width).toBeLessThanOrEqual(375);
    expect(bar.height).toBeGreaterThan(80); // several lines, not one clipped line
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBe(0);
    await banner(page).screenshot({ path: testInfo.outputPath('notice-phone.png') });
  });
});
