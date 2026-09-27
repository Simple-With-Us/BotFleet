// The port opens before the boot work, not after it.
//
// `server.listen` used to be the last statement of server/index.ts, so every
// boot connection-reset `/api/health` until Infisical, the provider registry
// and the post-update resume had all finished — and a slow network made that
// the full 12 s Infisical cap (audit HS19).  The fix has to hold two lines at
// once: health answers 200 from the first instant (every supervisor on this
// Mac reads 200 as UP), and no other route answers with half-built state.
//
// The boot is held open deliberately here: an enabled `claudeAgent` instance
// whose CLI blocks on `--version` stops `registry.load` exactly where the
// real Infisical preload stops it, which makes the booting window a fixture
// rather than a race.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";
import { freePortBlock } from "./testing/ports.ts";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SERVER_DIR, "..");

let home: string;
let probeGate: string;
let port = 0;
let base = "";
let child: ReturnType<typeof spawnDetached> | null = null;
let stderr = "";

const health = async () => {
  const res = await fetch(`${base}/api/health`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "bf-boot-gate-"));
  const dataDir = join(home, ".botfleet");
  mkdirSync(dataDir, { recursive: true });
  probeGate = join(home, "probe-gate");
  const slowCli = join(home, "fake-claude-slow-probe");
  // Answers every probe itself, so the only slow thing about it is the gate:
  // importing the type-stripped fixture would add its own seconds and blur
  // what this test is measuring.
  writeFileSync(
    slowCli,
    [
      "#!/usr/bin/env node",
      'const { existsSync } = await import("node:fs");',
      "const argv = process.argv.slice(2);",
      'if (argv[0] === "--version") {',
      `  while (!existsSync(${JSON.stringify(probeGate)})) await new Promise((r) => setTimeout(r, 10));`,
      '  process.stdout.write("2.1.232 (Claude Code)\\n");',
      "  process.exit(0);",
      "}",
      'if (argv[0] === "--help") { process.stdout.write("  --strict-mcp-config  Only load explicit MCP servers\\n"); process.exit(0); }',
      'if (argv[0] === "auth" && argv[1] === "status") {',
      '  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }) + "\\n");',
      "  process.exit(0);",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dataDir, "config.json"),
    JSON.stringify({
      instances: {
        slow: { driver: "claudeAgent", displayName: "Slow Probe", config: { cli: slowCli } },
      },
    }),
  );

  const portBase = await freePortBlock([0, 1]);
  port = portBase;
  base = `http://127.0.0.1:${port}`;
  child = spawnDetached(process.execPath, [join(SERVER_DIR, "index.ts")], {
    cwd: ROOT,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      HOME: home,
      USERPROFILE: home,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(portBase + 1),
      OMB_DISABLE_ANTIGRAVITY_QUOTA: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
}, 30_000);

afterAll(async () => {
  if (child && child.exitCode === null) await waitForExit(child, { signal: "SIGTERM" });
  await removeTempDir(home);
});

describe("the harness answers while it is still booting", () => {
  it("serves health at 200 with ready:false, refuses every other route, then flips", async () => {
    // 1. Health answers long before boot finishes — and says so.
    await expect
      .poll(async () => {
        try {
          return (await health()).status;
        } catch {
          return 0;
        }
        // A cold harness is a type-stripped module graph of a few hundred
        // files; binding the port is the first thing it does, but not the
        // first thing that happens.
      }, { timeout: 120_000, interval: 500 })
      .toBe(200);
    const booting = await health();
    expect(booting.body).toMatchObject({ app: "botfleet", booting: true, ready: false });
    expect(typeof booting.body.pid).toBe("number");
    // The identity fields the desktop launcher matches on are still there —
    // including the ownership proof, which is what stops it attaching to a
    // harness serving somebody else's data directory.
    expect(booting.body).toHaveProperty("static");
    const challenged = await fetch(`${base}/api/health`, {
      headers: { "x-botfleet-owner-challenge": "a".repeat(64) },
    });
    const proven = (await challenged.json()) as Record<string, unknown>;
    expect(typeof proven.ownerProof).toBe("string");

    // `/health` is the name the launchd wrapper and mac-process-watch poll,
    // and it answers 200 on the same terms.
    const plain = await fetch(`${base}/health`);
    expect(plain.status).toBe(200);
    expect(((await plain.json()) as Record<string, unknown>).booting).toBe(true);

    // 2. Nothing else answers with half-built state.
    const bots = await fetch(`${base}/api/bots`);
    expect(bots.status).toBe(503);
    expect(await bots.json()).toEqual({ error: "booting" });
    expect((await fetch(`${base}/api/config`)).status).toBe(503);

    // 3. Release the probe that is holding the registry load, and the same
    //    port serves the whole route table — no rebind, no dropped socket.
    writeFileSync(probeGate, "release");
    await expect
      .poll(async () => (await health()).body.ready, { timeout: 120_000, interval: 500 })
      .toBe(true);
    const ready = await health();
    expect(ready.body).toMatchObject({ app: "botfleet", booting: false, ready: true });
    expect((await fetch(`${base}/api/bots`)).status, stderr).toBe(200);
  }, 300_000);
});
