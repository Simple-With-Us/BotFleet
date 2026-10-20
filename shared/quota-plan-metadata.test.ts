import { describe, expect, it } from "vitest";
import { parseQuotaPlanMetadata, quotaPlanMetadataLines } from "./quota-plan-metadata";

export const planMetadata = {
  detectedPlanName: "Ultra", userPlanName: "My Pro", userCostUsd: "20.00",
  userRenewalDateText: "Next Friday", userSubtitle: "Work account",
  showCostAndRenewal: true, hasMismatch: true,
};

describe("quota plan metadata", () => {
  it("keeps both sources and rejects unknown or malformed fields", () => {
    expect(parseQuotaPlanMetadata({ ...planMetadata, token: "never forward" })).toEqual(planMetadata);
    expect(parseQuotaPlanMetadata({ userPlanName: "x".repeat(501), detectedPlanName: "bad\ntext", userCostUsd: 20, hasMismatch: "true" }))
      .toEqual({ hasMismatch: false });
    expect(parseQuotaPlanMetadata(undefined)).toBeUndefined();
    expect(parseQuotaPlanMetadata([])).toBeUndefined();
  });

  it("displays separate identities, entered cost and renewal, and mismatch", () => {
    expect(quotaPlanMetadataLines(planMetadata)).toEqual([
      "Detected Plan: Ultra", "Entered Plan: My Pro", "Work account",
      "Entered Cost (USD): 20.00", "Entered Renewal: Next Friday", "Detected and entered plans differ",
    ]);
    expect(quotaPlanMetadataLines({ ...planMetadata, showCostAndRenewal: false })).not.toContain("Entered Cost (USD): 20.00");
    expect(quotaPlanMetadataLines(undefined)).toEqual([]);
  });
});
