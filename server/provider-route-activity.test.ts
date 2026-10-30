import { describe, expect, it } from "vitest";
import { ProviderRouteActivity } from "./provider-route-activity.ts";
import { isTransientCapacityChip, transientCapacityRetryDelayMs } from "./model-fallback.ts";

describe("provider route activity evidence", () => {
  it("recognizes the complete capacity refusal used by the queued-routine fixture", () => {
    const chip = "HTTP 429: concurrency limit reached; retry after 120 seconds";
    expect(isTransientCapacityChip(chip)).toBe(true);
    expect(transientCapacityRetryDelayMs(chip)).toBe(120_000);
  });
  it("does not mistake fragmented error chips for healthy sibling activity", () => {
    const evidence = new ProviderRouteActivity();
    for (const [index, chunks] of [
      ["HTTP ", "429: Too Many Requests"],
      ["You've hit your ", "usage limit"],
      ["Con", "currency limit reached"],
      ["{\"error\":", "{\"code\":\"rate_limit_error\"}}"],
    ].entries()) {
      const owner = { dispatchId: index };
      for (const chunk of chunks) expect(evidence.observe(owner, "assistant_text", chunk)).toBe(false);
    }
  });

  it("recognizes normal progress as soon as an ambiguous prefix becomes ordinary output", () => {
    const evidence = new ProviderRouteActivity();
    const owner = { dispatchId: 1 };
    expect(evidence.observe(owner, "assistant_text", "H")).toBe(false);
    expect(evidence.observe(owner, "assistant_text", "ello, the build is running.")).toBe(true);
    expect(evidence.observe(owner, "reasoning_text", "I am checking the failing test.")).toBe(true);
  });

  it("keeps dispatches and assistant/reasoning prefixes separate", () => {
    const evidence = new ProviderRouteActivity();
    const failing = { dispatchId: 1 };
    const sibling = { dispatchId: 2 };
    expect(evidence.observe(failing, "assistant_text", "HTTP ")).toBe(false);
    expect(evidence.observe(sibling, "assistant_text", "The next test is running.")).toBe(true);
    expect(evidence.observe(failing, "assistant_text", "429: concurrency limit reached")).toBe(false);
    expect(evidence.observe(failing, "reasoning_text", "Checking the source.")).toBe(true);
  });
});
