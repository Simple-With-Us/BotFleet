// Prove the built server actually STARTS with no node_modules in reach.
//
// 0.1.24 shipped a server that died on every launch with
//   ERR_MODULE_NOT_FOUND: Cannot find package 'zod'
// because `tsc` leaves bare imports verbatim and the packaged app carries no
// node_modules. Every existing gate passed it: the unit suite runs in the repo
// (where zod resolves), and the packaging check only asserts index.js EXISTS.
//
// So this copies dist-server OUT of the repo before running it. Inside the
// repo a bare import still resolves by walking up to ./node_modules and the
// test passes on a build that would be dead in the field — which is precisely
// how the bug escaped. The copy is the whole point; do not "simplify" it away.
import { execFile, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertRuntimeExecutable, resolveRuntime } from "./smoke-runtime-mode.mjs";
import { packagedSmokeConfig } from "./smoke-packaged-fixture.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const port = 21000 + Math.floor(Math.random() * 9000);

// BF-1991: run the gate on the runtime production uses.  OMB_SMOKE_RUNTIME
// names the packaged binary, and it is booted with ELECTRON_RUN_AS_NODE=1
// exactly the way the shipped harness boots it.  An unnamed runtime is a
// bundle check against the runner's Node, and it is labelled as one.  A NAMED
// runtime that cannot be executed is an error, never a fallback: silently
// falling back would let a bundle check's result pass as a runtime pass.
//
// Resolved BEFORE the copy, so a broken runtime fails the gate without
// leaving a staging tree behind, and before the spawn, so the mode is in the
// log even when the gate fails.
const runtime = (() => {
  try {
    const resolved = resolveRuntime(process.env.OMB_SMOKE_RUNTIME);
    console.log(`smoke mode: ${resolved.mode} (${resolved.label})`);
    console.log(`smoke gate kind: ${resolved.kind}`);
    console.log(`smoke runtime: ${resolved.command}`);
    if (resolved.mode === "runtime") {
      // Existence and the executable bit are not enough -- a binary built for
      // another architecture exists, is executable, and still dies with "Bad
      // CPU type in executable".  Exec it once before the gate claims
      // anything about it.
      assertRuntimeExecutable(resolved.command, { env: resolved.env });
    }
    return resolved;
  } catch (error) {
    console.error(`packaged server smoke failed: ${error.message}`);
    process.exit(1);
  }
})();

const staging = mkdtempSync(join(tmpdir(), "omb-smoke-"));
const home = mkdtempSync(join(tmpdir(), "omb-smoke-home-"));
const dataDir = join(home, ".botfleet");
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
// The DSN the packaged SDK must load.  It is a loopback address with a fake
// key, so the SDK parses it, initializes against it, and no event ever leaves
// the machine.
const LOOPBACK_DSN = "https://0123456789abcdef0123456789abcdef@127.0.0.1:1/1";
const LOOPBACK_DSN_KEY = "0123456789abcdef0123456789abcdef";
// A DIFFERENT fake DSN, and the one the process inherits.  The environment
// carries no copy of a value (owner ruling, November 22, 2026), so this one
// must never be the answer.  It is here so the smoke can prove the packaged
// server resolved the DSN from its own configuration and not from what it
// inherited.  It is a loopback address too, so nothing leaves the machine
// either way.
const STALE_ENV_DSN = "https://99999999999999999999999999999999@127.0.0.1:9/9";
const STALE_ENV_DSN_KEY = "99999999999999999999999999999999";

