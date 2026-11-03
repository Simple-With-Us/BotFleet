// Machine-checkable post-reboot verification harness (BF-2515).
//
// Verifies that after a Mac reboot following Phase 5 cutover:
// 1. No Mac-local BotFleet Node processes are running (harness, companion, or
//    Electron-as-Node).
// 2. The legacy LaunchAgents (app.botfleet.server, app.botfleet.companion,
//    com.jay.botfleet-server, com.jay.botfleet-companion) are not active/loaded
//    in launchd.
// 3. Local TCP ports (8799, 8800, 8810, 8811) have no active Node listeners on
//    loopback 127.0.0.1.
// 4. (Optional --check-git): git ls-files under Mac-local roots (server/,
//    companion/, electron/) confirms no lingering unapproved files exist.
//    Retained Linux server code (deploy/linux-server/) is out of scope.
//
// Pure inspection functions allow the test suite to exercise every scenario
// (lingering process, lingering launchd job, lingering port listener, dirty git
// tree) without requiring a destructive reboot during testing.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const BOTFLEET_PORTS = [8799, 8800, 8810, 8811];
export const BOTFLEET_AGENTS = [
  "app.botfleet.server",
  "app.botfleet.companion",
  "com.jay.botfleet-server",
  "com.jay.botfleet-companion",
];
export const MAC_LOCAL_ROOTS = ["server", "companion", "electron"];
// Note: deploy/linux-server/ is retained for Linux hosting and is outside MAC_LOCAL_ROOTS.
export const RETAINED_EXCEPTIONS = [];

export const EXPLICIT_LEGACY_NODE_PATTERNS = [
  /app\.botfleet\.server/i,
  /botfleet-server-start\.sh/i,
  /server\/(?:index|local-vm-offline-cli)\.(?:ts|js|mjs)/i,
  /companion\/src\//i,
  /botfleet-companion-start\.sh/i,
  /app\.botfleet\.companion/i,
  /com\.jay\.botfleet-server/i,
  /com\.jay\.botfleet-companion/i,
  /ELECTRON_RUN_AS_NODE=1/i,
  /node.*(?:dist\/server|dist-companion)\/index/i,
];

export const BOTFLEET_HELPER_PATTERNS = [
  /\bBotFleet Helper\b/i,
];

const BOTFLEET_MAIN_EXECUTABLE = /(?:^|[\s"'=])(.+\/BotFleet\.app\/Contents\/MacOS\/BotFleet)(?=$|[\s"'])/i;

/**
 * Inspect the executable backing a candidate main-app process.
 *
 * The native and Electron apps share a bundle and executable path, so argv and
 * bundle naming cannot distinguish them.
 *
 * Read the kernel-reported executable path for the PID, then inspect its
 * linked frameworks without invoking a shell.
 *
 * Any missing or ambiguous evidence is unknown and remains a gate failure.
 */
export function inspectRunningExecutable(pid, expectedPath) {
  if (!/^[1-9]\d*$/.test(String(pid ?? "")) || !expectedPath) return "unknown";

  let actualPath;
  try {
    actualPath = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    }).trim();
  } catch {
    return "unknown";
  }
  if (!actualPath || actualPath !== expectedPath) return "unknown";

  let linkedLibraries;
  try {
    linkedLibraries = execFileSync("otool", ["-L", actualPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
  } catch {
    return "unknown";
  }

  if (/Electron\.framework(?:\/|\s)/i.test(linkedLibraries)) return "electron";
  if (
    /(?:SwiftUI|AppKit)\.framework(?:\/|\s)/i.test(linkedLibraries) &&
    /libswiftCore(?:\.dylib)?/i.test(linkedLibraries)
  ) {
    return "native";
  }
  return "unknown";
}

function mainExecutablePath(cmdLine) {
  return String(cmdLine).match(BOTFLEET_MAIN_EXECUTABLE)?.[1] ?? null;
}

/**
 * Check if a command line represents a BotFleet-specific Node process.
 * Ignores unrelated Node processes like build tools, test runners, or developer shells,
 * and a positively identified native BotFleet macOS executable.
 */
export function isBotFleetNodeProcess(
  cmdLine,
  { pid = null, inspectExecutable = inspectRunningExecutable } = {},
) {
  if (!cmdLine) return false;
  const str = String(cmdLine);
  // Ignore the check script itself or test runners executing it
  if (str.includes("check-post-reboot-node") || str.includes("decommission-gates")) {
    return false;
  }
  // If an explicit legacy Node indicator is present, flag it immediately
  if (EXPLICIT_LEGACY_NODE_PATTERNS.some((pattern) => pattern.test(str))) {
    return true;
  }
  if (BOTFLEET_HELPER_PATTERNS.some((pattern) => pattern.test(str))) return true;

  if (/(?:^|\/)BotFleet\.app\b/i.test(str)) {
    const executablePath = mainExecutablePath(str);
    if (!executablePath) return true;
    // Fail closed when the inspector cannot prove this is the native Swift app.
    try {
      return inspectExecutable(pid, executablePath) !== "native";
    } catch {
      return true;
    }
  }

  // Ignore native macOS Swift applications (case-folded per Rule 30)
  const lower = str.toLowerCase();
  if (
    lower.includes("botfleet control.app") ||
    lower.includes("botfleetcontrol") ||
    lower.includes("botfleetmac.app") ||
    lower.includes("botfleetmac")
  ) {
    return false;
  }
  return false;
}

/**
 * Parse `ps aux` or `ps -ef` output to find any lingering BotFleet Node processes.
 * Returns array of offending process objects: { pid, user, command }.
 */
export function inspectProcesses(psOutput, { inspectExecutable = inspectRunningExecutable } = {}) {
  if (!psOutput) return [];
  const lines = String(psOutput).split("\n");
  const offending = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("USER") || trimmed.startsWith("UID")) continue;
    const parts = trimmed.split(/\s+/);
    let user = parts[0];
    let pid = parts[1];
    let command = "";
    if (parts.length >= 11) {
      // Standard `ps aux` column format: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND...
      command = parts.slice(10).join(" ");
    } else if (parts.length >= 8) {
      // Standard `ps -ef` column format: UID PID PPID C STIME TTY TIME CMD...
      command = parts.slice(7).join(" ");
    } else {
      continue;
    }

    if (isBotFleetNodeProcess(command, { pid, inspectExecutable })) {
      offending.push({ pid, user, command });
    }
  }
  return offending;
}

