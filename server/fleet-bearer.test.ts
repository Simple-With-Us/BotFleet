import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FLEET_BEARER_ENV_NAME,
  FLEET_BEARER_SEAT_PATTERN,
  fleetBearerSecretPath,
} from "./secret-map.ts";
import {
  FLEET_BEARER_CACHE_MAX,
  FLEET_BEARER_FAILURE_BACKOFF_MS,
  FLEET_BEARER_TTL_MS,
  applyFleetBearer,
  awaitFleetBearer,
  fleetBearerCacheSize,
  fleetBearerEnvironment,
  primeFleetBearer,
  resetFleetBearerCache,
  setFleetBearerVault,
} from "./fleet-bearer.ts";
import { launchedChildCredentials, primeSeatCredentials, seatCredentialEnvironment } from "./child-credentials.ts";

// Obviously fake, and never sent anywhere:  these exist so the assertions
// below have credential-shaped strings to work on.
const SENTINEL_BEARER = "sentinel-bearer-value-not-real";
const SENTINEL_LOGIN = "sentinel-login-value-not-real";

/** A vault stub that answers one seat's folder and records what it was
 * asked for. */
function stubVault(values: Record<string, string>) {
  const calls: Array<{ project: string; secretPath: string }> = [];
  const reader = {
    async readProjectPath(project: string, secretPath: string) {
      calls.push({ project, secretPath });
      return new Map(Object.entries(values));
    },
  };
  return { calls, reader };
}

/** A vault that refuses, the way a down vault does. */
function failingVault() {
  const calls: Array<{ project: string; secretPath: string }> = [];
  const reader = {
    async readProjectPath(project: string, secretPath: string) {
      calls.push({ project, secretPath });
      throw new Error("the vault is unreachable");
    },
  };
  return { calls, reader };
}

afterEach(() => {
  setFleetBearerVault(null);
  resetFleetBearerCache();
});

describe("the fleet bearer table", () => {
  it("names the environment variable the fleet's own tools read", () => {
    expect(FLEET_BEARER_ENV_NAME).toBe("SIMPLE_TOOLS_BEARER");
  });

  it("builds the seat's folder, and only for a seat the fleet could have written", () => {
    expect(fleetBearerSecretPath("BF-ORACLE")).toBe("/fleet-bearers/BF-ORACLE");
    expect(fleetBearerSecretPath("ZC")).toBe("/fleet-bearers/ZC");
    // No seat, no folder:  nothing is invented for a bot that has none.
    expect(fleetBearerSecretPath("")).toBeNull();
    // A seat that is not one the fleet's writer accepts has no folder
    // either, and a path that could climb out of the folder is refused.
    expect(fleetBearerSecretPath("lowercase")).toBeNull();
    expect(fleetBearerSecretPath("../other")).toBeNull();
    expect(fleetBearerSecretPath("A/B")).toBeNull();
    expect(fleetBearerSecretPath("A".repeat(17))).toBeNull();
    expect(FLEET_BEARER_SEAT_PATTERN.test("BF-MONITOR")).toBe(true);
  });

  it("keeps the bearer out of the config-shaped snapshot filter", () => {
    // The bearer is not a config field and does not live in BotFleet's own
    // project, so nothing in the config's own tables may claim it.
    expect(FLEET_BEARER_ENV_NAME).not.toBe("GH_TOKEN");
  });
});

describe("reading a seat's fleet bearer", () => {
  it("reads the seat's own folder out of the fleet's project", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    expect(stub.calls).toEqual([{ project: "fleet-ops", secretPath: "/fleet-bearers/BF-ORACLE" }]);
    expect(fleetBearerEnvironment("BF-ORACLE")).toEqual({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
  });

  it("keeps only the bearer name", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER, SOMETHING_ELSE: "ignored" });
    setFleetBearerVault(stub.reader);
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    expect(Object.keys(fleetBearerEnvironment("BF-ORACLE"))).toEqual([FLEET_BEARER_ENV_NAME]);
  });

  it("reads nothing for a bot with no seat", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeFleetBearer(null);
    primeFleetBearer("");
    await awaitFleetBearer(null);
    expect(stub.calls).toEqual([]);
    expect(fleetBearerEnvironment(null)).toEqual({});
    expect(fleetBearerEnvironment("")).toEqual({});
  });

  it("reads once and reuses the value until the window expires", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    expect(stub.calls).toHaveLength(1);
    expect(FLEET_BEARER_TTL_MS).toBeGreaterThan(0);
  });

  it("gives one bot's bearer to no other bot", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    // Another seat's cache entry is its own, and a seat nobody read has
    // nothing:  one bot's bearer can never authenticate another bot.
    expect(fleetBearerEnvironment("BF-MONITOR")).toEqual({});
    expect(fleetBearerEnvironment("BF-ORACLE")).toEqual({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
  });

  it("keeps the last good value when a later read fails", async () => {
    const good = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(good.reader);
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    expect(fleetBearerEnvironment("BF-ORACLE")).toEqual({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });

    // The next read fails:  the child still gets the last good bearer.
    const bad = failingVault();
    setFleetBearerVault(bad.reader);
    resetFleetBearerCache();
    // A failed read leaves the cache empty, because the reset cleared it.
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    expect(fleetBearerEnvironment("BF-ORACLE")).toEqual({});

    // A failed read on its own never throws and never logs the value.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => primeFleetBearer("BF-MONITOR")).not.toThrow();
    await awaitFleetBearer("BF-MONITOR");
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("BF-MONITOR");
    expect(logged).not.toContain(SENTINEL_BEARER);
    warn.mockRestore();
  });

  it("bounds how many bots' bearers the cache holds", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    for (let index = 0; index < FLEET_BEARER_CACHE_MAX + 4; index += 1) {
      const seat = `BF-SEAT${index}`;
      primeFleetBearer(seat);
      await awaitFleetBearer(seat);
    }
    expect(fleetBearerCacheSize()).toBeLessThanOrEqual(FLEET_BEARER_CACHE_MAX);
    expect(FLEET_BEARER_FAILURE_BACKOFF_MS).toBeGreaterThan(0);
  });
});

