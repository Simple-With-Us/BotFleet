import { afterEach, describe, expect, it } from "vitest";

import { PROVIDER_CREDENTIAL_ENV, WORKSPACE_CREDENTIAL_ENV, type AppConfig } from "./config.ts";
import {
  INFISICAL_NAME_PATTERN,
  SECRET_FIELDS,
  credentialFingerprint,
  infisicalSnapshot,
  resolveSecretFields,
  secretProvenance,
  secretSource,
  setInfisicalSnapshot,
  vaultNames,
} from "./secret-map.ts";

// Obviously fake, and never sent anywhere: these exist so the assertions below
// have credential-shaped strings to work on.  Every one is asserted absent
// from anything this module hands back.
const SENTINEL_FILE = "sentinel-file-value-not-real";
const SENTINEL_ENV = "sentinel-env-value-not-real";
const SENTINEL_VAULT = "sentinel-vault-value-not-real";

/** Env aliases that are read only by the harness process itself and are
 * deliberately absent from both strip lists, because no spawned engine CLI has
 * ever been given them: the usage-monitor endpoint and tokens, the Bot RAG
 * connection, and the Sentry DSN.  The assertion below exists so that a future
 * mapped field whose env name IS handed to children cannot be added without
 * somebody noticing that it now rides along in `...process.env`. */
const HARNESS_ONLY = new Set([
  "USAGE_MONITOR_INGEST_URL",
  "USAGE_MONITOR_INGEST_TOKEN",
  "USAGE_INGEST_TOKEN",
  "USAGE_READ_TOKEN",
  "OMB_RECALL_URL",
  "RECALL_URL",
  "QDRANT_URL",
  "OMB_RECALL_API_KEY",
  "RECALL_API_KEY",
  "QDRANT_API_KEY",
  "OMB_RECALL_COLLECTION",
  "RECALL_COLLECTION",
  "QDRANT_COLLECTION",
  "OMB_RECALL_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_ID",
  "OMB_RECALL_ACCESS_CLIENT_SECRET",
  "CF_ACCESS_CLIENT_SECRET",
  "SENTRY_DSN",
  "BOTFLEET_SENTRY_DSN",
  "SENTRY_FLEET_DSN",
]);

const spec = (id: string) => {
  const found = SECRET_FIELDS.find((entry) => entry.id === id);
  if (!found) throw new Error(`no spec for ${id}`);
  return found;
};

afterEach(() => {
  setInfisicalSnapshot(null, []);
  resolveSecretFields({}, {}, null);
});

