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

  // Unrelated processes must not be flagged
  assert.equal(isBotFleetNodeProcess("node /usr/local/bin/vite dev"), false);
  assert.equal(isBotFleetNodeProcess("node /usr/local/bin/pnpm test"), false);
  assert.equal(isBotFleetNodeProcess("oxlint --fix"), false);
  assert.equal(isBotFleetNodeProcess("node scripts/check-post-reboot-node.mjs"), false);
  assert.equal(isBotFleetNodeProcess(""), false);
  assert.equal(isBotFleetNodeProcess(null), false);
});

test("inspectProcesses detects offending processes in ps output", () => {
  const samplePs = `
USER       PID  %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND
root         1   0.1  0.1 41101968  18352   ??  Ss    3Nov26   0:15.22 /sbin/launchd
jay       1234   0.0  0.2 41500000  25000   ??  S     3Nov26   0:01.05 node /Users/jay/Code/BotFleet/server/index.ts
jay       5678   0.0  0.1 41400000  20000   ??  S     3Nov26   0:00.50 /usr/local/bin/vite
jay       9999   0.0  0.3 41600000  30000   ??  S     3Nov26   0:02.10 node /Users/jay/Code/BotFleet/companion/src/index.ts
`;

  const offending = inspectProcesses(samplePs);
  assert.equal(offending.length, 2);
  assert.equal(offending[0].pid, "1234");
  assert.equal(offending[0].user, "jay");
  assert.match(offending[0].command, /server\/index\.ts/);

  assert.equal(offending[1].pid, "9999");
  assert.equal(offending[1].user, "jay");
  assert.match(offending[1].command, /companion\/src\/index\.ts/);
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
    if (label === "app.botfleet.server") {
      return { loaded: true, running: true, rawOutput: "state = running" };
    }
    return { loaded: false, running: false };
  };

  const lingering = inspectLaunchAgents(BOTFLEET_AGENTS, mockProbe);
  assert.equal(lingering.length, 1);
  assert.equal(lingering[0].label, "app.botfleet.server");
  assert.equal(lingering[0].running, true);
});

test("inspectLaunchAgents returns empty when no agents are loaded", () => {
  const mockProbe = () => ({ loaded: false, running: false });
  const lingering = inspectLaunchAgents(BOTFLEET_AGENTS, mockProbe);
  assert.deepEqual(lingering, []);
});

test("inspectPortListeners parses lsof output for BotFleet ports", () => {
  const sampleLsof = `
COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
node     1234  jay   22u  IPv4 0x1234567890abcdef      0t0  TCP 127.0.0.1:8799 (LISTEN)
node     1234  jay   23u  IPv4 0x1234567890abcdee      0t0  TCP 127.0.0.1:8800 (LISTEN)
python3  9000  jay    4u  IPv4 0x1234567890abcdff      0t0  TCP 127.0.0.1:3000 (LISTEN)
node     4321  jay   15u  IPv4 0x1234567890abceee      0t0  TCP 127.0.0.1:8810 (LISTEN)
`;

  const listeners = inspectPortListeners(sampleLsof, BOTFLEET_PORTS);
  assert.equal(listeners.length, 3);
  assert.equal(listeners[0].port, 8799);
  assert.equal(listeners[0].isNode, true);
  assert.equal(listeners[1].port, 8800);
  assert.equal(listeners[1].isNode, true);
  assert.equal(listeners[2].port, 8810);
  assert.equal(listeners[2].isNode, true);
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
  });

  assert.equal(verdict.ok, false);
  assert.equal(verdict.failures.length, 4);
  assert.match(verdict.failures[0], /Lingering BotFleet Node processes/);
  assert.match(verdict.failures[1], /Lingering BotFleet LaunchAgents/);
  assert.match(verdict.failures[2], /Lingering Node listeners on BotFleet ports/);
  assert.match(verdict.failures[3], /Unapproved lingering files/);
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
