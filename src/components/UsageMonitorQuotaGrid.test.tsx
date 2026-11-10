import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageMonitorQuotaGrid } from "./UsageMonitorQuotaGrid";

describe("quota plan details", () => {
  it("renders both reported names and user details as escaped text", () => {
    const html = renderToStaticMarkup(createElement(UsageMonitorQuotaGrid, { windows: [{
      id: "cursor", provider: "cursor", label: "Plan", skip: false, planName: "Ultra",
      planMetadata: { detectedPlanName: "Ultra", userPlanName: "My Pro", userCostUsd: "20.00",
        userRenewalDateText: "Next Friday", userSubtitle: "<script>account</script>", showCostAndRenewal: true, hasMismatch: true },
    }] }));
    for (const text of ["Detected Plan: Ultra", "Entered Plan: My Pro", "Entered Cost (USD): 20.00", "Entered Renewal: Next Friday", "Detected and entered plans differ", "not reported"]) expect(html).toContain(text);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
