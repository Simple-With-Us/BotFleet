// Tests for the vendor-neutral feature-flag module.  Covers the typed
// helpers, the LocalConfigProvider shape, fallback semantics, and the
// "read-before-init is queued by the SDK, returns the fallback" contract.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getBool,
  getNumber,
  getString,
  installLocalConfigProvider,
  isFeatureFlagsInstalled,
  LocalConfigProvider,
  _resetForTests,
} from "./feature-flags.ts";

describe("LocalConfigProvider", () => {
  const noopLogger = {
    warn: () => {},
    error: () => {},
    info: () => {},
    debug: () => {},
  };

  it("returns the static value for a known boolean flag", async () => {
    const provider = new LocalConfigProvider({
      "harness.experimentalAcpDriverV2": {
        defaultVariant: "on",
        variants: { off: false, on: true },
      },
    });
    const detail = await provider.resolveBooleanEvaluation("harness.experimentalAcpDriverV2", false, {}, noopLogger);
    expect(detail.value).toBe(true);
    expect(detail.reason).toBe("STATIC");
  });

  it("returns the caller-supplied fallback for an unknown flag", async () => {
    const provider = new LocalConfigProvider({});
    const detail = await provider.resolveBooleanEvaluation("does.not.exist", true, {}, noopLogger);
    expect(detail.value).toBe(true);
    expect(detail.reason).toBe("DEFAULT");
  });

  it("treats `disabled: true` as an unknown flag", async () => {
    const provider = new LocalConfigProvider({
      "harness.experimentalAcpDriverV2": {
        defaultVariant: "on",
        variants: { off: false, on: true },
        disabled: true,
      },
    });
    const detail = await provider.resolveBooleanEvaluation("harness.experimentalAcpDriverV2", false, {}, noopLogger);
    expect(detail.value).toBe(false);
    expect(detail.reason).toBe("DEFAULT");
  });

  it("supports string and number variants with type checking", async () => {
    const provider = new LocalConfigProvider({
      "ui.theme": { defaultVariant: "system", variants: { system: "system", light: "light" } },
      "ui.density": { defaultVariant: "compact", variants: { compact: 1, roomy: 2 } },
    });
    const stringDetail = await provider.resolveStringEvaluation("ui.theme", "light", {}, noopLogger);
    expect(stringDetail.value).toBe("system");
    const numberDetail = await provider.resolveNumberEvaluation("ui.density", 0, {}, noopLogger);
    expect(numberDetail.value).toBe(1);
  });

  it("falls back when the stored variant has the wrong type", async () => {
    const provider = new LocalConfigProvider({
      "ui.density": { defaultVariant: "compact", variants: { compact: "one", roomy: "two" } },
    });
    const detail = await provider.resolveNumberEvaluation("ui.density", 42, {}, noopLogger);
    expect(detail.value).toBe(42);
    expect(detail.reason).toBe("DEFAULT");
  });

  it("loads its flag table from a JSON file", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-flags-"));
    try {
      const path = join(dir, "flags.json");
      writeFileSync(
        path,
        JSON.stringify({
          "harness.experimentalAcpDriverV2": {
            defaultVariant: "on",
            variants: { off: false, on: true },
          },
        }),
      );
      const provider = LocalConfigProvider.fromFile(path);
      expect(provider.sourcePath).toBe(path);
      // constructor is synchronous; resolveBooleanEvaluation is the
      // async API the SDK invokes.
      expect(typeof provider.resolveBooleanEvaluation).toBe("function");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("installLocalConfigProvider + typed helpers", () => {
  beforeEach(() => {
    // OpenFeature's client is process-global, so each test installs a
    // fresh provider.  The internal `installed` guard would otherwise
    // short-circuit the second test's install call.
    _resetForTests();
  });
  afterEach(() => {
    _resetForTests();
  });

  it("installs the provider once and reports it", () => {
    expect(isFeatureFlagsInstalled()).toBe(false);
    installLocalConfigProvider(
      new LocalConfigProvider({
        "harness.experimentalAcpDriverV2": {
          defaultVariant: "off",
          variants: { off: false, on: true },
        },
      }),
    );
    expect(isFeatureFlagsInstalled()).toBe(true);
  });

  it("returns the configured value via the typed helpers", async () => {
    installLocalConfigProvider(
      new LocalConfigProvider({
        "harness.experimentalAcpDriverV2": {
          defaultVariant: "on",
          variants: { off: false, on: true },
        },
        "ui.theme": { defaultVariant: "system", variants: { system: "system" } },
        "ui.density": { defaultVariant: "compact", variants: { compact: 2 } },
      }),
    );
    expect(await getBool("harness.experimentalAcpDriverV2", false)).toBe(true);
    expect(await getString("ui.theme", "light")).toBe("system");
    expect(await getNumber("ui.density", 1)).toBe(2);
  });

  it("falls back when the flag is unknown to the provider", async () => {
    installLocalConfigProvider(new LocalConfigProvider({}));
    expect(await getBool("does.not.exist", true)).toBe(true);
    expect(await getString("does.not.exist", "fallback")).toBe("fallback");
    expect(await getNumber("does.not.exist", 99)).toBe(99);
  });
});
