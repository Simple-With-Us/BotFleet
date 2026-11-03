// Machine-checkable post-reboot verification harness (BF-2515).
//
// Verifies that after a Mac reboot following Phase 5 cutover:
// 1. No Mac-local BotFleet Node processes are running (harness, companion, or
//    Electron-as-Node).
// 2. The legacy LaunchAgents (app.botfleet.server and app.botfleet.companion)
//    are not active/loaded in launchd.
// 3. Local TCP ports (8799, 8800, 8810) have no active Node listeners on
//    loopback 127.0.0.1.
// 4. (Optional --check-git): git ls-files under Mac-local roots (server/,
//    companion/, electron/) confirms no lingering unapproved files exist
//    beyond approved retained exceptions (deploy/linux-server/).
//
// Pure inspection functions allow the test suite to exercise every scenario
// (lingering process, lingering launchd job, lingering port listener, dirty git
// tree) without requiring a destructive reboot during testing.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOTFLEET_PORTS = [8799, 8800, 8810];
export const BOTFLEET_AGENTS = ["app.botfleet.server", "app.botfleet.companion"];
export const MAC_LOCAL_ROOTS = ["server", "companion", "electron"];
export const RETAINED_EXCEPTIONS = ["deploy/linux-server/"];

export const BOTFLEET_NODE_PATTERNS = [
  /app\.botfleet\.server/i,
  /botfleet-server-start\.sh/i,
  /server\/(?:index|local-vm-offline-cli)\.(?:ts|js|mjs)/i,
  /companion\/src\//i,
  /botfleet-companion-start\.sh/i,
  /app\.botfleet\.companion/i,
  /ELECTRON_RUN_AS_NODE=1.*botfleet/i,
  /node.*(?:dist\/server|dist-companion)\/index/i,
];

/**
 * Check if a command line represents a BotFleet-specific Node process.
 * Ignores unrelated Node processes like build tools, test runners, or developer shells.
 */
export function isBotFleetNodeProcess(cmdLine) {
  if (!cmdLine) return false;
  const str = String(cmdLine);
  // Ignore the check script itself or test runners executing it
  if (str.includes("check-post-reboot-node") || str.includes("decommission-gates")) {
    return false;
  }
  return BOTFLEET_NODE_PATTERNS.some((pattern) => pattern.test(str));
}

/**
 * Parse `ps aux` or `ps -ef` output to find any lingering BotFleet Node processes.
 * Returns array of offending process objects: { pid, user, command }.
 */
export function inspectProcesses(psOutput) {
  if (!psOutput) return [];
  const lines = String(psOutput).split("\n");
  const offending = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("USER") || trimmed.startsWith("UID")) continue;
    // Standard `ps aux` column format: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
    const parts = trimmed.split(/\s+/);
    if (parts.length < 11) continue;
    const user = parts[0];
    const pid = parts[1];
    const command = parts.slice(10).join(" ");

    if (isBotFleetNodeProcess(command)) {
      offending.push({ pid, user, command });
    }
  }
  return offending;
}

/**
 * Inspect launchd status for BotFleet agents.
 * `probeFn(agentLabel)` should return { loaded: boolean, running: boolean, rawOutput?: string }.
 */
export function inspectLaunchAgents(agentLabels = BOTFLEET_AGENTS, probeFn) {
  const active = [];
  for (const label of agentLabels) {
    const status = probeFn(label);
    if (status.loaded || status.running) {
      active.push({ label, running: status.running, details: status.rawOutput ?? "loaded" });
    }
  }
  return active;
}

/**
 * Real system probe for launchctl on macOS.
 */
export function realLaunchctlProbe(label) {
  try {
    const uid = process.getuid ? process.getuid() : 501;
    const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const running = out.includes("state = running");
    return { loaded: true, running, rawOutput: out.split("\n").slice(0, 5).join("; ") };
  } catch {
    return { loaded: false, running: false };
  }
}

/**
 * Inspect `lsof -nP -iTCP -sTCP:LISTEN` output for listeners on BotFleet ports.
 * Returns array of offending listeners on loopback: { port, pid, command }.
 */
export function inspectPortListeners(lsofOutput, watchedPorts = BOTFLEET_PORTS) {
  if (!lsofOutput) return [];
  const lines = String(lsofOutput).split("\n");
  const listeners = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMAND")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 9) continue;
    const command = parts[0];
    const pid = parts[1];
    const addressCol = parts[8]; // e.g. 127.0.0.1:8799 or *:8799

    for (const port of watchedPorts) {
      const portSuffix = `:${port}`;
      if (addressCol.endsWith(portSuffix)) {
        // We care about Node processes listening on loopback or all interfaces
        const isNode = /node|electron/i.test(command);
        listeners.push({ port, pid, command, address: addressCol, isNode });
      }
    }
  }
  return listeners;
}

