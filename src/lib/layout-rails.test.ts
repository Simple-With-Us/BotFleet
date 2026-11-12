import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { RAIL_OVERLAY_MAX_PX, railAsideClass } from "./layout-rails";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..");

describe("right-rail overlay (UX-006)", () => {
  it("overlays instead of shrinking chat below ~1100px", () => {
    expect(RAIL_OVERLAY_MAX_PX).toBe(1099);
    const cls = railAsideClass("w-[400px]");
    expect(cls).toContain("max-[1099px]:absolute");
    expect(cls).toContain("max-[1099px]:right-0");
    expect(cls).toContain("min-[1100px]:relative");
    expect(cls).toContain("w-[400px]");
    expect(cls).toContain("max-w-full");
  });

  it("wires Bot Profile, Inspector, Computer, and Group settings through the helper", () => {
    const files = [
      "components/SettingsPanel.tsx",
      "components/InspectorPanel.tsx",
      "components/ComputerPanel.tsx",
      "components/GroupSettingsPanel.tsx",
    ];
    for (const rel of files) {
      const text = readFileSync(join(src, rel), "utf8");
      expect(text, rel).toContain("railAsideClass(");
      expect(text, rel).not.toMatch(/aside className="animate-panel-in[^"]*shrink-0/);
    }
  });

  it("dims chat under an overlay rail so a click dismisses it", () => {
    const app = readFileSync(join(src, "App.tsx"), "utf8");
    expect(app).toContain("max-[1099px]:block");
    expect(app).toContain("toggleSettings");
    expect(app).toContain("toggleComputer");
    expect(app).toContain("toggleInspector");
  });

  it("keeps Electron min widths at 760 (viewer) and 900 (app)", () => {
    const main = readFileSync(join(here, "../../electron/main.mjs"), "utf8");
    expect(main).toMatch(/minWidth:\s*760/);
    expect(main).toMatch(/minWidth:\s*900/);
  });
});
