import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const card = read("./HostCliIntegrationCard.tsx");
const codeLines = card.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));

describe("HostCliIntegrationCard", () => {
  it("is rendered by the Computers settings section on its own, not inside the Local VM card", () => {
    expect(read("./SettingsModal.tsx")).toContain("<HostCliIntegrationCard />");
    expect(read("./LocalVmRuntimeCard.tsx")).not.toContain("setting-computers-cli-credentials");
  });

  it("saves each toggle through the config route and reports a failed save itself", () => {
    expect(card).toContain('"/api/config"');
    expect(card).toContain("PersistentActionErrorCard");
    expect(card).toContain("shareCliCredentials");
    expect(card).toContain("allowHostTerminal");
    expect(card).toContain("setError(");
    expect(card).toContain('type: "configStatus"');
  });

  it("keeps the search anchor the settings search points at", () => {
    expect(card).toContain('id="setting-computers-cli-credentials"');
    expect(read("../lib/settings-search.ts")).toContain("setting-computers-cli-credentials");
  });

  it("uses the non-breaking sentence gap in everything a person reads", () => {
    const offenders = codeLines.filter((line) => /[.?!] {2}\S/.test(line));
    expect(offenders).toEqual([]);
    expect(card).toContain("accounts.\\u00a0 ");
  });
});
