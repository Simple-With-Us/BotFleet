// Decide WHICH runtime the packaged-server smoke gate boots, and say so.
//
// BF-1991.  The gate used to start the staged server with process.execPath --
// the runner's own Node -- while production runs the packaged Electron binary
// under ELECTRON_RUN_AS_NODE=1.  A build could pass this gate and still die
// under the runtime it ships on, so the gate could not fail for the bug it
// exists to catch.  The install-time probe (scripts/update-botfleet-mac.mjs,
// smokeStagedServer) already boots the packaged binary; this module gives CI
// the same runtime wherever the host can actually execute it, and LABELS the
// jobs that cannot.
//
// Two modes, never swapped silently:
//
//   runtime  the packaged binary, run with ELECTRON_RUN_AS_NODE=1.  A runtime
//            pass: it proves the shipped runtime starts the packaged server.
//
//   bundle   the runner's Node, against the packaged server tree.  A bundle
//            check: it proves the tree is complete and that it starts.  It
//            says nothing about the packaged binary, so it must never be read
//            as a runtime pass.
//
// The decision is arch-driven: lipo -archs of the packaged binary against the
// host arch.  A cross-arch matrix entry -- an x64 app on an arm64 runner --
// cannot exec its own binary, so it is a bundle check, and the output says so.
//
// If OMB_SMOKE_RUNTIME names a binary that cannot be executed, the gate FAILS.
// Falling back to the runner's Node would turn a runtime pass into a bundle
// check without telling anyone, which is the exact failure this file exists
// to remove.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNTIME_MODE = "runtime";
export const BUNDLE_MODE = "bundle";

export const RUNTIME_LABEL = "runtime pass";
export const BUNDLE_LABEL = "bundle check";

// Every report names BOTH kinds, so a log line always says which one it was
// and which one it was not.  A reader who never saw the workflow file can
// still tell a runtime pass from a bundle check.
export const RUNTIME_KIND = "runtime pass -- this is NOT a bundle check";
export const BUNDLE_KIND = "bundle check -- this is NOT a runtime pass";

// The packaged executable, and the only path the shipped app ever runs its
// server on (server/index.ts's AGENTS_NODE_FLAG).
export const PACKAGED_BINARY_SEGMENTS = ["Contents", "MacOS", "BotFleet"];

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** lipo and uname -m disagree about Intel: lipo says x86_64, node says x64. */
export function normalizeArch(value) {
  const arch = String(value ?? "").trim().toLowerCase();
  if (arch === "x86_64" || arch === "amd64" || arch === "x64") return "x64";
  if (arch === "aarch64" || arch === "arm64") return "arm64";
  return arch;
}

/** Parse the output of `lipo -archs` into normalized architecture names. */
export function parseLipoArchs(output) {
  return String(output ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeArch);
}

/**
 * The packaged executable inside a built .app bundle.
 *
 * The path is absolute on purpose.  The gate hands this binary to child
 * processes that run with a different working directory (the preflight
 * scratch directory, the staging tree), and a relative path would be
 * resolved against THAT directory instead of the one the operator named.
 */
export function packagedBinaryPath(appPath) {
  return join(resolve(appPath), ...PACKAGED_BINARY_SEGMENTS);
}

/**
 * The gate's decision, from the app's architectures and the host's.
 *
 * `requireRuntime` is the fail-closed switch: it demands a runtime pass and
 * throws instead of degrading to a bundle check.
 */
export function resolveSmokeRuntime({
  appPath,
  appArches = [],
  hostArch = process.arch,
  runnerNode = process.execPath,
  requireRuntime = false,
} = {}) {
  const host = normalizeArch(hostArch);
  const arches = [...new Set((appArches ?? []).map(normalizeArch).filter(Boolean))];
  const binary = appPath ? packagedBinaryPath(appPath) : null;

  const bundle = (reason) => ({
    mode: BUNDLE_MODE,
    label: BUNDLE_LABEL,
    kind: BUNDLE_KIND,
    reason,
    runtime: null,
    command: runnerNode,
    env: {},
    hostArch: host,
    appArches: arches,
  });
  const runtime = (reason) => ({
    mode: RUNTIME_MODE,
    label: RUNTIME_LABEL,
    kind: RUNTIME_KIND,
    reason,
    runtime: binary,
    command: binary,
    // The packaged binary is an Electron app: without this it opens a window
    // instead of running the server.  This is the same flag the shipped
    // harness sets (server/index.ts's AGENTS_NODE_FLAG).
    env: { ELECTRON_RUN_AS_NODE: "1" },
    hostArch: host,
    appArches: arches,
  });

  if (!binary) {
    if (requireRuntime) throw new Error("a runtime pass was required but no packaged app was given");
    return bundle("no packaged app was given, so there is no packaged binary to boot");
  }
  if (!arches.length) {
    if (requireRuntime) {
      throw new Error(`a runtime pass was required but ${binary} has no readable architecture`);
    }
    return bundle("the packaged binary's architecture could not be read, so it cannot be exec'd safely");
  }
  if (!arches.includes(host)) {
    if (requireRuntime) {
      throw new Error(
        `a runtime pass was required but ${binary} is ${arches.join(" ")} and this host is ${host}`,
      );
    }
    return bundle(`the packaged binary is ${arches.join(" ")} and this host is ${host}, so it cannot be exec'd here`);
  }
  return runtime(`the packaged binary is ${arches.join(" ")} and this host is ${host}, so it can be exec'd here`);
}

