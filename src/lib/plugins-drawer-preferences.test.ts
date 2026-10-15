import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLUGINS_DRAWER_WIDTH,
  loadPluginsDrawerWidth,
  MAX_PLUGINS_DRAWER_WIDTH,
  MIN_PLUGINS_DRAWER_WIDTH,
  parsePluginsDrawerWidth,
  savePluginsDrawerWidth,
} from "./plugins-drawer-preferences";

describe("plugins drawer width preferences", () => {
  it("defaults when nothing is stored", () => {
    expect(parsePluginsDrawerWidth(null)).toBe(DEFAULT_PLUGINS_DRAWER_WIDTH);
    expect(loadPluginsDrawerWidth({ getItem: () => null })).toBe(DEFAULT_PLUGINS_DRAWER_WIDTH);
  });

  it("clamps stored values", () => {
    expect(parsePluginsDrawerWidth(String(MIN_PLUGINS_DRAWER_WIDTH - 1))).toBe(MIN_PLUGINS_DRAWER_WIDTH);
    expect(parsePluginsDrawerWidth(String(MAX_PLUGINS_DRAWER_WIDTH + 50))).toBe(MAX_PLUGINS_DRAWER_WIDTH);
  });

  it("round-trips through save and load", () => {
    const storage = new Map<string, string>();
    savePluginsDrawerWidth(420, {
      setItem: (key, value) => storage.set(key, value),
    });
    expect(loadPluginsDrawerWidth({ getItem: (key) => storage.get(key) ?? null })).toBe(420);
  });
});
