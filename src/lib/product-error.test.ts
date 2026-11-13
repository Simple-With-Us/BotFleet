import { describe, expect, it } from "vitest";
import { productErrorMessage } from "./product-error";

describe("productErrorMessage", () => {
  it("maps network failures to a product sentence", () => {
    const mapped = productErrorMessage(new Error("Failed to fetch"));
    expect(mapped.headline).toContain("Couldn't Reach the Bot Server.");
    expect(mapped.detail).toBe("Failed to fetch");
  });

  it("does not show HTTP status as the primary copy", () => {
    const mapped = productErrorMessage("Save failed: HTTP 502");
    expect(mapped.headline).not.toMatch(/HTTP 502/);
    expect(mapped.detail).toContain("HTTP 502");
  });

  it("keeps an unknown Error.message in the detail", () => {
    const mapped = productErrorMessage(new Error("quota bucket exploded"));
    expect(mapped.headline).toBe("Something Went Wrong.");
    expect(mapped.detail).toBe("quota bucket exploded");
  });
});
