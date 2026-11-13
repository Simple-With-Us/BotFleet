#!/usr/bin/env node
// Fake of the Antigravity `agy` CLI's print-mode stdio surface, for driver
// tests of drivers/antigravity.ts. On `--version` it prints a version; on a
// print-mode invocation (`--print <prompt> … --output-format stream-json`) it
// reads the prompt from the `--print` ARGV value (the real CLI does NOT read a
// piped prompt in print mode), then emits a canned NDJSON turn: init → tool
// step (ACTIVE then DONE) → agent_response step with usage → result with
// status SUCCESS. Deterministic, no network.
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_AGY_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
}
// SIGTERM is how the driver stops a turn: killCliTree signals the whole
// process group.  Recording that it arrived is how a test tells a child that
// was killed from one that was merely ignored and left running behind a turn
// the person was already told had ended.
if (process.env.FAKE_AGY_KILLED_MARKER) {
  const killedMarker = process.env.FAKE_AGY_KILLED_MARKER;
  process.on("SIGTERM", () => {
    try {
      writeFileSync(killedMarker, "sigterm");
    } catch {}
    process.exit(143);
  });
}
if (process.env.FAKE_AGY_READY_FILE) {
  writeFileSync(process.env.FAKE_AGY_READY_FILE, "ready");
}
if (process.env.FAKE_AGY_DUMP) {
  writeFileSync(process.env.FAKE_AGY_DUMP, JSON.stringify({ argv, env: process.env }, null, 2));
}
if (argv.includes("--version")) {
  console.log("1.1.12");
  process.exit(0);
}

const delayMs = Number(process.env.FAKE_AGY_DELAY_MS ?? 0);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
if (process.env.FAKE_AGY_MCP_DUMP) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  let config = "null";
  try {
    config = readFileSync(join(home, ".gemini", "config", "mcp_config.json"), "utf8");
  } catch {}
  writeFileSync(process.env.FAKE_AGY_MCP_DUMP, config);
}

// FAKE_AGY_BURST=1 holds every line back and writes the whole turn as one
// stdout chunk, so the driver parses all of it in a single synchronous pass.
// That is the shape that shows whether a refusal at the init event really
// stops the rest of the stream, rather than merely winning a race with the
// next chunk to arrive.
const burst = process.env.FAKE_AGY_BURST === "1";
let burstBuf = "";
const out = (obj: unknown) => {
  const line = JSON.stringify(obj) + "\n";
  if (burst) burstBuf += line;
  else process.stdout.write(line);
};
const flush = () => {
  if (!burstBuf) return;
  const pending = burstBuf;
  burstBuf = "";
  process.stdout.write(pending);
};
const CONV = "conv-fake-123";

// The Tool Execution Policy agy reports on its init event.  The real CLI
// reports one of `always-proceed`, `request-review`, `strict` or
// `proceed-in-sandbox` here; `accept-edits` is a `--mode` value on a different
// axis and never appears in this field.  Default to `request-review`, agy's
// shipped default, so a plain turn is not a turn the driver has to refuse.
// FAKE_AGY_PERMISSION_MODE=omit drops the key entirely, for the driver's
// unreported-policy path.
const permissionMode = process.env.FAKE_AGY_PERMISSION_MODE ?? "request-review";
const initPolicy: Record<string, string> = permissionMode === "omit" ? {} : { permission_mode: permissionMode };

// A host-control turn is refused at the init event, and the only way a test
// can see that the refusal beat the tool is if something separates the two.
// The real CLI takes an LLM round trip there; a fake that emits init and its
// first tool in the same tick could never tell a working gate from a broken
// one.  FAKE_AGY_INIT_HOLD_MS is that gap: hold it long enough and a killed
// child provably never reaches the marker below.
const initHoldMs = Number(process.env.FAKE_AGY_INIT_HOLD_MS ?? 0);
const holdAfterInit = async () => {
  if (Number.isFinite(initHoldMs) && initHoldMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, initHoldMs));
  }
};
// Written immediately before the first tool step: "the tool ran".  A turn the
// driver stopped at init must leave no such file behind.
const markToolRan = () => {
  if (process.env.FAKE_AGY_TOOL_MARKER) writeFileSync(process.env.FAKE_AGY_TOOL_MARKER, "ran");
};

// Failure shapes the real agy produces, for the driver's error-mapping tests.
// FAKE_AGY_RESULT_ERROR: emit init, then one `result` with status ERROR and
// this text — how agy reports a provider quota, a failed eligibility check,
// and its own "timeout waiting for response".
// FAKE_AGY_DIE: exit with this code after writing FAKE_AGY_STDERR (if any)
// and no NDJSON at all — a crash, or the silent EOF of an exit-0 no-op.
// FAKE_AGY_LEAK_STDOUT: hand stdout to a detached grandchild that outlives
// this process, so the driver's `close` never fires and only `exit` does.
// writeSync: a piped stderr is async, and process.exit below would drop it.
if (process.env.FAKE_AGY_STDERR) writeSync(2, process.env.FAKE_AGY_STDERR);
if (process.env.FAKE_AGY_DIE) process.exit(Number(process.env.FAKE_AGY_DIE));

