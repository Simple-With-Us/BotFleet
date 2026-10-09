// The permission-prompt proxy the Claude CLI spawns.  Auto-review matches each
// ask to the step the CLI already showed by the tool_use id, so the proxy has
// to carry that id to the broker; without it every asked step on a held turn
// was reviewed twice, once as a step and once at the card.
import type { ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { removeTempDir, spawnDetached, waitForExit } from "./testing/cleanup.ts";

const PROXY = join(dirname(fileURLToPath(import.meta.url)), "permission-proxy.ts");
const posixOnly = describe.skipIf(process.platform === "win32");

let child: ChildProcess | undefined;
let broker: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (child) await waitForExit(child, { signal: "SIGTERM" });
  const open = broker;
  if (open) await new Promise<void>((resolve) => open.close(() => resolve()));
  if (dir) await removeTempDir(dir);
  child = undefined;
  broker = undefined;
  dir = undefined;
});

/** Run the proxy against a stand-in broker; resolves with the ask it sent. */
async function askThroughProxy(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  dir = mkdtempSync(join(tmpdir(), "omb-pp-"));
  const socketPath = join(dir, "p.sock");
  const ask = new Promise<Record<string, unknown>>((resolve) => {
    broker = createServer((conn: Socket) => {
      let buffered = "";
      conn.on("data", (chunk) => {
        buffered += chunk;
        const line = buffered.split("\n").find((candidate) => candidate.trim());
        if (!line) return;
        // SAFETY: the line is the proxy's own JSON object frame, which this test reads only for its `id`.
        const message = JSON.parse(line) as Record<string, unknown>;
        // answer, so the proxy's tool call completes
        conn.write(JSON.stringify({ t: "answer", id: message.id, behavior: "deny", message: "no" }) + "\n");
        resolve(message);
      });
    });
  });
  await new Promise<void>((resolve) => broker?.listen(socketPath, resolve));
  child = spawnDetached(process.execPath, [PROXY, socketPath], { stdio: ["pipe", "pipe", "ignore"] });
  child.stdin?.write(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "approve", arguments: args } }) + "\n",
  );
  return ask;
}

posixOnly("permission proxy", () => {
  it("carries the tool_use id of the call being asked about to the broker", async () => {
    const ask = await askThroughProxy({ tool_name: "Bash", input: { command: "ls" }, tool_use_id: "toolu_abc" });
    expect(ask).toMatchObject({ t: "ask", tool: "Bash", input: { command: "ls" }, toolUseId: "toolu_abc" });
  });

  it("sends no id when the CLI named none", async () => {
    const ask = await askThroughProxy({ tool_name: "Bash", input: { command: "ls" } });
    expect(ask).toMatchObject({ t: "ask", tool: "Bash" });
    expect(ask.toolUseId).toBeUndefined();
  });
});