/**
 * The runtime the smoke script itself will use.
 *
 * An empty OMB_SMOKE_RUNTIME means the caller asked for a bundle check, and
 * the runner's Node is the right runtime for that.  A NAMED runtime that
 * cannot be executed is an error, never a fallback: a silent fallback would
 * report a bundle check's result as a runtime pass.
 */
export function resolveRuntime(runtimePath, { runnerNode = process.execPath } = {}) {
  const raw = String(runtimePath ?? "").trim();
  if (!raw) {
    return {
      mode: BUNDLE_MODE,
      label: BUNDLE_LABEL,
      kind: BUNDLE_KIND,
      command: runnerNode,
      env: {},
      runtime: null,
      reason: "no runtime was named, so this is a bundle check against the runner's Node",
    };
  }
  // Absolute, because every child that runs it uses a different working
  // directory.  A relative name would resolve against that directory and
  // fail with ENOENT on a binary that is really there.
  const named = resolve(raw);
  if (!existsSync(named)) {
    throw new Error(
      `the named runtime ${named} does not exist.  Refusing to fall back to the runner's Node: ` +
        `a bundle check is not a runtime pass.`,
    );
  }
  const stats = statSync(named);
  if (!stats.isFile()) {
    throw new Error(`the named runtime ${named} is not a file.  Refusing to fall back to the runner's Node.`);
  }
  if (!(stats.mode & 0o111)) {
    throw new Error(`the named runtime ${named} is not executable.  Refusing to fall back to the runner's Node.`);
  }
  return {
    mode: RUNTIME_MODE,
    label: RUNTIME_LABEL,
    kind: RUNTIME_KIND,
    command: named,
    env: { ELECTRON_RUN_AS_NODE: "1" },
    runtime: named,
    reason: `the named runtime ${named} was booted with ELECTRON_RUN_AS_NODE=1`,
  };
}

/**
 * Prove the named runtime can actually run a script.
 *
 * Existence and the executable bit are not enough: a binary built for another
 * architecture exists, is executable, and still dies with "Bad CPU type in
 * executable".  So exec it once before the gate claims anything about it.
 */
