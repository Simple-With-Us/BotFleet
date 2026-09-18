import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("product honesty copy", () => {
  it("names Infisical as One Project for Now (UX-013)", () => {
    const text = readFileSync(join(src, "components/SecretsSection.tsx"), "utf8");
    expect(text).toContain("One Project for Now.");
  });

  it("ships an honest Event Triggers empty, not fake wizards (UX-014)", () => {
    const text = readFileSync(join(src, "components/WebhooksPanel.tsx"), "utf8");
    expect(text).toContain("Generic Webhooks Only — Guided Setup Coming");
  });
});
