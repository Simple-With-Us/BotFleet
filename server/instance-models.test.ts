import { describe, expect, it } from "vitest";
import { instanceModelsSchema } from "./instance-models.ts";

describe("instance model edits", () => {
  it("trims model text and accepts an explicit cleared catalog", () => {
    expect(instanceModelsSchema.parse([{ id: " model/a ", label: " Model A " }]))
      .toEqual([{ id: "model/a", label: "Model A" }]);
    expect(instanceModelsSchema.parse([])).toEqual([]);
  });

  it("rejects unknown fields instead of dropping them", () => {
    expect(instanceModelsSchema.safeParse([{ id: "model/a", label: "Model A", unexpected: true }]).success).toBe(false);
  });

  it("rejects malformed, excessive, multiline, and duplicate entries", () => {
    const valid = { id: "model/a", label: "Model A" };
    const invalid = [null, {}, [null], [{ id: 1, label: "A" }],
      [{ id: " ", label: "A" }], [{ id: "a", label: "" }],
      [{ id: "a\nb", label: "A" }], [{ id: "a", label: "A\rB" }],
      [{ id: "a".repeat(201), label: "A" }], [{ id: "a", label: "A".repeat(201) }],
      [valid, { id: " model/a ", label: "Another label" }],
      Array.from({ length: 101 }, (_, index) => ({ id: `model/${index}`, label: "A" }))];
    for (const input of invalid) expect(instanceModelsSchema.safeParse(input).success).toBe(false);
  });
});