export function assertRuntimeExecutable(command, { env = {}, cwd, timeoutMs = 30_000 } = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "omb-runtime-preflight-"));
  const script = join(scratch, "preflight.js");
  writeFileSync(script, "process.exit(0);\n");
  try {
    const result = spawnSync(command, [script], {
      cwd: cwd ?? scratch,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if (result.error) {
      throw new Error(
        `the named runtime ${command} could not be executed (${result.error.message}).  ` +
          `Refusing to fall back to the runner's Node.`,
      );
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "").trim();
      throw new Error(
        `the named runtime ${command} exited ${result.status} instead of running a trivial script.  ` +
          `Refusing to fall back to the runner's Node.${stderr ? `\n${stderr}` : ""}`,
      );
    }
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The architectures of a packaged binary, or [] when they cannot be read. */
export function readAppArches(binaryPath) {
  if (!existsSync(binaryPath)) return [];
  try {
    return parseLipoArchs(execFileSync("lipo", ["-archs", binaryPath], { encoding: "utf8" }));
  } catch {
    // lipo is missing (a non-Mac host) or refused the file (a malformed
    // bundle).  Either way the arch is unknown, and an unknown arch is a
    // bundle check, never a runtime pass.
    return [];
  }
}

/**
 * The command line, parsed once here so the call sites branch on WHAT a flag
 * is rather than on what type it happens to be.  A flag written with a value
 * lands in `values`, and every value there is a string the operator typed; a
 * bare switch lands in `flags`.  Nothing downstream has to ask what it is
 * holding.
 */
function parseArgs(argv) {
  const positional = [];
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split("=");
    if (inline !== undefined) {
      values.set(key, inline);
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
      continue;
    }
    flags.add(key);
  }
  return { positional, values, flags };
}

function describe(plan) {
  return [
    `smoke mode: ${plan.mode} (${plan.label})`,
    `smoke gate kind: ${plan.kind}`,
    `smoke reason: ${plan.reason}`,
    `smoke runtime: ${plan.runtime ?? `none -- this is a bundle check against the runner's Node, not a runtime pass`}`,
    `smoke host arch: ${plan.hostArch}`,
    `smoke app arch: ${plan.appArches.length ? plan.appArches.join(" ") : "unknown"}`,
  ];
}

/**
 * The environment the smoke script runs with.
 *
 * The runtime name is set for a runtime pass and REMOVED for a bundle check.
 * Without the removal, a stale OMB_SMOKE_RUNTIME inherited from the parent
 * process would make the smoke script boot a runtime while the gate, the
 * label and the step summary all said bundle check, so the two would
 * disagree about what actually ran.
 */
export function buildGateEnv(plan, { dist = null, parentEnv = process.env } = {}) {
  const env = { ...parentEnv, ...plan.env };
  if (plan.mode === RUNTIME_MODE) {
    env.OMB_SMOKE_RUNTIME = plan.runtime;
  } else {
    delete env.OMB_SMOKE_RUNTIME;
  }
  if (dist) env.OMB_SMOKE_DIST = resolve(dist);
  return env;
}

async function gate({ values, flags }) {
  const app = values.get("app") ?? null;
  if (!app) {
    console.error("smoke-runtime-mode gate: --app <path to the packaged .app> is required");
    process.exit(2);
  }
  const binary = packagedBinaryPath(app);
  if (!existsSync(binary)) {
    // A bundle without its executable is a broken bundle, not a bundle check.
    console.error(`smoke-runtime-mode gate: the packaged app has no executable at ${binary}`);
    process.exit(1);
  }
  const plan = resolveSmokeRuntime({
    appPath: app,
    appArches: readAppArches(binary),
    requireRuntime: flags.has("require-runtime"),
  });
  for (const line of describe(plan)) console.log(line);
  console.log(`::notice::packaged server smoke gate: ${plan.mode} (${plan.label}) -- ${plan.reason}`);

  const env = buildGateEnv(plan, { dist: values.get("dist") ?? null });

  const smoke = join(ROOT, "scripts", "smoke-packaged-server.mjs");
  const result = spawnSync(process.execPath, [smoke], { stdio: "inherit", env });

  const summary = values.get("summary") ?? null;
  if (summary) {
    const mode = plan.mode === RUNTIME_MODE ? "**runtime pass**" : "**bundle check**";
    const lines = [
      "### Packaged server smoke gate",
      "",
      `- mode: ${mode}`,
      `- reason: ${plan.reason}`,
      `- runtime: ${plan.runtime ?? "the runner's Node (no packaged binary was exec'd)"}`,
      `- host arch: ${plan.hostArch}`,
      `- app arch: ${plan.appArches.length ? plan.appArches.join(" ") : "unknown"}`,
      "",
    ];
    try {
      writeFileSync(summary, lines.join("\n"), { flag: "a" });
    } catch (error) {
      console.error(`smoke-runtime-mode gate: could not write the step summary: ${error.message}`);
    }
  }
  process.exit(result.status ?? 1);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (command === "gate") {
    await gate(args);
    return;
  }
  if (command === "plan") {
    const app = args.values.get("app") ?? null;
    const plan = resolveSmokeRuntime({
      appPath: app,
      appArches: app ? readAppArches(packagedBinaryPath(app)) : [],
    });
    for (const line of describe(plan)) console.log(line);
    return;
  }
  console.error("usage: node scripts/smoke-runtime-mode.mjs <plan|gate> [--app <.app>] [--dist <dir>] [--summary <file>] [--require-runtime]");
  process.exit(2);
}

// Only run the CLI when this file is the entry point, so the test file can
// import the helpers without the gate firing underneath it.
if (process.argv[1] && process.argv[1].endsWith("smoke-runtime-mode.mjs")) {
  await main();
}