/**
 * Inspect launchd status for BotFleet agents.
 * `probeFn(agentLabel)` should return { loaded: boolean, running: boolean, rawOutput?: string, error?: string }.
 */
export function inspectLaunchAgents(agentLabels = BOTFLEET_AGENTS, probeFn, probeErrors = null) {
  const active = [];
  for (const label of agentLabels) {
    const status = probeFn(label);
    if (status.error && Array.isArray(probeErrors)) {
      probeErrors.push(`launchctl probe error for ${label}: ${status.error}`);
    }
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
  if (process.platform !== "darwin") {
    return { loaded: false, running: false, skipped: true };
  }
  try {
    const uid = process.getuid ? process.getuid() : 501;
    const out = execFileSync("launchctl", ["print", `gui/${uid}/${label}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    const running = out.includes("state = running");
    return { loaded: true, running, rawOutput: out.split("\n").slice(0, 5).join("; ") };
  } catch (error) {
    const stderr = String(error.stderr || error.stdout || "");
    const isNotFound =
      error.status === 113 ||
      /Could not find service|No such process|Bad request/i.test(stderr);
    if (isNotFound) {
      return { loaded: false, running: false };
    }
    return {
      loaded: false,
      running: false,
      error: error.message || `launchctl exit ${error.status}: ${stderr.trim()}`,
    };
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
        // We care about Node or BotFleet processes listening on loopback or all interfaces
        const isNode = /node|electron|botfleet/i.test(command);
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
    const isException = exceptions.some((exc) => file === exc || file.startsWith(`${exc}/`));
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
export function evaluatePostReboot({
  processes = [],
  launchAgents = [],
  portListeners = [],
  gitFiles = [],
  probeErrors = [],
} = {}) {
  const failures = [];

  if (probeErrors.length > 0) {
    failures.push(`Inspection probe failures encountered: ${probeErrors.join("; ")}`);
  }

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
      probeErrors,
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

  const probeErrors = [];
  let psOut = "";
  try {
    psOut = execFileSync("ps", ["aux"], { encoding: "utf8", timeout: 15_000 });
  } catch (error) {
    probeErrors.push(`ps aux probe failed: ${error.message}`);
    console.error("warning: unable to read ps aux:", error.message);
  }

  let lsofOut = "";
  try {
    lsofOut = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  } catch (error) {
    // lsof exits 1 if no files matching ports found, which is clean
    if (error.status !== 1) {
      probeErrors.push(`lsof probe failed (exit ${error.status}): ${error.message}`);
    }
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
      probeErrors.push(`git ls-files probe failed: ${error.message}`);
      console.error("warning: unable to read git ls-files:", error.message);
    }
  }

  const processes = inspectProcesses(psOut);
  const launchAgents = inspectLaunchAgents(BOTFLEET_AGENTS, realLaunchctlProbe, probeErrors);
  const portListeners = inspectPortListeners(lsofOut, BOTFLEET_PORTS);
  const gitFiles = checkGit ? inspectGitFiles(gitTracked) : [];

  const verdict = evaluatePostReboot({ processes, launchAgents, portListeners, gitFiles, probeErrors });

  if (jsonMode) {
    console.log(JSON.stringify(verdict, null, 2));
    if (!verdict.ok) {
      process.exit(1);
    }
  } else {
    const nodePortListeners = portListeners.filter((l) => l.isNode);
    console.log("=== BotFleet Post-Reboot Verification (BF-2515) ===");
    console.log(`Processes:     ${processes.length === 0 ? "OK (no lingering BotFleet Node processes)" : `FAILED (${processes.length} detected)`}`);
    console.log(`LaunchAgents:  ${launchAgents.length === 0 ? "OK (none loaded)" : `FAILED (${launchAgents.length} loaded)`}`);
    console.log(`TCP Listeners: ${nodePortListeners.length === 0 ? (portListeners.length === 0 ? "OK (ports 8799, 8800, 8810, 8811 free)" : `INFO (${portListeners.length} non-Node listeners)`) : `FAILED (${nodePortListeners.length} Node listeners)`}`);
    if (checkGit) {
      console.log(`Git Tree:      ${gitFiles.length === 0 ? "OK (no unapproved Mac-local files)" : `FAILED (${gitFiles.length} unapproved files)`}`);
    }
    if (probeErrors.length > 0) {
      console.log(`Probes:        FAILED (${probeErrors.length} probe errors)`);
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
