import { test, expect, type Page } from '@playwright/test';

// Automated visual coverage for the keyed TVFaceAvatar mount path used by the
// main app shell. The fixture is mounted via /?fixture=tv-face (see
// src/main.tsx); this spec pins each first-paint src, watches the timed
// enter→hold transition driven by the component's own
// TVFACE_TRANSITION_MS timer, and proves that the keyed remount of a hold
// avatar mounts a fresh <img> rather than reusing the previous one.
//
// The native Mac desktop app is NOT covered here — Playwright cannot drive
// it; that surface stays on code review + CI.
const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02 } as const;

/** Pin fonts: the app's first-choice "Inter" is not installed on CI runners
 * or this lane's VM, so each environment falls back to a different system
 * sans and every glyph rasterizes differently. DejaVu Sans (+ Mono) ships
 * with Ubuntu base and is present in both, so forcing it makes the
 * baselines portable across machines. */
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

test.use({ viewport: { width: 800, height: 600 } });

test('visual: keyed TVFaceAvatar mount, transition, and remount', async ({ page }) => {
  await page.goto('/?fixture=tv-face');

  const board = page.getByTestId('tv-face-board');
  await expect(board).toBeVisible();

  // Capture the enter frame before anything else.  The component swaps to
  // the hold GIF on its own TVFACE_TRANSITION_MS timer (1000ms), and a slow
  // first load must not miss that window.
  const holdImg = page.getByTestId('animated-hold').locator('img');
  await expect(holdImg).toHaveAttribute('src', /thinking_enter\.gif$/);

  // Mark the enter-phase img so we can detect that the hold step mounted a
  // fresh <img> node (the component keys the img on imgKey, which flips
  // from enter to hold). The new node will not carry the mark.
  await holdImg.evaluate((el: HTMLImageElement) => {
    el.dataset.fxHoldMark = '1';
  });

  await pinFonts(page);

  // Still frame: animated={false} cuts straight to the still PNG. The src
  // comes from the component's initialFrameMedia path, so any drift back to
  // a GIF would surface here.
  const stillHappyImg = page.getByTestId('still-happy').locator('img');
  await expect(stillHappyImg).toHaveAttribute('src', /stills\/happy\.png$/);

  // First paint of an animated resting avatar: prev=resting, next=resting,
  // frame unchanged → resting_hold GIF with holdEpoch 1.
  const restingImg = page.getByTestId('animated-resting').locator('img');
  await expect(restingImg).toHaveAttribute('src', /resting_hold\.gif$/);

  await expect(holdImg).toHaveAttribute('src', /thinking_hold\.gif$/, {
    timeout: 5_000,
  });

  // The new hold-phase <img> is a different DOM node, so the mark we set
  // on the enter-phase img is gone with it. This is the proof that the
  // keyed hold step did not silently reuse the previous img.
  await expect(holdImg).not.toHaveAttribute('data-fx-hold-mark', '1');

  // Keyed remount: clicking the button flips the React key on the
  // remount-slot avatar, so the previous instance unmounts and a fresh one
  // mounts. The new mount's first paint is the resting hold GIF.
  await page.getByRole('button', { name: 'Remount hold avatar' }).click();
  const remountImg = page.getByTestId('remount-slot').locator('img');
  await expect(remountImg).toHaveAttribute('src', /resting_hold\.gif$/);
  await expect(remountImg).not.toHaveAttribute('src', /^$/);

  // After all four states have settled, snapshot the board. The fixtures
  // carry no clocks, no random data, and the GIFs are frozen on first
  // frame by animations: 'disabled'.
  await expect(board).toHaveScreenshot('tv-face-avatar-keyed-mount.png', stableShot);
});