describe("the secret map", () => {
  it("gives every field a unique id that names its own config path", () => {
    const ids = SECRET_FIELDS.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of SECRET_FIELDS) {
      expect(entry.id).toBe(`${String(entry.section)}.${entry.path.join(".")}`);
      expect(entry.path.length).toBeGreaterThan(0);
      expect(entry.label.trim()).toBe(entry.label);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("never maps the store's own machine identity", () => {
    // A lock cannot hold its own key: if `infisical.clientSecret` were mapped,
    // unlocking the store would require a value that only the store has.
    for (const entry of SECRET_FIELDS) {
      expect(entry.id.startsWith("infisical.")).toBe(false);
      expect(String(entry.section)).not.toBe("infisical");
    }
  });

  it("uses names the store itself will accept", () => {
    for (const entry of SECRET_FIELDS) {
      expect(INFISICAL_NAME_PATTERN.test(entry.infisicalName)).toBe(true);
      expect(entry.env.length).toBeGreaterThan(0);
    }
  });

  it("keeps every env alias out of a spawned engine, or names it as harness-only", () => {
    const stripped = new Set<string>([...WORKSPACE_CREDENTIAL_ENV, ...PROVIDER_CREDENTIAL_ENV]);
    for (const entry of SECRET_FIELDS) {
      for (const name of entry.env) {
        expect(stripped.has(name) || HARNESS_ONLY.has(name), `${entry.id} alias ${name}`).toBe(true);
      }
    }
  });
});

describe("resolving a mapped field", () => {
  it("reports this computer's own copy as the source when nothing else has one", () => {
    const cfg: AppConfig = { xai: { key: SENTINEL_FILE } };
    const rows = resolveSecretFields(cfg, {}, null);
    expect(rows.find((row) => row.id === "xai.key")).toEqual({
      id: "xai.key",
      source: "file",
      hasValue: true,
      hasLocalCopy: false,
    });
    expect(cfg.xai?.key).toBe(SENTINEL_FILE);
  });

  it("reports the environment when the value in hand came from an alias", () => {
    // loadConfig's own overlay has already copied the env value into cfg by
    // the time this runs, which is why both sides carry it here.
    const cfg: AppConfig = { xai: { key: SENTINEL_ENV } };
    const rows = resolveSecretFields(cfg, { XAI_API_KEY: SENTINEL_ENV }, null);
    expect(rows.find((row) => row.id === "xai.key")?.source).toBe("env");
    // An alias the harness reads per call, with nothing in the file at all.
    expect(rows.find((row) => row.id === "usage.readToken")).toEqual({
      id: "usage.readToken",
      source: "none",
      hasValue: false,
      hasLocalCopy: false,
    });
    const withEnvOnly = resolveSecretFields({}, { USAGE_READ_TOKEN: SENTINEL_ENV }, null);
    expect(withEnvOnly.find((row) => row.id === "usage.readToken")).toMatchObject({
      source: "env",
      hasValue: true,
    });
  });

  it("lets the store overwrite both, and says a local copy is still on disk", () => {
    const cfg: AppConfig = { xai: { key: SENTINEL_FILE, url: "https://api.example.test/v1" } };
    setInfisicalSnapshot(new Map([["XAI_API_KEY", SENTINEL_VAULT]]), ["XAI_API_KEY"]);
    const rows = resolveSecretFields(cfg, { XAI_API_KEY: SENTINEL_ENV }, infisicalSnapshot());
    expect(cfg.xai?.key).toBe(SENTINEL_VAULT);
    // The rest of the section survives the write.
    expect(cfg.xai?.url).toBe("https://api.example.test/v1");
    expect(rows.find((row) => row.id === "xai.key")).toEqual({
      id: "xai.key",
      source: "infisical",
      hasValue: true,
      hasLocalCopy: true,
    });
    expect(secretSource("xai.key")).toBe("infisical");
    expect(secretSource("box.token")).toBe("none");
    expect(secretSource("not.a.field")).toBe("none");
    expect(secretProvenance()).toHaveLength(SECRET_FIELDS.length);
  });

  it("reports no local copy when the store is the only place the value lives", () => {
    const cfg: AppConfig = {};
    setInfisicalSnapshot(new Map([["BOX_TOKEN", SENTINEL_VAULT]]), ["BOX_TOKEN"]);
    const rows = resolveSecretFields(cfg, {}, infisicalSnapshot());
    expect(cfg.box?.token).toBe(SENTINEL_VAULT);
    expect(rows.find((row) => row.id === "box.token")).toEqual({
      id: "box.token",
      source: "infisical",
      hasValue: true,
      hasLocalCopy: false,
    });
  });

  it("sources the MiniMax key and base URL the same way every other provider's are", () => {
    // Before this row existed the driver read MINIMAX_API_KEY out of the
    // process environment or ~/.mmx/config.json and nothing else, so neither
    // the vault nor ~/.botfleet/config.json could supply it and the Secrets
    // card could not say where the value in use had come from.
    expect(spec("minimax.key").env).toEqual(["MINIMAX_API_KEY"]);
    expect(spec("minimax.key").secret).toBe(true);
    expect(spec("minimax.url").env).toEqual(["MINIMAX_BASE_URL"]);
    // The endpoint is configuration, not a credential: the card shows it.
    expect(spec("minimax.url").secret).toBe(false);
    // Both rebuild the fleet — a MiniMax instance decodes its endpoint and
    // resolves its key when the driver is created, not per turn.
    expect(spec("minimax.key").reloadProviders).toBe(true);
    expect(spec("minimax.url").reloadProviders).toBe(true);

    const fromFile = resolveSecretFields({ minimax: { key: SENTINEL_FILE } }, {}, null);
    expect(fromFile.find((row) => row.id === "minimax.key")).toEqual({
      id: "minimax.key",
      source: "file",
      hasValue: true,
      hasLocalCopy: false,
    });

    const fromEnv = resolveSecretFields({}, { MINIMAX_API_KEY: SENTINEL_ENV }, null);
    expect(fromEnv.find((row) => row.id === "minimax.key")).toMatchObject({
      source: "env",
      hasValue: true,
    });

    // Nothing anywhere: the card says so rather than implying ~/.mmx holds
    // it, which is the one source this table deliberately cannot see.
    const nowhere = resolveSecretFields({}, {}, null);
    expect(nowhere.find((row) => row.id === "minimax.key")).toEqual({
      id: "minimax.key",
      source: "none",
      hasValue: false,
      hasLocalCopy: false,
    });
  });

  it("lets the vault override a MiniMax key and endpoint held on this computer", () => {
    const cfg: AppConfig = { minimax: { key: SENTINEL_FILE, url: "https://api.minimax.io/v1" } };
    setInfisicalSnapshot(
      new Map([
        ["MINIMAX_API_KEY", SENTINEL_VAULT],
        ["MINIMAX_BASE_URL", "https://api.minimaxi.com/v1"],
      ]),
      ["MINIMAX_API_KEY", "MINIMAX_BASE_URL"],
    );
    const rows = resolveSecretFields(cfg, { MINIMAX_API_KEY: SENTINEL_ENV }, infisicalSnapshot());
    expect(cfg.minimax?.key).toBe(SENTINEL_VAULT);
    expect(cfg.minimax?.url).toBe("https://api.minimaxi.com/v1");
    expect(rows.find((row) => row.id === "minimax.key")).toEqual({
      id: "minimax.key",
      source: "infisical",
      hasValue: true,
      hasLocalCopy: true,
    });
    expect(secretSource("minimax.url")).toBe("infisical");
  });

  it("falls through an empty value in the store instead of blanking the local one", () => {
    const cfg: AppConfig = { composio: { apiKey: SENTINEL_FILE } };
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", ""]]), ["COMPOSIO_API_KEY"]);
    const rows = resolveSecretFields(cfg, {}, infisicalSnapshot());
    expect(cfg.composio?.apiKey).toBe(SENTINEL_FILE);
    expect(rows.find((row) => row.id === "composio.apiKey")?.source).toBe("file");
  });
});

describe("the snapshot", () => {
  it("applies only mapped names and never touches the process environment", () => {
    const pathBefore = process.env.PATH;
    const homeBefore = process.env.HOME;
    setInfisicalSnapshot(
      new Map([
        ["PATH", "/sentinel/not/real"],
        ["HOME", "/sentinel/not/real"],
        ["NODE_ENV", "sentinel"],
        ["INFISICAL_CLIENT_SECRET", SENTINEL_VAULT],
        ["xai_api_key", SENTINEL_VAULT],
        ["XAI_API_KEY", SENTINEL_VAULT],
      ]),
      ["PATH", "HOME", "NODE_ENV", "INFISICAL_CLIENT_SECRET", "xai_api_key", "XAI_API_KEY"],
    );
    const snap = infisicalSnapshot();
    expect([...(snap?.keys() ?? [])]).toEqual(["XAI_API_KEY"]);
    expect(snap?.has("PATH")).toBe(false);
    expect(snap?.has("INFISICAL_CLIENT_SECRET")).toBe(false);
    expect(snap?.has("xai_api_key")).toBe(false);
    expect(process.env.PATH).toBe(pathBefore);
    expect(process.env.HOME).toBe(homeBefore);
    expect(process.env.NODE_ENV).not.toBe("sentinel");
    // The unmapped names still have to be reportable, or the card cannot say
    // "in Infisical, not used by BotFleet".
    expect(vaultNames()).toContain("NODE_ENV");
    expect(vaultNames()).toHaveLength(6);
  });

  it("clears to null so a turned-off store re-resolves from env and file", () => {
    setInfisicalSnapshot(new Map([["BOX_TOKEN", SENTINEL_VAULT]]), ["BOX_TOKEN"]);
    expect(infisicalSnapshot()).not.toBeNull();
    setInfisicalSnapshot(null, []);
    expect(infisicalSnapshot()).toBeNull();
    expect(vaultNames()).toEqual([]);
    const cfg: AppConfig = { box: { token: SENTINEL_FILE } };
    resolveSecretFields(cfg, {}, infisicalSnapshot());
    expect(cfg.box?.token).toBe(SENTINEL_FILE);
  });
});

describe("the credential fingerprint", () => {
  it("changes for a key that rebuilds the fleet and not for one that does not", () => {
    expect(spec("xai.key").reloadProviders).toBe(true);
    expect(spec("tts.key").reloadProviders).toBe(false);
    expect(spec("usage.ingestToken").reloadProviders).toBe(false);

    const base: AppConfig = { xai: { key: "one" }, tts: { key: "one" }, usage: { ingestToken: "one" } };
    const start = credentialFingerprint(base);
    expect(credentialFingerprint({ ...base, tts: { key: "two" } })).toBe(start);
    expect(credentialFingerprint({ ...base, usage: { ingestToken: "two" } })).toBe(start);
    expect(credentialFingerprint({ ...base, xai: { key: "two" } })).not.toBe(start);
  });

  it("is stable, order-independent, and reveals nothing", () => {
    const one: AppConfig = { xai: { key: SENTINEL_FILE }, box: { token: SENTINEL_VAULT } };
    const two: AppConfig = { box: { token: SENTINEL_VAULT }, xai: { key: SENTINEL_FILE } };
    const digest = credentialFingerprint(one);
    expect(digest).toBe(credentialFingerprint(two));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    for (const sentinel of [SENTINEL_FILE, SENTINEL_ENV, SENTINEL_VAULT]) {
      expect(digest).not.toContain(sentinel);
    }
    // An empty config still fingerprints, so the boot comparison has a value
    // to start from rather than a special case.
    expect(credentialFingerprint({})).toMatch(/^[0-9a-f]{64}$/);
    expect(credentialFingerprint({})).not.toBe(digest);
  });
});
