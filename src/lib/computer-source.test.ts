import { describe, expect, it } from "vitest";
import {
  AUTO_PRECEDENCE,
  autoSource,
  choiceSurvives,
  hasPreviewChoice,
  previewChoices,
  resolvePreviewSource,
} from "./computer-source";

describe("autoSource", () => {
  // These encode the precedence the panel shipped with.  They are the part of
  // the switcher that could silently change which computer every bot uses, so
  // they are pinned rather than left implicit in a chain of includes() calls.
  it("gives the Local VM outright when the bot holds it", () => {
    expect(autoSource(["vm", "cloud"])).toBe("vm");
    expect(autoSource(["vm", "local"])).toBe("vm");
    expect(autoSource(["vm", "cloud", "local"])).toBe("vm");
  });

  it("gives cloud whenever the bot holds it, ahead of This Mac", () => {
    expect(autoSource(["cloud", "local"])).toBe("cloud");
    expect(autoSource(["local", "cloud"])).toBe("cloud");
  });

  it("falls back to This Mac only when it is the sole option", () => {
    expect(autoSource(["local"])).toBe("local");
  });

  it("reports no computer for an empty list", () => {
    expect(autoSource([])).toBe("off");
  });

  it("states its precedence in the documented order", () => {
    expect(AUTO_PRECEDENCE).toEqual(["vm", "cloud", "local"]);
  });
});

describe("resolvePreviewSource", () => {
  it("honours a choice the bot actually holds", () => {
    expect(resolvePreviewSource(["cloud", "local"], "local")).toBe("local");
    expect(resolvePreviewSource(["cloud", "local", "vm"], "vm")).toBe("vm");
    expect(resolvePreviewSource(["cloud", "local"], "cloud")).toBe("cloud");
  });

  it("falls back to auto when the bot does not hold the choice", () => {
    // Picking "Local VM" for a bot without one must not render a stranger's
    // desktop — the bot has no claim to it.
    expect(resolvePreviewSource(["cloud", "local"], "vm")).toBe("cloud");
    expect(resolvePreviewSource(["cloud"], "local")).toBe("cloud");
    expect(resolvePreviewSource([], "vm")).toBe("off");
  });

  it("defers to auto when that is the choice", () => {
    expect(resolvePreviewSource(["cloud", "local"], "auto")).toBe("cloud");
  });
});

describe("hasPreviewChoice", () => {
  it("offers nothing to a bot with a single computer", () => {
    expect(hasPreviewChoice([])).toBe(false);
    expect(hasPreviewChoice(["vm"])).toBe(false);
  });

  it("offers a choice as soon as there are two", () => {
    expect(hasPreviewChoice(["cloud", "local"])).toBe(true);
  });
});

describe("previewChoices", () => {
  it("puts auto first, then only the computers the bot holds", () => {
    expect(previewChoices(["cloud", "local"])).toEqual(["auto", "cloud", "local"]);
    expect(previewChoices(["vm", "cloud", "local"])).toEqual(["auto", "vm", "cloud", "local"]);
  });

  it("never offers a computer the bot does not hold", () => {
    expect(previewChoices(["cloud", "local"])).not.toContain("vm");
    expect(previewChoices(["vm", "local"])).toEqual(["auto", "vm", "local"]);
  });

  it("stays out of the way for a single computer", () => {
    expect(previewChoices(["vm"])).toEqual([]);
    expect(previewChoices([])).toEqual([]);
  });
});

describe("choiceSurvives", () => {
  it("keeps a choice the bot still holds", () => {
    expect(choiceSurvives("local", ["cloud", "local"])).toBe("local");
  });

  it("reverts to auto when the computer is gone, since auto is always defined", () => {
    expect(choiceSurvives("vm", ["cloud", "local"])).toBe("auto");
    expect(choiceSurvives("local", [])).toBe("auto");
  });

  it("leaves auto alone", () => {
    expect(choiceSurvives("auto", ["cloud"])).toBe("auto");
  });
});

describe("autoSource matches the precedence the panel shipped with", () => {
  // These are transcriptions of the branches this change replaced.  If any of
  // them changes, a bot silently starts using a different computer than it
  // always has — which is exactly the kind of change that has no symptom until
  // a bot posts from the wrong machine.
  it.each([
    [["cloud", "local"], "cloud"],
    [["local", "cloud"], "cloud"],
    [["vm", "cloud"], "vm"],
    [["cloud", "vm"], "vm"],
    [["vm", "local"], "vm"],
    [["local", "vm"], "vm"],
    [["vm", "cloud", "local"], "vm"],
    [["local"], "local"],
    [["cloud"], "cloud"],
    [["vm"], "vm"],
    [[], "off"],
  ] as Array<[Array<"vm" | "local" | "cloud">, "vm" | "local" | "cloud" | "off"]>)(
    "%s resolves to %s",
    (computers, expected) => {
      expect(autoSource(computers)).toBe(expected);
    },
  );
});
