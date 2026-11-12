// The simple-chat MCP fixture's own contract.
//
// The fixture stands in for the fleet's simple-chat entry, and the launch-seat
// test registers it the way the owner registers it in ~/.minimax/mcp.json.
// Two things about it are load-bearing and neither is obvious from reading it:
//
//   - the entry must find its seat in BOTH argument forms.  A caller can write
//     `--default-seat MM` or `--default-seat=MM`,  and a fixture that read only
//     the first would resolve to nothing and exit,  so the handshake would get
//     no answer at all:  the exact failure the fixture exists to remove.
//   - an entry that names no seat must serve nothing,  because falling back to
//     some default would sign the turn as a seat nobody launched it for.
//
// The fixture is spawned rather than imported,  because importing it would
// start the server:  these cases are about what the process does,  not about
// what a function returns.

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "simple-chat-mcp.mjs");

/** Ask the fixture to initialize, and report whether it answered. */
function initialize(args: string[], timeoutMs = 5000): Promise<{ answered: boolean; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [FIXTURE, "mcp", ...args], {
      // The seat the launcher bound comes from the environment,  so an
      // inherited AGENT_SEAT would answer the cases that mean to test the
      // entry's own argument.  The environment is rebuilt here rather than
      // inherited,  so the fixture sees only what the case gives it.
      env: {
        PATH: "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
      },
    });
    let out = "";
    let stderr = "";
    let answered = false;
    // The entry may exit before the case is finished with it,  and a write to
    // a closed pipe is an error the case did not cause.  It is swallowed here
    // so the file reports the assertion's result and not the pipe's.
    child.stdin.on("error", () => {});
    const send = (line: string) => {
      try {
        child.stdin.write(line);
      } catch {
        // The entry is already gone;  the assertions say whether that was
        // expected.
      }
    };
    const finish = (code: number | null) => {
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ answered, stderr, code });
    };
    const timer = setTimeout(() => finish(child.exitCode), timeoutMs);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1 && message.result) answered = true;
        } catch {
          // A partial line is not a message yet.
        }
      }
      if (answered) {
        send(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("exit", (code) => finish(code));
    send(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } })}\n`);
  });
}

describe("the simple-chat MCP fixture", () => {
  it("serves when the seat is named in the separate-token form", async () => {
    const result = await initialize(["--default-seat", "MM"]);
    expect(result.answered).toBe(true);
  });

  it("serves when the seat is named in the equals form", async () => {
    // The form a caller writes as one argument.  A fixture that read only the
    // separate-token form resolves to nothing here and exits,  and the
    // handshake gets no answer.
    const result = await initialize(["--default-seat=MM"]);
    expect(result.answered).toBe(true);
  });

  it("serves nothing when no seat is named", async () => {
    const result = await initialize([]);
    expect(result.answered).toBe(false);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("no seat named");
  });
});
