import { describe, expect, it, vi } from "vitest";
import { onTrajectorySearchRequest, requestTrajectorySearch } from "./trajectory-search.ts";

describe("asking the Trajectory tab to search", () => {
  it("does nothing when the tab is not open", () => {
    expect(() => requestTrajectorySearch()).not.toThrow();
  });

  it("reaches the open tab, once per request, until it unsubscribes", () => {
    const focus = vi.fn();
    const off = onTrajectorySearchRequest(focus);
    requestTrajectorySearch();
    requestTrajectorySearch();
    expect(focus).toHaveBeenCalledTimes(2);
    off();
    requestTrajectorySearch();
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
