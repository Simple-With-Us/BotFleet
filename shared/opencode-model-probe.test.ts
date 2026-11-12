import { describe, expect, it } from "vitest";

import { humanizeOpenCodeModelProbeProblem } from "./opencode-model-probe.ts";

describe("humanizeOpenCodeModelProbeProblem", () => {
  it("keeps timeout and signal sentences", () => {
    expect(
      humanizeOpenCodeModelProbeProblem("OpenCode's model probe timed out after 20 s (host load 3.0 per core)"),
    ).toBe("OpenCode's model probe timed out after 20 s (host load 3.0 per core)");
    expect(
      humanizeOpenCodeModelProbeProblem("OpenCode's model probe was stopped by SIGTERM before it answered"),
    ).toBe("OpenCode's model probe was stopped by SIGTERM before it answered");
  });

  it("replaces empty-catalog jargon", () => {
    expect(humanizeOpenCodeModelProbeProblem("opencode models answered nothing")).toBe(
      "OpenCode answered but listed no models.",
    );
    expect(
      humanizeOpenCodeModelProbeProblem("opencode models listed nothing (Unrecognized flag: --verbose)"),
    ).toBe("OpenCode listed no models (Unrecognized flag: --verbose).");
  });
});
