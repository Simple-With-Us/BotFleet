import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  ADD_ENGINE_DRIVERS,
  addEngineDriverOption,
  createCustomEngine,
  customEngineCalloutTitle,
  deleteCustomEngine,
  driverDisplayName,
  isCustomEngineInstance,
  validateAddEngine,
  type EngineCredentialDeps,
} from "./custom-engine";

describe("createCustomEngine", () => {
  it("never calls setInstanceCredential when there is no bridge (dev/browser fallback)", async () => {
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-ollama" });
    const deps: EngineCredentialDeps = {
      createInstance,
      deleteInstance: vi.fn(),
      // setInstanceCredential intentionally absent
    };

    const created = await createCustomEngine(deps, {
      name: "Ollama Local",
      endpoint: "http://localhost:11434/v1",
      key: "unused-without-a-bridge",
      models: ["llama3"],
    });

    expect(created).toEqual({ instanceId: "custom-ollama" });
    // The dev fallback still sends the plaintext key straight to the server.
    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ key: "unused-without-a-bridge" }),
      // No bridge, so no external-storage declaration: the key is in the body.
      undefined,
    );
  });

  it("creates first, then hands the real instance id to the encrypted-credential bridge", async () => {
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-groq-2" });
    const setInstanceCredential = vi.fn().mockResolvedValue(undefined);
    const deps: EngineCredentialDeps = {
      createInstance,
      deleteInstance: vi.fn(),
      setInstanceCredential,
    };

    await createCustomEngine(deps, {
      name: "Groq",
      endpoint: "https://api.groq.com/openai/v1",
      key: "sk-groq-secret",
      models: ["llama-3.3-70b-versatile"],
    });

    // With the bridge present, the plaintext key never reaches the POST body.
    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({ key: undefined }), {
      secretStorage: "external",
    });
    expect(setInstanceCredential).toHaveBeenCalledWith("custom-groq-2", "sk-groq-secret");
  });

  it("skips the bridge call entirely when no key was entered", async () => {
    const setInstanceCredential = vi.fn();
    const deps: EngineCredentialDeps = {
      createInstance: vi.fn().mockResolvedValue({ instanceId: "custom-keyless" }),
      deleteInstance: vi.fn(),
      setInstanceCredential,
    };

    await createCustomEngine(deps, {
      name: "Local LM Studio",
      endpoint: "http://localhost:1234/v1",
      key: "",
      models: ["local-model"],
    });

    expect(setInstanceCredential).not.toHaveBeenCalled();
  });

  it("rolls back the just-created instance and reports the failure when the credential save fails", async () => {
    // The exact bug the [BF-DESIGNER] review comment flagged: a half-created
    // keyless engine must not linger in the list, and a retry with the same
    // name must not mint a second "Engine-2" alongside it.
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-flaky" });
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const setInstanceCredential = vi.fn().mockRejectedValue(new Error("The operating-system credential store is unavailable"));
    const deps: EngineCredentialDeps = { createInstance, deleteInstance, setInstanceCredential };

    await expect(
      createCustomEngine(deps, {
        name: "Flaky Engine",
        endpoint: "https://example.test/v1",
        key: "sk-flaky",
        models: ["model-a"],
      }),
    ).rejects.toThrow(
      "Could not save the encrypted key, so the new engine was removed.  The operating-system credential store is unavailable",
    );

    expect(deleteInstance).toHaveBeenCalledWith("custom-flaky");
  });

  it("still rejects even if the rollback delete itself fails, without masking the original error", async () => {
    const deps: EngineCredentialDeps = {
      createInstance: vi.fn().mockResolvedValue({ instanceId: "custom-double-flaky" }),
      deleteInstance: vi.fn().mockRejectedValue(new Error("network down")),
      setInstanceCredential: vi.fn().mockRejectedValue(new Error("locked keychain")),
    };

    await expect(
      createCustomEngine(deps, {
        name: "Double Flaky",
        endpoint: "https://example.test/v1",
        key: "sk-x",
        models: ["model-a"],
      }),
    ).rejects.toThrow(/locked keychain/);
  });
});

