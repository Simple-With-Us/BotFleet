#!/usr/bin/env node
// Fake of the claude CLI's stream-json surface, for driver tests.
// Reads the prompt from stdin (one stream-json line), then plays a
// scripted session. Failure modes are toggled by env var, mirroring how
// the real thing misbehaves:
//
//   FAKE_CLAUDE_MODE   happy (default) | exit-early | hang | malformed | quota
//                      | stream (partial-message text deltas before the
//                        whole-message frame, plus subagent noise to drop)
//                      | api-error (a real Anthropic API failure shaped like
//                        production BOTFLEET-K events: is_error true,
//                        terminal_reason "api_error", but a stale
//                        stop_reason "stop_sequence" left over from the CLI's
//                        result-builder — the regression case for trusting
//                        stop_reason over terminal_reason on a failed turn)
//                      | model-not-found (the CLI's answer to a model id it
//                        cannot use, shaped like production frames: a
//                        synthetic assistant frame with zero usage and a
//                        top-level error "model_not_found", then a result
//                        frame with is_error true, terminal_reason
//                        "api_error" and api_error_status 404)
//                      | model-not-found-text (the same, from a CLI that
//                        drops the `error` field: only the synthetic model
//                        and the text name the rejection)
//                      | model-404 (a bare 404 result frame, no assistant
//                        frame at all)
//                      | model-lookalike (a REAL reply, with real usage, whose
//                        prose opens with the rejection words: a success that
//                        must stay an ordinary assistant message)
//                      | ghost-turn (after the first turn settles, the CLI
//                        starts a turn of its own: a background task's
//                        notification, text, a tool step, a second result)
//                      | ghost-running (the same, still running: no result)
//                      | ghost-queued (a result for the CLI's own turn
//                        arrives first, with this turn's message still queued)
//                      | helpers (a native subagent's frames, each carrying
//                        parent_tool_use_id)
//   FAKE_CLAUDE_DUMP   path to write {argv, env, prompt, mcpConfig} as JSON,
//                      so the test can assert on argv shape and env hygiene.
//                      mcpConfig is read back from the --mcp-config file the
//                      way the real CLI reads it — the driver writes it to a
//                      private temp file and deletes it when the turn settles,
//                      so a test cannot open it after the fact.
//   FAKE_CLAUDE_AUTH   in (default) | out | unsupported | malformed |
//                      inherited-api-key | hang — what `auth status` reports
//                      (hang: never answers, so the probe runs out of time)
//   FAKE_CLAUDE_QUOTA_GATE  optional file whose creation releases quota mode,
//                           so integration tests can queue work before settle
//   FAKE_CLAUDE_REPLY  optional successful assistant text for prose-boundary tests
//   FAKE_CLAUDE_PROMPTS  optional path; every user message this process reads
//                        from stdin is appended as one JSON line, so a test
//                        can see what a REUSED process was sent (the dump
//                        above records only the launch)
//
// Keep this file dependency-free — it runs as a bare `node` subprocess.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// The dump is read by a separate process that only knows the file exists.
// A plain writeFileSync creates the file and then fills it, so a reader that
// polls existsSync() can open it mid-write and get truncated JSON — the
// "Unexpected end of JSON input" flake.  Writing a sibling temp file and
// renaming it into place makes the swap atomic: a reader sees either no file
// or the whole thing.  The temp name carries the pid so two fake CLIs sharing
// one dump path cannot clobber each other's partial write.
const writeFileAtomic = (path: string, body: string): void => {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
};

const mode = process.env.FAKE_CLAUDE_MODE ?? "happy";

const argv = process.argv.slice(2);
const argAfter = (flag: string): string | null => {
  const i = argv.indexOf(flag);
  return i === -1 ? null : (argv[i + 1] ?? null);
};

const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

// Snapshot probes: both answer on argv alone and exit without reading stdin.
if (argv[0] === "--version") {
  process.stdout.write(`${process.env.FAKE_CLAUDE_VERSION ?? "2.1.232 (Claude Code)"}\n`);
  process.exit(0);
}

