// Contract tests for the generic CLI wrapper.  The driver spawns a real
// process (node itself, via process.execPath) for every case, so each one
// proves a behaviour of the spawn path — credential stripping, cwd, the
// settle guard, interrupt — rather than a mock's bookkeeping.
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import type { ProviderInstance, SendTurnInput } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { CliWrapperDriver, type CliWrapperConfig } from "./cli-wrapper.ts";

const NODE = process.execPath;

const turn = (text: string, extra: Partial<SendTurnInput> = {}): SendTurnInput =>
  ({ threadId: "t1", text, ...extra }) as SendTurnInput;

describe("CliWrapperDriver.decodeConfig", () => {
  it("fills every field for an absent or empty config", () => {
    expect(CliWrapperDriver.decodeConfig(undefined)).toEqual({ command: "echo", args: [], passPromptAs: "arg" });
    expect(CliWrapperDriver.decodeConfig({})).toEqual({ command: "echo", args: [], passPromptAs: "arg" });
  });

  it("keeps a valid config intact", () => {
    expect(CliWrapperDriver.decodeConfig({ command: "my-cli", args: ["--json"], passPromptAs: "stdin" })).toEqual({
      command: "my-cli",
      args: ["--json"],
      passPromptAs: "stdin",
    });
  });

  it("rejects a field saved with the wrong type instead of coercing it", () => {
    expect(() => CliWrapperDriver.decodeConfig({ command: 5 })).toThrow();
    expect(() => CliWrapperDriver.decodeConfig({ args: "not-a-list" })).toThrow();
    expect(() => CliWrapperDriver.decodeConfig({ passPromptAs: "file" })).toThrow();
  });
});

describe("CliWrapperDriver turns (real child process)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (config: CliWrapperConfig, environment: Record<string, string> = {}) => {
    instance = await CliWrapperDriver.create({
      instanceId: "cli-test",
      displayName: "CLI Test",
      environment,
      enabled: true,
      config,
    });
    recorder = recordEvents(instance.adapter);
    return instance;
  };

  beforeEach(() => {
    ensureDirs();
  });

  afterEach(async () => {
    recorder?.stop();
    await instance?.dispose();
  });

  it("opens the turn before any delta and settles it exactly once", async () => {
    await create({ command: NODE, args: ["-e", "process.stdout.write('hello')"], passPromptAs: "arg" });
    const { turnId } = await instance.adapter.sendTurn(turn("hi"));
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const types = recorder.events.map((e) => e.type);
    expect(types[0]).toBe("turn.started");
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const deltas = recorder.events
      .filter((e) => e.type === "content.delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(deltas).toContain("hello");
  });

  it("settles a missing binary once, not once per event", async () => {
    await create({ command: join(tmpdir(), "cli-wrapper-does-not-exist-826"), args: [], passPromptAs: "arg" });
    const { turnId } = await instance.adapter.sendTurn(turn("hi"));
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    // A failed spawn fires `error` AND `close`; only one may reach the harness.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    expect((done as { ok: boolean }).ok).toBe(false);
    // ENOENT is a setup problem, and the product already has words for it.
    expect((done as { stopReason?: string }).stopReason).toContain("PATH");
  });

  it("keeps the harness's workspace credentials out of the child, and passes the approved ones", async () => {
    process.env.LINQ_WEBHOOK_SECRET = "whsec-must-not-leak";
    try {
      await create(
        {
          command: NODE,
          args: [
            "-e",
            "process.stdout.write(JSON.stringify({leak: process.env.LINQ_WEBHOOK_SECRET ?? null, ok: process.env.CLI_WRAPPER_OK ?? null}))",
          ],
          passPromptAs: "arg",
        },
        { CLI_WRAPPER_OK: "approved" },
      );
      const { turnId } = await instance.adapter.sendTurn(turn("hi"));
      await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

      const out = recorder.events
        .filter((e) => e.type === "content.delta")
        .map((e) => (e as { delta: string }).delta)
        .join("");
      const seen = JSON.parse(out) as { leak: string | null; ok: string | null };
      expect(seen.leak).toBeNull();
      expect(seen.ok).toBe("approved");
      expect(out).not.toContain("whsec-must-not-leak");
    } finally {
      delete process.env.LINQ_WEBHOOK_SECRET;
    }
  });

  it("runs the child in the turn's cwd, not the server's", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cli-wrapper-cwd-")));
    await create({ command: NODE, args: ["-e", "process.stdout.write(process.cwd())"], passPromptAs: "arg" });
    const { turnId } = await instance.adapter.sendTurn(turn("hi", { cwd: dir }));
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const out = recorder.events
      .filter((e) => e.type === "content.delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(out).toContain(dir);
  });

  it("passes the prompt over stdin when asked", async () => {
    await create({
      command: NODE,
      args: ["-e", "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>process.stdout.write('got:'+s))"],
      passPromptAs: "stdin",
    });
    const { turnId } = await instance.adapter.sendTurn(turn("prompt-body"));
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const out = recorder.events
      .filter((e) => e.type === "content.delta")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(out).toContain("got:prompt-body");
  });

  it("survives a child that exits before draining stdin", async () => {
    // `echo` never reads stdin, so the write races the exit.  An unlistened
    // stream error is an uncaught exception, and it would take the whole
    // server with it — which is why spawnCli attaches a no-op handler.
    await create({ command: NODE, args: ["-e", "process.exit(0)"], passPromptAs: "stdin" });
    const { turnId } = await instance.adapter.sendTurn(turn("x".repeat(200_000)));
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("refuses an oversized prompt in argv instead of failing the spawn", async () => {
    await create({ command: NODE, args: ["-e", "process.stdout.write('ran')"], passPromptAs: "arg" });
    const { turnId } = await instance.adapter.sendTurn(turn("x".repeat(40_000)));
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    expect((done as { ok: boolean }).ok).toBe(false);
    expect((done as { stopReason?: string }).stopReason).toBe("prompt_too_large");
    // The command never ran: no output, so no spawn happened.
    expect(recorder.events.filter((e) => e.type === "content.delta")).toHaveLength(0);
  });

  it("kills the child on interrupt", async () => {
    // A child that would outlive the test: its settling at all proves the
    // interrupt reached the process.
    await create({ command: NODE, args: ["-e", "setTimeout(() => {}, 60_000)"], passPromptAs: "arg" });
    const { turnId } = await instance.adapter.sendTurn(turn("hi"));
    await recorder.until((e) => e.type === "turn.started" && e.turnId === turnId);

    await instance.adapter.interruptTurn("t1");
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId, 15_000);
    expect(done.turnId).toBe(turnId);
  });

  it("kills every outstanding child on stopAll", async () => {
    await create({ command: NODE, args: ["-e", "setTimeout(() => {}, 60_000)"], passPromptAs: "arg" });
    const { turnId } = await instance.adapter.sendTurn(turn("hi"));
    await recorder.until((e) => e.type === "turn.started" && e.turnId === turnId);

    await instance.adapter.stopAll();
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId, 15_000);
    expect(done.turnId).toBe(turnId);
  });
});
