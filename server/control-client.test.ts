import { describe, expect, it } from "vitest";

import {
  CONTROL_REFUSAL_PLAIN,
  CONTROL_UNCONFIRMED,
  controlRefusal,
  createControlClient,
} from "./control-client.ts";

describe("createControlClient", () => {
  it("stays disengaged when URL or token is missing", async () => {
    const client = createControlClient({
      url: "",
      token: "",
      fetchImpl: async () => {
        throw new Error("must not fetch when unconfigured");
      },
    });
    expect(client.configured).toBe(false);
    await expect(client.state(true)).resolves.toEqual({ held: false, helpOpen: false });
  });

  it("fails closed as unconfirmed when the harness fetch throws", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () => {
        throw new Error("harness down");
      },
    });
    const state = await client.state(true);
    expect(state).toEqual({ held: true, helpOpen: false, blockedReason: CONTROL_UNCONFIRMED });
    expect(controlRefusal(state)).toBe(CONTROL_UNCONFIRMED);
    expect(controlRefusal(state)).not.toBe(CONTROL_REFUSAL_PLAIN);
  });

  it("fails closed as unconfirmed when the harness returns non-ok", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });
    await expect(client.state(true)).resolves.toEqual({
      held: true,
      helpOpen: false,
      blockedReason: CONTROL_UNCONFIRMED,
    });
  });

  it("fails closed as unconfirmed when the body is not a hold", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () => new Response("not-json", { status: 200 }),
    });
    await expect(client.state(true)).resolves.toEqual({
      held: true,
      helpOpen: false,
      blockedReason: CONTROL_UNCONFIRMED,
    });
  });

  it("does not call a hold a person unless the harness says so", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ held: true, helpOpen: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const state = await client.state(true);
    expect(state.reason).toBeUndefined();
    expect(controlRefusal(state)).toBe(CONTROL_UNCONFIRMED);
  });

  it("keeps a person's hold in the harness's own words", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ held: true, helpOpen: true, reason: "person" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const state = await client.state(true);
    expect(state).toEqual({ held: true, helpOpen: true, reason: "person" });
    expect(controlRefusal(state)).toBe(CONTROL_REFUSAL_PLAIN);
  });

  it("returns the harness hold when the read succeeds", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ held: false, helpOpen: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await expect(client.state(true)).resolves.toEqual({ held: false, helpOpen: true });
  });

  it("waits out a slow honest answer instead of calling it a person", async () => {
    const client = createControlClient({
      url: "http://127.0.0.1:9/control",
      token: "test-token",
      timeoutMs: 1_000,
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response(JSON.stringify({ held: false, helpOpen: false, blockedReason: "busy" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const state = await client.state(true);
    expect(state).toEqual({ held: false, helpOpen: false, blockedReason: "busy" });
    expect(controlRefusal(state)).not.toBe(CONTROL_REFUSAL_PLAIN);
  });
});