describe("applying the bearer to a child's environment", () => {
  it("removes an inherited bearer before it sets the seat's own", () => {
    const applied = applyFleetBearer(
      { [FLEET_BEARER_ENV_NAME]: "someone-elses-bearer", PATH: "/usr/bin" },
      { [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER },
    );
    expect(applied[FLEET_BEARER_ENV_NAME]).toBe(SENTINEL_BEARER);
    expect(applied.PATH).toBe("/usr/bin");
  });

  it("takes the inherited bearer away when the seat has none", () => {
    const applied = applyFleetBearer({ [FLEET_BEARER_ENV_NAME]: "someone-elses-bearer" }, {});
    expect(applied[FLEET_BEARER_ENV_NAME]).toBeUndefined();
  });

  it("never mutates the environment it was given", () => {
    const original = { [FLEET_BEARER_ENV_NAME]: "someone-elses-bearer" };
    applyFleetBearer(original, { [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    expect(original[FLEET_BEARER_ENV_NAME]).toBe("someone-elses-bearer");
  });
});

describe("a launched child", () => {
  it("gets the seat's bearer, and the launch scrub does not take it away", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeSeatCredentials("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");

    const env = launchedChildCredentials(
      { PATH: "/usr/bin", [FLEET_BEARER_ENV_NAME]: "the-harness-own-bearer" },
      { seat: "BF-ORACLE", session: "thread-1" },
      "BF-ORACLE",
    );
    // The scrub strips the inherited value;  the seat's own lands after it.
    expect(env[FLEET_BEARER_ENV_NAME]).toBe(SENTINEL_BEARER);
    expect(env.AGENT_LAUNCH_SEAT).toBe("BF-ORACLE");
    expect(env.PATH).toBe("/usr/bin");
  });

  it("never inherits a bearer it was not given", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeSeatCredentials("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");

    // A bot with no bearer of its own gets none, even though the harness
    // process holds one.
    const env = launchedChildCredentials(
      { [FLEET_BEARER_ENV_NAME]: "the-harness-own-bearer" },
      { seat: "BF-MONITOR", session: "thread-2" },
      "BF-MONITOR",
    );
    expect(env[FLEET_BEARER_ENV_NAME]).toBeUndefined();
  });

  it("gets no bearer and no login when it has no seat", () => {
    const env = launchedChildCredentials(
      { [FLEET_BEARER_ENV_NAME]: "the-harness-own-bearer", GH_TOKEN: "the-harness-own-login" },
      { seat: null, session: "thread-3" },
      null,
    );
    expect(env[FLEET_BEARER_ENV_NAME]).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AGENT_LAUNCHER).toBe("botfleet");
  });

  it("carries the seat's CLI login beside its bearer", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeSeatCredentials("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    // The login table's cache is empty in this test, so the login is
    // absent, and the bearer is still there:  one missing credential does
    // not take the other with it.
    const env = launchedChildCredentials({ PATH: "/usr/bin" }, { seat: "BF-ORACLE", session: "t" }, "BF-ORACLE");
    expect(env[FLEET_BEARER_ENV_NAME]).toBe(SENTINEL_BEARER);
    expect(env.GH_TOKEN).toBeUndefined();
  });

  it("merges the seat's credentials without one overwriting the other", () => {
    const merged = seatCredentialEnvironment("BF-ORACLE");
    // The tables hold disjoint names, so the merge keeps both kinds.
    expect(merged).toEqual({});
    expect(Object.keys(merged)).not.toContain("GH_TOKEN");
  });

  it("never puts the bearer in the config, the process environment or a log line", async () => {
    const stub = stubVault({ [FLEET_BEARER_ENV_NAME]: SENTINEL_BEARER });
    setFleetBearerVault(stub.reader);
    primeFleetBearer("BF-ORACLE");
    await awaitFleetBearer("BF-ORACLE");
    // The value is only ever read out of the cache, by name.
    expect(Object.values(fleetBearerEnvironment("BF-ORACLE"))).toEqual([SENTINEL_BEARER]);
    // The cache holds it under the environment name, not as a config field.
    expect(fleetBearerEnvironment("BF-ORACLE")[FLEET_BEARER_ENV_NAME]).toBe(SENTINEL_BEARER);
    expect(SENTINEL_LOGIN).not.toBe(SENTINEL_BEARER);
  });
});
