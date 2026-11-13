// main.mjs pulls in Electron itself, so the application menu cannot be
// imported here. These are source-level assertions instead: they exist
// because a settings item once dispatched a section id ("keys") that the
// renderer has never had, which opened Settings on an empty pane with no
// nav row selected and no error anywhere.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const main = read("./main.mjs");
const store = read("../src/state/store.tsx");
// The Settings rail (section ids and the labels it shows) lives in its own file.
const settingsNav = read("../src/components/SettingsNav.tsx");

/** Every id in the AppSettingsSection union. */
function declaredSections() {
  const union = /export type AppSettingsSection =([\s\S]*?);/.exec(store);
  expect(union).not.toBeNull();
  return [...union[1].matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]);
}

/** id -> the name the Settings nav shows for it. */
function sectionLabels() {
  const entries = [...settingsNav.matchAll(/\{ id: "([a-zA-Z]+)", label: "([^"]+)"/g)];
  expect(entries.length).toBeGreaterThan(0);
  return new Map(entries.map((m) => [m[1], m[2]]));
}

/** Every menu item that deep-links into a Settings section. */
function settingsMenuItems() {
  const pattern = /label: "([^"]+)",\s*\n\s*click: \(\) => sendToRenderer\("open-settings", \{ section: "([a-zA-Z]+)" \}\)/g;
  return [...main.matchAll(pattern)].map(([, label, section]) => ({ label, section }));
}

describe("application menu settings items", () => {
  it("only deep-links to sections the renderer can actually show", () => {
    const sections = declaredSections();
    const items = settingsMenuItems();
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(sections, `${item.label} dispatches an unknown section`).toContain(item.section);
    }
    // the specific regression: "keys" is a search keyword on Connections,
    // never a section of its own
    expect(sections).not.toContain("keys");
    expect(items.map((item) => item.section)).not.toContain("keys");
  });

  it("names each item after its own Settings section, two spaces before the descriptor", () => {
    const labels = sectionLabels();
    for (const { label, section } of settingsMenuItems()) {
      const parsed = /^(.+?) {2}\((.+)\.\.\.\)$/.exec(label);
      expect(parsed, `${label} is not "<Section Name>  (<descriptor>...)"`).not.toBeNull();
      expect(parsed[1]).toBe(labels.get(section));
      expect(parsed[2]).not.toBe("");
    }
  });

  it("keeps every settings item covered", () => {
    expect(settingsMenuItems()).toEqual([
      { label: "Connections  (API Keys, Models & Ingress...)", section: "connections" },
      { label: "Phone  (Companion Access...)", section: "companion" },
      { label: "Engines  (CLIs...)", section: "engines" },
      { label: "Usage  (Token Spend...)", section: "usage" },
    ]);
  });
});