describe("deleteCustomEngine", () => {
  it("deletes directly when there is no bridge, reporting no credential error", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const result = await deleteCustomEngine({ createInstance: vi.fn(), deleteInstance }, "custom-x");

    expect(deleteInstance).toHaveBeenCalledWith("custom-x");
    expect(result).toEqual({ credentialClearError: null });
  });

  it("deletes the instance BEFORE purging its encrypted key, not after", async () => {
    // The exact ordering bug a fresh review caught: purging first PATCHes
    // the live instance (setInstanceCredential's job), which reloads that
    // provider and settles any bot mid-turn on it as no-longer-busy —
    // silently defeating DELETE's own busy-bot guard. clearInstanceCredential
    // never touches the live harness at all, and must only run once the
    // delete has already gone through.
    const calls: string[] = [];
    const deleteInstance = vi.fn(async (instanceId: string) => {
      calls.push(`delete:${instanceId}`);
    });
    const clearInstanceCredential = vi.fn(async (instanceId: string) => {
      calls.push(`clear:${instanceId}`);
    });

    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, clearInstanceCredential },
      "custom-reused-name",
    );

    expect(clearInstanceCredential).toHaveBeenCalledWith("custom-reused-name");
    expect(calls).toEqual(["delete:custom-reused-name", "clear:custom-reused-name"]);
    expect(result).toEqual({ credentialClearError: null });
  });

  it("never purges the credential when the delete itself is refused (busy bot or no replacement)", async () => {
    // The other half of the same bug: if purge-then-delete deleted the
    // credential and THEN the route refused the delete (no replacement
    // engine available), the instance survived configured but keyless.
    // Delete-then-purge makes that structurally impossible — a rejected
    // delete must never reach the purge step at all.
    const deleteInstance = vi.fn().mockRejectedValue(new Error("cannot delete engine while a bot using it is working"));
    const clearInstanceCredential = vi.fn();

    await expect(
      deleteCustomEngine({ createInstance: vi.fn(), deleteInstance, clearInstanceCredential }, "custom-busy"),
    ).rejects.toThrow(/cannot delete engine/);

    expect(clearInstanceCredential).not.toHaveBeenCalled();
  });

  it("still reports success when there is no bridge — the dev fallback never wrote an encrypted key to purge", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, clearInstanceCredential: undefined },
      "custom-dev-only",
    );
    expect(result).toEqual({ credentialClearError: null });
  });

  it("the delete having already succeeded, still reports it when purging the stored credential fails", async () => {
    const deleteInstance = vi.fn().mockResolvedValue(undefined);
    const clearInstanceCredential = vi.fn().mockRejectedValue(new Error("The operating-system credential store is unavailable"));

    const result = await deleteCustomEngine(
      { createInstance: vi.fn(), deleteInstance, clearInstanceCredential },
      "custom-y",
    );

    expect(deleteInstance).toHaveBeenCalledWith("custom-y");
    expect(result).toEqual({ credentialClearError: "The operating-system credential store is unavailable" });
  });
});

const SENTINEL_ADD_KEY = "sentinel-add-engine-key-not-real";

