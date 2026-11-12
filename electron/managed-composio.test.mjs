import { describe, expect, it, vi } from "vitest";
import {
  MANAGED_COMPOSIO_SERVICE,
  ensureManagedComposioCredentials,
  managedComposioAccess,
  managedComposioChildEnvironment,
  normalizeManagedComposioBrokerUrl,
  preflightManagedComposioBroker,
} from "./managed-composio.mjs";

const TOKEN = "a".repeat(64);
const healthBody = { service: MANAGED_COMPOSIO_SERVICE, ready: true };
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe("managed Composio desktop registration", () => {
  it("publishes only a complete broker credential", () => {
    expect(managedComposioAccess("https://broker.example/", { composioBrokerToken: TOKEN })).toEqual({
      url: "https://broker.example",
      token: TOKEN,
    });
    expect(managedComposioAccess("https://broker.example", {})).toBeNull();
    expect(managedComposioAccess("", { composioBrokerToken: TOKEN })).toBeNull();
  });

  it("accepts HTTPS and loopback development brokers but rejects insecure remote URLs", async () => {
    expect(normalizeManagedComposioBrokerUrl("https://broker.example/root/")).toBe(
      "https://broker.example/root",
    );
    expect(normalizeManagedComposioBrokerUrl("http://127.0.0.1:8787/")).toBe(
      "http://127.0.0.1:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://localhost:8787")).toBe(
      "http://localhost:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://[::1]:8787/")).toBe(
      "http://[::1]:8787",
    );
    expect(normalizeManagedComposioBrokerUrl("http://broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://user:secret@broker.example")).toBe("");
    expect(normalizeManagedComposioBrokerUrl("https://broker.example?redirect=evil")).toBe("");

    const fetchImpl = vi.fn();
    const credentials = { composioBrokerToken: TOKEN };
    await ensureManagedComposioCredentials({
      brokerUrl: "http://broker.example",
      credentials,
      fetchImpl,
      saveCredentials: vi.fn(),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(managedComposioAccess("http://broker.example", credentials)).toBeNull();
    expect(
      managedComposioChildEnvironment("http://broker.example", credentials, {
        PATH: "/usr/bin",
        OMB_COMPOSIO_BROKER_URL: "http://attacker.example",
        OMB_COMPOSIO_BROKER_TOKEN: "attacker-controlled",
      }),
    ).toEqual({ PATH: "/usr/bin" });
    expect(
      managedComposioChildEnvironment("http://[::1]:8787", credentials, { PATH: "/usr/bin" }),
    ).toEqual({
      PATH: "/usr/bin",
      OMB_COMPOSIO_BROKER_URL: "http://[::1]:8787",
      OMB_COMPOSIO_BROKER_TOKEN: TOKEN,
    });
  });

  it("requires the broker to identify itself before any credential is minted", async () => {
    const timeoutSignal = vi.fn(() => new AbortController().signal);
    await expect(preflightManagedComposioBroker({ brokerUrl: "" })).resolves.toMatchObject({ ok: false });
    await expect(
      preflightManagedComposioBroker({
        brokerUrl: "https://broker.example/",
        fetchImpl: vi.fn(async () => jsonResponse(healthBody)),
        timeoutSignal,
      }),
    ).resolves.toEqual({ ok: true, reason: "" });
    expect(timeoutSignal).toHaveBeenCalledWith(5_000);

    // The renamed Worker: Cloudflare answers 404 "error code: 1042".
    await expect(
      preflightManagedComposioBroker({
        brokerUrl: "https://broker.example",
        fetchImpl: vi.fn(async () => ({ ok: false, status: 404, json: async () => { throw new Error("html"); } })),
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("HTTP 404") });
    // A live Worker with a different identity (the pre-rename third-party host).
    await expect(
      preflightManagedComposioBroker({
        brokerUrl: "https://broker.example",
        fetchImpl: vi.fn(async () => jsonResponse({ service: "openmausbot-composio", ready: true })),
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("not a BotFleet connected-apps service") });
    // Right identity, but no project key behind it yet.
    await expect(
      preflightManagedComposioBroker({
        brokerUrl: "https://broker.example",
        fetchImpl: vi.fn(async () => jsonResponse({ service: MANAGED_COMPOSIO_SERVICE, ready: false })),
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("not ready") });
    await expect(
      preflightManagedComposioBroker({
        brokerUrl: "https://broker.example",
        fetchImpl: vi.fn(async () => { throw new Error("offline"); }),
      }),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("could not be reached") });
  });

  it("skips registration and reports a visible failure when the preflight fails", async () => {
    const credentials = {};
    const saveCredentials = vi.fn(async () => {});
    const report = vi.fn();
    const log = vi.fn();
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, json: async () => null }));

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl,
      saveCredentials,
      report,
      log,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://broker.example/health");
    expect(credentials).toEqual({});
    expect(saveCredentials).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      status: "failed",
      message: expect.stringContaining("HTTP 404"),
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("registration skipped"));
  });

  it("registers a new installation and persists it", async () => {
    const credentials = {};
    const saveCredentials = vi.fn(async () => {});
    const report = vi.fn();
    const fetchImpl = vi.fn(async (url) =>
      String(url).endsWith("/health")
        ? jsonResponse(healthBody)
        : jsonResponse({ token: TOKEN, installationId: "installation-test" }),
    );

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl,
      saveCredentials,
      report,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://broker.example/v1/installations",
      expect.objectContaining({ method: "POST", redirect: "error" }),
    );
    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).toHaveBeenCalledWith(credentials);
    expect(report).toHaveBeenLastCalledWith({ status: "ready" });
  });

  it("settles a stalled optional registration without storing partial credentials", async () => {
    vi.useFakeTimers();
    try {
      const credentials = {};
      const saveCredentials = vi.fn(async () => {});
      const log = vi.fn();
      const fetchImpl = vi.fn((url, init) =>
        String(url).endsWith("/health")
          ? Promise.resolve(jsonResponse(healthBody))
          : new Promise((_resolve, reject) => {
              init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
            }),
      );
      const operation = ensureManagedComposioCredentials({
        brokerUrl: "https://broker.example",
        credentials,
        fetchImpl,
        saveCredentials,
        log,
        registrationTimeoutMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(operation).resolves.toBe(credentials);
      expect(credentials).toEqual({});
      expect(saveCredentials).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("registration failed"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a valid installation identity during a transient broker outage", async () => {
    const credentials = {
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    };
    const saveCredentials = vi.fn(async () => {});

    await ensureManagedComposioCredentials({
      brokerUrl: "https://broker.example",
      credentials,
      fetchImpl: vi.fn(async () => {
        throw new Error("offline");
      }),
      saveCredentials,
    });

    expect(credentials).toEqual({
      composioBrokerToken: TOKEN,
      composioInstallationId: "installation-test",
    });
    expect(saveCredentials).not.toHaveBeenCalled();
  });
});