/**
 * Audit tracked git files under Mac-local roots.
 * Returns array of lingering files that are not covered by approved exceptions.
 */
export function inspectGitFiles(filesList, roots = MAC_LOCAL_ROOTS, exceptions = RETAINED_EXCEPTIONS) {
  if (!Array.isArray(filesList)) return [];
  const lingering = [];

  for (const file of filesList) {
    const matchesRoot = roots.some((root) => file === root || file.startsWith(`${root}/`));
    if (!matchesRoot) continue;
    const isException = exceptions.some((exc) => file.startsWith(exc));
    if (!isException) {
      lingering.push(file);
    }
  }
  return lingering.sort();
}

/**
 * Evaluate overall post-reboot health.
 * Pure aggregator over injected inspection outputs.
 */
export function evaluatePostReboot({ processes = [], launchAgents = [], portListeners = [], gitFiles = [] } = {}) {
  const failures = [];

  if (processes.length > 0) {
    failures.push(
      `Lingering BotFleet Node processes detected (${processes.length}): ${processes.map((p) => `PID ${p.pid} (${p.command.slice(0, 60)})`).join("; ")}`,
    );
  }

  if (launchAgents.length > 0) {
    failures.push(
      `Lingering BotFleet LaunchAgents loaded in launchd (${launchAgents.length}): ${launchAgents.map((a) => a.label).join(", ")}`,
    );
  }

  const nodePortListeners = portListeners.filter((l) => l.isNode);
  if (nodePortListeners.length > 0) {
    failures.push(
      `Lingering Node listeners on BotFleet ports (${nodePortListeners.length}): ${nodePortListeners.map((l) => `port ${l.port} (PID ${l.pid} ${l.command})`).join(", ")}`,
    );
  }

  if (gitFiles.length > 0) {
    failures.push(
      `Unapproved lingering files under Mac-local roots (${gitFiles.length}): ${gitFiles.slice(0, 5).join(", ")}${gitFiles.length > 5 ? "..." : ""}`,
    );
  }

  return {
    ok: failures.length === 0,
    failures,
    details: {
      processes,
      launchAgents,
      portListeners,
      gitFiles,
    },
  };
}

function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const args = process.argv.slice(2);
  const jsonMode = args.includes("--json");
  const checkGit = args.includes("--check-git");

  let psOut = "";
  try {
    psOut = execFileSync("ps", ["aux"], { encoding: "utf8", timeout: 15_000 });
  } catch (error) {
    console.error("warning: unable to read ps aux:", error.message);
  }

  let lsofOut = "";
  try {
    lsofOut = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  } catch {
    // lsof exits 1 if no files matching ports found
  }

  let gitTracked = [];
  if (checkGit) {
    try {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
      const out = execFileSync("git", ["-C", repoRoot, "ls-files", "--", ...MAC_LOCAL_ROOTS], {
        encoding: "utf8",
        timeout: 30_000,
      });
      gitTracked = out.split("\n").filter(Boolean);
    } catch (error) {
      console.error("warning: unable to read git ls-files:", error.message);
    }
  }

  const processes = inspectProcesses(psOut);
  const launchAgents = inspectLaunchAgents(BOTFLEET_AGENTS, realLaunchctlProbe);
  const portListeners = inspectPortListeners(lsofOut, BOTFLEET_PORTS);
  const gitFiles = checkGit ? inspectGitFiles(gitTracked) : [];

  const verdict = evaluatePostReboot({ processes, launchAgents, portListeners, gitFiles });

  if (jsonMode) {
    console.log(JSON.stringify(verdict, null, 2));
  } else {
    console.log("=== BotFleet Post-Reboot Verification (BF-2515) ===");
    console.log(`Processes:     ${processes.length === 0 ? "OK (no lingering BotFleet Node processes)" : `FAILED (${processes.length} detected)`}`);
    console.log(`LaunchAgents:  ${launchAgents.length === 0 ? "OK (none loaded)" : `FAILED (${launchAgents.length} loaded)`}`);
    console.log(`TCP Listeners: ${portListeners.length === 0 ? "OK (ports 8799, 8800, 8810 free)" : `INFO (${portListeners.length} active listeners)`}`);
    if (checkGit) {
      console.log(`Git Tree:      ${gitFiles.length === 0 ? "OK (no unapproved Mac-local files)" : `FAILED (${gitFiles.length} unapproved files)`}`);
    }
    console.log("---------------------------------------------------");
    if (verdict.ok) {
      console.log("Verdict: PASS — Mac is clean of BotFleet Node services post-reboot.");
    } else {
      console.error("Verdict: FAIL — lingering services or processes detected:");
      for (const fail of verdict.failures) {
        console.error(`  - ${fail}`);
      }
      process.exit(1);
    }
  }
}