describe("the Add Engine form's driver choice", () => {
  it("omits the driver entirely for the route's own default", async () => {
    // An older client never sent one, and the body it did send has to keep
    // meaning exactly what it meant.
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-groq" });
    await createCustomEngine(
      { createInstance, deleteInstance: vi.fn() },
      { name: "Groq", endpoint: "https://api.groq.com/openai/v1", driver: "openai-compat", key: "", models: ["m"] },
    );
    expect(Object.hasOwn(createInstance.mock.calls[0][0], "driver")).toBe(false);
    // No bridge: the key is in the body, so the route needs no declaration.
    expect(createInstance.mock.calls[0][1]).toBeUndefined();
  });

  it("sends the driver for a second MiniMax connection", async () => {
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-minimax-china" });
    await createCustomEngine(
      { createInstance, deleteInstance: vi.fn() },
      { name: "MiniMax China", endpoint: "https://api.minimaxi.com/v1", driver: "minimax", key: "sk-cn", models: [] },
    );
    expect(createInstance).toHaveBeenCalledWith(
      expect.objectContaining({ driver: "minimax", key: "sk-cn", models: [] }),
      undefined,
    );
  });

  it("asks for model IDs only where the driver has no catalog of its own", () => {
    expect(addEngineDriverOption("openai-compat").requiresModels).toBe(true);
    expect(addEngineDriverOption("minimax").requiresModels).toBe(false);
    // An unknown driver falls back to the first option rather than rendering
    // a form with no labels at all.
    expect(addEngineDriverOption("nonsense")).toBe(ADD_ENGINE_DRIVERS[0]);

    const base = { name: "Second MiniMax", endpoint: "https://api.minimaxi.com/v1", key: SENTINEL_ADD_KEY };
    expect(validateAddEngine({ ...base, driver: "minimax", models: [] })).toBeNull();
    expect(validateAddEngine({ ...base, driver: "openai-compat", models: [] })).toContain("model ID is required");
    expect(validateAddEngine({ ...base, driver: "minimax", models: [] , name: "" })).toBe("Engine name is required");
    expect(validateAddEngine({ ...base, driver: "minimax", models: [], endpoint: " " })).toBe("Endpoint URL is required");
    // A paid hosted API is given no workspace credential for a connection the
    // operator added, so one created keyless could only fail every turn.
    expect(validateAddEngine({ ...base, driver: "minimax", models: [], key: "  " })).toBe("An API key is required");
    // openai-compat is the exception: an endpoint needing no auth at all —
    // Ollama, LM Studio, vLLM — is a first-class use of it, and safe because
    // the driver refuses the workspace key for a non-reserved instance.
    expect(validateAddEngine({ ...base, driver: "openai-compat", models: ["m"], key: "" })).toBeNull();
    expect(addEngineDriverOption("openai-compat").requiresKey).toBe(false);
    expect(addEngineDriverOption("minimax").requiresKey).toBe(true);
    // A custom icon reaches the rail only through a driver that reads one out
    // of its config.  MiniMax's config schema has exactly one field, so the
    // form does not offer an icon it could only drop on the floor.
    expect(addEngineDriverOption("openai-compat").supportsIcon).toBe(true);
    expect(addEngineDriverOption("minimax").supportsIcon).toBe(false);
    expect(
      validateAddEngine({ ...base, driver: "openai-compat", models: Array.from({ length: 16 }, (_, i) => `m${i}`) }),
    ).toContain("At most 15");
  });

  it("treats any instance other than a driver's reserved one as added by the operator", () => {
    expect(isCustomEngineInstance({ driverKind: "minimax", instanceId: "minimax" })).toBe(false);
    expect(isCustomEngineInstance({ driverKind: "minimax", instanceId: "custom-minimax-china" })).toBe(true);
    expect(isCustomEngineInstance({ driverKind: "openai-compat", instanceId: "openaiCompat" })).toBe(false);
    expect(isCustomEngineInstance({ driverKind: "openai-compat", instanceId: "custom-ollama" })).toBe(true);
    // The default fleet's own ids, for drivers whose id is not their kind.
    expect(isCustomEngineInstance({ driverKind: "claudeAgent", instanceId: "claude" })).toBe(false);
    expect(isCustomEngineInstance({ driverKind: "boxAgent", instanceId: "computer" })).toBe(false);
    // …and a driver nobody listed fails SAFE: its reserved id is its own
    // kind, so anything else reads as operator-added and offers a delete
    // button, rather than hiding one for an engine that really was added.
    expect(isCustomEngineInstance({ driverKind: "someFutureDriver", instanceId: "someFutureDriver" })).toBe(false);
    expect(isCustomEngineInstance({ driverKind: "someFutureDriver", instanceId: "custom-x" })).toBe(true);
    // The server's own flag still wins when it is set.
    expect(isCustomEngineInstance({ driverKind: "claudeAgent", instanceId: "claude", isCustom: true })).toBe(true);
  });

  it("names the engine the operator actually added in the row callout", () => {
    expect(customEngineCalloutTitle("minimax")).toBe("Added MiniMax Connection.");
    expect(customEngineCalloutTitle("openai-compat")).toBe("Custom OpenAI-Compatible Engine.");
    // Only openai-compat instances are OpenAI-compatible engines.  Since
    // isCustomEngineInstance was widened to answer true for ANY unlisted
    // driver's non-reserved id, an extra instance of one of those used to
    // claim a wire shape its endpoint may not speak at all.
    expect(customEngineCalloutTitle("claudeAgent")).toBe("Added Claude Connection.");
    expect(customEngineCalloutTitle("boxAgent")).toBe("Added Computer Connection.");
    // A driver nobody listed is named after itself rather than mislabelled.
    expect(customEngineCalloutTitle("someFutureDriver")).toBe("Added SomeFutureDriver Connection.");
    expect(customEngineCalloutTitle("nimbus")).toBe("Added Nimbus Connection.");
  });

  it("falls back to a humanized driver kind rather than a wrong product name", () => {
    expect(driverDisplayName("minimax")).toBe("MiniMax");
    expect(driverDisplayName("dshAgent")).toBe("DeepSeek");
    expect(driverDisplayName("piAgent")).toBe("pi");
    expect(driverDisplayName("widgetAgent")).toBe("Widget");
    expect(driverDisplayName("widget")).toBe("Widget");
    // Never returns an empty label, whatever it is handed.
    expect(driverDisplayName("Agent")).toBe("Agent");
    expect(driverDisplayName("")).toBe("");
  });
});

