#!/usr/bin/env node
// Fake of the ZCode CLI's headless `--prompt ... --output-format stream-json`
// surface, for driver contract tests of server/drivers/zcode.ts. Prints the
// vendor's stream-json line shapes (session-mapper.ts / prompt-command.ts):
// one JSON event per line, closed by a single {type:"result"} terminator.
// Failure modes mirror how the real CLI misbehaves:
//
//   FAKE_ZCODE_MODE   happy (default) | tool | turn-error | exit-early
//   FAKE_ZCODE_DUMP   path to append {argv, env} JSON, so a test can assert
//                     argv shape and env hygiene (no leaked API keys).

import { appendFileSync } from "node:fs";

import type { JsonObject } from "../schema.ts";

const mode = process.env.FAKE_ZCODE_MODE ?? "happy";
const argv = process.argv.slice(2);

if (process.env.FAKE_ZCODE_DUMP) {
  appendFileSync(
    process.env.FAKE_ZCODE_DUMP,
    JSON.stringify({
      argv,
      env: {
        // Presence only: a leaked vendor key must never reach the dump file.
        Z_AI_API_KEY: process.env.Z_AI_API_KEY !== undefined,
        GLM_API_KEY: process.env.GLM_API_KEY !== undefined,
        BIGMODEL_API_KEY: process.env.BIGMODEL_API_KEY !== undefined,
        FAKE_ZCODE_MODE: process.env.FAKE_ZCODE_MODE ?? null,
      },
    }) + "\n",
  );
}

if (argv.includes("--version")) {
  process.stdout.write("zcode 3.17.1\n");
  process.exit(0);
}

const argValue = (name: string) => {
  const idx = argv.indexOf(name);
  return idx === -1 ? null : argv[idx + 1] ?? null;
};

const sessionId = argValue("--resume") ?? "zs-fake-1";
const write = (obj: JsonObject) => process.stdout.write(JSON.stringify(obj) + "\n");
const stream = (payload: JsonObject) =>
  write({ type: "model.streaming", sessionId, turnId: "zt-1", seq: 1, timestamp: 1, payload });

switch (mode) {
  case "no-trailing-newline": {
    stream({ kind: "text_delta", delta: "Tail" });
    write({ type: "turn.completed", sessionId, turnId: "zt-1", payload: {} });
    // The result line arrives without its trailing newline: the driver must
    // drain the final buffer on close instead of dropping the turn.
    process.stdout.write(JSON.stringify({
      type: "result",
      sessionId,
      turnId: "zt-1",
      response: "Tail",
      usage: { inputTokens: 5, outputTokens: 2 },
      projection: { status: "idle", turnCount: 1, totalTokenCount: 7, contextUsed: null, contextWindow: null },
    }));
    process.exit(0);
    break;
  }
  case "tool-no-ids":
    write({
      type: "tool.updated",
      sessionId,
      turnId: "zt-1",
      payload: { kind: "started", toolName: "read_file", input: { path: "a.ts" } },
    });
    write({
      type: "tool.updated",
      sessionId,
      turnId: "zt-1",
      payload: { kind: "result", toolName: "read_file", output: "file body" },
    });
    write({
      type: "result",
      sessionId,
      turnId: "zt-1",
      response: "done",
      usage: { inputTokens: 7, outputTokens: 1 },
      projection: { status: "idle", turnCount: 1, totalTokenCount: 8, contextUsed: null, contextWindow: null },
    });
    process.exit(0);
    break;
  case "exit-early":
    process.stderr.write("zcode: catastrophic startup failure\n");
    process.exit(1);
    break;
  case "turn-error":
    stream({ kind: "text_delta", delta: "partial" });
    write({ type: "turn.failed", sessionId, turnId: "zt-1", payload: { message: "model exploded" } });
    process.exit(1);
    break;
  case "tool":
    stream({ kind: "text_delta", delta: "Let me check. " });
    write({
      type: "tool.updated",
      sessionId,
      turnId: "zt-1",
      payload: { kind: "started", toolCallId: "call-1", toolName: "read_file", input: { path: "a.ts" } },
    });
    write({
      type: "tool.updated",
      sessionId,
      turnId: "zt-1",
      payload: { kind: "result", toolCallId: "call-1", toolName: "read_file", output: "file body" },
    });
    stream({ kind: "text_delta", delta: "It says hi." });
    write({ type: "turn.completed", sessionId, turnId: "zt-1", payload: {} });
    write({
      type: "result",
      sessionId,
      turnId: "zt-1",
      response: "Let me check. It says hi.",
      usage: { inputTokens: 30, outputTokens: 9 },
      eventCount: 5,
      projection: { status: "idle", turnCount: 1, totalTokenCount: 39, contextUsed: null, contextWindow: null },
    });
    process.exit(0);
    break;
  default:
    stream({ kind: "text_delta", delta: "Hello" });
    stream({ kind: "text_delta", delta: " from zcode" });
    write({ type: "turn.completed", sessionId, turnId: "zt-1", payload: {} });
    write({
      type: "result",
      sessionId,
      turnId: "zt-1",
      response: "Hello from zcode",
      usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 4 },
      eventCount: 3,
      projection: { status: "idle", turnCount: 1, totalTokenCount: 19, contextUsed: null, contextWindow: null },
    });
    process.exit(0);
}
