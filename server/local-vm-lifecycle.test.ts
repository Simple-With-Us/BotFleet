import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeTempDir, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

// Real HTTP admission and state changes, with every container executable
// shadowed by a fixture.  A file gate holds cleanup before any container I/O.
describe.skipIf(process.platform === "win32")("Local VM lifecycle exclusion", () => {
  let child: ChildProcess;
  let home: string;
  let gate: string;
  let entered: string;
  let log: string;
  let stderr = "";
  const port = 18800 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  const serverDir = dirname(fileURLToPath(import.meta.url));
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method, headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() as any };
  };
  const hold = () => {
    rmSync(entered, { force: true });
    writeFileSync(gate, "hold");
  };
  const release = () => rmSync(gate, { force: true });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "bf-vm-lifecycle-"));
    const bin = join(home, "bin");
    gate = join(home, "gate");
    entered = join(home, "entered");
    log = join(home, "runtime.log");
    mkdirSync(bin);
    mkdirSync(join(home, ".botfleet"));
    writeFileSync(join(home, ".botfleet", "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver" } },
      localVm: { mode: "shared" },
    }));
    const fake = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const home = process.env.HOME;
const args = process.argv.slice(2);
if (path.basename(process.argv[1]) !== "docker") process.exit(1);
fs.appendFileSync(path.join(home, "runtime.log"), args.join(" ") + "\\n");
(async () => {
  if (args[0] === "info") {
    if (fs.existsSync(path.join(home, "gate"))) {
      fs.writeFileSync(path.join(home, "entered"), "entered");
      while (fs.existsSync(path.join(home, "gate"))) await new Promise(r => setTimeout(r, 10));
    }
    console.log("fixture-runtime");
  } else if (args[0] === "inspect") {
    console.log(JSON.stringify([{State: {Running: false}, Config: {}, HostConfig: {}, NetworkSettings: {}}]));
  } else if (args[0] === "image" && args[1] === "inspect") {
    console.log("[]");
  } else if (args[0] !== "rm") process.exitCode = 64;
})().catch(() => { process.exitCode = 1; });
`;
    // One runtime keeps the lifecycle log deterministic.  Advertising all
    // three makes runtime discovery probe Docker and Podman concurrently, so
    // a second preflight line can race an assertion about the fenced request.
    writeFileSync(join(bin, "docker"), fake, { mode: 0o755 });
    child = spawn(process.execPath, [join(serverDir, "index.ts")], {
      cwd: join(serverDir, ".."), stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH, OMB_EXTRA_PATH: bin,
        OMB_PORT: String(port), OMB_WEBHOOK_PORT: String(39000 + Math.floor(Math.random() * 10000)),
        OMB_DISABLE_ANTIGRAVITY_QUOTA: "1", VITEST: "1" },
    });
    child.stdout!.resume();
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    const deadline = Date.now() + 30000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`fixture exited ${child.exitCode}: ${stderr.slice(-1000)}`);
      if (await harnessReady(base)) break;
      if (Date.now() > deadline) throw new Error(`fixture did not start: ${stderr.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Listen awaits the startup idle-backstop probe, so health means that
    // shared-VM inspect has finished.  Still drain the log briefly in case a
    // future boot path reintroduces background docker traffic before tests
    // take the fence snapshot.
    for (let prev = -1, quiet = 0; quiet < 3; ) {
      const size = existsSync(log) ? readFileSync(log, "utf8").length : 0;
      if (size === prev) quiet += 1;
      else { prev = size; quiet = 0; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }, 40000);

  afterAll(async () => {
    if (gate) release();
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("refuses deletion while mode cleanup owns the global fence, then permits retry", async () => {
    const bot = (await api("POST", "/api/bots", { name: "Mode held" })).body.bot;
    hold();
    const mode = api("POST", "/api/local-computer/mode", { mode: "per-bot" });
    try {
      await expect.poll(() => existsSync(entered), { timeout: 10000 }).toBe(true);
      const before = readFileSync(log, "utf8");
      expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(409);
      expect((await api("GET", "/api/bots")).body.bots.some((item: any) => item.id === bot.id)).toBe(true);
      // Exact equality: a blocked delete must not start container I/O.  The
      // startup idle-backstop probe is awaited before listen so its inspect
      // cannot appear here as a flake.
      expect(readFileSync(log, "utf8")).toBe(before);
    } finally { release(); await mode; }
    expect((await mode).status).toBe(200);
    expect((await api("DELETE", `/api/bots/${bot.id}`)).status).toBe(200);
  });

  it("refuses mode changes while deletion owns a target fence, then permits retry", async () => {
    // Establish this case's own starting mode.  It must not depend on the
    // preceding test having completed its mode switch.
    expect((await api("POST", "/api/local-computer/mode", { mode: "per-bot" })).status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Delete held" })).body.bot;
    hold();
    const deletion = api("DELETE", `/api/bots/${bot.id}`);
    try {
      await expect.poll(() => existsSync(entered), { timeout: 10000 }).toBe(true);
      const before = readFileSync(log, "utf8");
      expect((await api("POST", "/api/local-computer/mode", { mode: "shared" })).status).toBe(409);
      // Same contract as the deletion fence case above.
      expect(readFileSync(log, "utf8")).toBe(before);
    } finally { release(); await deletion; }
    expect((await deletion).status).toBe(200);
    expect((await api("POST", "/api/local-computer/mode", { mode: "shared" })).status).toBe(200);
  });
});
