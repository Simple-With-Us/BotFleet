import { describe, expect, it } from "vitest";

import {
  createConnectorInventoryProbe,
  safeConnectorFailure,
  type ConnectorIdentity,
} from "./composio-readiness.ts";
import type { AppConfig } from "./config.ts";

const cfg = {} as AppConfig;

describe("connected-app readiness", () => {
  it("coalesces only the same identity and preserves an authoritative empty success", async () => {
    let identity: ConnectorIdentity = { key: "first", configured: true };
    let calls = 0;
    let release: ((services: Record<string, { connected: boolean }>) => void) | undefined;
    const load = () => {
      calls += 1;
      return new Promise<Record<string, { connected: boolean }>>((resolve) => { release = resolve; });
    };
    let time = 100;
    const status = createConnectorInventoryProbe({ identify: () => identity, load, now: () => ++time });

    const first = status(cfg);
    const same = status(cfg);
    expect(calls).toBe(1);
    release?.({});

    await expect(first).resolves.toMatchObject({
      authoritative: true,
      services: {},
      readiness: { ready: true, state: "ready", lastSuccessAt: 101 },
    });
    await expect(same).resolves.toMatchObject({ authoritative: true, services: {} });

    identity = { key: "second", configured: true };
    void status(cfg);
    expect(calls).toBe(2);
  });

  it("discards an old success when the key changes while it is pending", async () => {
    let identity: ConnectorIdentity = { key: "old", configured: true };
    const releases: Array<(services: Record<string, { connected: boolean }>) => void> = [];
    const status = createConnectorInventoryProbe<{ connected: boolean }>({
      identify: () => identity,
      load: () => new Promise<Record<string, { connected: boolean }>>((resolve) => releases.push(resolve)),
      now: () => 500,
    });

    const oldRequest = status(cfg);
    identity = { key: "new", configured: true };
    const newRequest = status(cfg);
    releases[0]!({ stale: { connected: true } });
    releases[1]!({ current: { connected: true } });

    await expect(oldRequest).resolves.toMatchObject({
      authoritative: true,
      services: { current: { connected: true } },
      readiness: { state: "ready", lastSuccessAt: 500 },
    });
    await expect(newRequest).resolves.toMatchObject({ services: { current: { connected: true } } });
  });

  it("turns key removal during a pending request into authoritative unconfigured state", async () => {
    let identity: ConnectorIdentity = { key: "old", configured: true };
    let release: ((services: Record<string, never>) => void) | undefined;
    const status = createConnectorInventoryProbe<never>({
      identify: () => identity,
      load: () => new Promise((resolve) => { release = resolve; }),
      now: () => 700,
    });

    const request = status(cfg);
    identity = { key: null, configured: false };
    release?.({});
    await expect(request).resolves.toMatchObject({
      authoritative: true,
      services: {},
      readiness: { ready: false, configured: false, state: "unconfigured", lastSuccessAt: null },
    });
  });

  it("retains success time for one identity but never carries it onto another", async () => {
    let identity: ConnectorIdentity = { key: "one", configured: true };
    let fail = false;
    let time = 1_000;
    const status = createConnectorInventoryProbe({
      identify: () => identity,
      load: async () => {
        if (fail) throw Object.assign(new Error("private upstream body https://private.example"), { upstreamStatus: 503 });
        return { gmail: { connected: true } };
      },
      now: () => ++time,
    });

    await expect(status(cfg)).resolves.toMatchObject({ readiness: { lastSuccessAt: 1_001 } });
    fail = true;
    await expect(status(cfg)).resolves.toMatchObject({
      authoritative: false,
      readiness: {
        state: "degraded",
        lastSuccessAt: 1_001,
        failure: { kind: "upstream", message: "The connected-apps service is temporarily unavailable." },
      },
    });

    identity = { key: "two", configured: true };
    const changed = await status(cfg);
    expect(changed.readiness.lastSuccessAt).toBeNull();
    expect(JSON.stringify(changed)).not.toMatch(/private\.example|private upstream body/);
  });

  it("distinguishes pending, unreadable, unconfigured, and network failure", async () => {
    let identity: ConnectorIdentity = { key: "configured", configured: true };
    const status = createConnectorInventoryProbe<never>({
      identify: () => identity,
      load: async () => { throw new TypeError("fetch failed at https://private.example"); },
      now: () => 2_000,
    });

    await expect(status(cfg, "pending")).resolves.toMatchObject({
      authoritative: false,
      credentialStore: "pending",
      readiness: { state: "credential_pending", failure: { kind: "credential_pending" } },
    });
    await expect(status(cfg, "unreadable")).resolves.toMatchObject({
      authoritative: false,
      credentialStore: "unavailable",
      readiness: { state: "credential_unreadable", failure: { kind: "credential_unreadable" } },
    });
    await expect(status(cfg)).resolves.toMatchObject({
      authoritative: false,
      readiness: { state: "degraded", failure: { kind: "network" } },
    });
    identity = { key: null, configured: false };
    await expect(status(cfg)).resolves.toMatchObject({
      authoritative: true,
      readiness: { state: "unconfigured" },
    });
  });
});

describe("safe connected-app failures", () => {
  it("uses fixed messages for auth, permission, rate-limit, timeout, and invalid responses", () => {
    expect(safeConnectorFailure(Object.assign(new Error("private"), { upstreamStatus: 401 })).kind).toBe("authentication");
    expect(safeConnectorFailure(Object.assign(new Error("private"), { upstreamStatus: 403 })).kind).toBe("permission");
    expect(safeConnectorFailure(Object.assign(new Error("private"), { upstreamStatus: 429 })).kind).toBe("rate_limited");
    expect(safeConnectorFailure(Object.assign(new Error("private"), { name: "TimeoutError" })).kind).toBe("timeout");
    expect(safeConnectorFailure(Object.assign(new Error("private"), { name: "ZodError" })).kind).toBe("invalid_response");
    expect(safeConnectorFailure(new SyntaxError("Unexpected end of JSON input")).kind).toBe("invalid_response");
  });
});
