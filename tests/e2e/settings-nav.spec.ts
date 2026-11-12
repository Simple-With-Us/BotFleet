import { test, expect, type Locator, type Page } from '@playwright/test';

// Automated visual verification for the Settings rail (owner request
// 2026-09-30): bold tab labels that stay on one line, a little more room under
// the Search field, a lighter Search field, and "Remote" instead of "Remote
// Access".
//
// These are measurements rather than pixel baselines on purpose.  The
// whole-dialog baseline in visual.spec.ts pins DejaVu Sans, which is wider than
// the system font the app ships with, so a "no label wraps" check against it
// would say more about DejaVu than about the app.  Weight, line count, spacing
// and relative luminance hold in any font and in every skin.

async function openSettings(page: Page, skin: 'studio' | 'midnight'): Promise<Locator> {
  await page.addInitScript((value) => {
    localStorage.setItem('omb-email-gate', 'skipped');
    localStorage.setItem('omb-skin', value);
  }, skin);
  await page.goto('/');
  await page.getByTitle('App Settings').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'General', exact: true })).toBeVisible();
  return dialog;
}

for (const skin of ['studio', 'midnight'] as const) {
  test.describe(`settings rail (${skin})`, () => {
    test('tab labels are bold and each sits on one line', async ({ page }) => {
      const dialog = await openSettings(page, skin);
      const tabs = await dialog.locator('nav button').evaluateAll((buttons) =>
        buttons.map((button) => {
          const label = button.querySelector('span.truncate');
          const style = getComputedStyle(button);
          return {
            text: label?.textContent ?? '',
            weight: Number(style.fontWeight),
            fontSize: parseFloat(style.fontSize),
            buttonHeight: button.getBoundingClientRect().height,
            labelHeight: label?.getBoundingClientRect().height ?? 0,
          };
        }),
      );

      expect(tabs.map((tab) => tab.text)).toEqual([
        'General',
        'Connections',
        'Remote',
        'Engines',
        'Models',
        'Phone',
        'Computers',
        'Usage',
        'Observability',
        'Secrets',
        'Resources',
      ]);
      for (const tab of tabs) {
        expect(tab.weight, `${tab.text} font weight`).toBeGreaterThanOrEqual(600);
        // One line of text is about 1.5x the font size tall; two lines is about 3x.
        expect(tab.labelHeight, `${tab.text} label height`).toBeLessThan(tab.fontSize * 2);
        expect(tab.buttonHeight, `${tab.text} tab height`).toBeCloseTo(tabs[0]!.buttonHeight, 0);
      }
    });

    test('Remote is its own tab and opens the Remote Access card', async ({ page }) => {
      const dialog = await openSettings(page, skin);
      await expect(dialog.getByRole('button', { name: 'Remote Access' })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Remote', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Remote', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(dialog.getByText('Remote Access', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Phone', exact: true })).toBeVisible();
    });

    test('Resources tab renders a stubbed host report with editable headroom knobs', async ({ page }) => {
      const dialog = await openSettings(page, skin);
      // The E2E preview server has no /api/* backend, so stub the one route
      // this tab reads (composer-draft.spec.ts stubs **/api/** the same way).
      const GB = 1024 ** 3;
      await page.route('**/api/host/resources', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            hostId: 'mac:e2e-stub',
            version: '1.2.3',
            platform: 'darwin',
            capabilities: ['shell', 'macos'],
            sample: {
              at: Date.UTC(2026, 9, 29, 19, 14, 0),
              cores: 10,
              loadPerCore: 2.41,
              ramTotalBytes: 32 * GB,
              ramAvailableBytes: 20 * GB,
              memoryPressure: null,
              memoryAvailablePercent: 63,
              swapTotalBytes: 4 * GB,
              swapUsedBytes: 3 * GB,
              diskTotalBytes: 100 * GB,
              diskFreeBytes: 60 * GB,
              inodesTotal: 6_000_000,
              inodesFree: 5_000_000,
              dataVolume: null,
              rootDiskFreeBytes: 10 * GB,
              storage: { online: true, dataDevice: '8:16', rootDevice: '8:1' },
            },
            storage: { online: true, dataDevice: '8:16', rootDevice: '8:1' },
            admission: { maxSwapPercent: 98, minFreeDiskBytes: 2 * GB, unknownReading: 'admit' },
            enforcement: {
              cpu: { kind: 'priorityOnly' },
              memory: { kind: 'gateOnly' },
              swap: { kind: 'gateOnly' },
              disk: { kind: 'gateOnly' },
              inodes: { kind: 'unsupported', reason: 'No inode admission gate is active' },
              io: { kind: 'unsupported', reason: 'No I/O rate enforcement observed' },
            },
            observedLimits: {},
            limitations: ['Disk is an admission gate; no disk quota is observed'],
          }),
        }),
      );
      await dialog.getByRole('button', { name: 'Resources', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Resources', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      await expect(dialog.getByText('Host Resource Readings', { exact: true })).toBeVisible();
      await expect(dialog.getByRole('table', { name: 'Host resource readings' })).toBeVisible();
      await expect(dialog.getByText('Admission Thresholds (Saved vs Applied)', { exact: true })).toBeVisible();
      await expect(dialog.getByText('Owner-Set Headroom', { exact: true })).toBeVisible();
      // Unset headroom knobs stay editable with a Not set placeholder.
      const reservedCpu = dialog.getByLabel('Reserved CPU cores');
      await expect(reservedCpu).toBeEnabled();
      await expect(reservedCpu).toHaveAttribute('placeholder', 'Not set');
      await expect(dialog.getByRole('button', { name: 'Save headroom' })).toBeVisible();
      // Refresh keeps the report on screen instead of flashing a skeleton.
      await dialog.getByRole('button', { name: 'Refresh host resources' }).click();
      await expect(dialog.getByRole('table', { name: 'Host resource readings' })).toBeVisible();
    });

    test('there is more room under Search, and the field is lighter than before', async ({ page }) => {
      const dialog = await openSettings(page, skin);
      const measured = await dialog.evaluate((root) => {
        const nav = root.querySelector('nav')!;
        const field = nav.querySelector('[data-testid="settings-search-field"]')!;
        const firstTab = [...nav.querySelectorAll('button')].find((button) => button.querySelector('span.truncate'))!;
        const gap = firstTab.getBoundingClientRect().top - field.getBoundingClientRect().bottom;

        // Relative luminance of a CSS color painted over the dialog's own panel
        // color, read back through a canvas so any color syntax resolves.
        const panel = getComputedStyle(root).backgroundColor;
        const luminanceOver = (css: string) => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d')!;
          ctx.fillStyle = panel;
          ctx.fillRect(0, 0, 1, 1);
          ctx.fillStyle = css;
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data as unknown as number[];
          const channel = (value: number) => {
            const v = value / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          };
          return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
        };

        const control = getComputedStyle(nav).getPropertyValue('--color-control').trim();
        return {
          gap,
          now: luminanceOver(getComputedStyle(field).backgroundColor),
          // What the field used to paint: `bg-control/70`.
          before: luminanceOver(`color-mix(in oklab, ${control} 70%, transparent)`),
        };
      });

      // Was 8px (a 6px margin plus the 2px flex gap); now 14px.
      expect(measured.gap).toBeGreaterThanOrEqual(12);
      expect(measured.gap).toBeLessThanOrEqual(20);
      expect(measured.now).toBeGreaterThan(measured.before);
    });

    test('searching keeps bold tabs, and the Remote tab finds the Remote Access card', async ({ page }) => {
      const dialog = await openSettings(page, skin);
      await dialog.getByRole('textbox', { name: 'Search Settings' }).fill('tunnel');
      const remote = dialog.locator('nav').getByRole('button', { name: /^Remote/ });
      await expect(remote).toBeVisible();
      const weights = await dialog.locator('nav button').evaluateAll((buttons) =>
        buttons
          .filter((button) => button.querySelector('span.truncate'))
          .map((button) => Number(getComputedStyle(button).fontWeight)),
      );
      expect(weights.length).toBeGreaterThan(1);
      for (const weight of weights) expect(weight).toBeGreaterThanOrEqual(600);
    });
  });
}
