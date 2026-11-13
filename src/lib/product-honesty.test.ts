import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const src = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("product honesty copy", () => {
  it("describes multiple exact-scope Infisical token sources (UX-013)", () => {
    const text = readFileSync(join(src, "components/SecretsSection.tsx"), "utf8");
    expect(text).toContain("Additional Project and Folder Tokens");
    expect(text).toContain("Each row names an exact project, environment, and folder scope.");
    expect(text).toContain("Add Source");
    expect(text).not.toContain("One Project for Now.");
  });

  it("ships an honest Event Triggers empty, not fake wizards (UX-014)", () => {
    const text = readFileSync(join(src, "components/WebhooksPanel.tsx"), "utf8");
    expect(text).toContain("No Guided Setup Yet");
    expect(text).toContain("Setup guides for specific apps are not here yet.");
    expect(text).not.toContain("Generic Webhooks Only");
    expect(text).not.toContain("webhook POST");
  });
});
