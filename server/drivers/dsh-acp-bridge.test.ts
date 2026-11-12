import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir } from "../testing/cleanup.ts";
import { createPatchCleanup, dshMcpPatchPaths, rewriteAcpNdjsonLine } from "./dsh-acp-bridge.ts";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "dsh-acp-bridge.ts");

describe("rewriteAcpNdjsonLine", () => {
  it("zeros non-empty mcpServers on session/new, resume, and load", () => {
    for (const method of ["session/new", "session/resume", "session/load"]) {
      const rewritten = JSON.parse(
        rewriteAcpNdjsonLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method,
            params: { cwd: "/tmp", sessionId: "s1", mcpServers: [{ name: "computer", command: "/cua" }] },
          }),
        ),
      );
      expect(rewritten.params.mcpServers).toEqual([]);
      expect(rewritten.params.cwd).toBe("/tmp");
    }
  });

  it("leaves unrelated frames and empty mcpServers untouched", () => {
    const initialize = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}';
    expect(rewriteAcpNdjsonLine(initialize)).toBe(initialize);
    const empty = '{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}';
    expect(rewriteAcpNdjsonLine(empty)).toBe(empty);
    expect(rewriteAcpNdjsonLine("not-json")).toBe("not-json");
  });
});

describe("dshMcpPatchPaths", () => {
  it("only collects BotFleet-owned --patch overlays", () => {
    expect(
      dshMcpPatchPaths(["--profile", "acp", "--patch", "/tmp/botfleet-dsh-mcp-1.yml", "--patch", "/tmp/user.yml"]),
    ).toEqual(["/tmp/botfleet-dsh-mcp-1.yml"]);
  });
});

describe("createPatchCleanup", () => {
  it("is safe when error and exit both fire", () => {
    const patch = "/tmp/botfleet-dsh-mcp-overlay.yml";
    const removed: string[] = [];
    const cleanup = createPatchCleanup([patch], (path, cb) => {
      removed.push(path);
      cb(null);
    });
    const child = new EventEmitter();
    child.on("error", cleanup);
    child.on("exit", cleanup);
    expect(() => {
      child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }));
      child.emit("exit", 1, null);
    }).not.toThrow();
    expect(removed).toEqual([patch]);
  });

  it("takes the private directory the overlay was written into, and nothing else", () => {
    const owned = "/tmp/botfleet-dsh-mcp-AbC123/botfleet-dsh-mcp-overlay.yml";
    const legacy = "/tmp/botfleet-dsh-mcp-overlay.yml";
    const removedDirs: string[] = [];
    createPatchCleanup(
      [owned, legacy],
      (_path, cb) => cb(null),
      (path, cb) => {
        removedDirs.push(path);
        cb(null);
      },
    )();
    // The overlay's own 0700 directory goes with it; the shared temp root an
    // older build wrote straight into never does.
    expect(removedDirs).toEqual(["/tmp/botfleet-dsh-mcp-AbC123"]);
  });
});

describe("dsh-acp-bridge process", () => {
  let child: ChildProcessWithoutNullStreams | null = null;
  let scratch = "";

  afterEach(async () => {
    child?.kill("SIGKILL");
    child = null;
    if (scratch) await removeTempDir(scratch);
    scratch = "";
  });

  it("lets session/new succeed against a child that rejects non-empty mcpServers", async () => {
    scratch = mkdtempSync(join(tmpdir(), "botfleet-dsh-bridge-"));
    const fake = join(scratch, "reject-mcp.mjs");
    writeFileSync(
      fake,
      `import readline from "node:readline";
const seen = [];
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== "session/new") return;
  seen.push(msg.params.mcpServers);
  if (msg.params.mcpServers.length > 0) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "mcpServers is not supported" } }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "ok", seen } }) + "\\n");
});
`,
    );
    chmodSync(fake, 0o755);
    child = spawn(process.execPath, ["--experimental-strip-types", BRIDGE, "--", process.execPath, fake], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "session/new",
        params: {
          cwd: "/tmp",
          mcpServers: [{ name: "computer", command: "/opt/cua-driver", args: ["mcp"], env: [] }],
        },
      })}\n`,
    );
    const reply = await Promise.race([
      new Promise<string>((resolve, reject) => {
        lines.once("line", (line) => resolve(line));
        lines.once("error", reject);
      }),
      once(child, "exit").then(([code]) => {
        throw new Error(`bridge exited ${String(code)}`);
      }),
    ]);
    expect(JSON.parse(reply)).toMatchObject({
      id: 1,
      result: { sessionId: "ok", seen: [[]] },
    });
  });

  it("exits cleanly when sent SIGTERM without hanging or leaking the process", async () => {
    scratch = mkdtempSync(join(tmpdir(), "botfleet-dsh-bridge-"));
    const fake = join(scratch, "sleep.mjs");
    writeFileSync(
      fake,
      `import readline from "node:readline";
readline.createInterface({ input: process.stdin });
setInterval(() => {}, 10_000);
`,
    );
    chmodSync(fake, 0o755);
    child = spawn(process.execPath, ["--experimental-strip-types", BRIDGE, "--", process.execPath, fake], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGTERM");
    const [code, signal] = await Promise.race([
      once(child, "exit"),
      new Promise<[never, never]>((_, reject) =>
        setTimeout(() => reject(new Error("bridge failed to exit within timeout after SIGTERM")), 4000),
      ),
    ]);
    expect(signal === "SIGTERM" || code !== null).toBe(true);
    child = null;
  });
});
