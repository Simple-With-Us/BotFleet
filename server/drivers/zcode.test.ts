// zcode driver contract tests, run against the scripted fake `zcode` CLI in
// server/testing/fake-zcode-cli.ts: normalize a stream-json turn into
// canonical events, pass --resume with the persisted session id, fail a turn
// whose process dies before the result line, and keep vendor API keys out of
// the child's environment.
//
// The fake CLI is a shebang script Windows cannot exec directly; spawnCli
// resolves it to `node <script>`, so these run everywhere.
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { isJsonObject, isJsonString, parseJson } from "../schema.ts";
import type { ProviderInstance } from "../contracts.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { ZcodeDriver } from "./zcode.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-zcode-cli.ts");

/** The fake CLI's FAKE_ZCODE_DUMP rows, decoded at the file boundary. */
const readLaunches = (path: string) =>
  readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const row = parseJson(line);
      if (!isJsonObject(row)) throw new Error("fake launch row is not an object");
      const argv = row.argv;
      if (!Array.isArray(argv) || !argv.every(isJsonString)) {
        throw new Error("fake launch row argv is not a string array");
      }
      return { argv };
    });

describe("ZcodeDriver turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;
  let dir: string;
  let originalCliMode: number;

  const create = async (mode?: string, environment: Record<string, string> = {}) => {
    const childEnv = { ...environment };
    if (mode) childEnv.FAKE_ZCODE_MODE = mode;
    instance = await ZcodeDriver.create({
      instanceId: "zcode-test",
      displayName: "ZCode Test",
      environment: childEnv,
      enabled: true,
      config: { cli: FAKE_CLI },
    });
    recorder = recordEvents(instance.adapter);
  };

  const sessionStarted = (forTurnId: string) => {
    const event = recorder.events.find((e) => e.type === "session.started" && e.turnId === forTurnId);
    if (event?.type !== "session.started") throw new Error(`no session.started for ${forTurnId}`);
    return event;
  };

  beforeEach(() => {
    ensureDirs();
    originalCliMode = statSync(FAKE_CLI).mode & 0o777;
    chmodSync(FAKE_CLI, 0o755);
    dir = mkdtempSync(join(tmpdir(), "omb-zcode-"));
  });
  afterEach(async () => {
    try {
      recorder?.stop();
      await instance?.dispose();
    } finally {
      chmodSync(FAKE_CLI, originalCliMode);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the app-bundled CLI when zcode is not on PATH", async () => {
    // ZCODE_BUNDLED_CLI replaces the resolution candidates; the fake CLI
    // answers --version exactly like the app bundle's zcode.cjs.
    instance = await ZcodeDriver.create({
      instanceId: "zcode-bundled",
      displayName: "ZCode Bundled",
      environment: { ZCODE_BUNDLED_CLI: FAKE_CLI },
      enabled: true,
      config: { cli: "zcode" },
    });
    recorder = recordEvents(instance.adapter);
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("zcode 3.17.1");
  });

  it("normalizes a full turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({
      threadId: "t-happy",
      text: "hi",
      model: "GLM-5.3",
    });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "content.delta",
      "content.delta",
      "item.completed", // assistant_text
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "zcodeAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect(session).toMatchObject({ sessionId: "zs-fake-1", model: "GLM-5.3" });

    const text = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "assistant_text");
    expect(text).toMatchObject({ text: "Hello from zcode" });

    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({
      type: "turn.completed",
      ok: true,
      stopReason: "end_turn",
      usage: { input: 12, output: 3, cachedInput: 4 },
    });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("streams tool steps as canonical item rows", async () => {
    await create("tool");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-tool", text: "read a.ts" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const started = recorder.events.find((e) => e.type === "item.started")!;
    expect(started).toMatchObject({ itemType: "tool", title: "read_file" });
    const completed = recorder.events.find((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(completed).toMatchObject({ ok: true });
    expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 30, output: 9 } });
  });

  it("resumes a prior zcode session with --resume and keeps the session id", async () => {
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_ZCODE_DUMP: dump });
    const first = await instance.adapter.sendTurn({ threadId: "t-resume", text: "first" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === first.turnId);
    const firstSession = sessionStarted(first.turnId);
    expect(firstSession.sessionId).toBe("zs-fake-1");

    const second = await instance.adapter.sendTurn({
      threadId: "t-resume",
      text: "second",
      resumeCursor: firstSession.sessionId,
    });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === second.turnId);
    const secondSession = sessionStarted(second.turnId);
    expect(secondSession.sessionId).toBe("zs-fake-1");

    const launches = readLaunches(dump);
    const resumed = launches.find((l) => l.argv.includes("--resume"));
    expect(resumed).toBeTruthy();
    expect(resumed?.argv[resumed.argv.indexOf("--resume") + 1]).toBe("zs-fake-1");
  });

  it("launches with the vendor headless recipe and the requested model", async () => {
    const dump = join(dir, "dump.jsonl");
    await create(undefined, { FAKE_ZCODE_DUMP: dump });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-argv", text: "hi", model: "GLM-5.3-Flash", cwd: dir });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const argv = readLaunches(dump)[0]?.argv ?? [];
    expect(argv[argv.indexOf("--mode") + 1]).toBe("yolo");
    expect(argv[argv.indexOf("--disallowed-tools") + 1]).toBe("AskUserQuestion EnterPlanMode ExitPlanMode");
    expect(argv[argv.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(argv[argv.indexOf("--model") + 1]).toBe("GLM-5.3-Flash");
    expect(argv).toContain("--no-color");
    expect(argv[argv.indexOf("--cwd") + 1]).toBe(dir);
    // The prompt is the positional text after --prompt, never a flag mashup.
    expect(argv[argv.indexOf("--prompt") + 1]).toBe("hi");
  });

  it("strips stray vendor API keys from the child environment", async () => {
    const dump = join(dir, "dump.jsonl");
    await create(undefined, {
      FAKE_ZCODE_DUMP: dump,
      Z_AI_API_KEY: "sk-should-not-leak",
      GLM_API_KEY: "glm-should-not-leak",
      BIGMODEL_API_KEY: "bm-should-not-leak",
    });
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-env", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);

    const launch = readFileSync(dump, "utf8").trim().split("\n").map((line) => JSON.parse(line))[0];
    expect(launch.env.Z_AI_API_KEY).toBe(false);
    expect(launch.env.GLM_API_KEY).toBe(false);
    expect(launch.env.BIGMODEL_API_KEY).toBe(false);
  });

  it("settles a turn whose result line arrives without a trailing newline", async () => {
    await create("no-trailing-newline");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-tail", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("correlates tool rows when the CLI omits call ids", async () => {
    await create("tool-no-ids");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-noids", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const started = recorder.events.find((e) => e.type === "item.started");
    const completed = recorder.events.find((e) => e.type === "item.completed");
    expect(started).toBeTruthy();
    expect(completed).toBeTruthy();
    expect(started?.itemId).toBe(completed?.itemId);
  });

  it("rejects a second turn on the same thread while the first is still starting", async () => {
    // The guard slot is reserved synchronously, before the CLI probe await:
    // an immediate second sendTurn must throw instead of double-spawning.
    await create();
    const first = instance.adapter.sendTurn({ threadId: "t-race", text: "one" });
    await expect(instance.adapter.sendTurn({ threadId: "t-race", text: "two" })).rejects.toThrow(
      "a turn is already running on this thread",
    );
    const { turnId } = await first;
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
  });

  it("settles a turn whose result line carries a mistyped usage field", async () => {
    await create("mistyped-usage");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-mistyped", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: true, stopReason: "end_turn" });
  });

  it("falls back to the default cli when the saved cli string is empty", () => {
    // Saved configs from before validation may carry an empty cli string;
    // decoding must fall back to the default instead of throwing.
    expect(ZcodeDriver.decodeConfig({ cli: "   " })).toEqual({ cli: "zcode" });
    expect(ZcodeDriver.decodeConfig({ cli: "" })).toEqual({ cli: "zcode" });
    expect(ZcodeDriver.decodeConfig({})).toEqual({ cli: "zcode" });
    expect(ZcodeDriver.decodeConfig({ cli: "/usr/local/bin/zcode" })).toEqual({ cli: "/usr/local/bin/zcode" });
  });

  it("gives repeated same-name tool calls without ids their own row pairs", async () => {
    await create("tool-repeat-noids");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-repeat", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    const starts = recorder.events.filter((e) => e.type === "item.started" && e.itemType === "tool");
    const finishes = recorder.events.filter((e) => e.type === "item.completed" && e.itemType === "tool");
    expect(starts).toHaveLength(2);
    expect(finishes).toHaveLength(2);
    expect(starts[0]?.itemId).not.toBe(starts[1]?.itemId);
    expect(starts[0]?.itemId).toBe(finishes[0]?.itemId);
    expect(starts[1]?.itemId).toBe(finishes[1]?.itemId);
  });

  it("fails promptly when the zcode process exits before its result line", async () => {
    await create("exit-early");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-exit", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({
      message: expect.stringMatching(/^zcode exited 1 before its result line/),
    });
    expect(instance.adapter.hasSession("t-exit")).toBe(false);
  });

  it("settles a stream-level turn.failed as a failed turn", async () => {
    await create("turn-error");
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-fail", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed" && e.turnId === turnId);
    expect(done).toMatchObject({ ok: false, stopReason: "failed" });
    expect(recorder.events.find((e) => e.type === "runtime.error")).toMatchObject({ message: "model exploded" });
  });
});
