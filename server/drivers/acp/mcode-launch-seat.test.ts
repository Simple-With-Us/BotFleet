// A BotFleet turn on the real MiniMax Code CLI keeps its role seat all the way
// down:  into the MCP servers mcode starts and into the shell commands it runs.
//
// This is the regression test for "BotFleet chat turns sign as MM through the
// mcode MCP" (BF-2408).  The suspicion was that mcode starts its MCP servers
// with a cut-down environment, so the `agent-sync mcp --default-seat MM` entry
// in ~/.minimax/mcp.json would never see AGENT_LAUNCHER and AGENT_LAUNCH_SEAT
// and would fall back to its default seat.  Run against mcode 0.6.2 that is
// not what happens:  mcode hands the five launch variables (AGENT_LAUNCHER,
// AGENT_LAUNCH_SEAT, AGENT_SEAT, AGENT_SESSION, AGENT_SYNC_ATTACH) to an MCP
// server it starts, whether the server is listed in mcp.json or comes in over
// ACP, and to the shell tool as well.  (The probe reports only AGENT_ and
// X_FIXTURE_ names, so these tests do not claim anything about the rest of the
// environment.)  agent-sync then reads the launcher's seat and ignores
// `--default-seat`.  These tests pin that, so an mcode update that stops
// forwarding those variables fails here before it signs a bot's post with the
// wrong seat.
//
// They run the REAL mcode (and, for the second group, the real agent-sync)
// against a scripted fake model and a fake Zulip, in a throwaway data
// directory and home.  Neither is in CI, so every test skips with a message
// when its binary is missing;  run them on the Mac that has both.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDirs } from "../../config.ts";
import type { ProviderInstance, SendTurnInput } from "../../contracts.ts";
import { launchIdentityFor } from "../../launch-identity.ts";
import { removeTempDir } from "../../testing/cleanup.ts";
import { recordEvents, type EventRecorder } from "../../testing/events.ts";
import { FakeZulip } from "../../testing/fake-zulip-server.ts";
import { inheritHarnessIdentity } from "../../testing/launch-identity.ts";
import {
  ENV_PROBE_MCP,
  FakeModel,
  FIXTURE_MODEL,
  findExecutable,
  runOrdinaryMcode,
  writeMcodeFixture,
  writeZuliprc,
  type McodeFixture,
  type McpEntry,
  type ModelStep,
} from "../../testing/mcode-fixture.ts";
import { McodeAgentDriver } from "./mcode.ts";

// BOTFLEET_REAL_MCODE_TESTS=0 skips them on a Mac that has both binaries.
const OPTED_OUT = process.env.BOTFLEET_REAL_MCODE_TESTS === "0";
const MCODE = OPTED_OUT ? null : findExecutable("mcode");
const AGENT_SYNC = OPTED_OUT ? null : findExecutable("agent-sync");

if (!MCODE) {
  console.info(
    OPTED_OUT
      ? "[mcode-launch-seat] skipped: BOTFLEET_REAL_MCODE_TESTS=0."
      : "[mcode-launch-seat] skipped: no `mcode` on PATH or in ~/.local/bin.  Run these on the Mac that has MiniMax Code.",
  );
} else if (!AGENT_SYNC) {
  console.info("[mcode-launch-seat] the agent-sync tests skip: no `agent-sync` on PATH or in ~/.local/bin.");
}

const withMcode = describe.skipIf(!MCODE);
const withMcodeAndAgentSync = describe.skipIf(!MCODE || !AGENT_SYNC);

/** A real mcode turn is a process start, an MCP handshake and a few model
 *  round trips against a fake;  the default 20 seconds is not enough for it. */
const TURN_TIMEOUT_MS = 90_000;

/** What a BotFleet-launched bot turn must hand to everything it starts. */
function launchedAs(seat: string, session: string) {
  return {
    AGENT_LAUNCHER: "botfleet",
    AGENT_LAUNCH_SEAT: seat,
    AGENT_SEAT: seat,
    AGENT_SESSION: session,
    AGENT_SYNC_ATTACH: "0",
  };
}

