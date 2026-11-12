// The rule this module exists to enforce: "I could not read the store" and
// "the store is empty" are DIFFERENT ANSWERS. Collapsing them is what made a
// keychain hiccup look like the user had never connected anything.
import { describe, expect, it, vi } from "vitest";

import {
  applySafeStorageMigration,
  parseSafeStorageMigrationText,
  readSecureCredentials,
  SAFE_STORAGE_EXPORT_FLAG,
  wantsSafeStorageExport,
} from "./secure-credentials.mjs";

const transient = () =>
  new Error("safeStorage.decryptStringAsync is temporarily unavailable. Please try again.");

/** deps with sane defaults; each test overrides the one thing it is about */
const deps = (over = {}) => ({
  exists: () => true,
  isAvailable: async () => true,
  readFile: () => Buffer.from("cipher"),
  decrypt: async () => JSON.stringify({ composioApiKey: "ak_live" }),
  sleep: async () => {},
  ...over,
});

describe("readSecureCredentials", () => {
  it("reports an empty store when no file was ever written", async () => {
    const result = await readSecureCredentials(deps({ exists: () => false }));
    expect(result).toEqual({ status: "empty", credentials: {} });
  });

  it("returns the stored credentials when the store opens", async () => {
    const result = await readSecureCredentials(deps());
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("tries again when the OS says the store is temporarily unavailable", async () => {
    const decrypt = vi
      .fn()
      .mockRejectedValueOnce(transient())
      .mockRejectedValueOnce(transient())
      .mockResolvedValue(JSON.stringify({ composioApiKey: "ak_live" }));
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(decrypt).toHaveBeenCalledTimes(3);
    expect(result.status).toBe("ok");
    expect(result.credentials).toEqual({ composioApiKey: "ak_live" });
  });

  it("waits between attempts instead of hammering the keychain", async () => {
    const slept = [];
    const decrypt = vi.fn().mockRejectedValueOnce(transient()).mockResolvedValue("{}");
    await readSecureCredentials(deps({ decrypt, sleep: async (ms) => slept.push(ms) }));
    expect(slept).toEqual([100]);
  });

  it("says UNAVAILABLE — never empty — when every attempt fails", async () => {
    const decrypt = vi.fn().mockRejectedValue(transient());
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(result.credentials).toEqual({});
    expect(result.error).toMatch(/temporarily unavailable/);
    expect(decrypt.mock.calls.length).toBeGreaterThan(1);
  });

  it("says UNAVAILABLE when the OS store itself is switched off", async () => {
    const result = await readSecureCredentials(deps({ isAvailable: async () => false }));
    expect(result.status).toBe("unavailable");
  });

  it("says UNAVAILABLE for a file it cannot parse, rather than pretending it is empty", async () => {
    // retrying cannot fix corruption, but calling it "empty" would invite the
    // caller to register a fresh identity over the top of it
    const decrypt = vi.fn().mockResolvedValue("not json");
    const result = await readSecureCredentials(deps({ decrypt }));
    expect(result.status).toBe("unavailable");
    expect(decrypt).toHaveBeenCalledTimes(1);
  });
});

describe("safeStorage bundle-rename migration", () => {
  it("recognizes the one-shot export flag", () => {
    expect(wantsSafeStorageExport(["node", "main.mjs", SAFE_STORAGE_EXPORT_FLAG])).toBe(true);
    expect(wantsSafeStorageExport(["node", "main.mjs"])).toBe(false);
  });

  it("imports a predecessor migration when the renamed store cannot decrypt", () => {
    const result = applySafeStorageMigration(
      { status: "unavailable", credentials: {}, error: "keychain" },
      {
        migrationExists: () => true,
        readMigration: () => JSON.stringify({ xaiApiKey: "xai-keep" }),
        removeMigration: () => {
          throw new Error("must not delete until the new store re-encrypts");
        },
      },
    );
    expect(result).toEqual({
      status: "ok",
      credentials: { xaiApiKey: "xai-keep" },
      fromMigration: true,
    });
  });

  it("drops a leftover migration file once the current store already reads", () => {
    let removed = false;
    const result = applySafeStorageMigration(
      { status: "ok", credentials: { xaiApiKey: "current" } },
      {
        migrationExists: () => true,
        readMigration: () => JSON.stringify({ xaiApiKey: "stale" }),
        removeMigration: () => {
          removed = true;
        },
      },
    );
    expect(result).toEqual({ status: "ok", credentials: { xaiApiKey: "current" } });
    expect(removed).toBe(true);
  });

  it("rejects a non-object migration payload", () => {
    expect(() => parseSafeStorageMigrationText("[]")).toThrow(/not readable/);
  });
});
