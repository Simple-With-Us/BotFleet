import { describe, expect, it } from "vitest";
import { previewChoiceLabel } from "./ComputerSourcePicker";

describe("previewChoiceLabel", () => {
  it("names Auto rather than pretending to be a destination", () => {
    // The picker exists so a person can look at a specific computer; a label
    // that named a destination for Auto would hide which one is in play.
    expect(previewChoiceLabel("auto", "vps", true)).toBe("Auto");
  });

  it("names the cloud destination this bot actually uses", () => {
    // Two backends behind one button means "Cloud" alone is ambiguous.
    expect(previewChoiceLabel("cloud", "vps", true)).toBe("Self-hosted VPS");
    expect(previewChoiceLabel("cloud", "box", true)).toBe("ASCII.dev Box");
  });

  it("matches the platform wording the rest of the panel uses", () => {
    expect(previewChoiceLabel("local", "box", true)).toBe("This Mac");
    expect(previewChoiceLabel("local", "box", false)).toBe("This Computer");
  });

  it("always calls the container the Local VM", () => {
    expect(previewChoiceLabel("vm", "box", false)).toBe("Local VM");
    expect(previewChoiceLabel("vm", "vps", true)).toBe("Local VM");
  });
});