if (argv[0] === "--help") {
  if (process.env.FAKE_CLAUDE_HELP_PROBES) appendFileSync(process.env.FAKE_CLAUDE_HELP_PROBES, "probe\n");
  if (process.env.FAKE_CLAUDE_HELP === "hang") {
    // A busy Mac: no answer before the driver's deadline kills this.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    process.exit(0);
  }
  process.stdout.write(process.env.FAKE_CLAUDE_HELP === "unsupported" ? "Usage: claude\n" : "  --strict-mcp-config  Only load explicit MCP servers\n");
  process.exit(0);
}

if (argv[0] === "auth" && argv[1] === "status") {
  const auth = process.env.FAKE_CLAUDE_AUTH ?? "in";
  if (auth === "hang") {
    // A busy Mac: no answer before the driver's deadline kills this.
    await new Promise((resolve) => setTimeout(resolve, 60_000));
    process.exit(0);
  }
  if (auth === "unsupported") {
    process.stderr.write("error: unknown command 'auth'\n");
    process.exit(1);
  }
  if (auth === "malformed") {
    process.stdout.write("not json\n");
    process.exit(0);
  }
  const loggedIn = auth === "in" || (auth === "inherited-api-key" && Boolean(process.env.ANTHROPIC_API_KEY));
  process.stdout.write(
    JSON.stringify({ loggedIn, authMethod: loggedIn ? "claude.ai" : "none", apiProvider: "firstParty" }) + "\n",
    () => process.exit(auth === "out" ? 1 : 0),
  );
}

// One-shot helper mode used by generateText/reviewPermission. The prompt is
// deliberately read from stdin so sensitive review text never appears in
// argv or process listings.
if (argAfter("--output-format") === "text") {
  const prompt = await new Promise<string>((resolve) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => resolve(input));
  });
  if (process.env.FAKE_CLAUDE_DUMP) {
    writeFileAtomic(
      process.env.FAKE_CLAUDE_DUMP,
      JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, mcpConfig: null }, null, 2),
    );
  }
  process.stdout.write("fake generated text\n");
  process.exit(0);
}

// Line-driven, like the real CLI under --input-format stream-json: each user
// message starts a turn; a message that arrives WHILE a turn is playing is
// folded into it (the real CLI delivers it before the next model call — the
// harness calls that a steer); the process stays alive with stdin open and
// exits only when stdin ends. `slow` leaves a gap between the tool result
// and the reply so a test can steer into it.
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
const sessionId = argAfter("--resume") ?? argAfter("--session-id") ?? "fake-session";
const model = argAfter("--model") ?? "claude-fake";
let dumped = false;
let turnRunning = false;
let steered: string[] = [];
let stdinEnded = false;

// The harness delivers out-of-band context (the volatile half of the system
// prompt — drivers/prompt-split.ts) as a leading <system-reminder> block
// inside the user turn.  The real CLI reads that block as context, not as
// the message, so the echo below replies to the text after it: a test that
// asserts on the reply sees the user's words, never the harness's note.
const stripSystemReminder = (text: string): string =>
  text.replace(/^<system-reminder>\n[\s\S]*?\n<\/system-reminder>(?:\n\n|$)/, "");

const promptText = (prompt: JsonValue): string => {
  const m = prompt && typeof prompt === "object" && !Array.isArray(prompt) ? (prompt as { message?: { content?: unknown } }).message : undefined;
  return typeof m?.content === "string" ? stripSystemReminder(m.content) : "";
};

const finishIfDone = () => {
  if (stdinEnded && !turnRunning) process.exit(0);
};

