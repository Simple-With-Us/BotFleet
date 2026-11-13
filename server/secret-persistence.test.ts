// What is allowed to reach `~/.botfleet/config.json`, and what is not.
//
// `resolveSecretFields` writes the vault's values into the live `cfg` object
// on every `loadConfig()`, and `loadConfig()` also overlays the Infisical
// client secret onto `cfg.infisical`.  That makes the live config a bearer of
// every credential this install can resolve — which is fine while it stays in
// memory, and a disclosure the moment something persists it.  Four routes
// used to do exactly that (`saveConfig(cfg)` on Local VM mode, terminology,
// conversation mode and bot defaults, three of them deliberately reachable
// from the paired phone), so renaming rooms wrote the whole set to disk in
// cleartext: mode 0600, but readable by every process running as this user,
// by Time Machine, and by any backup.
//
// The fix is that a route saves the section it owns.  The guard below is the
// second line: `saveConfig` itself drops anything the store is currently
// canonical for, so the next route to reach for the live object cannot
// reintroduce the leak.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DATA_DIR, loadConfig, saveConfig } from "./config.ts";
import { secretSource, setInfisicalSnapshot, stripVaultManagedValues } from "./secret-map.ts";

// Obviously fake, and never sent anywhere: these exist so the assertions
// below have credential-shaped strings to hunt for on disk.
const SENTINEL_VAULT_KEY = "sentinel-vault-composio-key-not-real";
const SENTINEL_VAULT_TOKEN = "sentinel-vault-ingest-token-not-real";

const CONFIG_PATH = join(DATA_DIR, "config.json");
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const INDEX_SOURCE = readFileSync(join(SERVER_DIR, "index.ts"), "utf8");

/** Only the corners of `~/.botfleet/config.json` these tests seed and read
 * back.  Deliberately narrow: naming the whole config here would drift, and
 * every assertion below is about one of these three sections. */
interface DiskConfig {
  composio?: { apiKey?: string };
  box?: { token?: string };
  terminology?: string;
}

function seedDisk(contents: DiskConfig): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(contents, null, 2));
}

function readDisk(): DiskConfig {
  // SAFETY: the file was written by `saveConfig` from a patch this test
  // built, so the fields read back are the ones it just put there.
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as DiskConfig;
}

beforeEach(() => {
  mkdirSync(DATA_DIR, { recursive: true });
  rmSync(CONFIG_PATH, { force: true });
  setInfisicalSnapshot(null, []);
});

afterEach(() => {
  // Provenance is module state, so clear the snapshot AND re-resolve, or the
  // next test starts with this one's "managed" verdicts still recorded.
  setInfisicalSnapshot(null, []);
  loadConfig();
  rmSync(CONFIG_PATH, { force: true });
});

describe("saveConfig and the secret store", () => {
  it("drops every vault-managed value when handed the live config object", () => {
    seedDisk({ composio: { apiKey: "this-computer-older-copy" }, terminology: "rooms" });
    setInfisicalSnapshot(
      new Map([
        ["COMPOSIO_API_KEY", SENTINEL_VAULT_KEY],
        ["USAGE_MONITOR_INGEST_TOKEN", SENTINEL_VAULT_TOKEN],
      ]),
      ["COMPOSIO_API_KEY", "USAGE_MONITOR_INGEST_TOKEN"],
    );

    const cfg = loadConfig();
    // Precondition: the store won, so `cfg` is now carrying its values.
    expect(cfg.composio?.apiKey).toBe(SENTINEL_VAULT_KEY);
    expect(cfg.usage?.ingestToken).toBe(SENTINEL_VAULT_TOKEN);
    expect(secretSource("composio.apiKey")).toBe("infisical");

    // Exactly what the four routes used to do with a rename or a mode flip.
    saveConfig(cfg);

    const serialized = readFileSync(CONFIG_PATH, "utf8");
    expect(serialized).not.toContain(SENTINEL_VAULT_KEY);
    expect(serialized).not.toContain(SENTINEL_VAULT_TOKEN);
    // And the local copy that was already on disk is left exactly as it was:
    // dropping the patch value must not double as a delete.
    expect(readDisk().composio?.apiKey).toBe("this-computer-older-copy");
  });

  it("still writes the empty tombstone the write-through path depends on", () => {
    // With Write Through on, the handler writes the value to Infisical and
    // then blanks the local copy on purpose, so an older plaintext value
    // cannot survive the merge.  Stripping that empty string would leave the
    // stale value sitting on disk — the opposite of what it is for.
    seedDisk({ composio: { apiKey: "older-plaintext" } });
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", SENTINEL_VAULT_KEY]]), ["COMPOSIO_API_KEY"]);
    loadConfig();

    saveConfig({ composio: { apiKey: "" } });

    expect(readDisk().composio?.apiKey).toBe("");
  });

  it("leaves a field the store does not manage alone", () => {
    seedDisk({});
    setInfisicalSnapshot(new Map([["COMPOSIO_API_KEY", SENTINEL_VAULT_KEY]]), ["COMPOSIO_API_KEY"]);
    loadConfig();

    saveConfig({ box: { token: "this-computer-box-token" }, terminology: "channels" });

    const disk = readDisk();
    expect(disk.box?.token).toBe("this-computer-box-token");
    expect(disk.terminology).toBe("channels");
  });

  it("reports what it stripped by field id, never by value", () => {
    seedDisk({});
    setInfisicalSnapshot(new Map([["XAI_API_KEY", SENTINEL_VAULT_KEY]]), ["XAI_API_KEY"]);
    loadConfig();

    const patch = { xai: { key: SENTINEL_VAULT_KEY }, box: { token: "kept" } };
    expect(stripVaultManagedValues(patch)).toEqual(["xai.key"]);
    expect(patch.xai).not.toHaveProperty("key");
    expect(patch.box.token).toBe("kept");
  });
});