// Transient-failure script for the retry tests, the same shape
// fake-claude-cli uses.  FAKE_AGY_TRANSIENTS is how many launches die with
// 503-shaped stderr; the launch count lives in a state FILE because a child
// cannot mutate its parent's environment.  Once the quota is spent the turn
// runs normally, so one test asserts "failed twice, then answered once".
// FAKE_AGY_PARTIAL_FAILS streams a step first and THEN dies, which the
// replay-safety guard must refuse to retry.
let agyFailAfterStep = false;
if (process.env.FAKE_AGY_TRANSIENTS && process.env.FAKE_AGY_STATE) {
  let launched = 0;
  try {
    launched = Number(readFileSync(process.env.FAKE_AGY_STATE, "utf8")) || 0;
  } catch {}
  const quota = Number(process.env.FAKE_AGY_TRANSIENTS) || 0;
  writeFileSync(process.env.FAKE_AGY_STATE, String(launched + 1));
  if (launched < quota) {
    if (process.env.FAKE_AGY_PARTIAL_FAILS) {
      agyFailAfterStep = true;
    } else {
      writeSync(2, "agy: HTTP 503 service temporarily unavailable\n");
      process.exit(5);
    }
  }
}

// The prompt is the value that follows --print or -p on argv, or read from stdin.
const printIdx = argv.indexOf("--print") !== -1 ? argv.indexOf("--print") : argv.indexOf("-p");
let prompt = printIdx !== -1 && argv[printIdx + 1] && !argv[printIdx + 1].startsWith("-") ? argv[printIdx + 1] : undefined;
if (!prompt && !process.stdin.isTTY) {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (raw) prompt = raw;
  } catch {}
}
if (!prompt) process.exit(0);

if (process.env.FAKE_AGY_LEAK_STDOUT) {
  // The grandchild inherits this process's stdout pipe and keeps it open
  // after this process is gone — the real shape of an agy-spawned MCP server
  // that outlives its parent.
  const { spawn } = await import("node:child_process");
  spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], {
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  }).unref();
  process.exit(0);
}

if (process.env.FAKE_AGY_RESULT_ERROR) {
  out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: [], ...initPolicy } });
  out({
    event: "result",
    conversation_id: CONV,
    result: {
      conversation_id: CONV,
      status: "ERROR",
      response: "",
      error: process.env.FAKE_AGY_RESULT_ERROR,
      duration_seconds: 1,
      num_turns: 1,
      usage: { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 },
    },
  });
  flush();
  process.exit(0);
}

out({ event: "init", conversation_id: CONV, init: { cwd: process.cwd(), tools: ["run_command", "write_to_file"], ...initPolicy } });
await holdAfterInit();
if (agyFailAfterStep) {
  // A tool step the person has already seen, and only then the transport
  // failure: the driver must NOT relaunch this one.
  markToolRan();
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
  flush();
  writeSync(2, "agy: HTTP 503 service temporarily unavailable\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.exit(5);
}
markToolRan();
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
// FAKE_AGY_TOOL_HOLD_MS: the tool step stays ACTIVE and the stream goes
// completely silent for this long — a build or test run that prints nothing
// — before it reports DONE.  A hold longer than the driver's tool window is
// a wedged tool, which the driver must stop as a stall.
const toolHoldMs = Number(process.env.FAKE_AGY_TOOL_HOLD_MS ?? 0);
if (Number.isFinite(toolHoldMs) && toolHoldMs > 0) {
  flush();
  await new Promise((resolve) => setTimeout(resolve, toolHoldMs));
}
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 0, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
out({ event: "result", conversation_id: CONV, result: { conversation_id: CONV, status: "SUCCESS", response: "done from fake agy", duration_seconds: 1, num_turns: 1, usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 0, cache_read_tokens: 5, total_tokens: 125 } } });
if (process.env.FAKE_AGY_TRAILING_AFTER_RESULT === "1") {
  // Same buffered stdout chunk as `result`: no timer or process-exit race.
  out({ event: "step_update", conversation_id: CONV, step_update: { conversation_id: CONV, step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: {} } } });
}
flush();
const postResultDelayMs = Number(process.env.FAKE_AGY_POST_RESULT_DELAY_MS ?? 0);
if (Number.isFinite(postResultDelayMs) && postResultDelayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, postResultDelayMs));
}
process.exit(0);