// A turn the CLI starts on its own once the first turn has settled, in the
// shape the jobs panel's live probe of 2.1.284 recorded: a task_notification,
// a second init, the model's text and a tool step, then a second result whose
// origin is the notification.  `ghost-running` stops before that result — the
// CLI is still busy with its own turn when the next message would arrive.
let ghostPlayed = false;
const playGhostTurn = () => {
  out({
    type: "system",
    subtype: "task_notification",
    task_id: "bg-task-1",
    tool_use_id: "tu-bg-1",
    status: "completed",
    output_file: "/tmp/bg-task-1.output",
    summary: 'Background command "sleep 4; echo bgdone" completed (exit code 0)',
  });
  out({ type: "system", subtype: "init", session_id: sessionId, model, tools: ["Bash", "Task"] });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "GHOST DELTA" } } });
  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "GHOST TEXT" },
        { type: "tool_use", id: "ghost-tu-1", name: "Bash", input: { command: "cat /tmp/bg-task-1.output" } },
      ],
      usage: { input_tokens: 40, cache_read_input_tokens: 0, output_tokens: 6 },
    },
  });
  out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "ghost-tu-1", is_error: false, content: "bgdone" }] } });
  if (mode === "ghost-turn") {
    out({
      type: "result",
      is_error: false,
      stop_reason: "end_turn",
      result: "finished",
      total_cost_usd: 0.02,
      origin: { kind: "task-notification", producer: "session-task" },
      queued_turn_count: 0,
      result_index: 1,
      usage: { input_tokens: 40, cache_read_input_tokens: 0, output_tokens: 6 },
    });
  }
};

