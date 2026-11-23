import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, loadConfig } from "./config.ts";
import { secretProvenance, setInfisicalSnapshot } from "./secret-map.ts";

// The desktop shell keeps the operator's own keys OS-encrypted and hands them
// to the server it spawns, so the app's own configuration marks the value
// (`credentialStorage: "external"`) and the value arrives out of the
// environment.  That is the app's own store reaching its own server, never
// an ambient environment copy:  the fleet store still outranks it, and an
// environment value with no marker is never a source once a store is
// configured.
const VARS = ["DEEPSEEK_API_KEY", "DEEPSEEK_URL", "XAI_API_KEY"] as const;

describe("the app's own credential store", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
    for (const name of VARS) delete process.env[name];
    mkdirSync(DATA_DIR, { recursive: true });
    rmSync(join(DATA_DIR, "config.json"), { force: true });
  });

  afterEach(() => {
    for (const name of VARS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    rmSync(join(DATA_DIR, "config.json"), { force: true });
    setInfisicalSnapshot(null, []);
  });

  it("keeps the desktop's own credential store value when a store is configured", () => {
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        deepseek: { key: "", credentialStorage: "external" },
        xai: { key: "file-xai" },
      }),
    );
    process.env.DEEPSEEK_API_KEY = "env-deepseek";
    process.env.XAI_API_KEY = "env-xai";
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", "sentinel-vault-value-not-real"]]), ["COMPOSIO_API_KEY"]);
    const cfg = loadConfig();
    // The desktop's own store reaches its own server.
    expect(cfg.deepseek?.key).toBe("env-deepseek");
    // An ambient environment copy with no marker is not a source, and the
    // app's own configuration still applies for a name the store does not hold.
    expect(cfg.xai?.key).toBe("file-xai");
  });

  it("does not let an own-store marker make a non-secret alias a source", () => {
    // The marker means the app's own credential store holds this section's
    // secret.  A section can hold a secret and a non-secret beside it -- a
    // key and a base URL -- and the marker must not hand the non-secret one
    // an inherited environment copy of its own.
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        deepseek: { key: "", url: "https://file.example.test", credentialStorage: "external" },
      }),
    );
    process.env.DEEPSEEK_API_KEY = "env-deepseek";
    process.env.DEEPSEEK_URL = "https://env.example.test";
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", "sentinel-vault-value-not-real"]]), ["COMPOSIO_API_KEY"]);
    const cfg = loadConfig();
    expect(cfg.deepseek?.key).toBe("env-deepseek");
    expect(cfg.deepseek?.url).toBe("https://file.example.test");
  });

  it("reports no local copy when the file is tombstoned and the store holds the value", () => {
    // The app's own credential store handed the value over, but the file is
    // tombstoned, so there is no copy on disk for the vault to have
    // overridden.
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({ deepseek: { key: "", credentialStorage: "external" } }),
    );
    process.env.DEEPSEEK_API_KEY = "env-deepseek";
    setInfisicalSnapshot(new Map([["DEEPSEEK_API_KEY", "sentinel-vault-value-not-real"]]), ["DEEPSEEK_API_KEY"]);
    const cfg = loadConfig();
    expect(cfg.deepseek?.key).toBe("sentinel-vault-value-not-real");
    const row = secretProvenance().find((entry) => entry.id === "deepseek.key");
    expect(row?.source).toBe("infisical");
    expect(row?.hasLocalCopy).toBe(false);
  });

  it("ignores the same environment value with no marker on the field", () => {
    // The same two names, and this time the app's own configuration says the
    // values are its own file:  the environment copy is not a source.
    writeFileSync(
      join(DATA_DIR, "config.json"),
      JSON.stringify({
        deepseek: { key: "file-deepseek" },
        xai: { key: "file-xai" },
      }),
    );
    process.env.DEEPSEEK_API_KEY = "env-deepseek";
    process.env.XAI_API_KEY = "env-xai";
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", "sentinel-vault-value-not-real"]]), ["COMPOSIO_API_KEY"]);
    const cfg = loadConfig();
    expect(cfg.deepseek?.key).toBe("file-deepseek");
    expect(cfg.xai?.key).toBe("file-xai");
  });
});