// These four routes are the ones the finding names, and three of them are
// deliberately open to the paired phone.  Section-scoped saves are the real
// fix; the guard above only catches the vault half, because the Infisical
// client secret is legitimately persisted by the /api/config handler and so
// cannot be stripped unconditionally.
describe("no route hands saveConfig the live config", () => {
  it("server/index.ts never calls saveConfig(cfg)", () => {
    expect(INDEX_SOURCE).not.toMatch(/saveConfig\(\s*cfg\s*\)/);
  });

  it("each of the four routes saves only the section it owns", () => {
    expect(INDEX_SOURCE).toContain("saveConfig({ localVm: cfg.localVm })");
    expect(INDEX_SOURCE).toContain("saveConfig({ terminology: cfg.terminology, terminologyCustom: cfg.terminologyCustom })");
    expect(INDEX_SOURCE).toContain("saveConfig({ conversationMode: cfg.conversationMode })");
    expect(INDEX_SOURCE).toContain("saveConfig({ botDefaults: cfg.botDefaults })");
  });
});

// The remaining three are module-level wiring in `server/index.ts` — the
// harness boot sequence, which no unit test can reach without booting the
// whole server.  What is asserted here is the invariant each fix encodes, so
// a later edit that reverts the shape is caught even though the behaviour
// itself is proved by the manual boot checks in the plan.
describe("the fingerprint baseline and the reload fence", () => {
  it("compares against the fingerprint the registry was built with", () => {
    // A per-call `const before = credentialFingerprint(cfg)` is the bug: the
    // timer path already moved `cfg`, so every later comparison is equal and
    // the rebuild is unreachable for the rest of the process.
    expect(INDEX_SOURCE).toContain("let loadedCredentialFingerprint = credentialFingerprint(cfg);");
    expect(INDEX_SOURCE).toContain("credentialFingerprint(cfg) === loadedCredentialFingerprint");
    expect(INDEX_SOURCE).not.toMatch(/const before = credentialFingerprint\(cfg\)/);
    // And it is kept in step with the load that actually built the fleet.
    // withInstanceKeyOverrides(...) may wrap the instanceConfigs(cfg) call
    // (it merges live-only custom-engine credentials into the map before it
    // becomes the registry — see server/index.ts's own comment on it), so
    // this matches either the bare or the wrapped form.
    expect(INDEX_SOURCE).toMatch(
      /await registry\.load\((?:withInstanceKeyOverrides\()?instanceConfigs\(cfg\)\)?\);[\s\S]{0,400}?loadedCredentialFingerprint = credentialFingerprint\(cfg\);/,
    );
  });

  it("rebuilds when a boot preload landed after the fleet was built", () => {
    // `preload()` is capped at 12 s against two 8 s call budgets, so a slow
    // boot routinely lands after `registry.load` and before `bootComplete`,
    // where `applyResolvedSecrets` returns without rebuilding anything.
    expect(INDEX_SOURCE).toMatch(
      /bootComplete = true;[\s\S]{0,1200}?if \(credentialFingerprint\(cfg\) !== loadedCredentialFingerprint\)/,
    );
  });

  it("serializes every provider rebuild through one chain", () => {
    // detachAll -> disposeAll -> load -> attach, twice at once, leaves
    // instances registered but disposed.  `providerConfigBusy` fences the two
    // Settings routes only; Sync Now and a late `onApplied` reach the reload
    // on their own.
    expect(INDEX_SOURCE).toContain("let providerReloadChain: Promise<void> = Promise.resolve();");
    expect(INDEX_SOURCE).toMatch(/function serializeProviderReload[\s\S]{0,800}?providerReloadChain\.then\(/);
    expect(INDEX_SOURCE).toMatch(
      /function reloadProviders\(\): Promise<void> \{[\s\S]{0,120}?serializeProviderReload\(runProviderReload\)/,
    );
    expect(INDEX_SOURCE).toContain("async function runProviderReload()");
  });

  it("never leaves the apply callback's rejection unhandled", () => {
    // There is no process-level unhandledRejection handler anywhere in
    // server/, so a throw out of the fire-and-forget apply would terminate
    // the harness.
    expect(INDEX_SOURCE).toMatch(/void applyResolvedSecrets\(reason\)\.catch\(/);
  });

  it("fences Sync Now the way the two Settings routes are fenced", () => {
    const syncStart = INDEX_SOURCE.indexOf('if (method === "POST" && path === "/api/infisical/sync") {');
    const testRoute = INDEX_SOURCE.indexOf("// Test Connection:", syncStart);
    const syncRoute = syncStart < 0 ? "" : INDEX_SOURCE.slice(syncStart, testRoute < 0 ? undefined : testRoute);
    expect(syncRoute).toContain("if (infisicalCredentialPending())");
    expect(syncRoute).toMatch(/if \(providerConfigBusy\) return json\(res, 409/);
  });
});

// The headless runbook describes the managed service-token route and the
// explicit app-level auth choice without reviving a universal-auth handoff.
describe("the headless service-token runbook", () => {
  const DOC = readFileSync(join(SERVER_DIR, "..", "docs", "secrets.md"), "utf8");
  const start = DOC.indexOf("## BotFleet's Own Infisical Authentication");
  const end = DOC.indexOf("\n## ", start + 4);
  const block = start < 0 ? "" : DOC.slice(start, end < 0 ? undefined : end);

  it("documents the service-token bindings and forbids automatic machine-identity fallback", () => {
    expect(block).toContain("`INFISICAL_TOKEN`");
    expect(block).toContain("`INFISICAL_WRITE_TOKEN`");
    expect(block).toContain("`BOTFLEET_HARNESS_INFISICAL_READ_TOKEN`");
    expect(block).toContain("`BOTFLEET_HARNESS_INFISICAL_WRITE_TOKEN`");
    expect(block).toMatch(/never\s+activates machine identity/);
    expect(block).toContain("pending AFC-600");
    expect(block).not.toMatch(/INFISICAL_AUTOMATION_|--client-secret|\bcurl\b/);
  });

  it("documents disabled staging around encrypted credential writes", () => {
    expect(block).toMatch(/metadata with Infisical disabled[\s\S]*encrypted credential store[\s\S]*requested toggle/);
    expect(block).toContain("the staged connection stays disabled");
  });
});

// The refusal gate has to answer "does the store CLAIM this name", which the
// vault's own name list survives a failed refresh to answer.  Live provenance
// only says `infisical` once a snapshot has landed, so keying on it turns the
// gate off for every field on a boot with the store unreachable — accepting a
// save, writing it to disk, and letting the next successful refresh revert it.
describe("the refusal gate", () => {
  it("keys on the vault's name list, not only on the last resolution", () => {
    expect(INDEX_SOURCE).toContain("const vaultKnownNames = new Set(vaultNames());");
    expect(INDEX_SOURCE).toMatch(
      /secretSource\(spec\.id\) === "infisical" \|\| vaultKnownNames\.has\(spec\.infisicalName\)/,
    );
  });

  it("refuses with 503 rather than guessing when the store has never answered", () => {
    expect(INDEX_SOURCE).toContain("vaultForSave.enabled && vaultForSave.lastSyncAt === null && vaultForSave.lastError !== null");
    expect(INDEX_SOURCE).toMatch(/return json\(res, 503, \{[\s\S]{0,200}?Infisical is unreachable/);
  });

  it("names the vault writes that already landed when a later one fails", () => {
    // Every earlier upsert is already in the store, and each of them ran its
    // own refresh, so "nothing has been saved" was true of config.json and
    // false of Infisical.  The 502 has to say which.
    expect(INDEX_SOURCE).toContain("const writtenToVault: string[] = [];");
    expect(INDEX_SOURCE).toContain("Already written to Infisical:");
    expect(INDEX_SOURCE).toMatch(/written: writtenToVault,/);
  });

  it("renders its sentence gaps with NBSP, which HTML will not collapse", () => {
    // These messages are handed to `new Error(body.error)` and rendered
    // straight into a plain <div>, where `white-space: normal` collapses a run
    // of ordinary spaces to one.  Two ASCII spaces would silently become one.
    expect(INDEX_SOURCE).toContain(
      "is managed by Infisical (${vaultForSave.environment}).\\u00A0 Change it in Infisical",
    );
    expect(INDEX_SOURCE).toContain("\\u00A0 Try again once it answers, or turn Use Infisical off.");
  });
});
