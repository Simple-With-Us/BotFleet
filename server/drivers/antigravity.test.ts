// Antigravity driver contract tests, run against the scripted fake `agy` CLI
// in server/testing/fake-agy-cli.ts: normalize the print-mode stream-json turn
// into canonical events, and report availability from `agy --version`.
//
// The fake CLI is a shebang script Windows cannot exec directly;
// spawnCli resolves it to `node <script>`, so these run everywhere.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ensureDirs } from "../config.ts";
import { isQuotaOrCapText, parseQuotaResetTime } from "../model-fallback.ts";
import type { ProviderInstance } from "../contracts.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";
import { recordEvents, type EventRecorder } from "../testing/events.ts";
import { buildTurnEvents } from "../telemetry.ts";
import {
  ANTIGRAVITY_COMPUTER_MCP_KEY,
  ANTIGRAVITY_HOST_CONTROL_NOTICE,
  AntigravityDriver,
  acquireAntigravityComputerMcpLease,
  antigravityPrintTimeout,
  antigravityConfigHasBotfleetServers,
  antigravityHostPolicyRefusal,
  antigravityMcpConfigPath,
  antigravityMcpServers,
  antigravityTurnErrorMessage,
  parseAntigravityTurnResult,
  ensureAntigravityMcp,
  readAntigravityModelCatalog,
  STATIC_ANTIGRAVITY_MODELS,
} from "./antigravity.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "testing", "fake-agy-cli.ts");

