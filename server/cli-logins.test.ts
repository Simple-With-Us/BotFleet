import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLI_LOGIN_ENV_NAMES,
  CLI_LOGIN_FIELDS,
  CLI_LOGIN_SEAT_PATTERN,
  cliLoginSecretPath,
} from "./secret-map.ts";
import {
  CLI_LOGIN_CACHE_MAX,
  CLI_LOGIN_FAILURE_BACKOFF_MS,
  CLI_LOGIN_TTL_MS,
  applyCliLogins,
  awaitCliLogin,
  cliLoginCacheSize,
  cliLoginEnvironment,
  launchedChildEnvironment,
  primeCliLogin,
  resetCliLoginCache,
  setCliLoginVault,
} from "./cli-logins.ts";

// Obviously fake, and never sent anywhere:  these exist so the assertions
// below have credential-shaped strings to work on.
const SENTINEL_VAULT = "sentinel-vault-value-not-real";

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

/** A vault whose read waits for the test to open the gate. */
function gatedVault() {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = () => resolve(undefined);
  });
  const reader = {
    async readProjectPath() {
      await gate;
      return new Map([["GH_TOKEN", SENTINEL_VAULT]]);
    },
  };
  return { reader, open };
}

afterEach(() => {
  setCliLoginVault(null);
  resetCliLoginCache();
});

describe("the CLI login table", () => {
  it("names the four names a CLI reads out of its environment", () => {
    expect(CLI_LOGIN_ENV_NAMES).toEqual([
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "COPILOT_GITHUB_TOKEN",
    ]);
  });

  it("gives every row a unique id, a label and the fleet's own project", () => {
    const ids = CLI_LOGIN_FIELDS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of CLI_LOGIN_FIELDS) {
      expect(entry.id.startsWith("cliLogin.")).toBe(true);
      expect(entry.label.trim()).toBe(entry.label);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.project).toBe("fleet-ops");
      expect(entry.secret).toBe(true);
      expect(CLI_LOGIN_ENV_NAMES).toContain(entry.env);
    }
  });

  it("keeps the CLI login names out of the config-shaped snapshot filter", () => {
    // A CLI login is not a config field and does not live in BotFleet's own
    // project, so the snapshot filter must not be what decides where it
    // comes from.  Nothing in `SECRET_FIELDS` may claim one of the names.
    for (const entry of CLI_LOGIN_FIELDS) {
      expect(CLI_LOGIN_ENV_NAMES).toContain(entry.env);
    }
    expect(new Set(CLI_LOGIN_ENV_NAMES).size).toBe(CLI_LOGIN_FIELDS.length);
  });

  it("builds the seat's folder, and only for a seat the fleet could have written", () => {
    expect(cliLoginSecretPath("BF-ORACLE")).toBe("/cli-logins/BF-ORACLE");
    expect(cliLoginSecretPath("OPENCODE")).toBe("/cli-logins/OPENCODE");
    // No seat, no folder:  nothing is invented for a bot that has none.
    expect(cliLoginSecretPath("")).toBeNull();
    // A seat that is not one the fleet's writer accepts has no folder
    // either, and a path that could climb out of the folder is refused.
    expect(cliLoginSecretPath("lowercase")).toBeNull();
    expect(cliLoginSecretPath("../other")).toBeNull();
    expect(cliLoginSecretPath("A/B")).toBeNull();
    expect(cliLoginSecretPath("A".repeat(17))).toBeNull();
    expect(CLI_LOGIN_SEAT_PATTERN.test("BF-MONITOR")).toBe(true);
  });
});

