// Explicit adapters for a reviewed, network-isolated retained source fixture.
// This module has no entry point and never starts a runtime when imported.
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MAX_HEALTH_BYTES = 16_384;
const HEALTH_WAIT_MS = 90_000;
const PROCESS_STOP_MS = 10_000;

export function assertIsolatedNetwork() {
  if (process.platform !== 'linux' || Object.keys(networkInterfaces()).some((name) => name !== 'lo')) {
    throw new Error('Actual retained fixture requires a loopback-only Linux network namespace');
  }
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
  if (routes.some((row) => row.trim().split(/\s+/)[0] !== 'lo')) {
    throw new Error('Actual retained fixture has a non-loopback route');
  }
}

export function assertPrivateEnvironment(root, { env = process.env, cwd = process.cwd() } = {}) {
  const allowed = new Set([
    'PATH', 'HOME', 'PWD', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMPDIR', 'VITEST', 'CI',
    'GIT_CONFIG_NOSYSTEM', 'GIT_NO_LAZY_FETCH', 'GIT_TERMINAL_PROMPT',
    'COREPACK_ENABLE_NETWORK', 'npm_config_update_notifier',
  ]);
  // Bubblewrap sets PWD to its explicit --chdir destination after --clearenv.
  if (Object.keys(env).some((name) => !allowed.has(name)) ||
      env.HOME !== join(root, 'private-home') || env.VITEST !== 'true' ||
      env.PWD !== cwd || cwd !== dirname(root)) {
    throw new Error('Actual retained fixture requires a private allowlisted environment');
  }
}

function digest(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function privateDirectory(path, create = false) {
  if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o7777) !== 0o700 || realpathSync(path) !== path) {
    throw new Error('Retained fixture directory is not private');
  }
}
function git(cwd, ...args) {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function exactSource(context, fixtureRoot) {
  if (!['prior', 'candidate'].includes(context.slot) || resolve(context.root) !== fixtureRoot ||
      resolve(context.exportRoot) !== join(fixtureRoot, context.slot) ||
      context.sourceReceipt.sourceSha !== context.sourceSha) {
    throw new Error('Retained fixture slot is outside its exact receipt');
  }
  const root = realpathSync(context.exportRoot);
  if (git(root, 'rev-parse', 'HEAD') !== context.sourceSha || git(root, 'status', '--porcelain', '--untracked-files=no')) {
    throw new Error('Retained fixture source identity changed');
  }
  const expected = context.toolchain;
  for (const [name, hash] of [
    ['pnpm-lock.yaml', expected.lockSha256], ['pnpm-workspace.yaml', expected.workspaceSha256],
    ['scripts/compile-clutch-dep.mjs', expected.installCompilerSha256],
  ]) if (digest(join(root, name)) !== hash) throw new Error('Retained fixture toolchain source changed');
  return root;
}

function port() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const value = address?.port ?? 0;
      server.close((error) => error ? reject(error) : resolvePort(value));
    });
  });
}

async function distinctPorts() {
  for (;;) {
    const ports = [await port(), await port(), await port()];
    if (new Set(ports).size === 3 && ports.every((value) => value > 1024 && value !== 8799)) return ports;
  }
}

async function boundedBody(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Retained fixture response has no body');
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Retained fixture response is oversized');
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}

async function boundedHealth(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
  if (response.status !== 200 || response.headers.get('location')) throw new Error('Retained fixture health refused');
  return JSON.parse((await boundedBody(response, MAX_HEALTH_BYTES)).toString('utf8'));
}

async function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => { child.off('exit', onExit); child.off('error', onError); resolveExit(false); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); child.off('error', onError); resolveExit(true); };
    const onError = (error) => { clearTimeout(timer); child.off('exit', onExit); rejectExit(error); };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function waitGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!signalGroup(pid, 0)) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return !signalGroup(pid, 0);
}

export async function stopOwnedProcess(child, {
  signal = signalGroup, waitGroup = waitGroupGone, waitChild = waitExit, timeoutMs = PROCESS_STOP_MS,
} = {}) {
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('Retained fixture child has no owned PID');
  if (signal(child.pid, 0)) {
    signal(child.pid, 'SIGTERM');
    if (!await waitGroup(child.pid, timeoutMs)) {
      signal(child.pid, 'SIGKILL');
      if (!await waitGroup(child.pid, timeoutMs)) throw new Error('Retained fixture child group did not stop');
    }
  }
  if (!await waitChild(child, timeoutMs)) throw new Error('Retained fixture child did not join');
}

