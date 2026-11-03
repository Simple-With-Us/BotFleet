import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  BOTFLEET_AGENTS,
  BOTFLEET_PORTS,
  evaluatePostReboot,
  inspectGitFiles,
  inspectLaunchAgents,
  inspectPortListeners,
  inspectProcesses,
  isBotFleetNodeProcess,
} from "./check-post-reboot-node.mjs";
import { resolveBoardCli } from "./decommission-gate-state.mjs";

test("isBotFleetNodeProcess identifies BotFleet Node command lines", () => {
  assert.equal(isBotFleetNodeProcess("node server/index.ts"), true);
  assert.equal(
    isBotFleetNodeProcess(
      "ELECTRON_RUN_AS_NODE=1 /Applications/BotFleet.app/Contents/Frameworks/Electron.framework/Electron server/index.js",
    ),
    true,
  );
  assert.equal(isBotFleetNodeProcess("bash scripts/botfleet-server-start.sh"), true);
  assert.equal(isBotFleetNodeProcess("node companion/src/index.ts"), true);
  assert.equal(isBotFleetNodeProcess("node dist/server/index.js"), true);
  assert.equal(isBotFleetNodeProcess("launchd gui/501/app.botfleet.server"), true);
  assert.equal(isBotFleetNodeProcess("/Applications/BotFleet.app/Contents/MacOS/BotFleet Helper"), true);
  assert.equal(isBotFleetNodeProcess("/Applications/BotFleet.app --hidden"), true);
  assert.equal(isBotFleetNodeProcess("ELECTRON_RUN_AS_NODE=1 /Applications/BotFleet Control.app/helper"), true);
  assert.equal(isBotFleetNodeProcess("/Applications/BotFleet Control.app/Contents/node server/index.ts"), true);

  // Unrelated processes and native Swift macOS apps must not be flagged
  assert.equal(
    isBotFleetNodeProcess("/Users/jay/Applications/BotFleet Control.app/Contents/MacOS/BotFleetControl"),
    false,
  );
  assert.equal(
    isBotFleetNodeProcess("/applications/botfleet control.app/contents/macos/botfleetcontrol"),
    false,
  );
  assert.equal(isBotFleetNodeProcess("/Applications/BotFleetMac.app/Contents/MacOS/BotFleetMac"), false);
  assert.equal(isBotFleetNodeProcess("node /usr/local/bin/vite dev"), false);
  assert.equal(isBotFleetNodeProcess("node /usr/local/bin/pnpm test"), false);
  assert.equal(isBotFleetNodeProcess("oxlint --fix"), false);
  assert.equal(isBotFleetNodeProcess("node scripts/check-post-reboot-node.mjs"), false);
  assert.equal(isBotFleetNodeProcess(""), false);
  assert.equal(isBotFleetNodeProcess(null), false);
});

test("inspectProcesses detects offending processes in ps aux and ps -ef output", () => {
  const samplePsAux = `
USER       PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
root         1   0.1  0.1 41101968  18352   ??  Ss    3Nov26   0:15.22 /sbin/launchd
jay       1234   0.0  0.2 41500000  25000   ??  S     3Nov26   0:01.05 node /Users/jay/Code/BotFleet/server/index.ts
jay       5678   0.0  0.1 41400000  20000   ??  S     3Nov26   0:00.50 /usr/local/bin/vite
jay       9999   0.0  0.3 41600000  30000   ??  S     3Nov26   0:02.10 node /Users/jay/Code/BotFleet/companion/src/index.ts
`;

  const offendingAux = inspectProcesses(samplePsAux);
  assert.equal(offendingAux.length, 2);
  assert.equal(offendingAux[0].pid, "1234");
  assert.equal(offendingAux[0].user, "jay");
  assert.match(offendingAux[0].command, /server\/index\.ts/);

  const samplePsEf = `
UID   PID  PPID   C STIME   TTY           TIME CMD
501  1234     1   0  3Nov26 ??         0:01.05 node /Users/jay/Code/BotFleet/server/index.ts
501  5678     1   0  3Nov26 ??         0:00.50 /usr/local/bin/vite
`;
  const offendingEf = inspectProcesses(samplePsEf);
  assert.equal(offendingEf.length, 1);
  assert.equal(offendingEf[0].pid, "1234");
  assert.equal(offendingEf[0].user, "501");
});

test("inspectProcesses returns empty array when process list is clean", () => {
  const cleanPs = `
USER       PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
root         1   0.1  0.1 41101968  18352   ??  Ss    3Nov26   0:15.22 /sbin/launchd
jay       5678   0.0  0.1 41400000  20000   ??  S     3Nov26   0:00.50 /usr/local/bin/vite
jay       7777   0.0  0.0  4100000   1000 s001  R+    3Nov26   0:00.01 ps aux
`;
  const offending = inspectProcesses(cleanPs);
  assert.deepEqual(offending, []);
});

test("inspectLaunchAgents flags lingering agents based on probe function", () => {
  const mockProbe = (label) => {
    if (label === "app.botfleet.server" || label === "com.jay.botfleet-server") {
      return { loaded: true, running: true, rawOutput: "state = running" };
    }
    return { loaded: false, running: false };
  };

  const lingering = inspectLaunchAgents(BOTFLEET_AGENTS, mockProbe);
  assert.equal(lingering.length, 2);
  assert.equal(lingering[0].label, "app.botfleet.server");
  assert.equal(lingering[1].label, "com.jay.botfleet-server");
});

