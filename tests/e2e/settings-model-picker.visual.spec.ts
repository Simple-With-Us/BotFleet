import { test, expect, type Page } from '@playwright/test';

// Coverage for the contained (Settings) model picker — the shape the owner
// screenshotted on 2026-10-15, where "Primary Model" shared a line with the
// dropdown, wrapped onto two lines, and broke its subtitle into a five-word
// ribbon at every desktop width.
//
// The assertions are GEOMETRY, not a screenshot alone, and for the reason
// model-rows.visual.spec.ts gives: this is width arithmetic inside a flex row,
// and a picture of it is only as good as whoever looks at it.  These read the
// rendered boxes and check the invariants directly.  The stack is ALSO pinned
// as a source shape in ui-copy.test.ts; the two fail differently on purpose —
// that one catches the markup, this one catches what a person actually sees.

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

type Geometry = {
  labelText: string;
  labelWidth: number;
  labelHeight: number;
  oneLineHeight: number;
  labelTop: number;
  labelBottom: number;
  triggerTop: number;
  triggerWidth: number;
  triggerHeight: number;
  contentWidth: number;
};

async function geometry(page: Page): Promise<Geometry> {
  const card = page.getByTestId('settings-model-picker-card');
  return card.evaluate((node) => {
    // The label is the "Primary Model" heading the panel passes in; the trigger
    // is the only dialog-opening control on a closed picker.  Both are found by
    // behaviour rather than by a class name, so restyling either cannot break
    // this spec.
    const label = Array.from(node.querySelectorAll('div')).find(
      (el) => el.children.length === 0 && el.textContent?.trim() === 'Primary Model',
    ) as HTMLElement | undefined;
    const trigger = node.querySelector('button[aria-haspopup="dialog"]') as HTMLElement | null;
    if (!label || !trigger) throw new Error('picker did not render a label and a trigger');
    const labelBox = label.getBoundingClientRect();
    const triggerBox = trigger.getBoundingClientRect();
    const styles = getComputedStyle(node);
    return {
      labelText: (label.textContent ?? '').trim(),
      labelWidth: Math.round(labelBox.width),
      labelHeight: Math.round(labelBox.height),
      oneLineHeight: Math.round(Number.parseFloat(getComputedStyle(label).lineHeight) || labelBox.height),
      labelTop: Math.round(labelBox.top),
      labelBottom: Math.round(labelBox.bottom),
      triggerTop: Math.round(triggerBox.top),
      triggerWidth: Math.round(triggerBox.width),
      triggerHeight: Math.round(triggerBox.height),
      // The card's own content box: what the trigger is allowed to fill.
      contentWidth: Math.round(node.clientWidth - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight)),
    };
  });
}

test.use({ viewport: { width: 900, height: 600 }, locale: 'en-US' });

test.describe('the Settings model picker stacks label above dropdown', () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-10-15T15:00:00Z'));
    await page.goto('/?fixture=settings-model-picker');
    await pinFonts(page);
    await page.waitForSelector('[data-testid="settings-model-picker-card"] button[aria-haspopup="dialog"]');
  });

  test('reads "Primary Model" on a single line', async ({ page }) => {
    const box = await geometry(page);
    expect(box.labelText).toBe('Primary Model');
    // The wrap the owner reported: a taller box than one line means the heading
    // broke across two, which is what "wrapping it so terribly" looked like.
    expect(box.labelHeight, 'the label wrapped').toBeLessThanOrEqual(box.oneLineHeight + 1);
  });

  test('puts the label ABOVE the dropdown, never beside it', async ({ page }) => {
    const box = await geometry(page);
    // The defect itself: sharing a line meant the label got whatever width the
    // trigger left over, which is how "Primary Model" became two lines.
    expect(
      box.labelBottom,
      'the label sits beside the dropdown, so it inherits the leftover width',
    ).toBeLessThanOrEqual(box.triggerTop + 2);
  });

  test('fills the column with the dropdown', async ({ page }) => {
    const box = await geometry(page);
    // A chip left floating in a wide column reads as a button in space; the
    // contained trigger is a full-width control.
    expect(box.triggerWidth, 'the dropdown does not fill its column').toBeGreaterThan(box.contentWidth * 0.95);
    // And a full-width control is a row, not a pill: taller than one line.
    expect(box.triggerHeight).toBeGreaterThan(box.oneLineHeight);
  });
});
test.describe('fleet-wide model picker', () => {
  for (const width of [1440, 800, 390]) {
    test(`uses available width and stays on screen at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/?fixture=settings-model-picker&wide=1');
      const trigger = page.locator('[data-testid="settings-model-picker-card"] button[aria-haspopup="dialog"]');
      await trigger.click();
      const menu = page.getByRole('dialog', { name: 'Choose Model' });
      const box = await menu.boundingBox();
      const button = await trigger.boundingBox();
      expect(box).not.toBeNull();
      expect(button).not.toBeNull();
      expect(box!.width).toBeGreaterThan(350);
      expect(box!.width).toBeGreaterThan(button!.width);
      expect(box!.x).toBeGreaterThanOrEqual(11);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width - 11);
      expect(box!.y).toBeGreaterThanOrEqual(button!.y + button!.height);
      // The fixture deliberately clips its parent. The portaled menu must
      // remain visible and interactive outside that card.
      await expect(menu.getByRole('button', { name: /Claude Sonnet/ })).toBeVisible();
      // The menu mounts inside the modal dialog, not on the body, so that
      // dialog's Tab trap (which only walks its own subtree) still reaches it.
      await expect(page.locator('[aria-modal="true"] [data-model-picker-content]')).toHaveCount(1);
      // Opening moves focus into the menu, and Tab keeps it there.
      const focusInMenu = () => menu.evaluate((node) => node.contains(document.activeElement));
      expect(await focusInMenu()).toBe(true);
      await page.keyboard.press('Tab');
      expect(await focusInMenu()).toBe(true);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
    });
  }
});
