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

// A shared container still on the previous image, in the three faces the
// card gives it: before the build, while it builds (a fixed elapsed time so
// the shot is stable), and once the new image is ready to switch to.
const SHARED_VPS_STALE = {
  backend: 'vps',
  configured: true,
  sshAlias: 'vps',
  daemonUp: true,
  managed: true,
  container: 'running',
  ready: false,
  imageOutdated: true,
};
function sharedVpsOutdatedBody(pageState: string) {
  switch (pageState) {
    case 'vps-outdated':
      return {
        ...SHARED_VPS_STALE,
        image: false,
        imageMatches: false,
        imageBuild: { phase: 'idle', startedAt: null, elapsedMs: null, error: null },
        problem: 'Prepare the pinned BotFleet CUA image on the VPS (Driver 0.20.0)',
      };
    case 'vps-building':
      return {
        ...SHARED_VPS_STALE,
        image: false,
        imageMatches: false,
        imageBuild: { phase: 'building', startedAt: 1, elapsedMs: 754_000, error: null },
        problem: 'Prepare the pinned BotFleet CUA image on the VPS (Driver 0.20.0)',
      };
    case 'vps-switch':
      return {
        ...SHARED_VPS_STALE,
        image: true,
        imageMatches: false,
        imageBuild: { phase: 'ready', startedAt: null, elapsedMs: null, error: null },
        problem: 'The VPS container uses an incompatible or untrusted BotFleet image',
      };
    default:
      return null;
  }
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
    if (pageState === 'loading') {
      pendingVpsRoutes.push(route);
      return;
    }
    const outdated = sharedVpsOutdatedBody(pageState);
    if (outdated) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(outdated) });
    }
    if (pageState === 'normal' || pageState === 'shared') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          backend: 'vps',
          configured: true,
          sshAlias: 'vps',
          daemonUp: true,
          image: true,
          imageMatches: true,
          managed: true,
          container: 'running',
          ready: true,
          problem: null,
        }),
      });
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

test('visual: SharedVpsRuntimeCard — shared ready state', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=shared-vps&state=normal', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-shared-vps');
  await expect(board).toBeVisible();
  await expect(board.getByText('Shared VPS VM')).toBeVisible();
  await expect(board.getByText('Running', { exact: true })).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-shared-vps-ready.png', {
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

test('visual: SharedVpsRuntimeCard — outdated image, Prepare Image', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=shared-vps&state=vps-outdated', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-shared-vps');
  await expect(board.getByText('Running (outdated image)')).toBeVisible();
  await expect(board.getByText('Running', { exact: true })).toHaveCount(0);
  await expect(board.getByRole('button', { name: 'Prepare Image' })).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-shared-vps-outdated.png', stableShot);
});

test('visual: SharedVpsRuntimeCard — outdated image, building with elapsed time', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=shared-vps&state=vps-building', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-shared-vps');
  await expect(board.getByText(/Building the new image on the VPS: 12m 34s so far/)).toBeVisible();
  await expect(board.getByRole('button', { name: 'Prepare Image' })).toHaveCount(0);
  await expect(board).toHaveScreenshot('runtime-cards-shared-vps-building.png', {
    ...stableShot,
    mask: [board.locator('.animate-spin')],
  });
});

test('visual: SharedVpsRuntimeCard — new image ready, Switch to New Image with confirm', async ({ page }) => {
  await page.goto('/?fixture=runtime-cards&card=shared-vps&state=vps-switch', {
    waitUntil: 'domcontentloaded',
  });
  await pinFonts(page);
  const board = page.getByTestId('runtime-cards-shared-vps');
  const button = board.getByRole('button', { name: 'Switch to New Image' });
  await expect(button).toBeVisible();
  await expect(board).toHaveScreenshot('runtime-cards-shared-vps-switch.png', stableShot);
  // The switch resets the container filesystem, so it asks first and posts
  // nothing until confirmed.
  let posted = false;
  await page.route('**/api/vps-computer/switch-image', (route: Route) => {
    posted = true;
    return route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"fixture"}' });
  });
  await button.click();
  await expect(page.getByText('Switch to New Image?')).toBeVisible();
  await expect(page.getByText(/Everything saved inside the container is reset/)).toBeVisible();
  expect(posted).toBe(false);
});