test("inspectLaunchAgents returns empty when no agents are loaded", () => {
  const mockProbe = () => ({ loaded: false, running: false });
  const lingering = inspectLaunchAgents(BOTFLEET_AGENTS, mockProbe);
  assert.deepEqual(lingering, []);
});

test("inspectLaunchAgents records probe error into probeErrors", () => {
  const probeErrors = [];
  const mockFailingProbe = (label) => ({
    loaded: false,
    running: false,
    error: `timed out querying launchd for ${label}`,
  });
  const lingering = inspectLaunchAgents(["app.botfleet.server"], mockFailingProbe, probeErrors);
  assert.deepEqual(lingering, []);
  assert.equal(probeErrors.length, 1);
  assert.ok(probeErrors[0].includes("timed out querying launchd for app.botfleet.server"));

  const verdict = evaluatePostReboot({ probeErrors });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.failures.some((f) => f.includes("timed out querying launchd")));
});

test("inspectPortListeners parses lsof output for BotFleet ports", () => {
  const sampleLsof = `
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node     1234  jay   22u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:8799 (LISTEN)
node     1234  jay   23u  IPv4 0x1234567890abcdee      0t0  TCP 127.0.0.1:8800 (LISTEN)
python3  9000  jay    4u  IPv4 0x1234567890abcdff      0t0  TCP 127.0.0.1:3000 (LISTEN)
node     4321  jay   15u  IPv4 0x1234567890abceee      0t0  TCP 127.0.0.1:8810 (LISTEN)
BotFleet 4322  jay   16u  IPv4 0x1234567890abceef      0t0  TCP 127.0.0.1:8811 (LISTEN)
`;

  const listeners = inspectPortListeners(sampleLsof, BOTFLEET_PORTS);
  assert.equal(listeners.length, 4);
  assert.equal(listeners[0].port, 8799);
  assert.equal(listeners[0].isNode, true);
  assert.equal(listeners[1].port, 8800);
  assert.equal(listeners[1].isNode, true);
  assert.equal(listeners[2].port, 8810);
  assert.equal(listeners[2].isNode, true);
  assert.equal(listeners[3].port, 8811);
  assert.equal(listeners[3].isNode, true);
});

test("inspectGitFiles flags unapproved files under Mac-local roots while respecting exceptions", () => {
  const files = [
    "ios/Sources/BotFleet/App.swift",
    "scripts/check-post-reboot-node.mjs",
    "deploy/linux-server/botfleet-server.service.in",
    "deploy/linux-server/update.sh",
    "server/index.ts",
    "companion/src/index.ts",
    "electron/main.mjs",
  ];

  const unapproved = inspectGitFiles(files);
  assert.deepEqual(unapproved, [
    "companion/src/index.ts",
    "electron/main.mjs",
    "server/index.ts",
  ]);
});

test("evaluatePostReboot returns PASS when all inspections pass", () => {
  const verdict = evaluatePostReboot({
    processes: [],
    launchAgents: [],
    portListeners: [],
    gitFiles: [],
    probeErrors: [],
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.failures.length, 0);
});

test("evaluatePostReboot returns FAIL with diagnostics when checks fail", () => {
  const verdict = evaluatePostReboot({
    processes: [{ pid: "123", user: "jay", command: "node server/index.ts" }],
    launchAgents: [{ label: "app.botfleet.server", running: true }],
    portListeners: [{ port: 8799, pid: "123", command: "node", isNode: true }],
    gitFiles: ["server/index.ts"],
    probeErrors: ["probe timed out"],
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 5);
  assert.match(verdict.failures[0], /Inspection probe failures/);
  assert.match(verdict.failures[1], /Lingering BotFleet Node processes/);
  assert.match(verdict.failures[2], /Lingering BotFleet LaunchAgents/);
  assert.match(verdict.failures[3], /Lingering Node listeners on BotFleet ports/);
  assert.match(verdict.failures[4], /Unapproved lingering files/);
});

test("check-post-reboot-node.mjs CLI responds with JSON on --json", () => {
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "check-post-reboot-node.mjs");
  const res = spawnSync("node", [scriptPath, "--json"], { encoding: "utf8" });
  assert.ok(res.stdout.startsWith("{"));
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.ok === true || parsed.ok === false);
  assert.ok(Array.isArray(parsed.failures));
  assert.ok(parsed.details);
});

test("resolveBoardCli resolves BOARD_CLI or board", () => {
  const orig = process.env.BOARD_CLI;
  try {
    process.env.BOARD_CLI = "my-board-cli";
    assert.equal(resolveBoardCli(), "my-board-cli");
  } finally {
    if (orig !== undefined) process.env.BOARD_CLI = orig;
    else delete process.env.BOARD_CLI;
  }
});

test("resolveBoardCli throws fail-closed error when board binary is unavailable", () => {
  const origCli = process.env.BOARD_CLI;
  const origHome = process.env.HOME;
  const origPath = process.env.PATH;
  try {
    delete process.env.BOARD_CLI;
    process.env.HOME = "/tmp/nonexistent-home-dir-for-tests";
    process.env.PATH = "/tmp/nonexistent-empty-bin-dir";
    assert.throws(
      () => resolveBoardCli(),
      /Linear CLI 'board' not found on PATH or at ~\/\.local\/bin\/board/,
    );
  } finally {
    if (origCli !== undefined) process.env.BOARD_CLI = origCli;
    else delete process.env.BOARD_CLI;
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    if (origPath !== undefined) process.env.PATH = origPath;
    else delete process.env.PATH;
  }
});
