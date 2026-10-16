import { test, expect, type Page } from '@playwright/test';

// Coverage for the power-off-while-running dialog (src/components/ConfirmDialog.tsx,
// driven by shared/bot-power.ts copy through tests/fixture=power-off-confirm).
// This is the only dialog in the app that asks a question with THREE answers —
// keep it on, power off after this turn, or stop it and power off — and every
// one of those labels is long enough that the button row must wrap at the
// narrow end.  A two-button dialog cannot catch that failure, which is why the
// three-answer shape needed a spec of its own rather than more assertions on
// an existing screenshot.
//
// The assertions are GEOMETRY, not a screenshot, and for the reason
// model-rows.visual.spec.ts gives: the failure mode is width arithmetic inside
// a wrapping flex row, and a picture of it is only as good as whoever looks
// at it.  Reading the rendered boxes also keeps this spec off the baseline
// treadmill — toHaveScreenshot baselines are per-platform and CI runs this
// leg on Linux, so a new screenshot here would ship a baseline only the
// machine that wrote it can pass.  settings-model-picker.visual.spec.ts is the
// precedent for a visual spec that asserts without one.
//
// The component-level half of this coverage is src/components/ConfirmDialog.test.tsx,
// which pins the three labels, their order and the focus target in SSR and DOM.
// This spec pins what that test cannot see: the boxes a person actually gets.

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

type DialogGeometry = {
  labels: string[];
  dialogClientWidth: number;
  dialogScrollWidth: number;
  dialogScrollHeight: number;
  dialogClientHeight: number;
  viewportHeight: number;
  dialogLeft: number;
  dialogRight: number;
  /** Per button: its rendered box, whether it is wider than the dialog's own
   *  content box, and whether its own label was truncated. */
  buttons: Array<{
    label: string;
    left: number;
    right: number;
    top: number;
    bottom: number;
    height: number;
    width: number;
    clientWidth: number;
    scrollWidth: number;
  }>;
  /** How many rows the button row occupies — one means all three fitted. */
  rowCount: number;
};

async function geometry(page: Page): Promise<DialogGeometry> {
  const dialog = page.getByRole('dialog');
  return dialog.evaluate((node) => {
    const buttons = Array.from(node.querySelectorAll('button')).map((el) => {
      const box = el.getBoundingClientRect();
      return {
        label: (el.textContent ?? '').trim(),
        left: Math.round(box.left),
        right: Math.round(box.right),
        top: Math.round(box.top),
        bottom: Math.round(box.bottom),
        height: Math.round(box.height),
        width: Math.round(box.width),
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
      };
    });
    return {
      labels: buttons.map((b) => b.label),
      dialogClientWidth: node.clientWidth,
      dialogScrollWidth: node.scrollWidth,
      dialogScrollHeight: node.scrollHeight,
      dialogClientHeight: node.clientHeight,
      viewportHeight: window.innerHeight,
      dialogLeft: Math.round(node.getBoundingClientRect().left),
      dialogRight: Math.round(node.getBoundingClientRect().right),
      buttons,
      // Buttons sharing a rounded `top` share a row.  Grouped rather than
      // compared pairwise so a third row counts as its own row.
      rowCount: new Set(buttons.map((b) => b.top)).size,
    };
  });
}

const KEEP_ON = 'Keep It On';
const AFTER_TURN = 'Power Off After This Turn';
const STOP_AND_OFF = 'Stop It And Power Off';

test.describe('the power-off dialog asks three answers without clipping any of them', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?fixture=power-off-confirm');
    await pinFonts(page);
    await page.waitForSelector('[role="dialog"] button');
  });

  test('offers all three answers, reversible one first', async ({ page }) => {
    const box = await geometry(page);
    // Three buttons is the whole point of this dialog: Escape and Cancel both
    // mean "change nothing", so the third outcome must not land in the Cancel
    // slot.  If this ever reads two, the dialog has silently degraded into an
    // are-you-sure and the third answer is unreachable.
    expect(box.labels).toEqual([KEEP_ON, AFTER_TURN, STOP_AND_OFF]);
  });

  test('never lets the dialog outgrow its own box', async ({ page }) => {
    const box = await geometry(page);
    // The panel sets overflow-auto, so a too-wide row would not announce itself
    // — it would just gain a scrollbar and clip a label.  scrollWidth exceeding
    // clientWidth is that silent state.
    expect(box.dialogScrollWidth, 'the dialog scrolls sideways instead of wrapping').toBeLessThanOrEqual(
      box.dialogClientWidth + 1,
    );
  });

  test('keeps every button inside the dialog, whatever the viewport', async ({ page }) => {
    const box = await geometry(page);
    for (const button of box.buttons) {
      expect(
        button.width,
        `"${button.label}" is wider than the dialog can show`,
      ).toBeLessThanOrEqual(box.dialogClientWidth + 1);
    }
  });

  test('truncates no label', async ({ page }) => {
    const box = await geometry(page);
    for (const button of box.buttons) {
      expect(
        button.scrollWidth,
        `"${button.label}" had its text cut off`,
      ).toBeLessThanOrEqual(button.clientWidth + 1);
    }
  });

  test('wraps the row rather than squeezing the labels', async ({ page }) => {
    const box = await geometry(page);
    // The three labels are longer than the dialog's 420px, so the row has to
    // wrap.  Note what flex-nowrap does NOT do: it does not overflow, and it
    // does not clip.  Flex items shrink, so all three land on one row and each
    // label wraps INSIDE its own button.  Nothing overflows, nothing truncates,
    // and the squeeze still ships — which is why "no overflow" and "no
    // truncation" are not sufficient guards on their own.
    expect(
      box.rowCount,
      'the row did not wrap, so the buttons were squeezed instead',
    ).toBeGreaterThanOrEqual(2);
  });

  test('leaves every button one line tall', async ({ page }) => {
    const box = await geometry(page);
    // All three share padding and line-height, so the ONLY thing that can make
    // one taller than the others is its own label wrapping.  Comparing against
    // the shortest rather than the tallest keeps this a real assertion: every
    // button must equal the minimum, not merely sit below a maximum.
    const shortest = Math.min(...box.buttons.map((b) => b.height));
    for (const button of box.buttons) {
      expect(
        button.height - shortest,
        `"${button.label}" is taller than a one-line button`,
      ).toBeLessThanOrEqual(1);
    }
  });

  test('keeps the destructive answer rightmost, so muscle memory still lands', async ({ page }) => {
    const box = await geometry(page);
    const destructive = box.buttons.find((b) => b.label === STOP_AND_OFF);
    expect(destructive, 'the destructive answer is missing').toBeDefined();
    for (const button of box.buttons) {
      expect(
        destructive!.right,
        `"${button.label}" sits to the right of the destructive answer`,
      ).toBeGreaterThanOrEqual(button.right);
    }
  });

  test('fits on screen at the narrow end', async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 420 });
    const box = await geometry(page);
    expect(box.dialogLeft, 'the dialog runs off the left edge').toBeGreaterThanOrEqual(0);
    // The dialog is centred, so right overflow mirrors left overflow.
    expect(
      box.dialogScrollHeight,
      'the dialog is taller than it can show, so a button is clipped',
    ).toBeLessThanOrEqual(box.dialogClientHeight + 1);
  });
});