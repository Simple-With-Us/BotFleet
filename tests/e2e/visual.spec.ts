import { test, expect, type Page } from '@playwright/test';

// Automated visual verification for web surfaces (owner directive
// 2026-09-27). The native Mac desktop app is NOT covered here — Playwright
// cannot drive it; that surface stays on code review + CI.
//
// Every screen below renders deterministically against `vite preview` with
// no bot server and no network: animated bits are frozen with
// `animations: 'disabled'` and any section that could reach for live state
// is excluded by construction (see the notes per test).
// `caret: 'hide'` because step 0 autofocuses the name field: the blinking
// text caret would otherwise make two consecutive screenshots differ.
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

test('visual: onboarding welcome (first-run email gate)', async ({ page }) => {
  // Fresh context => the `omb-email-gate` key is absent => step 0 of the
  // gate: static welcome copy plus name/email fields. Later steps run live
  // engine checks, so they are intentionally not screenshotted.
  await page.goto('/');
  await pinFonts(page);
  await expect(page.getByRole('heading', { name: 'Welcome to BotFleet' })).toBeVisible();
  await expect(page.getByPlaceholder('you@example.com')).toBeVisible();
  // The BotMascot is a requestAnimationFrame-driven avatar (blinking,
  // drift, expression pool) that CSS animation freezing cannot stop, so it
  // is masked: the welcome copy and form — the actual UI surface — are
  // still asserted pixel-for-pixel.
  await expect(page).toHaveScreenshot('onboarding-welcome.png', {
    ...stableShot,
    mask: [page.locator('.fixed.inset-0.z-50 svg').first()],
  });
});

test('visual: app shell with no bot server', async ({ page }) => {
  // The hydration retry backoff alone takes ~15s; allow headroom on slow CI.
  test.setTimeout(120_000);
  // Dismiss the first-run gate via localStorage so the shell is uncovered.
  // With no server, the store stays disconnected and the shell shows the
  // static sidebar plus the "start the bot server" hint — nothing polls or
  // streams in this state.
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  await pinFonts(page);
  await expect(page.getByTitle('App Settings')).toBeVisible();
  await expect(page.getByText('Connecting to the bot server…')).toBeVisible();
  // Without a server, hydration fails and retries on a 1s/3s/10s backoff
  // before settling on "Reopen BotFleet to try again." — wait for that
  // final, stable state so the retry banner cannot flake the screenshot.
  await expect(page.getByText('Reopen BotFleet to try again.')).toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveScreenshot('app-shell-no-server.png', {
    ...stableShot,
    maxDiffPixelRatio: 0.02,
  });
});

test('visual: settings modal (General section)', async ({ page }) => {
  // General is the only section with no server or bridge dependence: the
  // Updates card renders null without a Mac harness or updater bridge, and
  // every remaining row is a static control or toggle.
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  await pinFonts(page);
  await page.getByTitle('App Settings').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Profile', { exact: true })).toBeVisible();
  await expect(dialog).toHaveScreenshot('settings-general.png', stableShot);
});

test('visual: plugins manager with installed plugins', async ({ page }) => {
  // Same no-server shell as above, with the one endpoint the manager reads
  // answered from a fixed fixture: one enabled plugin with capabilities and
  // contributions, one disabled git plugin.  Nothing in the view polls, and
  // every value below is static, so the screenshot is deterministic.
  test.setTimeout(120_000);
  const plugins = [
    {
      name: 'fleet-overview',
      version: '1.0.0',
      description: 'Dashboard card with bot counts by status and a /fleet slash command that summarizes the fleet.',
      author: 'BotFleet',
      license: 'Apache-2.0',
      botfleet: '>=1',
      entry: 'plugin.mjs',
      enabled: true,
      installedAt: '2026-10-04T12:00:00.000Z',
      updatedAt: '2026-10-04T12:00:00.000Z',
      source: { kind: 'folder', path: '<plugin-folder>' },
      warnings: [],
      capabilities: ['read.bots', 'read.status'],
      contributes: {
        cards: [{ id: 'fleet-overview', title: 'Fleet Overview', layout: 'stat-grid' }],
        commands: [{ name: 'fleet', description: 'Summarize the fleet.' }],
      },
    },
    {
      name: 'example-widget',
      version: '0.3.1',
      description: 'An example plugin installed from a git source.',
      botfleet: '>=1',
      entry: 'plugin.mjs',
      enabled: false,
      installedAt: '2026-10-04T12:00:00.000Z',
      updatedAt: '2026-10-04T12:00:00.000Z',
      source: { kind: 'git', url: 'example.invalid/acme/widget', ref: 'v0.3.1', path: '' },
      warnings: [],
      capabilities: ['read.bots'],
    },
  ];
  await page.route('**/api/plugins', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ plugins }) }),
  );
  await page.addInitScript(() => localStorage.setItem('omb-email-gate', 'skipped'));
  await page.goto('/');
  await pinFonts(page);
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  const heading = page.getByRole('heading', { name: 'Plugins', level: 1 });
  await expect(heading).toBeVisible();
  await expect(page.getByRole('heading', { name: 'fleet-overview' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'example-widget' })).toBeVisible();
  const view = page.locator('div.bg-app.p-6').filter({ has: heading });
  await expect(view).toHaveScreenshot('plugins-manager.png', stableShot);
});