const playTurn = (prompt: JsonValue) => {
  turnRunning = true;
  steered = [];
  if (!dumped && process.env.FAKE_CLAUDE_DUMP) {
    dumped = true;
    const configPath = argAfter("--mcp-config");
    let mcpConfig: unknown = null;
    if (configPath) {
      try {
        mcpConfig = JSON.parse(readFileSync(configPath, "utf8"));
      } catch {
        /* leave null — the test will see it */
      }
    }
    writeFileAtomic(process.env.FAKE_CLAUDE_DUMP, JSON.stringify({ pid: process.pid, argv, env: process.env, prompt, mcpConfig }, null, 2));
  }

  if (mode === "exit-early") {
    process.stderr.write("fake-claude: simulated crash before result\n");
    process.exit(3);
  }
  // transient-failure script for retry tests. FAKE_CLAUDE_TRANSIENTS is how
  // many launches fail transiently (503-shaped stderr, exit 5); the count of
  // launches so far lives in a state FILE because child processes cannot
  // mutate the parent's environment. When the quota is exhausted (or
  // FAKE_CLAUDE_STATE is unset) the turn completes normally.
  // FAKE_CLAUDE_PARTIAL_FAILS makes the FIRST launch emit a text delta
  // before failing — the partial-output guard must forbid retrying it.
  if (process.env.FAKE_CLAUDE_TRANSIENTS && process.env.FAKE_CLAUDE_STATE) {
    let launched = 0;
    try {
      launched = Number(readFileSync(process.env.FAKE_CLAUDE_STATE, "utf8")) || 0;
    } catch {}
    const quota = Number(process.env.FAKE_CLAUDE_TRANSIENTS) || 0;
    writeFileSync(process.env.FAKE_CLAUDE_STATE, String(launched + 1));
    out({ type: "system", subtype: "init", session_id: sessionId, model });
    if (launched < quota) {
      if (process.env.FAKE_CLAUDE_PARTIAL_FAILS) {
        out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half an answer" } } });
      }
      // FAKE_CLAUDE_TOOL_FAILS makes the failing launch emit a tool_use frame
      // first — the produced-output guard must forbid retrying it (E2): the
      // relaunch would replay the user message and re-run the tool.
      if (process.env.FAKE_CLAUDE_TOOL_FAILS) {
        out({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_fake_fail", name: "Bash", input: { command: "echo ran" } }] } });
      }
      process.stderr.write("claude: API error (503): service temporarily unavailable\n");
      process.exit(5);
    }
  }

  // the real CLI re-announces init on every turn of a live process
  out({ type: "system", subtype: "init", session_id: sessionId, model });

  if (mode === "hang") {
    // stay alive until killed — lets tests exercise interrupt + the
    // permission broker while a turn is officially in flight
    setInterval(() => {}, 1_000);
    return;
  }

  if (mode === "malformed") {
    process.stdout.write("this is not json\n{broken\n");
  }

  if (mode === "quota") {
    const finishQuota = () => {
      out({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "You've hit your session limit · resets in 30 minutes" }],
          usage: { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 1 },
        },
      });
      out({
        type: "result",
        is_error: false,
        stop_reason: "end_turn",
        total_cost_usd: 0,
        usage: { input_tokens: 3, cache_read_input_tokens: 0, output_tokens: 1 },
      });
      turnRunning = false;
      finishIfDone();
    };
    const gate = process.env.FAKE_CLAUDE_QUOTA_GATE;
    if (gate && !existsSync(gate)) {
      const timer = setInterval(() => {
        if (!existsSync(gate)) return;
        clearInterval(timer);
        finishQuota();
      }, 10);
    } else {
      finishQuota();
    }
    return;
  }

  if (mode === "api-error") {
    // No assistant/tool_use frame first: production samples show
    // duration_api_ms: 0 — the request never got a real model response, it
    // failed before one arrived. subtype stays "success" and stop_reason
    // stays the stale "stop_sequence" the same way the real CLI's result
    // builder does; only terminal_reason + api_error_status name the actual
    // cause.
    out({
      type: "result",
      is_error: true,
      subtype: "success",
      stop_reason: "stop_sequence",
      terminal_reason: "api_error",
      api_error_status: 429,
      num_turns: 1,
      total_cost_usd: 0,
    });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "model-not-found" || mode === "model-not-found-text" || mode === "model-404") {
    const rejection =
      `There's an issue with the selected model (${model}). It may not exist or you may not have access to it. ` +
      "Run /model to pick a different model.";
    const synthetic = {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text: rejection }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    };
    // the structural marker; the text-only mode is a CLI that drops it
    if (mode === "model-not-found") out({ type: "assistant", error: "model_not_found", message: synthetic });
    if (mode === "model-not-found-text") out({ type: "assistant", message: synthetic });
    const failure = {
      type: "result",
      is_error: true,
      subtype: "success",
      stop_reason: "stop_sequence",
      terminal_reason: "api_error",
      api_error_status: 404,
      duration_api_ms: 0,
      num_turns: 1,
      total_cost_usd: 0,
    };
    out(mode === "model-404" ? failure : { ...failure, result: rejection });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "model-lookalike") {
    out({
      type: "assistant",
      message: {
        model: "claude-fake",
        content: [{ type: "text", text: "There's an issue with the selected model dropdown: it listed stale ids, so I fixed the filter." }],
        usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 18 },
      },
    });
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.01, usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 18 } });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "helpers") {
    // A native helper (subagent) at work, shaped like 2.1.284's stream: the
    // bot calls Task, every helper frame carries parent_tool_use_id naming
    // that call, and the Task's own tool_result comes back at the top level.
    out({
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "task-1", name: "Task", input: { description: "Survey files", prompt: "look around", subagent_type: "Explore" } }],
        usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 4 },
      },
    });
    out({
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: {
        content: [
          { type: "text", text: "HELPER NARRATION" },
          { type: "tool_use", id: "helper-read-1", name: "Read", input: { file_path: "/tmp/helper-target.txt" } },
        ],
        usage: { input_tokens: 999, cache_read_input_tokens: 0, output_tokens: 99 },
      },
    });
    out({
      type: "user",
      parent_tool_use_id: "task-1",
      message: { content: [{ type: "tool_result", tool_use_id: "helper-read-1", is_error: false, content: "file body" }] },
    });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "task-1", is_error: false, content: "helper report" }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "all done" }], usage: { input_tokens: 12, cache_read_input_tokens: 0, output_tokens: 3 } } });
    out({ type: "result", is_error: false, stop_reason: "end_turn", total_cost_usd: 0.02, usage: { input_tokens: 22, cache_read_input_tokens: 0, output_tokens: 7 } });
    turnRunning = false;
    finishIfDone();
    return;
  }

  if (mode === "ghost-queued") {
    // The race the driver must survive: the CLI had started a turn of its
    // own (a background task's notification) when this message arrived, so
    // the message waits in its queue and the CLI's own result comes first.
    out({
      type: "result",
      is_error: false,
      stop_reason: "end_turn",
      result: "ghost reply",
      total_cost_usd: 0.03,
      origin: { kind: "task-notification" },
      queued_turn_count: 1,
      result_index: 0,
      usage: { input_tokens: 50, cache_read_input_tokens: 0, output_tokens: 9 },
    });
  }

  if (mode === "stream") {
    const delta = (d: unknown) => out({ type: "stream_event", event: { type: "content_block_delta", delta: d } });
    delta({ type: "thinking_delta", thinking: "hmm" });
    delta({ type: "text_delta", text: "hello from " });
    delta({ type: "text_delta", text: "fake claude" });
    // subagent narration — the driver must drop this, not render it
    out({
      type: "stream_event",
      parent_tool_use_id: "task-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "SUBAGENT NOISE" } },
    });
  }

  out({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: process.env.FAKE_CLAUDE_REPLY ?? "hello from fake claude" },
        // FAKE_CLAUDE_TOOL_IO gives the step real arguments and a real result, the
        // way the CLI reports them, so a test can follow them into the harness's
        // input/output side store (the default step carries neither)
        { type: "tool_use", id: "tu-1", name: "Bash", ...(process.env.FAKE_CLAUDE_TOOL_IO ? { input: { command: "echo hi", stdin: "TAIL-INPUT-MARKER" } } : {}) },
      ],
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    },
  });
  out({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          is_error: false,
          ...(process.env.FAKE_CLAUDE_TOOL_IO
            ? { content: [{ type: "text", text: `head line\n${"p".repeat(400)}\nTAIL-OUTPUT-MARKER the key is api_key=ak9999999999999999999999999999999 as printed` }] }
            : {}),
        },
      ],
    },
  });

  const finish = () => {
    const result = {
      type: "result",
      is_error: false,
      stop_reason: "end_turn",
      total_cost_usd: 0.01,
      usage: { input_tokens: 10, cache_read_input_tokens: 2, output_tokens: 5 },
    };
    // 2.1.284 names where each turn came from; the ghost modes need the
    // newer shape, every other mode keeps the older one with no origin.
    out(mode.startsWith("ghost-") ? { ...result, origin: { kind: "human" }, queued_turn_count: 0 } : result);
    turnRunning = false;
    if (!ghostPlayed && (mode === "ghost-turn" || mode === "ghost-running")) {
      ghostPlayed = true;
      setTimeout(playGhostTurn, 50);
    }
    finishIfDone();
  };
  if (mode === "slow") {
    // a gap a test can steer into; the closing reply carries anything that
    // was folded in, the way the real CLI includes a mid-turn message in
    // the same turn's next model call
    setTimeout(() => {
      const tail = steered.length ? ` + steered: ${steered.join(" | ")}` : "";
      out({ type: "assistant", message: { content: [{ type: "text", text: `reply to: ${promptText(prompt)}${tail}` }] } });
      finish();
    }, 800);
  } else {
    finish();
  }
};

let buf = "";
process.stdin.on("data", (c) => {
  buf += c;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let prompt: JsonValue = null;
    try {
      prompt = JSON.parse(line);
    } catch {
      continue;
    }
    if (process.env.FAKE_CLAUDE_PROMPTS) appendFileSync(process.env.FAKE_CLAUDE_PROMPTS, JSON.stringify({ pid: process.pid, prompt }) + "\n");
    if (turnRunning) steered.push(promptText(prompt));
    else playTurn(prompt);
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  finishIfDone();
});
