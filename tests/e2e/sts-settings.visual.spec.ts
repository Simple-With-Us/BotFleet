import { test, expect, type Locator, type Page } from '@playwright/test';

// Automated visual coverage for the speech-to-speech panel in Settings →
// Connections (Kody finding on PR #1085: the panel shipped with no screenshot
// assertion, so a visual regression could only surface after release).
//
// The real SettingsModal is driven — open it, pick Connections, let the real
// StsSettings mount — rather than a dedicated fixture component, because the
// defect this guards is "the panel does not look right where it ships".  The
// two inputs it reads are stubbed so the frame is deterministic:
//
//   * window.ogb.sts.status(), because Playwright's chromium lane has no
//     Electron bridge and the panel would otherwise render only its "available
//     in the installed desktop app" note.  Object.defineProperty rather than a
//     plain assignment, matching installNativeMenuStub in task-app-context.spec.
//   * GET /api/config, seeded with the sts slice the panel hydrates from, so the
//     panel shows a chosen provider and the engine toggle on instead of the
//     Auto/engine-on defaults it ships with.
//
// The screenshot is scoped to #setting-connections-sts rather than the whole
// dialog: the rest of Connections is a dozen live cards (Qdrant, Linq, the API
// key rows) whose state is not what this test is about, and pinning them here
// would make every unrelated change look like a regression in this panel.
//
// There is no visual-tests/ directory; this follows tests/e2e/visual.spec.ts.
const stableShot = { animations: 'disabled', caret: 'hide', maxDiffPixelRatio: 0.02, threshold: 0.2 } as const;

/** Pin fonts: the app's first-choice "Inter" is not installed on CI runners,
 * so each environment falls back to a different system sans and every glyph
 * rasterizes differently.  DejaVu Sans (+ Mono) ships with Ubuntu base, so
 * forcing it makes the baselines portable across machines. */
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

test.use({ viewport: { width: 1440, height: 1200 }, locale: 'en-US' });

/** What the harness answers for GET /api/config: xAI chosen, engine on. */
const config = {
  composio: { configured: false },
  box: { configured: false },
  vps: { configured: false, sshAlias: '' },
  rooms: { turnTimeoutMinutes: 30 },
  sts: { provider: 'xai', frontEngine: true },
};

/** What the desktop credential store reports: xAI has a key, Gemini does not. */
const keyStatus = { xai: true, gemini: false };

async function openStsPanel(page: Page): Promise<Locator> {
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.addInitScript((status) => {
    Object.defineProperty(window, 'ogb', {
      configurable: true,
      value: { sts: { status: () => Promise.resolve(status) } },
    });
  }, keyStatus);
  await page.route('**/api/config', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) }),
  );

  await page.goto('/');
  await pinFonts(page);

  // The fixed update popup sits over the header button and carries a live
  // timestamp.  It is unrelated to this panel, so it is dismissed rather than
  // masked: nothing about the STS surface should depend on it being there.
  // The button is looked up inside the banner, because another "Later" button
  // mounts elsewhere a second later and the bare role query can grab that one
  // instead, leaving the popup exactly where it was.
  const updateBanner = page.locator('div.fixed.bottom-4.left-4');
  const dismiss = updateBanner.getByRole('button', { name: 'Later' });
  if (await dismiss.count()) {
    await dismiss.first().click();
    await expect(updateBanner).toHaveCount(0, { timeout: 10_000 });
  }

  await page.getByTitle('App Settings').click();
  // The modal mounts inside providers that resolve after the shell paints, so
  // this waits for real rather than for a fixed delay.
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByRole('button', { name: 'Connections', exact: true }).click();

  const panel = page.locator('#setting-connections-sts');
  // Hydration has landed: the chosen provider is the one the config named, and
  // the key state has resolved, so neither is still on its loading default.
  await expect(panel.getByText('Key Ready')).toBeVisible();
  await expect(panel.locator('input[name="sts-provider"][value="xai"]')).toBeChecked();
  // Enabled, because the panel is loaded — a still-loading panel would show
  // the shipped defaults and the screenshot would pin the wrong frame.
  await expect(panel.locator('input[name="sts-provider"][value="xai"]')).toBeEnabled();
  return panel;
}

test('visual: speech-to-speech panel in Settings → Connections', async ({ page }) => {
  const panel = await openStsPanel(page);

  // What the panel is for, in the owner's words, so a copy regression fails
  // with a readable diff rather than only as a pixel count.
  await expect(panel.getByText('Speech-to-Speech Calls')).toBeVisible();
  await expect(panel.getByText('The model hears the caller and speaks back on one connection,', { exact: false }))
    .toBeVisible();
  await expect(panel.getByText("Hand Real Work To The Bot's Engine")).toBeVisible();

  // One radio per provider, in picker order, with Auto offered first.
  const radios = panel.locator('input[name="sts-provider"]');
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(0)).toHaveValue('auto');
  await expect(radios.nth(1)).toHaveValue('xai');
  await expect(radios.nth(2)).toHaveValue('gemini');
  // xAI is selected, because that is what the seeded config says.
  await expect(radios.nth(0)).not.toBeChecked();
  await expect(radios.nth(2)).not.toBeChecked();

  // The engine toggle is on, matching the seeded config rather than a default.
  const engine = panel.getByRole('checkbox', { name: "Hand real work to the bot's engine" });
  await expect(engine).toBeChecked();
  await expect(panel.getByText('On', { exact: true })).toBeVisible();
  await expect(panel.getByText('On by default.')).toBeVisible();

  // Masked below, so the copy they carry is asserted here instead: each
  // provider's credential line, and the header pill that reports one is ready.
  await expect(panel.getByText('Realtime duplex speech on one connection.', { exact: false })).toBeVisible();
  await expect(panel.getByText('Gemini Live duplex speech on one connection.', { exact: false })).toBeVisible();
  await expect(panel.getByText('Key configured.', { exact: false })).toBeVisible();
  await expect(panel.getByText('No GEMINI_API_KEY — calls use Auto until one is added.')).toBeVisible();

  await expect(panel).toHaveScreenshot('sts-connections-panel.png', {
    ...stableShot,
    // Key state is credential-store state: it differs per machine, so the
    // pixels are pinned for everything around it rather than for whether this
    // particular Mac happens to have an xAI key.  The text itself is asserted
    // above, so masking cannot hide a regression in what it says.
    mask: [
      panel.getByText('Key Ready'),
      panel.getByText('Key configured.', { exact: false }),
      panel.getByText('No GEMINI_API_KEY — calls use Auto until one is added.'),
    ],
  });
});