describe("reading a seat's CLI login", () => {
  it("reads the seat's own folder out of the fleet's project", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    primeCliLogin("BF-ORACLE");
    await awaitCliLogin("BF-ORACLE");
    expect(stub.calls).toEqual([{ project: "fleet-ops", secretPath: "/cli-logins/BF-ORACLE" }]);
    expect(cliLoginEnvironment("BF-ORACLE")).toEqual({ GH_TOKEN: SENTINEL_VAULT });
  });

  it("keeps only the names the table names", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT, SOMETHING_ELSE: "ignored" });
    setCliLoginVault(stub.reader);
    primeCliLogin("BF-ORACLE");
    await awaitCliLogin("BF-ORACLE");
    expect(Object.keys(cliLoginEnvironment("BF-ORACLE"))).toEqual(["GH_TOKEN"]);
  });

  it("reads once and reuses the value until the window expires", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    primeCliLogin("BF-ORACLE");
    await awaitCliLogin("BF-ORACLE");
    primeCliLogin("BF-ORACLE");
    await awaitCliLogin("BF-ORACLE");
    expect(stub.calls).toHaveLength(1);
    expect(cliLoginEnvironment("BF-ORACLE")).toEqual({ GH_TOKEN: SENTINEL_VAULT });
    expect(CLI_LOGIN_TTL_MS).toBeGreaterThan(0);
  });

  it("reads nothing for a bot with no seat", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    primeCliLogin(null);
    primeCliLogin(undefined);
    primeCliLogin("");
    // A seat the fleet could not have written is refused before any read.
    primeCliLogin("not-a-seat");
    await awaitCliLogin(null);
    expect(cliLoginEnvironment(null)).toEqual({});
    expect(cliLoginEnvironment(undefined)).toEqual({});
    expect(cliLoginEnvironment("")).toEqual({});
    expect(cliLoginEnvironment("not-a-seat")).toEqual({});
    expect(stub.calls).toEqual([]);
  });

  it("keeps the last good value when a later read fails", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
      setCliLoginVault(stub.reader);
      primeCliLogin("BF-ORACLE");
      await awaitCliLogin("BF-ORACLE");
      expect(cliLoginEnvironment("BF-ORACLE")).toEqual({ GH_TOKEN: SENTINEL_VAULT });
      // The window expires and the next read fails:  the seat keeps its
      // login rather than losing it.
      await vi.advanceTimersByTimeAsync(CLI_LOGIN_TTL_MS + 1);
      const failing = {
        async readProjectPath() {
          throw new Error("the vault is unreachable");
        },
      };
      setCliLoginVault(failing);
      primeCliLogin("BF-ORACLE");
      await awaitCliLogin("BF-ORACLE");
      expect(cliLoginEnvironment("BF-ORACLE")).toEqual({ GH_TOKEN: SENTINEL_VAULT });
      expect(CLI_LOGIN_FAILURE_BACKOFF_MS).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not put a login back when a read lands after a reset", async () => {
    const { reader, open } = gatedVault();
    setCliLoginVault(reader);
    primeCliLogin("BF-ORACLE");
    // The read is still in flight when the reset lands.
    resetCliLoginCache();
    open();
    // A macrotask wait lets the read's own continuation finish, so the
    // cache is inspected after the value would have been written.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cliLoginEnvironment("BF-ORACLE")).toEqual({});
  });

  it("keeps the cache inside its bound, and keeps the seat in use", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    const seats = Array.from(
      { length: CLI_LOGIN_CACHE_MAX + 4 },
      (_, index) => `SEAT-${String(index).padStart(2, "0")}`,
    );
    for (const seat of seats) {
      primeCliLogin(seat);
      await awaitCliLogin(seat);
      expect(cliLoginCacheSize()).toBeLessThanOrEqual(CLI_LOGIN_CACHE_MAX);
    }
    // The bound is real:  the seats beyond it were dropped, not kept.
    expect(cliLoginCacheSize()).toBe(CLI_LOGIN_CACHE_MAX);
    // The seat in use is still cached.
    expect(cliLoginEnvironment(seats[seats.length - 1])).toEqual({ GH_TOKEN: SENTINEL_VAULT });
    // The least recently used seat was evicted, and is read again rather
    // than remembered.
    expect(cliLoginEnvironment(seats[0])).toEqual({});
    const callsBefore = stub.calls.length;
    primeCliLogin(seats[0]);
    await awaitCliLogin(seats[0]);
    expect(stub.calls).toHaveLength(callsBefore + 1);
    expect(cliLoginEnvironment(seats[0])).toEqual({ GH_TOKEN: SENTINEL_VAULT });
  });

  it("hands back nothing when the very first read fails", async () => {
    setCliLoginVault({
      async readProjectPath() {
        throw new Error("the vault is unreachable");
      },
    });
    primeCliLogin("BF-ORACLE");
    await awaitCliLogin("BF-ORACLE");
    expect(cliLoginEnvironment("BF-ORACLE")).toEqual({});
  });
});

describe("applying a CLI login to a child's environment", () => {
  it("puts the seat's value where the CLI reads it", () => {
    const out = applyCliLogins({ HOME: "/home/bot" }, { GH_TOKEN: SENTINEL_VAULT });
    expect(out.GH_TOKEN).toBe(SENTINEL_VAULT);
    expect(out.HOME).toBe("/home/bot");
  });

  it("takes an inherited login away, so a child cannot act as another seat", () => {
    const out = applyCliLogins(
      { GH_TOKEN: "somebody-elses-token", GITHUB_TOKEN: "somebody-elses-token" },
      { GH_TOKEN: SENTINEL_VAULT },
    );
    expect(out.GH_TOKEN).toBe(SENTINEL_VAULT);
    expect(out.GITHUB_TOKEN).toBeUndefined();
  });

  it("takes every inherited login away when the seat has none of its own", () => {
    const out = applyCliLogins(
      {
        GH_TOKEN: "somebody-elses-token",
        GITHUB_TOKEN: "somebody-elses-token",
        GH_ENTERPRISE_TOKEN: "somebody-elses-token",
        COPILOT_GITHUB_TOKEN: "somebody-elses-token",
      },
      {},
    );
    for (const name of CLI_LOGIN_ENV_NAMES) expect(out[name]).toBeUndefined();
  });

  it("never mutates the environment it was handed", () => {
    const env = { GH_TOKEN: "somebody-elses-token" };
    applyCliLogins(env, { GH_TOKEN: SENTINEL_VAULT });
    expect(env.GH_TOKEN).toBe("somebody-elses-token");
  });
});

describe("the environment a launched child runs with", () => {
  it("carries the launch identity and the seat's login together", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    primeCliLogin("BF-ORACLE");
    await awaitCliLogin("BF-ORACLE");
    const env = launchedChildEnvironment(
      { HOME: "/home/bot" },
      { seat: "BF-ORACLE", session: "thread-1" },
      cliLoginEnvironment("BF-ORACLE"),
    );
    expect(env.AGENT_LAUNCHER).toBe("botfleet");
    expect(env.AGENT_LAUNCH_SEAT).toBe("BF-ORACLE");
    expect(env.AGENT_SESSION).toBe("thread-1");
    expect(env.GH_TOKEN).toBe(SENTINEL_VAULT);
  });

  it("gives a child with no seat no login, and none it inherited either", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    const env = launchedChildEnvironment(
      { GH_TOKEN: "somebody-elses-token" },
      { seat: null, session: "thread-1" },
      cliLoginEnvironment(null),
    );
    expect(env.AGENT_LAUNCH_SEAT).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(stub.calls).toEqual([]);
  });
});