export function createActualLinuxAdapters({ root, node, pnpm }) {
  assertIsolatedNetwork();
  const fixtureRoot = resolve(root);
  if (!fixtureRoot.startsWith('/mnt/fleet-extra/apps/lanes/BotFleet/codex-bf-2633-linux-retained-closure-20261103/')) {
    throw new Error('Actual retained fixture must stay in the owned BF-2633 lane');
  }
  privateDirectory(fixtureRoot);
  assertPrivateEnvironment(fixtureRoot);
  const nodePath = realpathSync(node);
  const pnpmPath = realpathSync(pnpm);
  if (!pnpmPath.startsWith(`${join(fixtureRoot, 'private-toolchain')}/`)) {
    throw new Error('Retained fixture pnpm must be copied into its private toolchain');
  }
  if (execFileSync(nodePath, ['--version'], { encoding: 'utf8' }).trim() !== 'v24.18.0' ||
      execFileSync(nodePath, [pnpmPath, '--version'], { encoding: 'utf8' }).trim() !== '12.16.1') {
    throw new Error('Retained fixture toolchain versions differ from both receipts');
  }
  const home = join(fixtureRoot, 'private-home');
  const data = join(fixtureRoot, 'private-data');
  const store = join(fixtureRoot, 'private-pnpm-store');
  const logs = join(fixtureRoot, 'logs');
  for (const path of [home, data, store, logs]) privateDirectory(path, true);
  const xdgConfig = join(home, '.config');
  const xdgCache = join(home, '.cache');
  for (const path of [xdgConfig, xdgCache]) privateDirectory(path, true);
  const privateBin = join(fixtureRoot, 'private-bin');
  privateDirectory(privateBin, true);
  for (const [name, target] of [['node', nodePath], ['pnpm', pnpmPath], ['git', realpathSync('/usr/bin/git')]]) {
    const link = join(privateBin, name);
    if (!existsSync(link)) symlinkSync(target, link);
    if (realpathSync(link) !== target) throw new Error('Retained fixture private PATH changed');
  }
  process.env.PATH = privateBin;
  const env = {
    PATH: privateBin, HOME: home, XDG_CONFIG_HOME: xdgConfig, XDG_CACHE_HOME: xdgCache,
    TMPDIR: '/tmp', VITEST: 'true', CI: 'true', GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', COREPACK_ENABLE_NETWORK: '0',
    npm_config_update_notifier: 'false',
  };
  const live = new Map();
  const commands = new Set();

  const run = async (context, action, executable, args) => {
    exactSource(context, fixtureRoot);
    const log = openSync(join(logs, `${context.slot}-${action}.log`), 'wx', 0o600);
    let child;
    try {
      child = spawn(executable, args, { cwd: context.exportRoot, env, detached: true, stdio: ['ignore', log, log] });
      if (child.pid) commands.add(child);
      const finished = await waitExit(child, 300_000);
      if (!finished) throw new Error(`Retained fixture ${action} timed out`);
      if (!await waitGroupGone(child.pid, 500)) throw new Error(`Retained fixture ${action} left a child running`);
      if (child.exitCode !== 0) throw new Error(`Retained fixture ${action} failed`);
    } finally {
      try {
        if (child?.pid) {
          await stopOwnedProcess(child);
          commands.delete(child);
        }
      } finally { closeSync(log); }
    }
    exactSource(context, fixtureRoot);
    return { ok: true, executable, pid: child.pid, joined: true };
  };

  return {
    installDependencies: async (context) => {
      if (context.toolchain.nodeVersion !== '24.18.0' || context.toolchain.packageManager !== 'pnpm@12.16.1') {
        throw new Error('Retained fixture receipt toolchain mismatch');
      }
      return run(context, 'install', nodePath, [
        pnpmPath, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--package-import-method=copy',
        '--config.optimistic-repeat-install=false', '--store-dir', store,
      ]);
    },
    buildUi: async (context) => {
      await run(context, 'compile-clutch', nodePath, ['scripts/compile-clutch-dep.mjs']);
      await run(context, 'build-ui', nodePath, ['node_modules/vite/bin/vite.js', 'build']);
      if (!existsSync(join(context.exportRoot, 'dist/index.html'))) throw new Error('Retained fixture UI build is absent');
      return { ok: true, uiHash: digest(join(context.exportRoot, 'dist/index.html')) };
    },
    start: async (context) => {
      const source = exactSource(context, fixtureRoot);
      if (live.size || commands.size) throw new Error('Retained fixture already has an unjoined process');
      if (!existsSync(join(source, 'dist/index.html'))) throw new Error('Retained fixture UI build is absent');
      const [httpPort, webhookPort, uiPort] = await distinctPorts();
      const log = openSync(join(logs, `${context.slot}-runtime.log`), 'a', 0o600);
      const runtimeEnv = {
        ...env, OMB_DATA_DIR: data, OMB_PORT: String(httpPort), OMB_WEBHOOK_PORT: String(webhookPort),
        OMB_UI_PORT: String(uiPort), OMB_STATIC_DIR: join(source, 'dist'),
        BOTFLEET_TEST_CHILD: '1', BOTFLEET_TEST_PARENT_PID: String(process.pid),
      };
      const child = spawn(nodePath, [join(source, 'server/index.ts')], {
        cwd: source, env: runtimeEnv, detached: true, stdio: ['ignore', log, log],
      });
      try {
        await new Promise((resolveSpawn, rejectSpawn) => {
          child.once('spawn', resolveSpawn);
          child.once('error', rejectSpawn);
        });
      } catch (error) { closeSync(log); throw error; }
      live.set(context.slot, { child, log, source, httpPort, webhookPort, uiPort });
      return { ok: true, sourceSha: context.sourceSha, pid: child.pid, executable: nodePath, httpPort, webhookPort, uiPort };
    },
    health: async (context) => {
      const state = live.get(context.slot);
      if (!state) throw new Error('Retained fixture runtime is absent');
      const deadline = Date.now() + HEALTH_WAIT_MS;
      let health;
      while (Date.now() < deadline) {
        if (state.child.exitCode !== null || state.child.signalCode !== null) break;
        try {
          health = await boundedHealth(`http://127.0.0.1:${state.httpPort}/api/health`);
          if (health.app === 'botfleet' && health.ready === true && health.booting === false &&
              health.degraded === false && health.static === true && Number.isSafeInteger(health.pid) &&
              health.pid === state.child.pid &&
              realpathSync(`/proc/${health.pid}/cwd`) === state.source &&
              realpathSync(readlinkSync(`/proc/${health.pid}/exe`)) === nodePath) break;
        } catch { /* Boot health is bounded by the deadline. */ }
        health = null;
        await new Promise((resolveWait) => setTimeout(resolveWait, 150));
      }
      if (!health) throw new Error('Retained fixture source health did not become ready');
      const ui = await fetch(`http://127.0.0.1:${state.httpPort}/`, {
        signal: AbortSignal.timeout(3000), redirect: 'manual',
      });
      if (ui.status !== 200 || !ui.headers.get('content-type')?.startsWith('text/html') || ui.headers.get('location')) {
        throw new Error('Retained fixture built UI was not served');
      }
      const expectedUi = readFileSync(join(state.source, 'dist/index.html'));
      if (!(await boundedBody(ui, 1_048_576)).equals(expectedUi)) throw new Error('Retained fixture UI differs from its build');
      exactSource(context, fixtureRoot);
      return { ok: true, sourceSha: context.sourceSha, pid: health.pid, executable: nodePath, version: health.version,
        uiHash: digest(join(state.source, 'dist/index.html')) };
    },
    stop: async (context) => {
      const state = live.get(context.slot);
      if (!state) return { ok: true };
      let stopped = false;
      try {
        await stopOwnedProcess(state.child);
        stopped = true;
        return { ok: true, pid: state.child.pid, joined: true };
      } finally {
        if (stopped) {
          closeSync(state.log);
          live.delete(context.slot);
          exactSource(context, fixtureRoot);
        }
      }
    },
    cleanup: async () => {
      for (const child of commands) {
        await stopOwnedProcess(child);
        commands.delete(child);
      }
      return { ok: commands.size === 0 };
    },
  };
}
