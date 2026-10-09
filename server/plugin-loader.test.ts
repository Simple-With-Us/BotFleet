import { describe, expect, it } from "vitest";

import {
  isPluginConfigKey,
  parsePluginHostConfigValue,
  PLUGIN_CONFIG_ALLOWLIST,
} from "./plugin-loader.ts";

describe("parsePluginHostConfigValue", () => {
  it("returns undefined for keys outside the closed allowlist", () => {
    expect(parsePluginHostConfigValue("providerApiKey", "secret-value")).toBeUndefined();
    expect(parsePluginHostConfigValue("openai", { key: "sk-test" })).toBeUndefined();
    expect(PLUGIN_CONFIG_ALLOWLIST).not.toContain("providerApiKey");
    expect(isPluginConfigKey("providerApiKey")).toBe(false);
  });

  it("strips secret-shaped fields and validates rooms", () => {
    const value = parsePluginHostConfigValue("rooms", {
      turnTimeoutMinutes: 45,
      accessToken: "must-not-leak",
    });
    expect(value).toEqual({ turnTimeoutMinutes: 45 });
  });

  it("rejects rooms shapes outside the strict schema", () => {
    expect(parsePluginHostConfigValue("rooms", { theme: "dark" })).toBeUndefined();
    expect(parsePluginHostConfigValue("rooms", { turnTimeoutMinutes: 0 })).toBeUndefined();
  });

  it("exposes only callStt provider, not keyterms", () => {
    expect(
      parsePluginHostConfigValue("callStt", {
        provider: "apple",
        keyterms: ["owner", "vocabulary"],
      }),
    ).toEqual({ provider: "apple" });
  });
});
