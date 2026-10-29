import { describe, expect, it } from "vitest";

import { joinRefusals } from "./peer-refusals.ts";

describe("joinRefusals", () => {
  it("lists every reason, in the order it came, on one line", () => {
    expect(joinRefusals(["Sleepy is switched off", "Archived is hidden", "no such bot: Ghost"])).toBe(
      "Sleepy is switched off; Archived is hidden; no such bot: Ghost",
    );
  });

  it("says a repeated reason once, so a bot named twice is not refused twice", () => {
    expect(joinRefusals(["Sleepy is switched off", "Sleepy is switched off"])).toBe("Sleepy is switched off");
  });

  it("is empty when nothing was refused", () => {
    expect(joinRefusals([])).toBe("");
  });
});