describe("readAntigravityModelCatalog", () => {
  it("returns the official list when settings are missing", () => {
    expect(readAntigravityModelCatalog({ HOME: join(tmpdir(), "omb-agy-missing-home") })).toEqual(
      STATIC_ANTIGRAVITY_MODELS,
    );
  });

  it("tags extra settings models as custom", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-catalog-"));
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(
      join(home, ".gemini", "antigravity-cli", "settings.json"),
      JSON.stringify({ customModels: [{ id: "local-gemini", displayName: "Local Gemini" }] }),
    );
    try {
      const catalog = readAntigravityModelCatalog({ HOME: home });
      expect(catalog.options.slice(0, STATIC_ANTIGRAVITY_MODELS.options.length)).toEqual(STATIC_ANTIGRAVITY_MODELS.options);
      expect(catalog.options.at(-1)).toEqual({ id: "local-gemini", label: "Local Gemini", custom: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("Antigravity decodeConfig", () => {
  it("publishes the official installer for every supported platform", () => {
    expect(AntigravityDriver.install).toMatchObject({
      command: {
        darwin: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        linux: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
        win32: "irm https://antigravity.google/cli/install.ps1 | iex",
      },
    });
  });

  it("defaults to the agy binary with the permission bypass off", () => {
    // --dangerously-skip-permissions skips the broker entirely; a fresh bot
    // must not inherit that, and defaultConfig() goes through the same path
    expect(AntigravityDriver.decodeConfig({})).toEqual({ cli: "agy", fullAuto: false });
    expect(AntigravityDriver.decodeConfig(undefined)).toEqual({ cli: "agy", fullAuto: false });
    expect(AntigravityDriver.defaultConfig?.()).toEqual({ cli: "agy", fullAuto: false });
  });
  it("fullAuto is an explicit opt-in: true only when stored as true", () => {
    expect(AntigravityDriver.decodeConfig({}).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: false }).fullAuto).toBe(false);
    expect(AntigravityDriver.decodeConfig({ fullAuto: true }).fullAuto).toBe(true);
  });
  it("rejects invalid types (throws → shadow snapshot)", () => {
    expect(() => AntigravityDriver.decodeConfig({ cli: 5 })).toThrow(/invalid cli/);
    expect(() => AntigravityDriver.decodeConfig({ fullAuto: "yes" })).toThrow(/invalid fullAuto/);
  });
  it("keeps turn deadline windows within acp/core.ts's bounds and drops the rest", () => {
    expect(
      AntigravityDriver.decodeConfig({ promptTimeoutMs: 600_000, promptIdleMs: 120_000, promptToolIdleMs: 300_000 }),
    ).toEqual({ cli: "agy", fullAuto: false, promptTimeoutMs: 600_000, promptIdleMs: 120_000, promptToolIdleMs: 300_000 });
    // Too short, too long, fractional, or not a number: fall back to the
    // default rather than throw — a stale setting must not take the engine down.
    expect(
      AntigravityDriver.decodeConfig({
        promptTimeoutMs: 999,
        promptIdleMs: 20 * 60_000 + 1,
        promptToolIdleMs: 1_500.5,
      }),
    ).toEqual({ cli: "agy", fullAuto: false });
    expect(AntigravityDriver.decodeConfig({ promptIdleMs: "180000" })).toEqual({ cli: "agy", fullAuto: false });
  });
  it("sets agy's own print timeout a whole minute above the driver's ceiling", () => {
    expect(antigravityPrintTimeout(11 * 60_000)).toBe("12m");
    expect(antigravityPrintTimeout(90_000)).toBe("3m");
    expect(antigravityPrintTimeout(1_000)).toBe("2m");
  });
});

// The real shapes agy 1.1.12–1.1.25 writes into `result.error` when a turn
// fails, copied verbatim from BotFleet's own native stream logs.
const AGY_QUOTA_ERROR =
  "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 44h3m45s.";
const AGY_ELIGIBILITY_ERROR =
  'Eligibility check failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist": read tcp 192.168.1.253:55172->172.217.116.4:443: read: connection reset by peer';

describe("antigravityTurnErrorMessage", () => {
  it("names the engine and keeps agy's quota wording and reset window", () => {
    const message = antigravityTurnErrorMessage({ status: "ERROR", error: AGY_QUOTA_ERROR });
    expect(message).toBe(`Antigravity: ${AGY_QUOTA_ERROR}`);
    // The harness classifies the chip from this text: it has to read as a
    // quota hit, and the reset window has to parse, or the bot silently
    // retries the same exhausted provider on the next turn.
    expect(isQuotaOrCapText(`error: ${message}`)).toBe(true);
    const parsed = parseQuotaResetTime(message, Date.parse("2026-09-03T07:54:39Z"));
    expect(parsed.isQuotaOrCap).toBe(true);
    expect(parsed.resetsAt).toBe(Date.parse("2026-09-03T07:54:39Z") + 44 * 3600 * 1000);
  });

  it("passes through a non-quota failure without inventing a cap", () => {
    const message = antigravityTurnErrorMessage({ status: "ERROR", error: AGY_ELIGIBILITY_ERROR });
    expect(message.startsWith("Antigravity: Eligibility check failed:")).toBe(true);
    // A network reset must not be read as a usage cap — that would burn the
    // one auto-failover hop and park the engine on a cooldown it never hit.
    expect(isQuotaOrCapText(`error: ${message}`)).toBe(false);
    expect(antigravityTurnErrorMessage({ status: "ERROR", error: "timeout waiting for response" })).toBe(
      "Antigravity: timeout waiting for response",
    );
  });

  it("trims a long message but never drops the reset window", () => {
    const long = `Individual quota reached. Please upgrade your subscription to increase your limits. ${"provider detail ".repeat(40)}Resets in 12h30m0s.`;
    const message = antigravityTurnErrorMessage({ status: "ERROR", error: long });
    expect(message.length).toBeLessThan(500); // model-fallback's quota-chip ceiling
    expect(message).toContain("Resets in 12h30m0s.");
    expect(isQuotaOrCapText(`error: ${message}`)).toBe(true);
  });

  it("still says something when agy sends a bare status", () => {
    expect(antigravityTurnErrorMessage({ status: "ERROR", error: null })).toBe(
      "Antigravity: the turn ended with status ERROR and no reply",
    );
    expect(antigravityTurnErrorMessage({ status: null, error: "   " })).toBe(
      "Antigravity: the turn ended with status ERROR and no reply",
    );
    // Shape drift must still end the turn, never widen a failure into success.
    expect(parseAntigravityTurnResult({ status: 7, error: { message: "x" } })).toEqual({
      status: null,
      error: null,
    });
    expect(parseAntigravityTurnResult("not an object")).toEqual({ status: null, error: null });
  });
});

describe("Antigravity turns (fake CLI)", () => {
  let instance: ProviderInstance;
  let recorder: EventRecorder;

  const create = async (environment: Record<string, string> = {}) => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-test",
      displayName: "Antigravity Test",
      environment,
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    recorder = recordEvents(instance.adapter);
  };

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_AGY_RETRY_SCALE;
    recorder?.stop();
    await instance?.dispose();
  });

  it("ignores a trailing buffered line after result settles the turn", async () => {
    await create({ FAKE_AGY_BURST: "1", FAKE_AGY_TRAILING_AFTER_RESULT: "1" });
    await instance.adapter.sendTurn({ threadId: "t-trailing", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");
    const types = recorder.events.map((e) => e.type);
    expect(types.at(-1)).toBe("turn.completed");
    expect(recorder.events.filter((e) => e.type === "item.started" && (e as any).itemId === "conv-fake-123:2")).toHaveLength(0);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  });

  it("normalizes a full print-mode turn into the canonical event sequence", async () => {
    await create();
    const { turnId } = await instance.adapter.sendTurn({ threadId: "t-happy", text: "hi", model: "gemini-3.1-pro-high" });
    await recorder.until((e) => e.type === "turn.completed");

    const types = recorder.events.map((e) => e.type);
    expect(types).toEqual([
      "turn.started",
      "session.started",
      "item.started", // tool ACTIVE
      "item.completed", // tool DONE
      "thread.token-usage.updated", // agent_response usage
      "content.delta", // result.response
      "item.completed", // assistant_text
      "thread.token-usage.updated", // result usage
      "turn.completed",
    ]);
    expect(recorder.events.every((e) => e.turnId === turnId && e.provider === "antigravityAgent")).toBe(true);

    const session = recorder.events.find((e) => e.type === "session.started")!;
    expect((session as any).sessionId).toBe("conv-fake-123");

    const tool = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "tool")!;
    expect((tool as any).ok).toBe(true);

    const usage = recorder.events.find((e) => e.type === "thread.token-usage.updated")!;
    expect(usage).toMatchObject({ input: 105, output: 20 });

    const text = recorder.events.find((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text")!;
    expect((text as any).text).toBe("done from fake agy");

    const done = recorder.events.at(-1)!;
    // result.usage is the turn total (the per-step figures precede it)
    expect(done).toMatchObject({ type: "turn.completed", ok: true, usage: { input: 105, output: 20 } });
    expect(instance.adapter.hasSession("t-happy")).toBe(false);
  });

  it("carries cache reads through live and terminal usage without billing them twice", async () => {
    await create();
    await instance.adapter.sendTurn({ threadId: "t-cache", text: "hi" });
    const completed = await recorder.until((e) => e.type === "turn.completed");

    const live = recorder.events.filter((e) => e.type === "thread.token-usage.updated");
    expect(live).toHaveLength(2);
    for (const event of live) {
      expect(event).toMatchObject({ input: 105, output: 20, cachedInput: 5 });
    }
    expect(completed).toMatchObject({ usage: { input: 105, output: 20, cachedInput: 5 } });
    if (completed.type !== "turn.completed") throw new Error("turn did not complete");

    const events = buildTurnEvents({
      botId: "bot-cache",
      botName: "Cache test",
      threadId: "t-cache",
      instanceId: "antigravity",
      modelId: "gemini-3.1-pro-high",
      driverKind: "antigravityAgent",
      inputTokens: completed.usage?.input,
      outputTokens: completed.usage?.output,
      cachedInputTokens: completed.usage?.cachedInput,
    });
    expect(events.map((event) => [event.metadata.tokenType, event.quantity])).toEqual([
      ["input", 100],
      ["cacheRead", 5],
      ["output", 20],
    ]);
    expect(events.reduce((total, event) => total + event.quantity, 0)).toBe(125);
  });

  // The stuck-forever bug. Every one of these used to leave the turn
  // unsettled or settled in silence, so the mascot kept counting seconds
  // with nothing ever arriving in its place.
  it("surfaces a provider quota as a runtime error and ends the turn", async () => {
    await create({ FAKE_AGY_RESULT_ERROR: AGY_QUOTA_ERROR });
    await instance.adapter.sendTurn({ threadId: "t-quota", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect(error).toBeDefined();
    expect((error as any).message).toBe(`Antigravity: ${AGY_QUOTA_ERROR}`);
    // the error has to reach the fold BEFORE the turn settles, or the chip
    // is not there yet when turn.completed decides whether to fail over
    const types = recorder.events.map((e) => e.type);
    expect(types.indexOf("runtime.error")).toBeLessThan(types.indexOf("turn.completed"));

    const done = recorder.events.at(-1)!;
    expect(done).toMatchObject({ type: "turn.completed", ok: false, stopReason: "ERROR" });
    expect(instance.adapter.hasSession("t-quota")).toBe(false);
  });

  it("ends the turn on a bare non-zero exit, with the CLI's stderr", async () => {
    await create({ FAKE_AGY_DIE: "3", FAKE_AGY_STDERR: "agy: authentication expired\n" });
    await instance.adapter.sendTurn({ threadId: "t-crash", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect((error as any).message).toContain("agy exited 3 before result");
    expect((error as any).message).toContain("authentication expired");
    // DR2: an expired login is the person's to fix, so no relaunch is tried
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(recorder.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: false,
      stopReason: "exit_before_result",
    });
    expect(instance.adapter.hasSession("t-crash")).toBe(false);
  });

  // DR2.  Antigravity had no transient-failure retry at all, so one 429 or
  // connection reset failed the whole turn and pushed the bot's fallback
  // chain into a cooldown a single relaunch would have avoided.
  it("auto-retries a transient exit, then completes with exactly one reply", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-retry-"));
    process.env.FAKE_AGY_RETRY_SCALE = "0.001";
    try {
      await create({ FAKE_AGY_TRANSIENTS: "2", FAKE_AGY_STATE: join(scratch, "launches") });
      await instance.adapter.sendTurn({ threadId: "t-agy-retry", text: "go" });

      await recorder.until((e) => e.type === "turn.completed" && (e as any).ok === true, 25_000);
      const retries = recorder.events.filter((e) => e.type === "turn.retrying");
      expect(retries.map((e) => (e as any).attempt)).toEqual([1, 2]);
      expect(retries.every((e) => (e as any).delayMs > 0 && typeof (e as any).reason === "string")).toBe(true);
      const replies = recorder.events.filter(
        (e) => e.type === "item.completed" && (e as any).itemType === "assistant_text",
      );
      expect(replies).toHaveLength(1);
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  it("stops retrying at the attempt cap and settles the turn as failed", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-retry-cap-"));
    process.env.FAKE_AGY_RETRY_SCALE = "0.001";
    try {
      await create({ FAKE_AGY_TRANSIENTS: "9", FAKE_AGY_STATE: join(scratch, "launches") });
      await instance.adapter.sendTurn({ threadId: "t-agy-cap", text: "go" });

      await recorder.until((e) => e.type === "turn.completed" && (e as any).ok === false, 25_000);
      expect(recorder.events.filter((e) => e.type === "turn.retrying").map((e) => (e as any).attempt)).toEqual([1, 2]);
      expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  it("never retries a failure that arrived after a tool step had already run", async () => {
    // Replay safety is PROTOCOL state, not error text: the stderr here is the
    // same transient 503 the test above relaunches on.  What forbids the
    // retry is that a tool already started on this computer.
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-retry-partial-"));
    process.env.FAKE_AGY_RETRY_SCALE = "0.001";
    try {
      await create({
        FAKE_AGY_TRANSIENTS: "1",
        FAKE_AGY_PARTIAL_FAILS: "1",
        FAKE_AGY_STATE: join(scratch, "launches"),
      });
      await instance.adapter.sendTurn({ threadId: "t-agy-partial", text: "go" });

      const done = await recorder.until((e) => e.type === "turn.completed", 25_000);
      expect(done).toMatchObject({ ok: false });
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(recorder.events.some((e) => e.type === "item.started" && (e as any).itemType === "tool")).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  it("ends the turn on a silent EOF — exit 0, no stream, no result", async () => {
    await create({ FAKE_AGY_DIE: "0" });
    await instance.adapter.sendTurn({ threadId: "t-silent", text: "hi" });
    await recorder.until((e) => e.type === "turn.completed");

    const error = recorder.events.find((e) => e.type === "runtime.error")!;
    expect((error as any).message).toBe("agy exited 0 before result");
    expect(recorder.events.at(-1)).toMatchObject({
      type: "turn.completed",
      ok: false,
      stopReason: "exit_before_result",
    });
    expect(instance.adapter.hasSession("t-silent")).toBe(false);
  });

  // `close` waits on the stdio pipes, so a grandchild that outlives agy —
  // one of agy's own MCP servers — holds it back forever. `exit` is the
  // process's real death, and the turn has to end on that alone.
  it.skipIf(process.platform === "win32")(
    "ends the turn on exit even when a grandchild holds stdout open",
    async () => {
      await create({ FAKE_AGY_LEAK_STDOUT: "1" });
      await instance.adapter.sendTurn({ threadId: "t-leak", text: "hi" });
      await recorder.until((e) => e.type === "turn.completed");

      const error = recorder.events.find((e) => e.type === "runtime.error")!;
      expect((error as any).message).toContain("before result");
      expect(recorder.events.at(-1)).toMatchObject({ type: "turn.completed", ok: false });
      expect(instance.adapter.hasSession("t-leak")).toBe(false);
    },
    10_000,
  );

  it("respondToRequest resolves `unavailable` — no interactive permission channel, so the caller denies", async () => {
    await create();
    await expect(instance.adapter.respondToRequest("t-happy", "req-1", { behavior: "allow" })).resolves.toBe("unavailable");
  });

  it("spawns agy with --mode accept-edits by default, and the bypass only when opted in", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-agy-args-"));
    const argvFor = async (config: { cli: string; fullAuto?: boolean }, name: string) => {
      const dump = join(dir, `${name}.json`);
      const inst = await AntigravityDriver.create({
        instanceId: `agy-args-${name}`,
        displayName: undefined,
        environment: { FAKE_AGY_DUMP: dump },
        enabled: true,
        // through decodeConfig on purpose: the default is the thing under test
        config: AntigravityDriver.decodeConfig(config),
      });
      const rec = recordEvents(inst.adapter);
      try {
        await inst.adapter.sendTurn({ threadId: `t-args-${name}`, text: "hi" });
        await rec.until((e) => e.type === "turn.completed");
        return JSON.parse(readFileSync(dump, "utf8")).argv as string[];
      } finally {
        rec.stop();
        await inst.dispose();
      }
    };
    try {
      const defaults = await argvFor({ cli: FAKE_CLI }, "default");
      expect(defaults).not.toContain("--dangerously-skip-permissions");
      const mode = defaults.indexOf("--mode");
      expect(defaults.slice(mode, mode + 2)).toEqual(["--mode", "accept-edits"]);

      // agy's own timeout sits above the driver's 11-minute ceiling, so agy
      // never kills a still-streaming turn before the driver decides to
      const printTimeout = defaults.indexOf("--print-timeout");
      expect(defaults.slice(printTimeout, printTimeout + 2)).toEqual(["--print-timeout", "12m"]);

      const opted = await argvFor({ cli: FAKE_CLI, fullAuto: true }, "bypass");
      expect(opted).toContain("--dangerously-skip-permissions");
      expect(opted).not.toContain("--mode");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ede5d0a7 / BOTFLEET-6 / BOTFLEET-10.  The turn used to have one clock, an
// 11-minute wall-clock watchdog, and agy's own "timeout waiting for response"
// was relaunched into the same hang.  These run the real driver against the
// fake agy with the windows scaled down to seconds.
describe("Antigravity turn deadlines (fake CLI)", () => {
  let instance: ProviderInstance | undefined;
  let recorder: EventRecorder | undefined;

  const create = async (
    environment: Record<string, string>,
    windows: { promptTimeoutMs?: number; promptIdleMs?: number; promptToolIdleMs?: number },
  ) => {
    instance = await AntigravityDriver.create({
      instanceId: "agy-deadlines",
      displayName: undefined,
      environment,
      enabled: true,
      // through decodeConfig, so the windows pass the same validation a
      // stored setting does
      config: AntigravityDriver.decodeConfig({ cli: FAKE_CLI, fullAuto: true, ...windows }),
    });
    recorder = recordEvents(instance.adapter);
    return { instance, recorder };
  };
  const notices = (rec: EventRecorder) =>
    rec.events.filter((e) => e.type === "item.started" && (e as any).toolKind === "notice");

  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
  });

  afterEach(async () => {
    delete process.env.FAKE_AGY_RETRY_SCALE;
    recorder?.stop();
    await instance?.dispose();
    instance = undefined;
    recorder = undefined;
  });

  it("does not kill a turn whose tool step is silent for longer than the plain idle window", async () => {
    // idle 5 s, tool 15 s: the tool is quiet for 6.5 s, past the plain
    // window, and the turn still completes because a tool is running.
    const { instance, recorder } = await create({ FAKE_AGY_TOOL_HOLD_MS: "6500" }, {
      promptIdleMs: 5_000,
      promptToolIdleMs: 15_000,
    });
    await instance.adapter.sendTurn({ threadId: "t-agy-tool-quiet", text: "build it" });
    const done = await recorder.until((e) => e.type === "turn.completed", 25_000);
    expect(done).toMatchObject({ ok: true });
    expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  }, 30_000);

  it("stops a tool step that stays silent past the tool window as a stall, and warns first", async () => {
    // The tool window is deliberately the SHORTER one here, so the plain
    // window cannot be what fires: the message has to name the tool.
    const { instance, recorder } = await create({ FAKE_AGY_TOOL_HOLD_MS: "60000" }, {
      promptIdleMs: 30_000,
      promptToolIdleMs: 3_000,
    });
    await instance.adapter.sendTurn({ threadId: "t-agy-tool-wedged", text: "build it" });
    const done = await recorder.until((e) => e.type === "turn.completed", 20_000);
    expect(done).toMatchObject({ ok: false, stopReason: "prompt_stall" });
    const errors = recorder.events.filter((e) => e.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as any).message).toBe(
      "Antigravity sent nothing for 3 s while a tool ran and was stopped.",
    );
    // the pre-cliff chip lands before the stop, not with it
    const warned = notices(recorder);
    expect(warned).toHaveLength(1);
    expect((warned[0] as any).title).toMatch(/^Antigravity has gone quiet while a tool runs\.  /);
    const types = recorder.events.map((e) => e.type);
    expect(recorder.events.indexOf(warned[0])).toBeLessThan(types.indexOf("runtime.error"));
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
  }, 30_000);

  it("stops a turn with no output and no tool as a stall, without relaunching it", async () => {
    process.env.FAKE_AGY_RETRY_SCALE = "0.001";
    const { instance, recorder } = await create({ FAKE_AGY_DELAY_MS: "60000" }, { promptIdleMs: 1_500 });
    await instance.adapter.sendTurn({ threadId: "t-agy-silent", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed", 20_000);
    expect(done).toMatchObject({ ok: false, stopReason: "prompt_stall" });
    const error = recorder.events.find((e) => e.type === "runtime.error");
    expect((error as any).message).toBe("Antigravity sent nothing for 2 s and was stopped.");
    // give a (wrong) relaunch time to show itself before counting
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
  }, 30_000);

  it("ends the turn at the hard ceiling even when the idle window has not run out", async () => {
    const { instance, recorder } = await create({ FAKE_AGY_DELAY_MS: "60000" }, {
      promptTimeoutMs: 2_000,
      promptIdleMs: 30_000,
    });
    await instance.adapter.sendTurn({ threadId: "t-agy-ceiling", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed", 20_000);
    expect(done).toMatchObject({ ok: false, stopReason: "prompt_timeout" });
    const error = recorder.events.find((e) => e.type === "runtime.error");
    expect((error as any).message).toBe("Antigravity ran past its 2 s limit and was stopped.");
  }, 30_000);

  it("settles an ERROR result carrying agy's timeout text once, without a relaunch", async () => {
    // An ERROR `result` settles directly and never reaches maybeRetry; this
    // pins that the timeout text keeps that shape.  The relaunch guard for a
    // timeout on the exit path is the next test.
    process.env.FAKE_AGY_RETRY_SCALE = "0.001";
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-timeout-"));
    try {
      const launches = join(scratch, "launches");
      const { instance, recorder } = await create(
        { FAKE_AGY_RESULT_ERROR: "timeout waiting for response", FAKE_AGY_TRANSIENTS: "0", FAKE_AGY_STATE: launches },
        {},
      );
      await instance.adapter.sendTurn({ threadId: "t-agy-timeout", text: "hi" });
      const done = await recorder.until((e) => e.type === "turn.completed", 20_000);
      expect(done).toMatchObject({ ok: false, stopReason: "ERROR" });
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
      expect(Number(readFileSync(launches, "utf8"))).toBe(1);
      const error = recorder.events.find((e) => e.type === "runtime.error");
      expect((error as any).message).toBe("Antigravity: timeout waiting for response");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it("never relaunches a child that exits with agy's own \"timeout waiting for response\"", async () => {
    // Transient to the shared classifier, and that is exactly the trap: the
    // provider already hung once on this prompt, and three relaunches used
    // to hold the bot for up to half an hour.  An exit with no `result` is
    // the only path that reaches maybeRetry, so this is the one that proves
    // the timeout guard there.
    process.env.FAKE_AGY_RETRY_SCALE = "0.001";
    const { instance, recorder } = await create(
      { FAKE_AGY_STDERR: "agy: timeout waiting for response\n", FAKE_AGY_DIE: "1" },
      {},
    );
    await instance.adapter.sendTurn({ threadId: "t-agy-exit-timeout", text: "hi" });
    const done = await recorder.until((e) => e.type === "turn.completed", 20_000);
    expect(done).toMatchObject({ ok: false, stopReason: "exit_before_result" });
    // give a (wrong) relaunch time to show itself before counting
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
    expect(recorder.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(recorder.events.filter((e) => e.type === "turn.completed")).toHaveLength(1);
    const error = recorder.events.find((e) => e.type === "runtime.error");
    expect((error as any).message).toMatch(/^agy exited 1 before result: .*timeout waiting for response/);
  }, 30_000);

  it("does not count time queued for the mount lease against the turn's ceiling", async () => {
    // A turn queued behind a mounting turn used to arrive with its ceiling
    // already spent, and was killed on the next tick as prompt_timeout.
    const home = mkdtempSync(join(tmpdir(), "omb-agy-lease-clock-"));
    try {
      const { instance, recorder } = await create({ HOME: home }, { promptTimeoutMs: 2_000, promptIdleMs: 30_000 });
      const releaseWriter = await acquireAntigravityComputerMcpLease(antigravityMcpConfigPath({ HOME: home }), true);
      const sent = instance.adapter.sendTurn({ threadId: "t-agy-lease-queue", text: "hi" });
      // queued for longer than the whole ceiling
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      expect(recorder.events.some((e) => e.type === "turn.started")).toBe(false);
      releaseWriter();
      await sent;
      const done = await recorder.until((e) => e.type === "turn.completed", 20_000);
      expect(done).toMatchObject({ ok: true });
      expect(recorder.events.some((e) => e.type === "runtime.error")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("settles a stopped turn as interrupted, with no runtime.error", async () => {
    // BOTFLEET-10: Stop used to surface as "agy was killed by SIGTERM before
    // result", a crash Sentry paged on for something the person asked for.
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-stop-"));
    const readyFile = join(scratch, "ready");
    try {
      const { instance, recorder } = await create({ FAKE_AGY_DELAY_MS: "10000", FAKE_AGY_READY_FILE: readyFile }, {});
      await instance.adapter.sendTurn({ threadId: "t-agy-stop", text: "hi" });
      await expect.poll(() => existsSync(readyFile), { timeout: 10_000 }).toBe(true);
      await instance.adapter.interruptTurn("t-agy-stop");
      const done = await recorder.until((e) => e.type === "turn.completed", 15_000);
      expect(done).toMatchObject({ ok: false, stopReason: "interrupted" });
      expect(recorder.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
      expect(recorder.events.some((e) => e.type === "turn.retrying")).toBe(false);
      expect(instance.adapter.hasSession("t-agy-stop")).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("Antigravity snapshot", () => {
  it("reports available with the CLI version against the fake", async () => {
    chmodSync(FAKE_CLI, 0o755);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-snap",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("available");
    expect(snap.version).toBe("1.1.12");
    // agy auth is keyring-backed with no reliable file marker, so the snapshot
    // must NOT claim signed-in from a mere directory — authenticated stays unset.
    expect((snap as any).authenticated).toBeUndefined();
    await instance.dispose();
  });

  it("a missing binary is unavailable", async () => {
    const instance = await AntigravityDriver.create({
      instanceId: "agy-missing",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: "definitely-not-a-real-agy-binary", fullAuto: false },
    });
    const snap = await instance.snapshot();
    expect(snap.state).toBe("unavailable");
    await instance.dispose();
  });

  it("strips workspace credentials from snapshot and helper children", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "omb-agy-env-"));
    const dump = join(scratch, "dump.json");
    const names = ["XAI_API_KEY", "COMPOSIO_API_KEY", "BOX_TOKEN", "OPENCODE_API_KEY", "OMB_TTS_KEY"] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.FAKE_AGY_DUMP = dump;
    for (const name of names) process.env[name] = `${name}-must-not-leak`;
    const instance = await AntigravityDriver.create({
      instanceId: "agy-env",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      await instance.snapshot();
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();

      await instance.generateText?.("summarize safely");
      for (const name of names) expect(JSON.parse(readFileSync(dump, "utf8")).env[name]).toBeUndefined();
    } finally {
      await instance.dispose();
      delete process.env.FAKE_AGY_DUMP;
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("Antigravity computer MCP config", () => {
  const configPath = (home: string) => join(home, ".gemini", "config", "mcp_config.json");
  const readConfig = (home: string) => JSON.parse(readFileSync(configPath(home), "utf8"));
  const boxIntegrations = {
    computer: {
      kind: "box" as const,
      boxId: "bx_1",
      token: "box-tok",
      control: { url: "http://127.0.0.1:9/control", token: "ctl-tok" },
    },
  };
  const boxEntry = () => antigravityMcpServers(boxIntegrations)["botfleet-computer"]!;

  it("builds the cloud-box spec on the shared computer proxy (never path-resolved locally)", () => {
    expect(antigravityMcpServers(boxIntegrations)["botfleet-computer"]).toEqual({
      command: process.execPath,
      args: [SPAWNED_PROXIES.computer],
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        OGB_BOX_ID: "bx_1",
        OGB_BOX_TOKEN: "box-tok",
        OMB_CONTROL_URL: "http://127.0.0.1:9/control",
        OMB_CONTROL_TOKEN: "ctl-tok",
      },
    });
  });

  it("passes a Local VM / VPS stdio connection through unchanged, and yields null without a computer", () => {
    expect(
      antigravityMcpServers({
        localComputer: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } },
      }),
    ).toEqual({ "botfleet-localComputer": { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } } });
    expect(antigravityMcpServers({})["botfleet-localComputer"]).toBeUndefined();
    expect(antigravityMcpServers(undefined)["botfleet-localComputer"]).toBeUndefined();
  });

  it("upserts only its own key — the user's servers and unknown top-level keys survive", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpcfg-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } },
          futureTopLevelKey: { keep: true },
        }),
      );
      ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      let config = readConfig(home);
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      // A later turn on a different computer overwrites the key in place.
      ensureAntigravityMcp(
        { [ANTIGRAVITY_COMPUTER_MCP_KEY]: { command: "/opt/cua", args: ["--mcp"], env: { CUA_SOCKET: "/tmp/cua.sock" } } },
        { HOME: home },
      );
      config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY].command).toBe("/opt/cua");
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      expect(config.futureTopLevelKey).toEqual({ keep: true });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("starts fresh from malformed JSON instead of failing the turn", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpbad-"));
    try {
      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(configPath(home), "{{{ not json");
      ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("restricts the token-bearing config directory and file to the current user", () => {
    if (process.platform === "win32") return;
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpperms-"));
    try {
      const directory = dirname(configPath(home));
      mkdirSync(directory, { recursive: true, mode: 0o755 });
      writeFileSync(configPath(home), "{}\n", { mode: 0o644 });

      ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });

      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(configPath(home)).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("preserves concurrent config edits while restoring only its own MCP entry", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpconcurrent-"));
    try {
      const restoreNewFile = ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      const concurrentlyCreated = readConfig(home);
      concurrentlyCreated.mcpServers["external-helper"] = { command: "external-mcp" };
      concurrentlyCreated.futureTopLevelKey = { keep: true };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyCreated));

      restoreNewFile();
      expect(existsSync(configPath(home))).toBe(true);
      let restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(restored.mcpServers["external-helper"]).toEqual({ command: "external-mcp" });
      expect(restored.futureTopLevelKey).toEqual({ keep: true });

      const originalEntry = { command: "user-owned-mcp", args: ["--serve"] };
      writeFileSync(
        configPath(home),
        JSON.stringify({ mcpServers: { [ANTIGRAVITY_COMPUTER_MCP_KEY]: originalEntry } }),
      );
      const restoreExistingEntry = ensureAntigravityMcp({ [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry() }, { HOME: home });
      const concurrentlyEdited = readConfig(home);
      concurrentlyEdited.mcpServers["another-helper"] = { command: "another-mcp" };
      writeFileSync(configPath(home), JSON.stringify(concurrentlyEdited));

      restoreExistingEntry();
      restored = readConfig(home);
      expect(restored.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(originalEntry);
      expect(restored.mcpServers["another-helper"]).toEqual({ command: "another-mcp" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a computer-less turn removes only its own key, and never creates the file just to remove", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcprm-"));
    try {
      // No file at all: removal is a no-op, not an empty file in the user's home.
      ensureAntigravityMcp({}, { HOME: home });
      expect(existsSync(configPath(home))).toBe(false);

      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(
        configPath(home),
        JSON.stringify({
          mcpServers: {
            "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] },
            [ANTIGRAVITY_COMPUTER_MCP_KEY]: boxEntry(),
          },
        }),
      );
      ensureAntigravityMcp({}, { HOME: home });
      const config = readConfig(home);
      expect(config.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      expect(config.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("advertises computerMcp and the tool integrations, but never host control (print mode has no approval channel)", async () => {
    ensureDirs();
    const fullAuto = await AntigravityDriver.create({
      instanceId: "agy-caps-full",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const acceptEdits = await AntigravityDriver.create({
      instanceId: "agy-caps-safe",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: false },
    });
    try {
      expect(fullAuto.adapter.capabilities.computerMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.localComputerMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.agentsMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.composioMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.phoneMcp).toBe(true);
      expect(fullAuto.adapter.capabilities.qdrantMcp).toBe(true);
      expect(acceptEdits.adapter.capabilities.computerMcp).toBe(true);
      expect(acceptEdits.adapter.capabilities.localComputerMcp).toBe(true);
      expect(acceptEdits.adapter.capabilities.agentsMcp).toBe(true);
    } finally {
      await fullAuto.dispose();
      await acceptEdits.dispose();
    }
  });

  it("uses the spawned CLI's HOME and restores the prior config when the turn exits", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpturn-"));
    const dump = join(home, "mcp-at-spawn.json");
    const original = JSON.stringify({ mcpServers: { "sqlite-helper": { command: "sqlite-mcp-server", args: ["/db"] } } });
    mkdirSync(join(home, ".gemini", "config"), { recursive: true });
    writeFileSync(configPath(home), original);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-mcp-turn",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "100", FAKE_AGY_MCP_DUMP: dump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({
        threadId: "t-mcp-on",
        text: "click things",
        integrations: boxIntegrations,
      });
      // sendTurn resolves after the child is spawned; the write happens
      // synchronously before that spawn, so this IS the spawn-time content.
      const mounted = readConfig(home);
      expect(mounted.mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(mounted.mcpServers["sqlite-helper"]).toEqual({ command: "sqlite-mcp-server", args: ["/db"] });
      await recorder.until((e) => e.type === "turn.completed");
      expect(JSON.parse(readFileSync(dump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => readFileSync(configPath(home), "utf8")).toBe(original);
    } finally {
      recorder.stop();
      await instance.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  // DR4.  The lease used to be one module-global promise taken by EVERY
  // turn, held for the child's whole lifetime — so two Antigravity bots with
  // no computer between them still answered one at a time, for up to the
  // 10-minute print timeout.  It is a reader/writer lease now: only a turn
  // that writes the shared file excludes anyone.
  it("lets computer-free turns run at the same time instead of queueing", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpshared-"));
    const first = await AntigravityDriver.create({
      instanceId: "agy-shared-first",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "400" },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-shared-second",
      displayName: undefined,
      environment: { HOME: home },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-shared-first", text: "first" });
      let secondSpawned = false;
      const secondTurn = second.adapter
        .sendTurn({ threadId: "t-shared-second", text: "second" })
        .then((result) => {
          secondSpawned = true;
          return result;
        });

      // The first child is still alive (its output is held back 400ms).
      // Under the old module-global lease the second turn could not even
      // spawn until that child was gone.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(secondSpawned).toBe(true);
      await secondTurn;
      await firstRecorder.until((event) => event.type === "turn.completed", 20_000);
      await secondRecorder.until((event) => event.type === "turn.completed", 20_000);
      // neither turn touched agy's global file
      expect(existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("shares the lease between computer-free turns and still excludes a mounting one", async () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-leaseunit-"));
    const other = mkdtempSync(join(tmpdir(), "omb-agy-leaseunit2-"));
    try {
      const path = antigravityMcpConfigPath({ HOME: home });
      const settled = <T,>(promise: Promise<T>) => {
        let done = false;
        const tracked = promise.then((value) => ((done = true), value));
        return { tracked, isDone: () => done };
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

      // two computer-free turns hold it at once
      const readerA = await acquireAntigravityComputerMcpLease(path, false);
      const readerB = await acquireAntigravityComputerMcpLease(path, false);

      // a mounting turn waits for BOTH of them
      const writer = settled(acquireAntigravityComputerMcpLease(path, true));
      await tick();
      expect(writer.isDone()).toBe(false);
      readerA();
      await tick();
      expect(writer.isDone()).toBe(false);
      readerB();
      const releaseWriter = await writer.tracked;
      expect(writer.isDone()).toBe(true);

      // and while it holds the file, a computer-free turn waits its turn
      const readerC = settled(acquireAntigravityComputerMcpLease(path, false));
      await tick();
      expect(readerC.isDone()).toBe(false);

      // a DIFFERENT config path is a different file and a different lease
      const otherPath = antigravityMcpConfigPath({ HOME: other });
      const elsewhere = settled(acquireAntigravityComputerMcpLease(otherPath, true));
      await tick();
      expect(elsewhere.isDone()).toBe(true);
      (await elsewhere.tracked)();

      releaseWriter();
      (await readerC.tracked)();
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("treats a leftover botfleet mount as a reason to take the file exclusively", () => {
    const home = mkdtempSync(join(tmpdir(), "omb-agy-leftover-"));
    try {
      const path = antigravityMcpConfigPath({ HOME: home });
      expect(antigravityConfigHasBotfleetServers(path)).toBe(false);

      mkdirSync(join(home, ".gemini", "config"), { recursive: true });
      writeFileSync(path, JSON.stringify({ mcpServers: { "sqlite-helper": { command: "x", args: [] } } }));
      expect(antigravityConfigHasBotfleetServers(path)).toBe(false);

      writeFileSync(
        path,
        JSON.stringify({ mcpServers: { [ANTIGRAVITY_COMPUTER_MCP_KEY]: { command: "x", args: [], env: {} } } }),
      );
      expect(antigravityConfigHasBotfleetServers(path)).toBe(true);

      // unreadable is not "clean": a turn that cannot tell takes the safe side
      writeFileSync(path, "{ not json");
      expect(antigravityConfigHasBotfleetServers(path)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("serializes overlapping turns so each child sees only its own computer mount", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcplease-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-first",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DELAY_MS: "150", FAKE_AGY_MCP_DUMP: firstDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-second",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-first", text: "first", integrations: boxIntegrations });
      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-second", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(secondSpawned).toBe(false);
      await firstRecorder.until((event) => event.type === "turn.completed");
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reaps a child that hangs after result, restores the mount, and unblocks the next turn", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpreaper-"));
    const firstDump = join(home, "first.json");
    const secondDump = join(home, "second.json");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-zombie",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_MCP_DUMP: firstDump,
        FAKE_AGY_POST_RESULT_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-zombie",
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_MCP_DUMP: secondDump },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const firstRecorder = recordEvents(first.adapter);
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-zombie", text: "first", integrations: boxIntegrations });
      await firstRecorder.until((event) => event.type === "turn.completed");
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-zombie", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");

      expect(JSON.parse(readFileSync(firstDump, "utf8")).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      expect(JSON.parse(readFileSync(secondDump, "utf8"))?.mcpServers?.[ANTIGRAVITY_COMPUTER_MCP_KEY]).toBeUndefined();
      await expect.poll(() => existsSync(configPath(home))).toBe(false);
    } finally {
      firstRecorder.stop();
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("force-reaps an interrupted child that ignores SIGTERM before result", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const home = mkdtempSync(join(tmpdir(), "omb-agy-mcpinterrupt-"));
    const readyFile = join(home, "ready");
    const first = await AntigravityDriver.create({
      instanceId: "agy-mcp-interrupted",
      displayName: undefined,
      environment: {
        HOME: home,
        FAKE_AGY_DELAY_MS: "10000",
        FAKE_AGY_IGNORE_SIGTERM: "1",
        FAKE_AGY_READY_FILE: readyFile,
      },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const second = await AntigravityDriver.create({
      instanceId: "agy-mcp-after-interrupt",
      displayName: undefined,
      environment: { HOME: home },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const secondRecorder = recordEvents(second.adapter);
    try {
      await first.adapter.sendTurn({ threadId: "t-mcp-interrupted", text: "first", integrations: boxIntegrations });
      expect(readConfig(home).mcpServers[ANTIGRAVITY_COMPUTER_MCP_KEY]).toEqual(boxEntry());
      await expect.poll(() => existsSync(readyFile), { timeout: 2_000 }).toBe(true);
      await first.adapter.interruptTurn("t-mcp-interrupted");

      let secondSpawned = false;
      const secondTurn = second.adapter.sendTurn({ threadId: "t-mcp-after-interrupt", text: "second" }).then((result) => {
        secondSpawned = true;
        return result;
      });
      if (process.platform !== "win32") {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(secondSpawned).toBe(false);
      }
      await secondTurn;
      await secondRecorder.until((event) => event.type === "turn.completed");
      await expect.poll(() => existsSync(configPath(home)), { timeout: 6_000 }).toBe(false);
    } finally {
      secondRecorder.stop();
      await first.dispose();
      await second.dispose();
      rmSync(home, { recursive: true, force: true });
    }
  }, 10_000);

  it("pipes prompts larger than 64KB via stdin without argv overflow", async () => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    const instance = await AntigravityDriver.create({
      instanceId: "agy-large-prompt",
      displayName: undefined,
      environment: {},
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto: true },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      // 100KB prompt — exceeds the 64KB argv threshold and pipes via stdin
      const largeText = "x".repeat(100 * 1024);
      const { turnId } = await instance.adapter.sendTurn({
        threadId: "t-large-prompt",
        text: largeText,
      });
      expect(turnId).toBeTruthy();
      const completed = await recorder.until((e) => e.type === "turn.completed");
      expect(completed).toMatchObject({ type: "turn.completed", ok: true });
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  });
});

// C2: the driver declares `localComputerMcp: true` while `respondToRequest`
// answers "unavailable" — print mode opens no ask, so there is no approval
// card behind that flag.  What keeps the flag honest is per-turn: a turn that
// can act on the person's own desktop loses the permission bypass AND is
// stopped at the init event unless agy reports a Tool Execution Policy that
// asks a human first.  Dropping the bypass is not enough on its own: `--mode`
// is the execution mode, not the permission switch, and a policy of
// `always-proceed` runs `run_command` on this Mac regardless of it.
describe("Antigravity host control", () => {
  const stdio = (scope?: "local-computer") => ({
    command: process.execPath,
    args: ["--version"],
    env: {},
    ...(scope ? { scope } : {}),
  });
  // The person's own desktop: the one mount `hostToolPrefix` recognizes.
  const hostIntegrations = { localComputer: stdio("local-computer") };
  // Same stdio shape, no scope — a Local VM or a VPS.  Isolated, so the
  // guard must NOT fire and a full-auto bot keeps its switch.
  const sandboxIntegrations = { localComputer: stdio() };
  // What startTurn actually sets now: the named-mount array.
  const hostComputersIntegrations = {
    computers: [{ name: "computer", label: "This Mac", kind: "local" as const, stdio: stdio("local-computer") }],
  };

  let home: string;
  beforeEach(() => {
    ensureDirs();
    chmodSync(FAKE_CLI, 0o755);
    // Mounting a computer rewrites `~/.gemini/config/mcp_config.json`, so
    // every turn here gets a throwaway HOME rather than the developer's.
    home = mkdtempSync(join(tmpdir(), "omb-agy-host-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const runTurn = async (
    name: string,
    fullAuto: boolean,
    integrations: Parameters<ProviderInstance["adapter"]["sendTurn"]>[0]["integrations"],
    fakeEnv: Record<string, string> = {},
    /** Runs after `turn.completed` and BEFORE dispose(), so an assertion about
     * the child can tell the turn's own cleanup from the instance teardown
     * reaping whatever was left over. */
    beforeDispose?: () => Promise<void>,
    autoApprove?: boolean,
    unattended?: boolean,
  ) => {
    const dump = join(home, `${name}.json`);
    const instance = await AntigravityDriver.create({
      instanceId: `agy-host-${name}`,
      displayName: undefined,
      environment: { HOME: home, FAKE_AGY_DUMP: dump, ...fakeEnv },
      enabled: true,
      config: { cli: FAKE_CLI, fullAuto },
    });
    const recorder = recordEvents(instance.adapter);
    try {
      await instance.adapter.sendTurn({ threadId: `t-host-${name}`, text: "hi", integrations, autoApprove, unattended });
      await recorder.until((e) => e.type === "turn.completed");
      if (beforeDispose) await beforeDispose();
      return {
        argv: JSON.parse(readFileSync(dump, "utf8")).argv as string[],
        events: [...recorder.events],
      };
    } finally {
      recorder.stop();
      await instance.dispose();
    }
  };

  it("drops the permission bypass for a turn that can act on this computer", async () => {
    // --dangerously-skip-permissions approves a shell command with nobody
    // watching.  On the person's own desktop that is the whole bug: there is
    // no card to decline it, because print mode never opens one.
    const host = await runTurn("host", true, hostIntegrations);
    expect(host.argv).not.toContain("--dangerously-skip-permissions");
    const mode = host.argv.indexOf("--mode");
    expect(host.argv.slice(mode, mode + 2)).toEqual(["--mode", "accept-edits"]);

    // The named-mount array startTurn writes today reaches the same guard.
    const viaComputers = await runTurn("host-computers", true, hostComputersIntegrations);
    expect(viaComputers.argv).not.toContain("--dangerously-skip-permissions");
  });

  it("retains the permission bypass on host control when turn has autoApprove: true", async () => {
    // When the operator explicitly sets autoApprove on the bot, the turn is
    // authorized to run autonomously without interactive approval cards.
    const host = await runTurn("host-auto-approved", false, hostIntegrations, {}, undefined, true);
    expect(host.argv).toContain("--dangerously-skip-permissions");
    expect(host.argv).not.toContain("--mode");
    expect(
      host.events.some((e) => (e as any).title === ANTIGRAVITY_HOST_CONTROL_NOTICE),
    ).toBe(false);
  });

  it("does not let bot-level autoApprove flip the bypass for a non-host turn", async () => {
    // autoApprove is scoped to host-control turns.  A bot with Auto Mode on
    // running in a sandbox/cloud/VM turn must not bypass the permission
    // broker unless the engine-level fullAuto switch is on (see P1 review).
    const sandbox = await runTurn("sandbox-auto-approved", false, sandboxIntegrations, {}, undefined, true);
    expect(sandbox.argv).not.toContain("--dangerously-skip-permissions");
    const mode = sandbox.argv.indexOf("--mode");
    expect(sandbox.argv.slice(mode, mode + 2)).toEqual(["--mode", "accept-edits"]);
  });

  it("withholds the bypass for an unattended host-control turn even with autoApprove", async () => {
    // A webhook/resource turn begins with nobody watching: it must not
    // inherit Auto Mode, so no --dangerously-skip-permissions even though
    // the bot has autoApprove on and controls the host.
    const host = await runTurn("host-unattended", false, hostIntegrations, {}, undefined, true, true);
    expect(host.argv).not.toContain("--dangerously-skip-permissions");
    const mode = host.argv.indexOf("--mode");
    expect(host.argv.slice(mode, mode + 2)).toEqual(["--mode", "accept-edits"]);
  });

  it("leaves a full-auto turn alone when no host computer is mounted", async () => {
    // An isolated sandbox is not the person's desktop, and neither is a bare
    // turn.  Forcing the bypass off for those would take away a switch the
    // owner opted into for work that was never brokered in the first place.
    const sandbox = await runTurn("sandbox", true, sandboxIntegrations);
    expect(sandbox.argv).toContain("--dangerously-skip-permissions");
    expect(sandbox.argv).not.toContain("--mode");

    const plain = await runTurn("plain", true, undefined);
    expect(plain.argv).toContain("--dangerously-skip-permissions");
  });

  it("says in the thread that it cannot ask, once, at the start of a host-control turn", async () => {
    const host = await runTurn("notice", false, hostIntegrations);
    const notices = host.events.filter(
      (e) => e.type === "item.started" && (e as any).title === ANTIGRAVITY_HOST_CONTROL_NOTICE,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ itemType: "tool", toolKind: "notice" });
    // The wording has to be true on this Mac.  The version this replaced
    // claimed shell commands "are refused during this turn", which was false
    // whenever agy's Tool Execution Policy was `always-proceed` — it ran them.
    expect(ANTIGRAVITY_HOST_CONTROL_NOTICE).toBe(
      "Antigravity has no approval cards, so BotFleet checks its tool execution policy instead.  A policy that would run shell commands on this computer unasked stops the turn.",
    );
    expect(ANTIGRAVITY_HOST_CONTROL_NOTICE).not.toContain("are refused during this turn");
    // A tool row that never completes spins for the whole turn, so the
    // notice settles itself in the same breath.
    const itemId = (notices[0] as any).itemId as string;
    expect(itemId).toBeTruthy();
    const settled = host.events.filter(
      (e) => e.type === "item.completed" && (e as any).itemId === itemId,
    );
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ itemType: "tool", ok: true });
    // It is a notice about this turn, so it belongs after the turn opens.
    const started = host.events.findIndex((e) => e.type === "turn.started");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(host.events.indexOf(notices[0])).toBeGreaterThan(started);
  });

  it("stays quiet when the bot has no host computer", async () => {
    const sandbox = await runTurn("quiet", true, sandboxIntegrations);
    expect(
      sandbox.events.some((e) => (e as any).title === ANTIGRAVITY_HOST_CONTROL_NOTICE),
    ).toBe(false);
  });

  // How long the fake holds between its init event and its first tool.  The
  // real CLI spends an LLM round trip there; without a gap of some kind a
  // test could not tell a gate that stopped the turn in time from one that
  // did not stop it at all.  Five seconds is far longer than any of these
  // turns takes to settle, so a marker that exists is a real failure and
  // never a slow machine.
  const POLICY_HOLD_MS = "5000";

  /** Wait for a file the fake CLI writes, rather than sleeping a fixed span. */
  const awaitFile = async (path: string, withinMs = 8_000) => {
    const deadline = Date.now() + withinMs;
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error(`${path} never appeared within ${withinMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("stops a host-control turn before any tool runs when the policy is always-proceed", async () => {
    // Measured on this Mac with agy 1.1.26: `--mode accept-edits` and no
    // bypass reports `always-proceed` and then RUNS `run_command`.  Print mode
    // opens no card and there is nobody to show one to, so the only honest
    // answer is a turn that does not start.
    const marker = join(home, "always-proceed-tool-ran");
    const host = await runTurn("always-proceed", false, hostIntegrations, {
      FAKE_AGY_PERMISSION_MODE: "always-proceed",
      FAKE_AGY_INIT_HOLD_MS: POLICY_HOLD_MS,
      FAKE_AGY_TOOL_MARKER: marker,
    });

    const completed = host.events.filter((e) => e.type === "turn.completed");
    expect(completed).toHaveLength(1); // settled exactly once
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "host_control_policy" });

    const errors = host.events.filter((e) => e.type === "runtime.error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as any).message).toBe(antigravityHostPolicyRefusal("always-proceed"));
    expect((errors[0] as any).message).toContain("always-proceed");
    expect((errors[0] as any).message).toContain("request-review or strict");

    // The child is killed, not merely ignored: the fake holds for five seconds
    // between init and its first tool and this turn settled in milliseconds,
    // so a marker on disk would mean the process outlived its own refusal.
    expect(existsSync(marker)).toBe(false);
    // Nothing from the killed child leaks into a turn the person was told had
    // ended, either.
    expect(
      host.events.some((e) => e.type === "item.started" && (e as any).title === "write_to_file"),
    ).toBe(false);
    // The refusal comes after init, so the conversation id is still recorded.
    expect(host.events.filter((e) => e.type === "session.started")).toHaveLength(1);
  });

  // Windows-only skip: killCliTree there is `taskkill /PID /T /F`, a hard kill
  // that delivers no signal the child could ever observe, so there is nothing
  // for the fake to record.  The always-proceed case above still proves on
  // every platform that the tool never ran.
  it.skipIf(process.platform === "win32")("kills the refused child rather than reading past it", async () => {
    // Ignoring the rest of the stream would leave agy running with a mounted
    // computer and nobody watching — the turn would look ended while the
    // process that could still act on this Mac was very much alive.  The
    // SIGTERM is asserted BEFORE dispose(), so it is the refusal's own kill
    // and not the instance teardown sweeping up afterwards.  The 1.5s bound is
    // deliberate: settle() arms a post-settle reaper at 2s, which would hide a
    // refusal that forgot to stop the child behind a two-second window where
    // agy is still live on a mounted computer.  The signal is sent in the same
    // tick as the refusal, so 1.5s is a wide margin, not a race.
    const marker = join(home, "killed-tool-ran");
    const killed = join(home, "killed-sigterm");
    await runTurn(
      "killed",
      false,
      hostIntegrations,
      {
        FAKE_AGY_PERMISSION_MODE: "always-proceed",
        FAKE_AGY_INIT_HOLD_MS: POLICY_HOLD_MS,
        FAKE_AGY_TOOL_MARKER: marker,
        FAKE_AGY_KILLED_MARKER: killed,
      },
      async () => {
        await awaitFile(killed, 1_500);
        expect(existsSync(marker)).toBe(false);
      },
    );
  });

  it("emits nothing more from a refused turn, even when agy ran ahead", async () => {
    // Killing the child does not recall the lines already in the pipe.  In
    // burst mode the fake writes its whole turn as one chunk, so the driver
    // parses the refusal and the rest of the stream in a single synchronous
    // pass: replaying them would put a tool row, an answer and a token bill
    // into a turn the person was told had ended, and `result` would try to
    // settle it a second time.
    const marker = join(home, "burst-tool-ran");
    const host = await runTurn("burst", false, hostIntegrations, {
      FAKE_AGY_PERMISSION_MODE: "always-proceed",
      FAKE_AGY_TOOL_MARKER: marker,
      FAKE_AGY_BURST: "1",
    });
    expect(existsSync(marker)).toBe(true); // the fake really did run ahead
    const completed = host.events.filter((e) => e.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "host_control_policy" });
    expect(host.events.some((e) => e.type === "content.delta")).toBe(false);
    expect(
      host.events.some((e) => e.type === "item.started" && (e as any).title === "write_to_file"),
    ).toBe(false);
    expect(
      host.events.some((e) => e.type === "item.completed" && (e as any).itemType === "assistant_text"),
    ).toBe(false);
    expect(host.events.some((e) => e.type === "thread.token-usage.updated")).toBe(false);
  });

  it("stops a host-control turn when agy reports no policy at all", async () => {
    // An unreported value is not a safe value.  This check exists because the
    // driver used to assume a refusal it had never verified; defaulting to
    // "probably fine" would be that same mistake in a new coat of paint.
    const marker = join(home, "omitted-tool-ran");
    const host = await runTurn("omitted", false, hostIntegrations, {
      FAKE_AGY_PERMISSION_MODE: "omit",
      FAKE_AGY_INIT_HOLD_MS: POLICY_HOLD_MS,
      FAKE_AGY_TOOL_MARKER: marker,
    });
    const completed = host.events.filter((e) => e.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: false, stopReason: "host_control_policy" });
    const error = host.events.find((e) => e.type === "runtime.error") as any;
    expect(error.message).toBe(antigravityHostPolicyRefusal(null));
    expect(error.message).toContain("was not reported");
    expect(existsSync(marker)).toBe(false);
  });

  it("stops a host-control turn on a policy value it does not recognize", async () => {
    // `accept-edits` is a `--mode` value, not a Tool Execution Policy.  If agy
    // ever reports something this driver has not measured, the turn stops and
    // the message says only what is known — not what it would do.
    const marker = join(home, "unknown-tool-ran");
    const host = await runTurn("unknown-policy", false, hostIntegrations, {
      FAKE_AGY_PERMISSION_MODE: "accept-edits",
      FAKE_AGY_INIT_HOLD_MS: POLICY_HOLD_MS,
      FAKE_AGY_TOOL_MARKER: marker,
    });
    expect(host.events.filter((e) => e.type === "turn.completed")[0]).toMatchObject({
      ok: false,
      stopReason: "host_control_policy",
    });
    const error = host.events.find((e) => e.type === "runtime.error") as any;
    expect(error.message).toBe(antigravityHostPolicyRefusal("accept-edits"));
    expect(error.message).toContain("is accept-edits");
    expect(existsSync(marker)).toBe(false);
  });

  it("stops a host-control turn under proceed-in-sandbox, whose host behaviour is unmeasured", async () => {
    // It auto-approves commands inside agy's terminal sandbox, and whether a
    // host command counts as inside depends on a setting this driver never
    // reads.  Unmeasured means refused, not assumed.
    const marker = join(home, "sandbox-policy-tool-ran");
    const host = await runTurn("sandbox-policy", false, hostIntegrations, {
      FAKE_AGY_PERMISSION_MODE: "proceed-in-sandbox",
      FAKE_AGY_INIT_HOLD_MS: POLICY_HOLD_MS,
      FAKE_AGY_TOOL_MARKER: marker,
    });
    expect(host.events.filter((e) => e.type === "turn.completed")[0]).toMatchObject({
      ok: false,
      stopReason: "host_control_policy",
    });
    const error = host.events.find((e) => e.type === "runtime.error") as any;
    expect(error.message).toContain("is proceed-in-sandbox");
    expect(existsSync(marker)).toBe(false);
  });

  it("runs a host-control turn under a policy that asks, and says so once", async () => {
    // `request-review` is agy's shipped default and it pauses for a human, so
    // there is nothing here for this driver to stop.
    const marker = join(home, "request-review-tool-ran");
    const host = await runTurn("request-review", false, hostIntegrations, {
      FAKE_AGY_PERMISSION_MODE: "request-review",
      FAKE_AGY_TOOL_MARKER: marker,
    });
    const completed = host.events.filter((e) => e.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ ok: true });
    expect(host.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(existsSync(marker)).toBe(true); // it really did reach its tool

    const notices = host.events.filter(
      (e) => e.type === "item.started" && (e as any).title === ANTIGRAVITY_HOST_CONTROL_NOTICE,
    );
    expect(notices).toHaveLength(1);
    const noticeId = (notices[0] as any).itemId as string;
    expect(
      host.events.filter((e) => e.type === "item.completed" && (e as any).itemId === noticeId),
    ).toHaveLength(1);
  });

  it("never gates a turn that has no host computer, whatever the policy says", async () => {
    // The gate is about the person's own desktop.  A Local VM or a VPS is
    // isolated, so `always-proceed` there is the owner's own call and this
    // driver has no business ending the turn over it.
    const marker = join(home, "sandbox-tool-ran");
    const sandbox = await runTurn("sandbox-policy", false, sandboxIntegrations, {
      FAKE_AGY_PERMISSION_MODE: "always-proceed",
      FAKE_AGY_TOOL_MARKER: marker,
    });
    expect(sandbox.events.filter((e) => e.type === "turn.completed")[0]).toMatchObject({ ok: true });
    expect(sandbox.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(
      sandbox.events.some((e) => (e as any).title === ANTIGRAVITY_HOST_CONTROL_NOTICE),
    ).toBe(false);
  });

  it("runs a host-control turn under always-proceed when turn has autoApprove: true", async () => {
    // When the operator configured autoApprove: true on the bot, always-proceed
    // is expected rather than an unbrokered hazard.  The turn must run to
    // completion without being killed by the policy guard.
    const marker = join(home, "auto-approved-always-proceed-ran");
    const host = await runTurn(
      "auto-approved-always-proceed",
      false,
      hostIntegrations,
      {
        FAKE_AGY_PERMISSION_MODE: "always-proceed",
        FAKE_AGY_TOOL_MARKER: marker,
      },
      undefined,
      true,
    );
    expect(host.events.filter((e) => e.type === "turn.completed")[0]).toMatchObject({ ok: true });
    expect(host.events.some((e) => e.type === "runtime.error")).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(
      host.events.some((e) => (e as any).title === ANTIGRAVITY_HOST_CONTROL_NOTICE),
    ).toBe(false);
  });
});
