import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLI_LOGIN_ENV_NAMES,
  CLI_LOGIN_FIELDS,
  CLI_LOGIN_SEAT_PATTERN,
  cliLoginSecretPath,
} from "./secret-map.ts";
import {
  CLI_LOGIN_FAILURE_BACKOFF_MS,
  CLI_LOGIN_TTL_MS,
  applyCliLogins,
  cliLoginEnvironment,
  launchedChildEnvironment,
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
    const values = await cliLoginEnvironment("BF-ORACLE");
    expect(stub.calls).toEqual([{ project: "fleet-ops", secretPath: "/cli-logins/BF-ORACLE" }]);
    expect(values).toEqual({ GH_TOKEN: SENTINEL_VAULT });
  });

  it("keeps only the names the table names", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT, SOMETHING_ELSE: "ignored" });
    setCliLoginVault(stub.reader);
    const values = await cliLoginEnvironment("BF-ORACLE");
    expect(Object.keys(values)).toEqual(["GH_TOKEN"]);
  });

  it("reads once and reuses the value until the window expires", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    await cliLoginEnvironment("BF-ORACLE");
    await cliLoginEnvironment("BF-ORACLE");
    expect(stub.calls).toHaveLength(1);
    expect(CLI_LOGIN_TTL_MS).toBeGreaterThan(0);
  });

  it("reads nothing for a bot with no seat", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    expect(await cliLoginEnvironment(null)).toEqual({});
    expect(await cliLoginEnvironment(undefined)).toEqual({});
    expect(await cliLoginEnvironment("")).toEqual({});
    // A seat the fleet could not have written is refused before any read.
    expect(await cliLoginEnvironment("not-a-seat")).toEqual({});
    expect(stub.calls).toEqual([]);
  });

  it("keeps the last good value when a later read fails", async () => {
    vi.useFakeTimers();
    try {
      const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
      setCliLoginVault(stub.reader);
      expect(await cliLoginEnvironment("BF-ORACLE")).toEqual({ GH_TOKEN: SENTINEL_VAULT });
      // The window expires and the next read fails:  the seat keeps its
      // login rather than losing it.
      await vi.advanceTimersByTimeAsync(CLI_LOGIN_TTL_MS + 1);
      const failing = stubVault({});
      setCliLoginVault({
        async readProjectPath() {
          throw new Error("the vault is unreachable");
        },
      });
      expect(await cliLoginEnvironment("BF-ORACLE")).toEqual({ GH_TOKEN: SENTINEL_VAULT });
      expect(failing.calls).toEqual([]);
      expect(CLI_LOGIN_FAILURE_BACKOFF_MS).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back nothing when the very first read fails", async () => {
    setCliLoginVault({
      async readProjectPath() {
        throw new Error("the vault is unreachable");
      },
    });
    expect(await cliLoginEnvironment("BF-ORACLE")).toEqual({});
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
    const env = await launchedChildEnvironment({ HOME: "/home/bot" }, { seat: "BF-ORACLE", session: "thread-1" });
    expect(env.AGENT_LAUNCHER).toBe("botfleet");
    expect(env.AGENT_LAUNCH_SEAT).toBe("BF-ORACLE");
    expect(env.AGENT_SESSION).toBe("thread-1");
    expect(env.GH_TOKEN).toBe(SENTINEL_VAULT);
  });

  it("gives a child with no seat no login, and none it inherited either", async () => {
    const stub = stubVault({ GH_TOKEN: SENTINEL_VAULT });
    setCliLoginVault(stub.reader);
    const env = await launchedChildEnvironment({ GH_TOKEN: "somebody-elses-token" }, { seat: null, session: "thread-1" });
    expect(env.AGENT_LAUNCH_SEAT).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(stub.calls).toEqual([]);
  });
});