// Keep package validation independent of host CLI discovery and authentication.
// The observability block is what the packaged server resolves the DSN from:
// the inherited environment value is not a source, so the DSN the SDK loads
// has to be in the configuration the packaged server reads for itself.
const writeSmokeConfig = (targetHome, targetDataDir, withObservability) => {
  const config = packagedSmokeConfig(targetHome);
  if (withObservability) {
    config.observability = { sentryDsn: LOOPBACK_DSN, tracesSampleRate: 0 };
  }
  writeFileSync(join(targetDataDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
};
writeSmokeConfig(home, dataDir, true);

// OMB_SMOKE_DIST lets the release workflow aim this at a packaged app's
// Resources/server tree instead of the repo build.
cpSync(process.env.OMB_SMOKE_DIST ?? join(root, "dist-server"), join(staging, "server"), { recursive: true });

const child = spawn(runtime.command, [join(staging, "server", "index.js")], {
  cwd: staging,
  env: {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...runtime.env,
    HOME: home,
    USERPROFILE: home,
    OMB_PORT: String(port),
    // The smoke boots a real harness against a throwaway HOME, but container
    // runtimes are machine-wide and the Local VM container name follows the OS
    // username, so the boot-time probe would inspect the owner's real
    // container.  Switch them off (server/container-runtime-guard.ts).
    BOTFLEET_DISABLE_CONTAINER_RUNTIME: "1",
    DOCKER_HOST: "unix:///nonexistent.sock",
    CONTAINER_HOST: "unix:///nonexistent.sock",
    // The STALE copy of a DSN this process inherits.  It is deliberately not
    // the DSN the server must use:  the packaged server resolves the DSN from
    // its own configuration, and the assertions below fail if this one is
    // ever read.  Both addresses are loopback with fake keys, so nothing
    // leaves the machine either way.
    SENTRY_DSN: STALE_ENV_DSN,
    SENTRY_TRACES_SAMPLE_RATE: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

// Best-effort by design. Windows holds file handles open a little longer than
// the process that owned them, so removing the scratch dir immediately after
// the kill raises EPERM; Linux runners can raise EACCES the same way. Scratch
// cleanup must never decide whether the build is good — it failed a green run
// on Windows once already, and see f66d30f for the same lesson on Linux.
const cleanup = () => {
  child.kill("SIGKILL");
  for (const dir of [staging, home]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      /* the OS will reap it; the assertion below is what matters */
    }
  }
};

// Match the packaged desktop's owned-child boot allowance in electron/main.mjs.
// This remains a readiness and packaging check, not a startup performance benchmark.
const deadline = Date.now() + 60_000;
let listening = false;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    // Health answers from the moment the port binds, which is before the boot
    // work is done — the checks below all hit routes that 503 until it is, so
    // wait for `ready` rather than for the first answer.
    if (res.ok && (await res.json().catch(() => null))?.ready !== false) {
      listening = true;
      break;
    }
  } catch {
    /* not up yet */
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
}

// Authenticated identity must describe the copied package, and the public
// health response must not disclose the private owner nonce or build data.
if (listening) {
  const owner = JSON.parse(readFileSync(join(home, ".botfleet", "harness-owner.json"), "utf8"));
  const expected = JSON.parse(readFileSync(join(staging, "server", "build-identity.json"), "utf8"));
  const publicHealth = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  const denied = await fetch(`http://127.0.0.1:${port}/api/runtime`);
  const diagnostic = await fetch(`http://127.0.0.1:${port}/api/runtime`, {
    headers: { authorization: `Bearer ${owner.nonce}` },
  });
  const actual = await diagnostic.json();
  if (denied.status !== 401 || !diagnostic.ok || actual.pid !== child.pid ||
      actual.sourceCommit !== expected.sourceCommit || actual.apiVersion !== expected.apiVersion ||
      actual.dataOwner?.pid !== child.pid || actual.dataOwner?.port !== port ||
      typeof actual.safeToRestart !== "boolean" || JSON.stringify(publicHealth).includes(owner.nonce) ||
      publicHealth.sourceCommit !== undefined || JSON.stringify(actual).includes(owner.nonce)) {
    cleanup();
    throw new Error("Packaged runtime identity, authentication, or redaction contract failed");
  }

  // Health can pass even if the optional SDK failed to load.  Assert its
  // actual packaged initialization path without emitting a test event.
  const observabilityResponse = await fetch(`http://127.0.0.1:${port}/api/observability`, {
    headers: { authorization: `Bearer ${owner.nonce}` },
  });
  const observability = observabilityResponse.ok ? await observabilityResponse.json() : null;
  // The allowed provenance is the packaged server's OWN configuration.  The
  // inherited environment value is not a source, so the status must not name
  // it, and the host and project id must be the ones the configuration
  // carries:  the inherited DSN points at another loopback port and another
  // project, so a preference for the environment shows up here.
  if (!observabilityResponse.ok || !observability?.configured || !observability?.enabled ||
      observability?.source !== "config" || observability?.lastError !== null ||
      observability?.host !== "127.0.0.1:1" || observability?.projectId !== "1") {
    cleanup();
    throw new Error("Packaged Sentry SDK did not initialize from the configured loopback DSN");
  }
  // The redaction guarantee.  The route hands the authenticated renderer the
  // DSN on purpose, so the check is on the fields the status itself owns and
  // on what the process wrote to its own log:  a DSN key belongs in neither.
  const statusFields = { ...observability };
  delete statusFields.dsn;
  const statusText = JSON.stringify(statusFields);
  if (statusText.includes(LOOPBACK_DSN_KEY) || statusText.includes(STALE_ENV_DSN_KEY) ||
      output.includes(LOOPBACK_DSN_KEY) || output.includes(STALE_ENV_DSN_KEY)) {
    cleanup();
    throw new Error("Packaged observability status or log disclosed a DSN key");
  }
}

// Serving /api/health is necessary but nowhere near sufficient. Bundling
// relocates import.meta.url, so a module that used to sit in drivers/ resolves
// its sibling paths from the bundle's directory instead — one level too high.
// The 0.1.24 candidate booted and answered /api/health perfectly while every
// spawned proxy pointed outside Resources/server, silently killing permission
// prompts, computer use and dweb. So check the paths the server ACTUALLY
// resolved, from inside the staged copy, before calling the build good.
const probe = join(staging, "server", "probe-proxy-paths.mjs");
writeFileSync(
  probe,
  [
    'import { existsSync } from "node:fs";',
    'import { SPAWNED_PROXIES } from "./proxy-paths.js";',
    "const missing = Object.entries(SPAWNED_PROXIES).filter(([, p]) => !existsSync(p));",
    "console.log(JSON.stringify({ resolved: SPAWNED_PROXIES, missing }));",
  ].join("\n"),
);

let proxyReport = null;
try {
  const { stdout } = await promisify(execFile)(runtime.command, [probe], {
    cwd: staging,
    // The same runtime the server booted on.  The probe asks where the server
    // would resolve its siblings, so it has to answer from the same tree AND
    // the same runtime that resolved them.
    env: { ...process.env, ...runtime.env },
  });
  proxyReport = JSON.parse(stdout);
} catch (error) {
  proxyReport = { error: String((error && error.message) || error) };
}

// The public MCP process is a second packaged entry point. Send a request and
// close stdin immediately: this proves both that the bundle has no external
// dependencies and that shutdown lets the final JSON-RPC frame drain.
let mcpReport = null;
if (listening) {
  const mcp = spawn(runtime.command, [join(staging, "server", "mcp-server.js")], {
    cwd: staging,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...runtime.env,
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  mcp.stdout.on("data", (chunk) => (stdout += chunk));
  mcp.stderr.on("data", (chunk) => (stderr += chunk));
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } },
  });
  const health = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_system_health", arguments: {} },
  });
  mcp.stdin.write(`${initialize}\n${health}\n`);
  const healthDeadline = Date.now() + 8_000;
  while (Date.now() < healthDeadline && !stdout.split("\n").some((line) => line.includes('"id":2'))) {
    if (mcp.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // The ping is deliberately followed by EOF without waiting. If the stdio
  // close path exits before buffered frames drain, id 3 will be missing.
  mcp.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" })}\n`);
  const closed = new Promise((resolve) => mcp.once("close", (code, signal) => resolve({ code, signal })));
  let timeout;
  const exit = await Promise.race([
    closed,
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve({ timeout: true }), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (exit.timeout) {
    mcp.kill("SIGKILL");
    await closed;
  }
  try {
    const responses = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    mcpReport = { exit, responses, stderr };
  } catch (error) {
    mcpReport = { exit, stdout, stderr, error: String(error) };
  }
}

// The stale-environment-only negative case.  The same packaged tree and the
// same inherited environment, with a configuration that carries no DSN:  the
// only DSN in reach is the one the process inherited, and the environment is
// not a source, so the optional reporting must come up OFF rather than
// adopting it.  A separate throwaway home keeps this boot independent of the
// first one's owner identity.
if (listening) {
  const negativePort = 30000 + Math.floor(Math.random() * 9000);
  const negativeHome = mkdtempSync(join(tmpdir(), "omb-smoke-home-"));
  const negativeDataDir = join(negativeHome, ".botfleet");
  mkdirSync(negativeDataDir, { recursive: true, mode: 0o700 });
  writeSmokeConfig(negativeHome, negativeDataDir, false);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }

  // The environment of the second boot.  It is the first boot's environment
  // exactly, so the inherited DSN is still there and still not a source.
  const negativeEnv = {
    ...runtime.env,
    HOME: negativeHome,
    USERPROFILE: negativeHome,
    OMB_PORT: String(negativePort),
    BOTFLEET_DISABLE_CONTAINER_RUNTIME: "1",
    DOCKER_HOST: "unix:///nonexistent.sock",
    CONTAINER_HOST: "unix:///nonexistent.sock",
    SENTRY_DSN: STALE_ENV_DSN,
    SENTRY_TRACES_SAMPLE_RATE: "0",
  };
  if (process.env.PATH) negativeEnv.PATH = process.env.PATH;
  if (process.env.SystemRoot) negativeEnv.SystemRoot = process.env.SystemRoot;

  const negativeChild = spawn(runtime.command, [join(staging, "server", "index.js")], {
    cwd: staging,
    env: negativeEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let negativeOutput = "";
  negativeChild.stdout.on("data", (chunk) => (negativeOutput += chunk));
  negativeChild.stderr.on("data", (chunk) => (negativeOutput += chunk));

  const negativeDeadline = Date.now() + 60_000;
  let negativeListening = false;
  while (Date.now() < negativeDeadline) {
    if (negativeChild.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${negativePort}/api/health`);
      if (res.ok && (await res.json().catch(() => null))?.ready !== false) {
        negativeListening = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!negativeListening) {
    negativeChild.kill("SIGKILL");
    cleanup();
    throw new Error(
      `the packaged server never served /api/health for the stale-environment case: ${negativeOutput.trim().slice(0, 400)}`,
    );
  }

  const negativeOwner = JSON.parse(
    readFileSync(join(negativeHome, ".botfleet", "harness-owner.json"), "utf8"),
  );
  const negativeResponse = await fetch(`http://127.0.0.1:${negativePort}/api/observability`, {
    headers: { authorization: `Bearer ${negativeOwner.nonce}` },
  });
  const negativeObservability = negativeResponse.ok ? await negativeResponse.json() : null;
  negativeChild.kill("SIGKILL");
  if (!negativeResponse.ok || negativeObservability?.configured !== false ||
      negativeObservability?.enabled !== false || negativeObservability?.source !== "none" ||
      negativeObservability?.host !== null || negativeObservability?.projectId !== null) {
    cleanup();
    throw new Error(
      `the packaged server adopted a DSN it inherited from the environment: ${JSON.stringify(negativeObservability)}`,
    );
  }
  if (JSON.stringify(negativeObservability).includes(STALE_ENV_DSN_KEY)) {
    cleanup();
    throw new Error("the stale-environment case disclosed the inherited DSN key");
  }
  rmSync(negativeHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  console.log("packaged server ignored the DSN it inherited from the environment ✓");
}

cleanup();

if (!listening) {
  console.error(`the packaged server never served /api/health on port ${port}.`);
  console.error(`exit code: ${child.exitCode}`);
  console.error(output.trim() || "(no output)");
  process.exit(1);
}

if (!proxyReport || proxyReport.error || proxyReport.missing.length > 0) {
  console.error("spawned proxy paths do not resolve inside the packaged server dir:");
  console.error(JSON.stringify(proxyReport, null, 2));
  console.error("\nthe server would still answer /api/health — and every one of these");
  console.error("features would be dead: permission prompts, computer use, dweb, peer comms.");
  process.exit(1);
}

if (
  !mcpReport ||
  mcpReport.error ||
  mcpReport.exit?.timeout ||
  mcpReport.exit?.code !== 0 ||
  mcpReport.responses?.find((response) => response.id === 1)?.result?.serverInfo?.name !== "botfleet-mcp" ||
  mcpReport.responses?.find((response) => response.id === 2)?.result?.structuredContent?.status !== "connected" ||
  JSON.stringify(mcpReport.responses?.find((response) => response.id === 3)?.result) !== "{}"
) {
  console.error("the packaged MCP stdio server failed its initialize-health-and-drain smoke test:");
  console.error(JSON.stringify(mcpReport, null, 2));
  process.exit(1);
}

const count = Object.keys(proxyReport.resolved).length;
console.log(`packaged server started with no node_modules in reach (port ${port}) ✓`);
console.log(`all ${count} spawned proxy paths resolve inside the packaged server dir ✓`);
console.log("packaged MCP stdio server reached the API and flushed its final frames ✓");
console.log(`smoke gate result: ${runtime.mode} (${runtime.label}) on ${runtime.command}`);
