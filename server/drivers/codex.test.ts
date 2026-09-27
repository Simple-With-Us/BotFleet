// Codex driver contract tests, run against the scripted fake app-server
// in server/testing/fake-codex-app-server.ts — the driver must drive the
// JSON-RPC handshake, normalize notifications into canonical events, and
// surface server->client approval requests as request.opened.
//
// The fake is a shebang script — the same constraint codex.cmd itself
// hits on Windows. resolveCliSpawn covers both, so these run everywhere.
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CodexDriver } from "./codex.ts";
import { removeTempDir } from "../testing/cleanup.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-codex-app-server.ts");

describe("CodexDriver.decodeConfig", () => {
  it("defaults to the codex binary with fullAuto off", () => {
    expect(CodexDriver.decodeConfig({})).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig(undefined)).toEqual({ cli: "codex", fullAuto: false });
    expect(CodexDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
    // anything non-true is off — a truthy string must not enable full auto
    expect(CodexDriver.decodeConfig({ fullAuto: "yes" }).fullAuto).toBe(false);
  });
});

/** What the fake app-server writes to FAKE_CODEX_DUMP.  `calls` is every
 * JSON-RPC method the driver sent, in order, with its params. */
interface FakeDump {
  calls: Array<{ method: string; params: { sandbox?: string; approvalPolicy?: string } }>;
  decision: unknown;
}

/** The params the thread was STARTED with.  A codex sandbox and approval
 * policy are fixed at `thread/start`, so this is the only place that says
 * whether a turn was really brokered. */
const startParams = (dump: FakeDump): FakeDump["calls"][number]["params"] => {
  const started = dump.calls.find((c) => c.method === "thread/start");
  if (!started) throw new Error("the fake app-server was never asked to start a thread");
  return started.params;
};