describe("a create whose key is going to the encrypted store", () => {
  it("declares it, so the route does not refuse a body with no key in it", () => {
    // With the bridge present the key is deliberately left out of the POST
    // and committed to the store straight afterwards. The route refuses a
    // keyless create without this declaration, because an instance with no
    // key from either source could only fail every turn it is given.
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-minimax-cn" });
    const setInstanceCredential = vi.fn().mockResolvedValue(undefined);
    return createCustomEngine(
      { createInstance, deleteInstance: vi.fn(), setInstanceCredential },
      {
        name: "MiniMax China",
        endpoint: "https://api.minimaxi.com/v1",
        driver: "minimax",
        key: SENTINEL_ADD_KEY,
        models: [],
      },
    ).then(() => {
      expect(createInstance.mock.calls[0][0].key).toBeUndefined();
      expect(createInstance.mock.calls[0][1]).toEqual({ secretStorage: "external" });
      expect(setInstanceCredential).toHaveBeenCalledWith("custom-minimax-cn", SENTINEL_ADD_KEY);
    });
  });
});

describe("an anonymous engine added from the desktop", () => {
  it("is not declared external, so it is never left waiting for a key nobody will send", () => {
    // The bridge exists but no key was typed — a local Ollama or LM Studio.
    // Declaring external here would mark the instance as waiting for a
    // credential that is never coming, and refuse its every turn.
    const createInstance = vi.fn().mockResolvedValue({ instanceId: "custom-ollama" });
    const setInstanceCredential = vi.fn().mockResolvedValue(undefined);
    return createCustomEngine(
      { createInstance, deleteInstance: vi.fn(), setInstanceCredential },
      { name: "Ollama", endpoint: "http://localhost:11434/v1", key: "", models: ["llama3"] },
    ).then(() => {
      expect(createInstance.mock.calls[0][1]).toBeUndefined();
      expect(setInstanceCredential).not.toHaveBeenCalled();
    });
  });
});

describe("the Add Engine modal's MiniMax note", () => {
  it("separates its sentences with NBSP, which the browser will not collapse", () => {
    // JSX preserves a run of two ASCII spaces into the DOM and CSS then
    // collapses it, so raw JSX text needs the same NBSP the string literals
    // above use.  Read from source because this repo has no component-render
    // harness — the same shape as server/secret-persistence.test.ts's own
    // "renders its sentence gaps with NBSP".
    const source = readFileSync(
      fileURLToPath(new URL("../components/EnginesSettings.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("nothing to type here.\u00A0 This connection offers the");
    expect(source).not.toContain("nothing to type here.  This connection");
  });
});
