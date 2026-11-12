import { afterEach, describe, expect, it } from "vitest";

import { infisicalSnapshot, resolveSecretFields, setInfisicalSnapshot } from "./secret-map.ts";
import {
  applySentryFleetConfig,
  buildFleetCapture,
  exportFleetTurn,
  resetSentryFleetForTests,
  resolveSentryFleetDsn,
  sentryFleetDsnFromEnv,
  sentryFleetState,
  setFleetSinkForTests,
  type FleetCapture,
} from "./sentry-fleet.ts";

const FLEET_DSN = "https://abc123@o0.ingest.sentry.io/99";

afterEach(() => {
  resetSentryFleetForTests();
  setInfisicalSnapshot(null, []);
  resolveSecretFields({}, {}, null);
  delete process.env.SENTRY_FLEET_DSN;
});

describe("fleet DSN resolution", () => {
  it("reads SENTRY_FLEET_DSN and ignores the product DSN name", () => {
    expect(sentryFleetDsnFromEnv({})).toBeUndefined();
    expect(sentryFleetDsnFromEnv({ SENTRY_FLEET_DSN: ` ${FLEET_DSN} ` })).toBe(FLEET_DSN);
    expect(sentryFleetDsnFromEnv({ SENTRY_DSN: FLEET_DSN })).toBeUndefined();
  });

  it("lets the vault beat env and the stored field", () => {
    const cfg = { observability: { sentryFleetDsn: "https://filekey@o0.ingest.sentry.io/2" } };
    setInfisicalSnapshot(new Map([["SENTRY_FLEET_DSN", FLEET_DSN]]), ["SENTRY_FLEET_DSN"]);
    resolveSecretFields(
      cfg,
      { SENTRY_FLEET_DSN: "https://envkey@o0.ingest.sentry.io/1" },
      infisicalSnapshot(),
    );
    expect(cfg.observability?.sentryFleetDsn).toBe(FLEET_DSN);
    expect(
      resolveSentryFleetDsn(cfg, { SENTRY_FLEET_DSN: "https://envkey@o0.ingest.sentry.io/1" }),
    ).toBe(FLEET_DSN);
  });

  it("uses env when the vault does not hold the name", () => {
    expect(
      resolveSentryFleetDsn({ observability: { sentryFleetDsn: "https://file@o0.ingest.sentry.io/2" } }, {
        SENTRY_FLEET_DSN: FLEET_DSN,
      }),
    ).toBe(FLEET_DSN);
  });
});

describe("fleet export", () => {
  it("stays inert without a DSN", () => {
    const state = applySentryFleetConfig(null);
    expect(state).toEqual({ active: false, configured: false, host: null, projectId: null });
    const captured: FleetCapture[] = [];
    setFleetSinkForTests({ capture: (event) => captured.push(event) });
    resetSentryFleetForTests();
    exportFleetTurn({
      conversationId: "turn-1",
      threadId: "thread-1",
      provider: "minimax",
      ok: true,
      durationMs: 10,
      toolNames: [],
    });
    expect(captured).toHaveLength(0);
    expect(sentryFleetState().active).toBe(false);
  });

  it("builds a gen_ai summary without prompts", () => {
    const event = buildFleetCapture({
      conversationId: "task-1",
      threadId: "thread-1",
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      ok: true,
      durationMs: 1200,
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.09,
      costSource: "catalog",
      toolNames: ["bash", "read"],
      botName: "Coder",
    });
    expect(event.message).toBe("botfleet gen_ai minimax MiniMax-M3.1-Flash");
    expect(event.tags.signal).toBe("agent");
    expect(event.tags.platform).toBe("botfleet");
    expect(event.tags["gen_ai.system"]).toBe("minimax");
    expect(event.tags["gen_ai.request.model"]).toBe("MiniMax-M3.1-Flash");
    expect(event.extra["gen_ai.usage.cost"]).toBe(0.09);
    expect(event.extra["botfleet.cost.estimated_usd"]).toBeUndefined();
    expect(event.extra["botfleet.tool.names"]).toBe("bash,read");
    expect(event.extra["gen_ai.input.messages"]).toBeUndefined();
    expect(event.extra["gen_ai.output.messages"]).toBeUndefined();
    expect(event.tags).not.toHaveProperty("prompt");
  });

  it("routes subscription estimates away from gen_ai.usage.cost", () => {
    const event = buildFleetCapture({
      conversationId: "task-est",
      threadId: "thread-est",
      provider: "openai",
      ok: true,
      durationMs: 1,
      cost: 0.02,
      costSource: "estimated",
      toolNames: [],
    });
    expect(event.extra["botfleet.cost.estimated_usd"]).toBe(0.02);
    expect(event.extra["gen_ai.usage.cost"]).toBeUndefined();
  });

  it("sends through the installed sink", () => {
    const captured: FleetCapture[] = [];
    setFleetSinkForTests({ capture: (event) => captured.push(event) });
    exportFleetTurn({
      conversationId: "task-2",
      threadId: "thread-2",
      provider: "deepseek",
      ok: false,
      durationMs: 40,
      toolNames: [],
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tags["botfleet.ok"]).toBe("false");
    expect(captured[0]?.tags["gen_ai.provider.name"]).toBe("deepseek");
  });

  it("never prints a DSN in the runtime state", () => {
    const state = applySentryFleetConfig(FLEET_DSN);
    expect(state.host).toBe("o0.ingest.sentry.io");
    expect(state.projectId).toBe("99");
    expect(JSON.stringify(state)).not.toContain("abc123");
  });
});
