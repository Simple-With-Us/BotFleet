// Guard: a harness booted the way every API suite boots one can never reach a
// container runtime.
//
// History: server/index.test.ts turned the Local VM on and POSTed
// `/api/bots/:id/local-computer/run`, asserting only on error text.  The
// spawned harness had a throwaway HOME but the machine's real `docker`, and
// the Local VM container name derives from the OS username, so on a Mac with
// the managed image present it ran `docker run`, claimed the owner's real
// `botfleet-computer-<user>` name, and bind-mounted a temp directory that the
// suite then deleted.
//
// Here every runtime on PATH is a TRAP: a script that records that it ran.  The
// harness is spawned with `spawnDetached` (which applies the kill switch) and
// is given NO fixture directory, so the only way a trap can fire is a spawn
// that bypasses the guard.  The assertions are the refusal and an empty trap
// log; if either `spawnDetached` stops applying the switch or a new code path
// spawns a runtime unguarded, this suite goes red.
import type { ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTAINER_RUNTIME_DISABLED_MESSAGE } from "./container-runtime-guard.ts";
import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { harnessReady } from "./testing/harness-ready.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");
const PORT = 18800 + Math.floor(Math.random() * 10_000);
const BASE = `http://127.0.0.1:${PORT}`;
const RUNTIMES = ["docker", "podman", "container", "orb", "orbctl"] as const;

type RequestBody =
  | { name: string }
  | { botDefaults: { computerProviders: { asciiBox: boolean; selfHostedVps: boolean; localVm: boolean; localMac: boolean } } }
  | Record<string, never>;

const api = async (method: string, path: string, body?: RequestBody): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

describe.skipIf(process.platform === "win32")("harness cannot reach a container runtime", () => {
  let child: ChildProcess;
  let home: string;
  let trapLog: string;
  let stderr = "";

  const trapCalls = () => (existsSync(trapLog) ? readFileSync(trapLog, "utf8") : "");

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "bf-runtime-guard-harness-"));
    const bin = join(home, "trap-bin");
    trapLog = join(home, "trap.log");
    mkdirSync(bin);
    mkdirSync(join(home, ".botfleet"));
    writeFileSync(join(home, ".botfleet", "config.json"), JSON.stringify({
      instances: { ghost: { driver: "not-a-real-driver" } },
    }));
    for (const name of RUNTIMES) {
      // Answers like a healthy runtime so that a harness which DID reach it
      // would report a runtime and try to create a container.
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\necho "${name} $*" >> "${trapLog}"\necho 1\n`,
        { mode: 0o755 },
      );
      chmodSync(join(bin, name), 0o755);
    }

    child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
      cwd: ROOT,
      env: {
        PATH: [bin, process.env.PATH ?? ""].join(delimiter),
        HOME: home,
        USERPROFILE: home,
        OMB_EXTRA_PATH: bin,
        OMB_PORT: String(PORT),
        OMB_WEBHOOK_PORT: String(39000 + Math.floor(Math.random() * 10_000)),
        OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.resume();
    child.stderr!.on("data", (chunk) => (stderr += chunk));

    const deadline = Date.now() + 45_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`harness exited ${child.exitCode}: ${stderr.slice(-1000)}`);
      if (await harnessReady(BASE)) break;
      if (Date.now() > deadline) throw new Error(`harness never came up: ${stderr.slice(-1000)}`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }, 60_000);

  afterAll(async () => {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    if (home) await removeTempDir(home);
  });

  it("reports no runtime and says why", async () => {
    const status = await api("GET", "/api/local-computer");
    expect(status.status).toBe(200);
    expect(status.body.runtime).toBeNull();
    expect(status.body.available).toEqual([]);
    expect(status.body.daemonUp).toBe(false);
    expect(status.body.container).toBe("missing");
    expect(status.body.problem).toBe(CONTAINER_RUNTIME_DISABLED_MESSAGE);
    expect(trapCalls()).toBe("");
  });

  it("refuses to create, start, stop or remove a Local VM from the per-bot routes", async () => {
    const on = await api("PUT", "/api/config", {
      botDefaults: { computerProviders: { asciiBox: true, selfHostedVps: true, localVm: true, localMac: true } },
    });
    expect(on.status).toBe(200);
    const bot = (await api("POST", "/api/bots", { name: "Rae Runtime" })).body.bot;
    try {
      for (const action of ["run", "stop", "remove"]) {
        const refused = await api("POST", `/api/bots/${bot.id}/local-computer/${action}`, {});
        expect({ action, status: refused.status, error: refused.body.error }).toEqual({
          action,
          status: 409,
          error: CONTAINER_RUNTIME_DISABLED_MESSAGE,
        });
      }
    } finally {
      await api("DELETE", `/api/bots/${bot.id}`);
    }
    expect(trapCalls()).toBe("");
  });

  it("refuses every shared Local VM lifecycle action", async () => {
    for (const action of ["pull", "run", "start", "stop", "remove"]) {
      const refused = await api("POST", `/api/local-computer/${action}`, {});
      expect({ action, status: refused.status, error: refused.body.error }).toEqual({
        action,
        status: 409,
        error: CONTAINER_RUNTIME_DISABLED_MESSAGE,
      });
    }
    expect(trapCalls()).toBe("");
  });

  it("never ran a single runtime command, including the boot-time probe", () => {
    expect(trapCalls()).toBe("");
  });
});