describe("CodexDriver turns (fake app-server)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let scratch: string;

  const create = async (
    opts: { mode?: string; fullAuto?: boolean; environment?: Record<string, string> } = {},
  ) => {
    if (opts.mode) process.env.FAKE_CODEX_MODE = opts.mode;
    instance = await CodexDriver.create({
      instanceId: "codex-test",
      displayName: "Codex Test",
      environment: opts.environment ?? {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: opts.fullAuto ?? false },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    chmodSync(FAKE_CLI, 0o755);
    scratch = mkdtempSync(join(tmpdir(), "omb-codex-test-"));
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_MODE;
    delete process.env.FAKE_CODEX_DUMP;
    delete process.env.FAKE_CODEX_TRANSIENTS;
    delete process.env.FAKE_CODEX_PARTIAL_FAILS;
    delete process.env.FAKE_CODEX_STATE;
    delete process.env.FAKE_CODEX_RETRY_SCALE;
    delete process.env.OPENAI_API_KEY;
    delete process.env.BOX_TOKEN;
    delete process.env.OMB_TTS_KEY;
    recorder?.stop();
    await instance?.dispose();
    await removeTempDir(scratch);
  });

  it("runs the handshake and normalizes a full turn", async () => {
    await create();
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    // workspace credentials the harness may hold (env-injected at boot by
    // the desktop shell) must never ride into the CLI child
    process.env.BOX_TOKEN = "box-should-not-leak";
    process.env.OMB_TTS_KEY = "tts-should-not-leak";

    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "list files",
      system: "You are Testy.",
      model: "gpt-5.6-sol",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // commandExecution ls -la
      "item.started", // webSearch BotFleet
      "item.completed", // commandExecution done
      "item.completed", // webSearch done
      "content.delta",
      "item.completed", // assistant_text
      "thread.token-usage.updated",
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "codex")).toBe(true);
    expect(recorder.events.find((e) => e.type === "session.started")).toMatchObject({
      sessionId: "codex-thread-1",
      model: "fake-codex-model",
    });
    expect(recorder.events.find((e) => e.type === "thread.token-usage.updated")).toMatchObject({
      input: 7,
      output: 3,
      cachedInput: 4,
    });
    expect(recorder.events.filter((event) => event.itemId === "w1")).toMatchObject([
      { type: "item.started", itemType: "tool", title: "web_search" },
      { type: "item.completed", itemType: "tool", ok: true },
    ]);
    // codex reports the THREAD total; the driver turns it into this turn's
    // figure so the harness never sums a running total
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 7, output: 3, cachedInput: 4 } });

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.env.OPENAI_API_KEY).toBeUndefined();
    expect(seen.env.BOX_TOKEN).toBeUndefined();
    expect(seen.env.OMB_TTS_KEY).toBeUndefined();
    const methods = seen.calls.map((c: { method: string }) => c.method);
    expect(methods).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    // persona rides in front of the prompt text — codex has no system slot
    const turnStart = seen.calls.at(-1);
    expect(turnStart.params.input[0].text).toBe("You are Testy.\n\nlist files");
    const threadStart = seen.calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({ model: "gpt-5.6-sol", modelProvider: "openai" });
  });

  it("keeps the full command when a Windows interpreter prefix is long", async () => {
    await create({ mode: "windows-command" });
    await instance.adapter.sendTurn({ threadId: "t-windows-command", text: "read notes" });

    const command = [
      "\"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\"",
      "-Command",
      `\"Get-Content -Raw -LiteralPath 'C:\\Users\\Ada\\workspaces\\${"very-long-folder\\".repeat(8)}NOTES.md'\"`,
    ].join(" ");
    expect(command.length).toBeGreaterThan(200);
    const opened = await recorder.until((event) => event.type === "request.opened");
    expect(recorder.events.find((event) => event.type === "item.started")).toMatchObject({
      type: "item.started",
      title: command,
    });
    expect(opened).toMatchObject({ requestType: "permission", summary: command });

    await instance.adapter.respondToRequest("t-windows-command", opened.requestId!, { behavior: "allow" });
    await recorder.until((event) => event.type === "turn.completed");
  });

  it("uses the instance environment for the Codex process", async () => {
    const codexHome = join(scratch, "custom-codex-home");
    await create({ environment: { CODEX_HOME: codexHome } });
    const dump = join(scratch, "environment.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-environment", text: "hi" });
    await recorder.until((event) => event.type === "turn.completed");

    expect(JSON.parse(readFileSync(dump, "utf8")).env.CODEX_HOME).toBe(codexHome);
  });

  it("mounts connected apps without placing credential values in argv", async () => {
    await create();
    const dump = join(scratch, "composio.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.composioMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-composio",
      text: "check mail",
      integrations: {
        composio: {
          command: process.execPath,
          args: ["/tmp/connector-proxy.js"],
          env: {
            OMB_CONNECTOR_UPSTREAM_URL: "http://127.0.0.1:8799/api/internal/connectors/mcp",
            OMB_COMMS_TOKEN: "per-boot-token",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.botfleet_connectors.command");
    expect(seen.argv.join(" ")).toContain("OMB_COMMS_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("per-boot-token");
    expect(seen.env.OMB_COMMS_TOKEN).toBe("per-boot-token");
  });

  it("mounts peer-agent comms without placing the comms token in argv", async () => {
    await create();
    const dump = join(scratch, "agents.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-agents",
      text: "ask the researcher",
      integrations: {
        agents: {
          command: process.execPath,
          args: ["/tmp/agents-proxy.js"],
          env: {
            ELECTRON_RUN_AS_NODE: "1",
            OMB_HARNESS_URL: "http://127.0.0.1:8799",
            OMB_BOT_ID: "captain",
            OMB_THREAD_ID: "t-agents",
            OMB_COMMS_TOKEN: "peer-comms-secret",
            OMB_TURN_DEPTH: "0",
          },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.agents.command");
    expect(seen.argv.join(" ")).toContain("/tmp/agents-proxy.js");
    expect(seen.argv.join(" ")).toContain("OMB_COMMS_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("peer-comms-secret");
    expect(seen.env.OMB_COMMS_TOKEN).toBe("peer-comms-secret");
    expect(instance.adapter.capabilities.agentsMcp).toBe(true);
  });

  it("mounts the Local VM computer MCP server without placing credentials in argv", async () => {
    await create();
    const dump = join(scratch, "local-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;
    expect(instance.adapter.capabilities.computerMcp).toBe(true);

    await instance.adapter.sendTurn({
      threadId: "t-local-computer",
      text: "open the browser",
      integrations: {
        localComputer: {
          command: process.execPath,
          args: ["/tmp/container-mcp.js", "podman", "botfleet-computer", "/run/cua.sock"],
          env: { ELECTRON_RUN_AS_NODE: "1", OMB_VM_TOKEN: "vm-secret" },
        },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("/tmp/container-mcp.js");
    expect(seen.argv.join(" ")).toContain("OMB_VM_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("vm-secret");
    expect(seen.env.OMB_VM_TOKEN).toBe("vm-secret");
  });

  it("mounts the remote computer proxy without placing its token in argv", async () => {
    await create();
    const dump = join(scratch, "remote-computer.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-remote-computer",
      text: "take a screenshot",
      integrations: {
        computer: { boxId: "box-123", token: "remote-secret" },
      },
    });
    await recorder.until((event) => event.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv.join(" ")).toContain("mcp_servers.computer.command");
    expect(seen.argv.join(" ")).toContain("computer-proxy");
    expect(seen.argv.join(" ")).toContain("OGB_BOX_TOKEN");
    expect(seen.argv.join(" ")).not.toContain("remote-secret");
    expect(seen.env.OGB_BOX_ID).toBe("box-123");
    expect(seen.env.OGB_BOX_TOKEN).toBe("remote-secret");
  });

  it("sends the local provider when the picker id is custom-encoded", async () => {
    await create({ environment: { UNSLOTH_STUDIO_AUTH_TOKEN: "unsloth-secret" } });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;
    await instance.adapter.sendTurn({
      threadId: "t-local",
      text: "hi",
      model: "unsloth::Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
    });
    await recorder.until((e) => e.type === "turn.completed");
    const threadStart = JSON.parse(readFileSync(dump, "utf8")).calls.find((c: { method: string }) => c.method === "thread/start");
    expect(threadStart.params).toMatchObject({
      model: "Qwen3.6-35B-A3B-bf16:qwen3-5-6-n-r-reasoning",
      modelProvider: "unsloth",
    });
    const seen = JSON.parse(readFileSync(dump, "utf8"));
    expect(seen.argv).toContain("model_providers.unsloth.base_url=\"http://127.0.0.1:8888/v1\"");
    expect(JSON.stringify(seen.argv)).not.toContain("unsloth-secret");
    expect(seen.env.BOTFLEET_LOCAL_UNSLOTH_API_KEY).toBe("unsloth-secret");
  });

  it("streams agentMessage deltas without re-emitting the settled text", async () => {
    process.env.FAKE_CODEX_MODE = "stream";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-stream", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const text = recorder.events.filter(
      (e: any) => e.type === "content.delta" && e.streamKind === "assistant_text",
    );
    // the two streamed chunks only — no third whole-message fallback delta
    expect(text.map((d: any) => d.delta)).toEqual(["done from ", "fake codex"]);
    const settled = recorder.events.filter(
      (e: any) => e.type === "item.completed" && e.itemType === "assistant_text",
    );
    expect(settled).toHaveLength(1);
    expect((settled[0] as any).text).toBe("done from fake codex");
  });

  it("tries thread/resume with a cursor and reuses the thread id", async () => {
    await create({ mode: "resume" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume", text: "again", resumeCursor: "codex-thread-9" });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-9" });
    await recorder.until((e) => e.type === "turn.completed");

    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  it("fails closed when a saved Codex thread cannot be resumed", async () => {
    await create(); // fake rejects thread/resume outside resume mode
    const dump = join(scratch, "resume-failed.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-resume-failed", text: "go", resumeCursor: "gone-thread" });
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(done).toMatchObject({ ok: false, stopReason: "resume_failed" });
    expect(recorder.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(recorder.events.filter((event) => event.type === "runtime.error")).toHaveLength(1);
    expect(recorder.events.find((event) => event.type === "runtime.error")?.message).toMatch(
      /saved Codex session could not be resumed/i,
    );
    expect(recorder.events.some((event) => event.type === "session.started")).toBe(false);
    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((call: { method: string }) => call.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
    expect(methods).not.toContain("turn/start");
  });

  it("rebuilds on a fresh thread when resume fails before accept and recoveryText is attached", async () => {
    await create(); // fake rejects thread/resume outside resume mode with missing-native shape
    const dump = join(scratch, "resume-recovered.json");
    process.env.FAKE_CODEX_DUMP = dump;

    const recoveryText = "[rebuild]\n\nUser: my dog is Biscuit\n\nwhat now?";
    await instance.adapter.sendTurn({
      threadId: "t-resume-recovered",
      text: "what now?",
      resumeCursor: "gone-thread",
      recoveryText,
    });
    const started = await recorder.until((e) => e.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-1", rebuilt: true });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((c: { method: string }) => c.method);
    expect(methods).toContain("thread/resume");
    expect(methods).toContain("thread/start");
    expect(methods).toContain("turn/start");
    const turnStart = JSON.parse(readFileSync(dump, "utf8")).calls.find((c: { method: string }) => c.method === "turn/start");
    expect(JSON.stringify(turnStart.params)).toContain("my dog is Biscuit");
  });

  it("keeps the rebuilt prompt across a transient failure after missing-session recovery", async () => {
    const dump = join(scratch, "rebuild-retry.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_STATE = join(scratch, "rebuild-launches");
    process.env.FAKE_CODEX_TRANSIENTS = "1";
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create(); // thread/resume rejects with the native missing-session error

    await instance.adapter.sendTurn({
      threadId: "t-rebuild-retry",
      text: "what now?",
      system: "You are Testy.",
      resumeCursor: "gone-thread",
      recoveryText: "[rebuild]\n\nUser: my dog is Biscuit\n\nwhat now?",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.ok === true);

    expect(recorder.events.filter((event) => event.type === "turn.retrying")).toHaveLength(1);
    expect(recorder.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    const sessions = recorder.events.filter((event) => event.type === "session.started");
    expect(sessions).toHaveLength(2);
    expect(sessions.every((event) => event.rebuilt === true)).toBe(true);
    const first = JSON.parse(readFileSync(`${dump}.attempt-0`, "utf8")).calls;
    const second = JSON.parse(readFileSync(`${dump}.attempt-1`, "utf8")).calls;
    expect(first.map((call: { method: string }) => call.method)).toContain("thread/resume");
    // The second process must not resume the original missing session or
    // fall back to the current text on its new empty native thread.
    expect(second.map((call: { method: string }) => call.method)).not.toContain("thread/resume");
    expect(second.map((call: { method: string }) => call.method)).toContain("thread/start");
    expect(second.find((call: { method: string }) => call.method === "turn/start").params.input[0].text).toBe(
      "You are Testy.\n\n[rebuild]\n\nUser: my dog is Biscuit\n\nwhat now?",
    );
  }, 20_000);

  it("retries a transient resume against the same saved Codex thread", async () => {
    const dump = join(scratch, "resume-retry.json");
    process.env.FAKE_CODEX_DUMP = dump;
    process.env.FAKE_CODEX_STATE = join(scratch, "resume-launches");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create({ mode: "resume-transient" });

    await instance.adapter.sendTurn({
      threadId: "t-resume-retry",
      text: "continue",
      resumeCursor: "codex-thread-preserved",
    });
    await recorder.until((event) => event.type === "turn.completed" && event.ok === true);

    expect(recorder.events.filter((event) => event.type === "turn.retrying")).toHaveLength(1);
    const started = recorder.events.find((event) => event.type === "session.started");
    expect(started).toMatchObject({ sessionId: "codex-thread-preserved" });
    expect(recorder.events.filter((event) => event.type === "turn.started")).toHaveLength(1);
    const methods = JSON.parse(readFileSync(dump, "utf8")).calls.map((call: { method: string }) => call.method);
    expect(methods).toContain("thread/resume");
    expect(methods).not.toContain("thread/start");
  });

  it("fails visibly when transient Codex resume retries are exhausted", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "9";
    process.env.FAKE_CODEX_STATE = join(scratch, "resume-exhausted-launches");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create({ mode: "resume-transient" });

    await instance.adapter.sendTurn({
      threadId: "t-resume-exhausted",
      text: "continue",
      resumeCursor: "codex-thread-preserved",
    });
    const error = await recorder.until((event) => event.type === "runtime.error");
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(recorder.events.filter((event) => event.type === "turn.retrying")).toHaveLength(2);
    expect(error).toMatchObject({ message: expect.stringMatching(/503: upstream capacity exceeded/) });
    expect(done).toMatchObject({ ok: false, stopReason: "resume_failed" });
    expect(recorder.events.some((event) => event.type === "session.started")).toBe(false);
  });

  it("classifies authentication rejected during Codex resume as setup", async () => {
    await create({ mode: "resume-unauthorized" });

    await instance.adapter.sendTurn({
      threadId: "t-resume-auth",
      text: "continue",
      resumeCursor: "codex-thread-preserved",
    });
    const error = await recorder.until((event) => event.type === "runtime.error");
    const done = await recorder.until((event) => event.type === "turn.completed");

    expect(error).toMatchObject({ setup: true });
    expect(error).toMatchObject({ message: expect.stringMatching(/401 Unauthorized/) });
    expect(done).toMatchObject({ ok: false, stopReason: "auth_required" });
    expect(recorder.events.some((event) => event.type === "session.started")).toBe(false);
  });

  it("surfaces an approval request and forwards the user's decision", async () => {
    await create({ mode: "approval" });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-approve", text: "clean up" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ requestType: "permission", tool: "shell", summary: "rm -rf scratch" });

    await instance.adapter.respondToRequest("t-approve", opened.requestId!, { behavior: "allow" });
    const resolved = await recorder.until((e) => e.type === "request.resolved");
    expect(resolved).toMatchObject({ behavior: "allow", source: "user" });

    await recorder.until((e) => e.type === "turn.completed");
    // legacy method name → legacy decision vocabulary
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ decision: "approved" });
  });

  it("answers Codex 0.149 MCP elicitation with the MCP result shape", async () => {
    await create({ mode: "mcp-elicitation" });
    const dump = join(scratch, "mcp-elicitation.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-mcp-elicitation", text: "list bots" });
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({
      requestType: "permission",
      tool: "list_bots",
      summary: 'Allow the agents MCP server to run tool "list_bots"?',
    });

    await instance.adapter.respondToRequest("t-mcp-elicitation", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");
    expect(JSON.parse(readFileSync(dump, "utf8")).decision).toEqual({ action: "accept", content: {} });
  });

  it("stamps approvalScope on cards only when the turn controls this Mac", async () => {
    await create({ mode: "approval" });

    // host-mounted: every card carries the scope that keeps the harness's
    // local-computer-block backstop in force for remembered always-allows
    await instance.adapter.sendTurn({
      threadId: "t-host-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: "/cua-driver", args: ["mcp"], env: {}, platform: "darwin", scope: "local-computer" },
      },
    });
    const host = await recorder.until((e) => e.type === "request.opened");
    expect(host).toMatchObject({ approvalScope: "local-computer" });
    await instance.adapter.respondToRequest("t-host-scope", host.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");

    // a Local VM mount is not the host: no scope stamped
    await instance.adapter.sendTurn({
      threadId: "t-vm-scope",
      text: "clean up",
      integrations: {
        localComputer: { command: process.execPath, args: ["/tmp/container-mcp.js"], env: {} },
      },
    });
    const vm = await recorder.until((e) => e.type === "request.opened" && e.threadId === "t-vm-scope");
    expect((vm as { approvalScope?: string }).approvalScope).toBeUndefined();
    await instance.adapter.respondToRequest("t-vm-scope", vm.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-vm-scope");
  });

  it("auto-approves commands in fullAuto without opening a request", async () => {
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-auto", text: "clean up" });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    const written = JSON.parse(readFileSync(dump, "utf8")) as FakeDump;
    expect(written.decision).toEqual({ decision: "approved" });
    // and the yolo switch is still real for everything that is not this Mac
    expect(startParams(written)).toMatchObject({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  it("brokers a full-auto turn that controls this Mac, and asks anyway", async () => {
    // A full-auto instance keeps its yolo switch for everything else, but a
    // turn that can click on the person's own desktop runs brokered: the
    // thread is started inside workspace-write with approvals on-request, so
    // every ask reaches the harness and the bot's Auto policy, the
    // destructive and sensitive guards, and the unattended block decide.
    // That is what `localComputerMcp: true` promises in server/contracts.ts,
    // and what lets a full-auto bot mount this computer at all.  The ACP
    // core and claude drivers already did this; codex computed
    // `controlsHost` and spent it only on tagging the card's scope, so a
    // full-auto Codex bot with This Computer acted on the Mac with no card
    // and no decision-log row.  Reached from a room as well as a 1:1 chat
    // since the room lane started resolving computers.
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "host-dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-host-brokered",
      text: "clean up",
      integrations: {
        localComputer: { command: "/cua-driver", args: ["mcp"], env: {}, platform: "darwin", scope: "local-computer" },
      },
    });

    // THE assertion: a card, from an instance whose config says full auto.
    const opened = await recorder.until((e) => e.type === "request.opened");
    expect(opened).toMatchObject({ approvalScope: "local-computer" });
    await instance.adapter.respondToRequest("t-host-brokered", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");

    // and the sandbox the thread was STARTED in matches, because that is
    // fixed at thread/start and no later ask can loosen it
    expect(startParams(JSON.parse(readFileSync(dump, "utf8")) as FakeDump)).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("does not broker an isolated computer, which carries no host scope", async () => {
    // The Local VM and a VPS also arrive as `localComputer`, and a full-auto
    // bot is meant to keep running unattended inside them.  Only a mount
    // carrying `scope: "local-computer"` is the person's own desktop.
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "vm-dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-vm-fullauto",
      text: "clean up",
      integrations: { localComputer: { command: process.execPath, args: ["/tmp/container-mcp.js"], env: {} } },
    });
    await recorder.until((e) => e.type === "turn.completed");

    expect(recorder.events.some((e) => e.type === "request.opened")).toBe(false);
    expect(startParams(JSON.parse(readFileSync(dump, "utf8")) as FakeDump)).toMatchObject({
      sandbox: "danger-full-access",
      approvalPolicy: "never",
    });
  });

  it("will not resume a thread it cannot prove was started brokered", async () => {
    // `thread/resume` keeps the sandbox and approval policy the thread was
    // STARTED with, so resuming a thread started full-auto would quietly
    // hand a host-control turn danger-full-access and approvalPolicy
    // "never" — no cards at all, the exact hole the brokered path closes.
    // The cost is one lost codex-side continuation per harness restart, for
    // full-auto bots that also hold this computer.
    // `approval` rather than `resume`: the fake answers `thread/resume` with
    // "no such thread" in this mode, so if the brokered turn ever reached
    // for the cursor the turn would fail instead of opening a card.
    await create({ mode: "approval", fullAuto: true });
    const dump = join(scratch, "resume-dump.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({
      threadId: "t-host-resume",
      text: "carry on",
      resumeCursor: "codex-thread-started-full-auto",
      integrations: {
        localComputer: { command: "/cua-driver", args: ["mcp"], env: {}, platform: "darwin", scope: "local-computer" },
      },
    });
    const opened = await recorder.until((e) => e.type === "request.opened");
    await instance.adapter.respondToRequest("t-host-resume", opened.requestId!, { behavior: "allow" });
    await recorder.until((e) => e.type === "turn.completed");

    const written = JSON.parse(readFileSync(dump, "utf8")) as FakeDump;
    expect(written.calls.some((c) => c.method === "thread/resume")).toBe(false);
    expect(startParams(written)).toMatchObject({
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
    });
  });

  it("rejects a second turn while one is in flight", async () => {
    await create({ mode: "approval" }); // approval mode parks the turn open
    await instance.adapter.sendTurn({ threadId: "t-busy", text: "one" });
    await recorder.until((e) => e.type === "request.opened");
    await expect(instance.adapter.sendTurn({ threadId: "t-busy", text: "two" })).rejects.toThrow(/already running/);
    await instance.adapter.interruptTurn("t-busy");
    await recorder.until((e) => e.type === "turn.completed");
  });

  it("a missing binary surfaces as a failed turn, and snapshot says unavailable", async () => {
    instance = await CodexDriver.create({
      instanceId: "codex-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: join(scratch, "does-not-exist"), fullAuto: false },
    });
    recorder = recordEvents(instance.adapter);

    await instance.adapter.sendTurn({ threadId: "t-missing", text: "go" });
    const done = await recorder.until((e) => e.type === "turn.completed");
    expect(done).toMatchObject({ ok: false });
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
  });

  it("reports whether the installed Codex CLI is signed in", async () => {
    await create();
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });

    await instance.dispose();
    recorder.stop();
    await create({ mode: "logged-out" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: false,
    });
  });

  it("also accepts login status from older Codex versions that used stdout", async () => {
    await create({ mode: "logged-in-stdout" });
    await expect(instance.snapshot()).resolves.toMatchObject({
      state: "available",
      authenticated: true,
    });
  });

  it("marks a Codex 401 as setup so the UI offers sign-in instead of Retry", async () => {
    await create({ mode: "unauthorized" });
    await instance.adapter.sendTurn({ threadId: "t-unauthorized", text: "hi" });

    const error = await recorder.until((event) => event.type === "runtime.error");
    expect(error).toMatchObject({ setup: true });
    await expect(recorder.until((event) => event.type === "turn.completed")).resolves.toMatchObject({
      ok: false,
      stopReason: "auth_required",
    });
  });

  it("auto-retries a transient turn/start failure, then completes with one final message", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-retry", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.ok === true);

    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
    expect(retries.every((e) => e.delayMs > 0 && typeof e.reason === "string")).toBe(true);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    // exactly one settled reply across all three app-server launches
    const replies = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(replies).toHaveLength(1);
  }, 20_000);

  it("stops retrying at the attempt cap and settles as failed", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "9";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-cap");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-cap", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    const retries = recorder.events.filter((e) => e.type === "turn.retrying");
    expect(retries.map((e) => e.attempt)).toEqual([1, 2]);
  }, 20_000);

  it("interrupting one thread does not cancel another thread's retry", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "2";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-concurrent");
    await create();

    const first = instance.adapter.sendTurn({ threadId: "t-codex-stop", text: "stop me" });
    const second = instance.adapter.sendTurn({ threadId: "t-codex-continue", text: "keep going" });
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-stop");
    await recorder.until((e) => e.type === "turn.retrying" && e.threadId === "t-codex-continue");
    await instance.adapter.interruptTurn("t-codex-stop");

    await expect(
      recorder.until((e) => e.type === "turn.completed" && e.threadId === "t-codex-continue"),
    ).resolves.toMatchObject({ ok: true });
    await Promise.allSettled([first, second]);
  }, 20_000);

  it("never retries after agent text already streamed (duplicate-text hazard)", async () => {
    process.env.FAKE_CODEX_TRANSIENTS = "1";
    process.env.FAKE_CODEX_PARTIAL_FAILS = "1";
    process.env.FAKE_CODEX_STATE = join(scratch, "codex-launches-partial");
    process.env.FAKE_CODEX_RETRY_SCALE = "0.001";
    await create();
    await instance.adapter.sendTurn({ threadId: "t-codex-partial", text: "hi" });

    await expect(recorder.until((e) => e.type === "turn.completed" && e.ok === false)).resolves.toBeTruthy();
    expect(recorder.events.some((e) => e.type === "content.delta" && e.streamKind === "assistant_text")).toBe(true);
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 20_000);


  it("uses the explicit login command from the official Codex flow", () => {
    expect(CodexDriver.install?.signInCommand).toBe("codex login");
  });

  it("declares the effort levels the app-server accepts", async () => {
    await create();
    expect(instance.adapter.capabilities.effortLevels).toEqual([
      "low", "medium", "high", "xhigh", "max",
    ]);
  });

  it("sends effort on turn/start, and omits the key when unset", async () => {
    await create();
    const dump = join(scratch, "effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-effort", text: "hi", effort: "xhigh" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params.effort).toBe("xhigh");
  });

  it("sends no effort key when the turn has none", async () => {
    await create();
    const dump = join(scratch, "no-effort.json");
    process.env.FAKE_CODEX_DUMP = dump;

    await instance.adapter.sendTurn({ threadId: "t-no-effort", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const seen = JSON.parse(readFileSync(dump, "utf8"));
    const turnStart = seen.calls.find((c: any) => c.method === "turn/start");
    expect(turnStart.params).not.toHaveProperty("effort");
  });
});