/** `NAME=value` lines (what `env | grep` prints) as a record. */
function parseEnvLines(text: string) {
  return Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const at = line.indexOf("=");
      return at > 0 ? [[line.slice(0, at), line.slice(at + 1)]] : [];
    }),
  );
}

/** The JSON object after a marker word in a tool result. */
function jsonAfter(text: string, marker: string) {
  return JSON.parse(text.slice(text.indexOf("{", text.indexOf(marker))));
}

/** The `whoami` answer among a session's tool results. */
function whoamiAnswer(results: readonly string[]): { seat: string; email: string; tag_prefix: string; session_source: string } {
  const text = results.find((result) => result.includes('"tag_prefix"'));
  if (!text) throw new Error(`no whoami answer among ${results.length} tool results`);
  // mcode may add lines after the tool's own JSON line.
  return JSON.parse(text.slice(text.indexOf("{")).split("\n")[0]);
}

describe("findExecutable", () => {
  // File modes mean nothing on Windows, where every file passes an X_OK check.
  it.skipIf(process.platform === "win32")("finds an executable file on PATH and passes over a directory or a plain file of the name", () => {
    const bin = mkdtempSync(join(tmpdir(), "botfleet-mcode-seat-bin-"));
    try {
      mkdirSync(join(bin, "a-directory"));
      writeFileSync(join(bin, "a-plain-file"), "not executable\n", { mode: 0o644 });
      writeFileSync(join(bin, "a-tool"), "#!/bin/sh\n", { mode: 0o755 });
      vi.stubEnv("PATH", bin);
      expect(findExecutable("a-tool")).toBe(join(bin, "a-tool"));
      expect(findExecutable("a-directory")).toBeNull();
      expect(findExecutable("a-plain-file")).toBeNull();
      expect(findExecutable("definitely-not-an-installed-program")).toBeNull();
    } finally {
      vi.unstubAllEnvs();
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

withMcode("a BotFleet turn on the real mcode keeps its seat in the MCP servers and the shell it starts", () => {
  let scratch: string;
  let model: FakeModel | undefined;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let restoreIdentity: (() => void) | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "botfleet-mcode-seat-"));
    vi.stubEnv("BOTFLEET_FLEET_SEAT_PROMPTS", "1");
    // The harness may have been started from a seat's terminal;  none of that
    // may reach the child.
    restoreIdentity = inheritHarnessIdentity();
  });

  afterEach(async () => {
    restoreIdentity?.();
    vi.unstubAllEnvs();
    recorder?.stop();
    await instance?.dispose();
    await model?.stop();
    model = undefined;
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  it(
    "gives an MCP server listed in mcp.json, and the shell, the bot's launch variables and nothing inherited",
    async () => {
      const steps: ModelStep[] = [
        { tool: /dump_env$/, input: {} },
        { tool: /^bash$/i, input: { command: "env | grep -E '^AGENT_' | sort" } },
      ];
      model = new FakeModel(steps);
      await model.start();
      const fixture = await writeMcodeFixture({
        mcode: MCODE!,
        dir: scratch,
        modelUrl: model.url,
        mcpServers: { probe: { command: process.execPath, args: [ENV_PROBE_MCP] } },
      });
      // The fixture must not send mcode's usage data anywhere.
      expect(readFileSync(join(fixture.dataDir, "config.yaml"), "utf8")).toMatch(/dataContribution:\s+enabled: false/);
      await runLaunchedTurn(fixture, "BF-Monitor", "thread-monitor-1");

      expect(model.missingTools).toEqual([]);
      const [mcpReport, shellReport] = model.toolResults;
      // Exactly the five launch variables:  the harness's own AGENT_SEAT,
      // AGENT_TAG, AGENT_SYNC_STATE_DIR and the rest were scrubbed first.
      expect(jsonAfter(mcpReport, "MCP_ENV")).toEqual(launchedAs("BF-MONITOR", "thread-monitor-1"));
      expect(parseEnvLines(shellReport)).toEqual(launchedAs("BF-MONITOR", "thread-monitor-1"));
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "gives an MCP server that comes in over ACP the same variables",
    async () => {
      model = new FakeModel([{ tool: /dump_env$/, input: {} }]);
      await model.start();
      const fixture = await writeMcodeFixture({ mcode: MCODE!, dir: scratch, modelUrl: model.url, mcpServers: {} });
      await runLaunchedTurn(fixture, "BF-Plumber", "thread-plumber-1", {
        // `integrations.composio` is mounted as an ACP session/new stdio server.
        composio: { command: process.execPath, args: [ENV_PROBE_MCP], env: {} },
      });

      expect(model.missingTools).toEqual([]);
      expect(jsonAfter(model.toolResults[0], "MCP_ENV")).toEqual(launchedAs("BF-PLUMBER", "thread-plumber-1"));
    },
    TURN_TIMEOUT_MS,
  );

  /** One BotFleet turn of the bot called `botName`, through the real driver. */
  async function runLaunchedTurn(
    fixture: McodeFixture,
    botName: string,
    threadId: string,
    integrations?: { composio: { command: string; args: string[]; env: Record<string, string> } },
  ): Promise<void> {
    instance = await McodeAgentDriver.create({
      instanceId: "mcode-launch-seat-test",
      displayName: "MiniMax Code",
      environment: { MINIMAX_DATA_DIR: fixture.dataDir, HOME: fixture.home },
      enabled: true,
      config: { cli: MCODE!, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const turn: SendTurnInput = {
      threadId,
      text: "go",
      model: FIXTURE_MODEL,
      launchIdentity: launchIdentityFor({ name: botName }, threadId),
    };
    turn.integrations = integrations;
    const started = await instance.adapter.sendTurn(turn);
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === started.turnId, 80_000);
    expect(done, JSON.stringify(recorder.events.filter((event) => event.type === "runtime.error"))).toMatchObject({ ok: true });
  }
});

withMcodeAndAgentSync("the agent-sync MCP entry the owner registered (`--default-seat MM`) signs the seat BotFleet gave", () => {
  const MONITOR = { user_id: 9101, full_name: "BF-Monitor", email: "bf-monitor-bot@zulip.test", key: "fixture-key-monitor" };
  const MINIMAX = { user_id: 9102, full_name: "MiniMax", email: "mm-bot@zulip.test", key: "fixture-key-minimax" };
  let scratch: string;
  let model: FakeModel | undefined;
  let zulip: FakeZulip | undefined;
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;
  let restoreIdentity: (() => void) | undefined;

  beforeEach(() => {
    ensureDirs();
    scratch = mkdtempSync(join(tmpdir(), "botfleet-mcode-seat-"));
    restoreIdentity = inheritHarnessIdentity();
  });

  afterEach(async () => {
    restoreIdentity?.();
    vi.unstubAllEnvs();
    recorder?.stop();
    await instance?.dispose();
    await model?.stop();
    await zulip?.stop();
    model = undefined;
    zulip = undefined;
    instance = undefined;
    recorder = undefined;
    await removeTempDir(scratch);
  });

  /** The fixture:  a fake Zulip with the two bots, their credential files in
   *  the engine child's home, and `mcp.json` registering agent-sync exactly as
   *  ~/.minimax/mcp.json does (`mcp --default-seat MM`), plus the one variable
   *  that points it at the fake realm instead of the real one. */
  async function build(): Promise<McodeFixture> {
    zulip = new FakeZulip();
    zulip.addUser(MONITOR);
    zulip.addUser(MINIMAX);
    await zulip.start();
    model = new FakeModel([{ tool: /whoami$/, input: {} }]);
    await model.start();
    const agentSync: McpEntry = {
      command: AGENT_SYNC!,
      args: ["mcp", "--default-seat", "MM"],
      env: { AGENT_SYNC_REALM: zulip.url },
    };
    const fixture = await writeMcodeFixture({
      mcode: MCODE!,
      dir: scratch,
      modelUrl: model.url,
      mcpServers: { "agent-sync": agentSync },
    });
    writeZuliprc({ home: fixture.home, fileName: "BF-Monitor-zuliprc", email: MONITOR.email, key: MONITOR.key, site: zulip.url });
    writeZuliprc({ home: fixture.home, fileName: "MM-zuliprc", email: MINIMAX.email, key: MINIMAX.key, site: zulip.url });
    return fixture;
  }

  async function runLaunchedTurn(fixture: McodeFixture, threadId: string): Promise<void> {
    instance = await McodeAgentDriver.create({
      instanceId: "mcode-launch-seat-test",
      displayName: "MiniMax Code",
      environment: { MINIMAX_DATA_DIR: fixture.dataDir, HOME: fixture.home },
      enabled: true,
      config: { cli: MCODE!, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
    const started = await instance.adapter.sendTurn({
      threadId,
      text: "go",
      model: FIXTURE_MODEL,
      launchIdentity: launchIdentityFor({ name: "BF-Monitor" }, threadId),
    });
    const done = await recorder.until((event) => event.type === "turn.completed" && event.turnId === started.turnId, 80_000);
    expect(done, JSON.stringify(recorder.events.filter((event) => event.type === "runtime.error"))).toMatchObject({ ok: true });
  }

  it(
    "answers whoami as BF-MONITOR for a launched bot turn, never as MM",
    async () => {
      vi.stubEnv("BOTFLEET_FLEET_SEAT_PROMPTS", "1");
      const fixture = await build();
      await runLaunchedTurn(fixture, "a1b2c3d4-0000-4000-8000-000000000001");

      const answer = whoamiAnswer(model!.toolResults);
      expect(answer.seat).toBe("BF-MONITOR");
      expect(answer.email).toBe(MONITOR.email);
      expect(answer.session_source).toBe("env");
      // A post would carry this tag, so this is the signature on the wire.
      expect(answer.tag_prefix.startsWith("[BF-MONITOR·")).toBe(true);
      expect(zulip!.requests.length).toBeGreaterThan(0);
      expect(zulip!.requests.every((request) => request.userId === MONITOR.user_id)).toBe(true);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "gives a launched turn with no seat no agent-sync at all, so nothing can sign as MM",
    async () => {
      // The seat switch is off, which is how the live harness runs until the
      // operator fleet is turned on:  the child is marked as launched and has
      // no seat, so agent-sync refuses to start and the tool is not offered.
      vi.stubEnv("BOTFLEET_FLEET_SEAT_PROMPTS", "");
      const fixture = await build();
      await runLaunchedTurn(fixture, "a1b2c3d4-0000-4000-8000-000000000002");

      expect(model!.missingTools).toEqual([/whoami$/.source]);
      expect(model!.toolResults).toEqual([]);
      expect(zulip!.requests).toEqual([]);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    "still answers as MM for an ordinary MiniMax Code session that no launcher started",
    async () => {
      const fixture = await build();
      const ran = await runOrdinaryMcode({ mcode: MCODE!, fixture, cwd: scratch });
      expect(ran.ok, ran.stderr).toBe(true);

      const answer = whoamiAnswer(model!.toolResults);
      expect(answer.seat).toBe("MM");
      expect(answer.email).toBe(MINIMAX.email);
      expect(answer.tag_prefix).toBe("[MM]");
      expect(answer.session_source).toBe("none");
      expect(zulip!.requests.length).toBeGreaterThan(0);
      expect(zulip!.requests.every((request) => request.userId === MINIMAX.user_id)).toBe(true);
    },
    TURN_TIMEOUT_MS,
  );
});
