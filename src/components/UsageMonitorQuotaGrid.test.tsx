import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { quotaGridPlaceholderLine } from "@/lib/quota-display";
import { UsageMonitorQuotaGrid } from "./UsageMonitorQuotaGrid";

describe("UsageMonitorQuotaGrid empty state", () => {
  it("renders a plain placeholder when there are no windows", () => {
    const line = quotaGridPlaceholderLine("empty", "Claude");
    const html = renderToStaticMarkup(createElement(UsageMonitorQuotaGrid, { windows: [], emptyLine: line }));
    expect(html).toContain("No usage limits reported yet for Claude.");
    expect(html).toContain("usage-monitor-quota-grid-empty");
  });

  it("renders nothing when there are no windows and no placeholder line", () => {
    const html = renderToStaticMarkup(createElement(UsageMonitorQuotaGrid, { windows: [] }));
    expect(html).toBe("");
  });
});

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
