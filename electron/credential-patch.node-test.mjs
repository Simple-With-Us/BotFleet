import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

// electron/main.mjs imports the "electron" module and runs Electron-runtime
// side effects at load time, so it cannot be imported under plain
// `node --test`. CREDENTIAL_PATCH is a self-contained object literal — every
// value is a pure arrow function of `value` with no outside references — so
// this test extracts and evaluates just that literal from the source text
// instead of importing the whole module. Same technique diagnostics.test.mjs
// uses to read WORKSPACE_CREDENTIAL_ENV out of server/config.ts.
function loadCredentialPatch() {
  const source = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
  const match = source.match(/const CREDENTIAL_PATCH = (\{[\s\S]*?\n\});/);
  assert.ok(match, "CREDENTIAL_PATCH literal not found in main.mjs");
  // eslint-disable-next-line no-new-func -- evaluating a hand-audited, side-effect-free object literal pulled straight from main.mjs
  return new Function(`"use strict"; return (${match[1]});`)();
}

// saveConfig() only persists sections named in this allowlist
// (server/config.ts) — a CREDENTIAL_PATCH row whose section is missing here
// would save silently to nowhere, exactly the deepseek.key bug this plan
// fixes for Infisical's own field.
function saveConfigSectionAllowlist() {
  const source = readFileSync(new URL("../server/config.ts", import.meta.url), "utf8");
  const match = source.match(/for \(const key of \[([^\]]*)\] as const\)/);
  assert.ok(match, "saveConfig section allowlist not found in server/config.ts");
  return [...match[1].matchAll(/"([a-zA-Z0-9]+)"/g)].map((m) => m[1]);
}

describe("desktop credential:set patches (CREDENTIAL_PATCH)", () => {
  const patch = loadCredentialPatch();
  const names = Object.keys(patch);

  it("declares at least the eight known patch builders, all functions", () => {
    assert.ok(names.length >= 8, `expected at least 8 CREDENTIAL_PATCH rows, found ${names.length}: ${names.join(", ")}`);
    for (const name of names) assert.equal(typeof patch[name], "function", `${name} is not a function`);
  });

  it("every patch builder yields { section: { ... } } and passes the value through unchanged", () => {
    // ttsKey pins the selected provider alongside the key.
    const multiField = new Set(["ttsKey"]);
    for (const name of names) {
      const sentinel = `sentinel-${name}`;
      const result = patch[name](sentinel);
      const sections = Object.keys(result);
      assert.equal(sections.length, 1, `${name} must patch exactly one config section, got ${sections.join(", ")}`);
      const [section] = sections;
      const fields = Object.keys(result[section]);
      if (multiField.has(name)) {
        assert.ok(fields.length >= 1, `${name} must patch at least one field of "${section}", got ${fields.join(", ")}`);
      } else {
        assert.equal(fields.length, 1, `${name} must patch exactly one field of "${section}", got ${fields.join(", ")}`);
      }
      const primaryField = multiField.has(name) ? "key" : fields[0];
      assert.equal(result[section][primaryField], sentinel, `${name} did not pass its value through unchanged`);
    }
  });

  it("every patched section is one saveConfig actually persists to disk", () => {
    const allowlist = saveConfigSectionAllowlist();
    for (const name of names) {
      const [section] = Object.keys(patch[name]("x"));
      assert.ok(
        allowlist.includes(section),
        `${name} writes into config.${section}, which is missing from saveConfig's merge allowlist in ` +
          `server/config.ts — Settings would report success while the save is silently dropped`,
      );
    }
  });

  it("wires the Infisical machine-identity secret into config.infisical.clientSecret", () => {
    assert.ok(Object.hasOwn(patch, "infisicalClientSecret"), "CREDENTIAL_PATCH is missing infisicalClientSecret");
    assert.deepEqual(patch.infisicalClientSecret("shh"), { infisical: { clientSecret: "shh" } });
  });

  it("pins the selected voice engine on each key save, including new installations", () => {
    // A fresh MiniMax save must carry the explicit provider field so the
    // config reader always knows which voice engine to use without guessing.
    // This is tested at the CREDENTIAL_PATCH level because packaged Electron
    // saves route through CREDENTIAL_PATCH rather than the shared helper.
    assert.ok(Object.hasOwn(patch, "ttsKey"), "CREDENTIAL_PATCH is missing ttsKey");
    assert.deepEqual(patch.ttsKey("sk-fresh"), { tts: { key: "sk-fresh", provider: "minimax" } });
    assert.deepEqual(patch.ttsKey("sk-eleven", "elevenlabs"), { tts: { key: "sk-eleven", provider: "elevenlabs" } });
  });
});
