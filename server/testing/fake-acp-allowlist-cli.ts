#!/usr/bin/env node
// A scripted ACP engine for the routine allowlist tests
// (server/drivers/acp/allowlist-core.test.ts).  It behaves the way Grok
// Build 1.0.50 was observed to on this Mac:  it advertises a blocking
// `pre_tool_use` client hook, asks the hook before every tool, runs shell
// commands through `terminal/create` wrapped as `bash -lc '<command>'` when
// the client offers a terminal, and writes and reads files through
// `fs/write_text_file` and `fs/read_text_file` when the client offers them.
//
//   FAKE_AL_STEPS     JSON list of steps to run during session/prompt:
//                     {type:"shell", command} | {type:"write", path, content}
//                     | {type:"read", path} | {type:"mcp", name}
//                     | {type:"permission", kind, rawInput, options}
//                     | {type:"raw-terminal", command, args?, cwd?}
//                     | {type:"raw-write", path, content} | {type:"hook-foreign"}
//                     | {type:"bypass", name}
//   FAKE_AL_DUMP      path:  written with what the client sent and answered
//   FAKE_AL_NO_HOOKS  "1":  initialize advertises no client hooks
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

/** One JSON-RPC message or step:  this fake reads whatever the client sends,
 *  so its messages stay untyped. */
type Json = any;

/** What the fake records for the test to read. */
interface Dump {
  argv: string[];
  env: { AGENT_LAUNCH_SEAT: string | null };
  results: Json[];
  clientCapabilities?: Json;
  sessionMeta?: Json;
  mcpServers?: Json;
}

const steps: Json[] = JSON.parse(process.env.FAKE_AL_STEPS ?? "[]");
const dumpPath = process.env.FAKE_AL_DUMP;
const dump: Dump = { argv: process.argv.slice(2), env: { AGENT_LAUNCH_SEAT: process.env.AGENT_LAUNCH_SEAT ?? null }, results: [] };
const save = () => {
  if (dumpPath) writeFileSync(dumpPath, JSON.stringify(dump, null, 2));
};
save();

if (process.argv.includes("--version")) {
  console.log("grok 1.0.50 (fake)");
  process.exit(0);
}

let nextId = 1_000;
const pending = new Map<number, (msg: Json) => void>();
const out = (msg: Json) => process.stdout.write(JSON.stringify(msg) + "\n");
const call = (method: string, params: Json) =>
  new Promise<Json>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });
const notify = (update: Json) => out({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-al", update } });

let hookId: string | undefined;
let callCount = 0;

const quote = (command: string) => `'${command.replaceAll("'", `'"'"'`)}'`;

async function hook(toolName: string, toolUseId: string, toolInput: Json, callbackId = hookId) {
  const answer = await call("_x.ai/hooks/run", {
    hookCallbackId: callbackId,
    hookEventName: "pre_tool_use",
    sessionId: "fake-al",
    toolName,
    toolUseId,
    toolInput,
    toolInputTruncated: false,
  });
  return answer.result ?? {};
}

async function runStep(step: Json): Promise<Json> {
  const id = `call-${++callCount}`;
  switch (step.type) {
    case "shell": {
      notify({ sessionUpdate: "tool_call", toolCallId: id, title: "run_terminal_command", kind: "execute", rawInput: { command: step.command } });
      const decision = await hook("run_terminal_command", id, { command: step.command });
      if (decision.decision === "deny") {
        notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
        return { step: step.type, hook: "deny" };
      }
      notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress" });
      const created = await call("terminal/create", { sessionId: "fake-al", command: `/bin/bash -lc ${quote(step.command)}`, cwd: process.cwd(), outputByteLimit: 40_000 });
      if (created.error) {
        notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
        return { step: step.type, hook: "allow", terminal: "refused", message: created.error.message };
      }
      const terminalId = created.result.terminalId;
      const exit = await call("terminal/wait_for_exit", { sessionId: "fake-al", terminalId });
      const output = await call("terminal/output", { sessionId: "fake-al", terminalId });
      await call("terminal/release", { sessionId: "fake-al", terminalId });
      notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
      return { step: step.type, hook: "allow", exit: exit.result, output: output.result?.output };
    }
    case "write": {
      notify({ sessionUpdate: "tool_call", toolCallId: id, title: "write", kind: "edit", rawInput: { file_path: step.path } });
      const decision = await hook("write", id, { file_path: step.path, content: step.content });
      if (decision.decision === "deny") return { step: step.type, hook: "deny" };
      const written = await call("fs/write_text_file", { sessionId: "fake-al", path: step.path, content: step.content });
      notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: written.error ? "failed" : "completed" });
      return { step: step.type, hook: "allow", write: written.error ? "refused" : "ok" };
    }
    case "read": {
      const decision = await hook("read_file", id, { target_file: step.path });
      if (decision.decision === "deny") return { step: step.type, hook: "deny" };
      const read = await call("fs/read_text_file", { sessionId: "fake-al", path: step.path });
      return { step: step.type, hook: "allow", read: read.error ? "refused" : read.result?.content };
    }
    case "mcp": {
      notify({ sessionUpdate: "tool_call", toolCallId: id, title: "use_tool", kind: "other", rawInput: { tool_name: step.name, tool_input: {} } });
      const decision = await hook(step.name, id, { tool_name: step.name, tool_input: {} });
      return { step: step.type, hook: decision.decision === "deny" ? "deny" : "allow" };
    }
    case "hook-foreign": {
      const decision = await hook("run_terminal_command", id, { command: "/usr/bin/true" }, "someone-else");
      return { step: step.type, hook: decision.decision === "deny" ? "deny" : "allow" };
    }
    case "permission": {
      const answer = await call("session/request_permission", {
        sessionId: "fake-al",
        toolCall: { toolCallId: id, kind: step.kind, rawInput: step.rawInput ?? {} },
        options: step.options ?? [
          { optionId: "allow-always", kind: "allow_always", name: "Always" },
          { optionId: "allow-once", kind: "allow_once", name: "Once" },
          { optionId: "reject-always", kind: "reject_always", name: "Never" },
          { optionId: "reject-once", kind: "reject_once", name: "No" },
        ],
      });
      return { step: step.type, outcome: answer.result?.outcome };
    }
    case "raw-terminal": {
      const params: Json = { sessionId: "fake-al", command: step.command };
      if (step.args) params.args = step.args;
      if (step.cwd) params.cwd = step.cwd;
      const created = await call("terminal/create", params);
      if (created.error) return { step: step.type, terminal: "refused" };
      const exit = await call("terminal/wait_for_exit", { sessionId: "fake-al", terminalId: created.result.terminalId });
      const output = await call("terminal/output", { sessionId: "fake-al", terminalId: created.result.terminalId });
      return { step: step.type, terminal: "ran", exit: exit.result, output: output.result?.output };
    }
    case "raw-write": {
      const written = await call("fs/write_text_file", { sessionId: "fake-al", path: step.path, content: step.content });
      return { step: step.type, write: written.error ? "refused" : "ok" };
    }
    case "bypass": {
      // The engine ran a tool on its own:  no hook, straight to completed.
      notify({ sessionUpdate: "tool_call", toolCallId: id, title: step.name, kind: "other", _meta: { "x.ai/tool": { name: step.name } } });
      notify({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", _meta: { "x.ai/tool": { name: step.name } } });
      return { step: step.type };
    }
    default:
      return { step: step.type, error: "unknown step" };
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const msg: Json = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    const resolve = pending.get(msg.id);
    pending.delete(msg.id);
    resolve?.(msg);
    return;
  }
  switch (msg.method) {
    case "initialize":
      dump.clientCapabilities = msg.params?.clientCapabilities ?? null;
      save();
      out({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          // where Grok 1.0.50 advertises its client hooks
          agentCapabilities: {
            loadSession: true,
            _meta: process.env.FAKE_AL_NO_HOOKS === "1" ? {} : { "x.ai/hooks": { blockingEvents: ["pre_tool_use", "stop"], decisions: ["deny", "block"] } },
          },
          authMethods: [{ id: "cached_token" }],
        },
      });
      return;
    case "authenticate":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "session/new":
    case "session/load": {
      dump.sessionMeta = msg.params?._meta ?? null;
      dump.mcpServers = msg.params?.mcpServers ?? null;
      hookId = msg.params?._meta?.["x.ai/hooks"]?.pre_tool_use?.[0]?.hookCallbackIds?.[0];
      save();
      out({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-al" } });
      return;
    }
    case "session/set_model":
      out({ jsonrpc: "2.0", id: msg.id, result: {} });
      return;
    case "session/prompt": {
      for (const step of steps) {
        dump.results.push(await runStep(step));
        save();
      }
      notify({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
      out({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
      return;
    }
    case "session/cancel":
      return;
    default:
      if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  }
});
