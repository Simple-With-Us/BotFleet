import { test, expect, type Page, type Route } from '@playwright/test';

// Visual coverage for the user-visible titles and runtime states of the
// Computer Settings cards: LocalVmRuntimeCard (per-bot, replacement,
// normal) and SharedVpsRuntimeCard (Fetching VPS status… loading state,
// per-bot caption).  The fixture is mounted via /?fixture=runtime-cards
// (see src/main.tsx) and renders the real card components with a
// deterministic StoreContext.
//
// BotFleet has NO top-level `visual-tests/` directory; this follows the
// existing convention of `tests/e2e/*.visual.spec.ts` with fixtures via
// `/?fixture=...` in `src/main.tsx` (see ComputerPanelVisualFixture.tsx
// and computer-panel.visual.spec.ts).  Run
// `pnpm run e2e:update tests/e2e/runtime-cards.visual.spec.ts` to
// regenerate the committed baselines — not `cd visual-tests && npm ci`.
// Pass the spec path without a `--` separator:  pnpm forwards a literal
// `--`, and Playwright then ignores the path and runs the whole suite.
//
// Screenshot tolerance is expect.toHaveScreenshot in playwright.config.ts:
// maxDiffPixelRatio 0.02 and threshold 0.2.  Only animation and caret
// handling stay on the call.  Spinners are frozen via animations:'disabled'.
const stableShot = { animations: 'disabled' as const, caret: 'hide' as const };

const LINUX_CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

function localComputerBody(state: 'normal' | 'per-bot' | 'replacement'): Record<string, unknown> {
  const base = {
    platform: 'darwin',
    runtime: 'podman',
    available: ['podman', 'docker', 'container'],
    daemonUp: true,
    image: true,
    imageMatches: true,
    managed: true,
    network: 'loopback',
    security: 'hardened',
    persistence: 'durable',
    desktopReady: state === 'normal',
    ready: state === 'normal',
    problem: null as string | null,
    image_ref: 'ghcr.io/botfleet/cua-desktop:0.20.0',
    base_image_ref: 'ghcr.io/botfleet/cua-base:0.20.0',
    driver_version: '0.20.0',
    container_name: 'botfleet-cua',
    workspace_path: '/Users/test/.botfleet/local-vm/workspace',
    workspace_guest_path: '/home/cua/workspace',
    viewer_url: 'http://127.0.0.1:6080/vnc.html',
    idle_timeout_ms: 28800000,
    max_instances: 1,
    commands: {
      install: null,
      runtimeStart: null,
      pull: null,
      run: null,
      start: null,
      stop: null,
      remove: null,
      view: 'http://127.0.0.1:6080/vnc.html',
    },
  };
  if (state === 'replacement') {
    return {
      ...base,
      container: 'stopped',
      imageMatches: false,
      ready: false,
      problem: 'The installed image is older than the pinned reference.',
    };
  }
  return {
    ...base,
    container: state === 'normal' ? 'running' : 'missing',
  };
}

test.use({
  viewport: { width: 1280, height: 1000 },
  locale: 'en-US',
  timezoneId: 'UTC',
  userAgent: LINUX_CHROME_UA,
});

// `/api/vps-computer` requests held open for the "Fetching VPS status…"
// loading shot.  Each one is aborted in `test.afterEach` so no route
// handler is still pending when Playwright closes the page and context.
let pendingVpsRoutes: Route[] = [];

test.beforeEach(async ({ page }) => {
  pendingVpsRoutes = [];
  // Cards poll these endpoints.  Hand back deterministic bodies so the
  // screenshot is stable.  The page URL `state=` param picks the body.
  await page.route('**/api/local-computer', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const pageState = new URL(page.url()).searchParams.get('state') ?? 'normal';
    const mapped =
      pageState === 'replacement'
        ? 'replacement'
        : pageState === 'per-bot'
          ? 'per-bot'
          : 'normal';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(localComputerBody(mapped)),
    });
  });

  await page.route('**/api/vps-computer', async (route: Route) => {
    // SharedVpsRuntimeCard only polls when the workspace is in shared
    // mode and VPS is configured.  For the loading-state screenshot we
    // hold the request open: the card renders "Fetching VPS status…"
    // until a body arrives, and we capture the shot while status is
    // still null.  The handler returns immediately rather than awaiting
    // a promise that never settles; the held route is tracked and
    // aborted in `test.afterEach`.
    if (route.request().method() !== 'GET') return route.fallback();
    const pageState = new URL(page.url()).searchParams.get('state') ?? 'normal';
    if (pageState === 'normal' || pageState === 'loading') {
      pendingVpsRoutes.push(route);
      return;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        backend: 'vps',
        configured: true,
        sshAlias: 'vps',
        daemonUp: true,
        image: true,
        managed: true,
        container: 'running',
        ready: true,
        problem: null,
      }),
    });
  });
});

test.afterEach(async ({ page }) => {
  // Settle every held `/api/vps-computer` request before teardown, then
  // drop the handlers so nothing is still in flight when the page and
  // context close.  A route the page already cancelled throws on abort,
  // which is fine to ignore here.
  const held = pendingVpsRoutes;
  pendingVpsRoutes = [];
  await Promise.all(held.map((route) => route.abort('aborted').catch(() => {})));
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('visual: LocalVmRuntimeCard — per-bot mode (Step 4 = per-bot instruction)', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=local-vm&state=per-bot', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-local-vm');
  await expect(board).toBeVisible();
  await expect(board.getByText("Create a Private Desktop from Each Bot's Computer Panel")).toBeVisible();
  await expect(board.getByText('Ready for per-bot desktops')).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-local-vm-per-bot.png', {
    ...stableShot,
    mask: [board.locator('.animate-spin')],
  });
});

test('visual: LocalVmRuntimeCard — replacement state (older/unsafe VM warning)', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=local-vm&state=replacement', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-local-vm');
  await expect(board).toBeVisible();
  await expect(board.getByText('Replace the Older or Unsafe VM')).toBeVisible();
  await expect(board.getByRole('button', { name: 'Delete and Recreate' })).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-local-vm-replacement.png', {
    ...stableShot,
    mask: [board.locator('.animate-spin')],
  });
});

test('visual: LocalVmRuntimeCard — normal/ready state (Create Local VM)', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=local-vm&state=normal', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-local-vm');
  await expect(board).toBeVisible();
  await expect(board.getByText('Create and Start the Local VM')).toBeVisible();
  await expect(board.getByText('Ready', { exact: true })).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-local-vm-normal.png', {
    ...stableShot,
    mask: [board.locator('.animate-spin')],
  });
});

test('visual: SharedVpsRuntimeCard — Fetching VPS status… loading state', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=shared-vps&state=loading', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-shared-vps');
  await expect(board).toBeVisible();
  await expect(board.getByText('Fetching VPS status…')).toBeVisible();
  await expect(board.getByText('Shared VPS VM')).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-shared-vps-loading.png', {
    ...stableShot,
    mask: [board.locator('.animate-spin')],
  });
});

test('visual: SharedVpsRuntimeCard — per-bot caption', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=shared-vps&state=per-bot-caption', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-shared-vps');
  await expect(board).toBeVisible();
  await expect(board.getByText('Self-Hosted VPS')).toBeVisible();
  await expect(board.getByText(/Per-bot mode:/)).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-shared-vps-per-bot-caption.png', stableShot);
});
