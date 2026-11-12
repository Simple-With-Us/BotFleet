import { describe, expect, it } from "vitest";

import { engineCheckingCopy, engineSetupCopy, isApiKeyOnly, needsCli, needsSignIn } from "./EngineSetup";
import type { InstanceInfo } from "@/state/store";

function instance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "kimi",
    driverKind: "kimiAgent",
    displayName: "Kimi",
    models: { default: "kimi-code/k3", options: [] },
    snapshot,
  };
}

/** MiniMax-shaped: no CLI, no interactive sign-in, `install.apiKeyOnly` set —
 * the exact shape server/drivers/minimax.ts and openai-compat.ts describe. */
function apiKeyInstance(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "minimax",
    driverKind: "minimax",
    displayName: "MiniMax",
    models: { default: "MiniMax-M3", options: [] },
    snapshot,
    install: {
      docsUrl: "https://platform.minimax.io/docs/token-plan/minimax-cli",
      apiKeyOnly: true,
      signInCommand: "Set MINIMAX_API_KEY to a MiniMax API key, or run `mmx auth login --api-key …`",
      command: { darwin: "Get a MiniMax API key at https://platform.minimax.io and set MINIMAX_API_KEY" },
    },
  };
}

describe("needsCli / needsSignIn", () => {
  it("never calls an engine whose probe did not answer in time 'not installed' or 'signed out'", () => {
    const checking = instance({ state: "unavailable", transient: true, reason: "Kimi did not answer in time" });
    expect(needsCli(checking)).toBe(false);
    expect(needsSignIn(checking)).toBe(false);
    const copy = engineCheckingCopy(checking);
    expect(copy.title).toBe("Checking Kimi");
    // Two-space sentence gap as U+00A0 + space, never the literal entity.
    expect(copy.description).toBe("Kimi did not answer in time.\u00a0 BotFleet is checking again and will update this on its own.");
    expect(copy.description).not.toContain("&nbsp;");
  });

  it("does not read an unknown sign-in (auth probe timed out) as signed out", () => {
    const unknown = instance({ state: "available", version: "0.36.1" });
    expect(needsSignIn(unknown)).toBe(false);
  });

  it("treats a missing binary as a CLI install, not a sign-in", () => {
    const missing = instance({ state: "unavailable", reason: "`kimi` CLI not found" });
    expect(needsCli(missing)).toBe(true);
    expect(needsSignIn(missing)).toBe(false);
  });

  it("lets Custom inject run when the CLI is installed but unsigned-in", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    expect(needsCli(unsigned)).toBe(false);
    expect(needsSignIn(unsigned)).toBe(true);
  });

  it("is ready for inject when the CLI is present", () => {
    const ready = instance({ state: "available", authenticated: true, version: "0.36.1" });
    expect(needsCli(ready)).toBe(false);
    expect(needsSignIn(ready)).toBe(false);
  });
});

describe("isApiKeyOnly / engineSetupCopy — MiniMax-shaped, key-only engines", () => {
  it("flags an engine whose install descriptor sets apiKeyOnly", () => {
    const noKey = apiKeyInstance({ state: "unavailable", reason: "no MiniMax API key" });
    expect(isApiKeyOnly(noKey)).toBe(true);
    expect(isApiKeyOnly(instance({ state: "unavailable" }))).toBe(false);
  });

  it("never calls it an install or a sign-in on the Cloud pane with no key", () => {
    const noKey = apiKeyInstance({ state: "unavailable", reason: "no MiniMax API key" });
    const { title, description } = engineSetupCopy(noKey, "cloud");
    expect(title).toBe("Add a MiniMax API key");
    expect(title).not.toMatch(/^install|sign in/i);
    expect(description).not.toMatch(/install the command-line app|sign in to terminal/i);
    expect(description).toMatch(/API key/);
  });

  it("gives the same honest copy on the Custom/inject pane — no phantom local-model promise", () => {
    const noKey = apiKeyInstance({ state: "unavailable", reason: "no MiniMax API key" });
    const { title, description } = engineSetupCopy(noKey, "inject");
    expect(title).toBe("Add a MiniMax API key");
    expect(description).not.toMatch(/local model/i);
  });

  it("leaves a real CLI+sign-in engine's copy untouched", () => {
    const unsigned = instance({ state: "available", authenticated: false, version: "0.36.1" });
    const { title } = engineSetupCopy(unsigned, "cloud");
    expect(title).toBe("Sign in to Kimi");
  });
});
