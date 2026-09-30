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
