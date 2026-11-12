import { describe, expect, it } from "vitest";

import {
  OPEN_CODE_ANSWERED_NO_MODELS,
  OPEN_CODE_LISTED_NO_MODELS,
  OPEN_CODE_MODELS_LOAD_FAILED,
  OPEN_CODE_MODELS_STOPPED_EARLY,
  OPEN_CODE_MODELS_TIMED_OUT_BUSY,
  humanizeOpenCodeModelProbeProblem,
  openCodeModelProbeProblemIsUnknown,
} from "./opencode-model-probe.ts";

describe("humanizeOpenCodeModelProbeProblem", () => {
  it("replaces probe timeout copy with plain English", () => {
    expect(
      humanizeOpenCodeModelProbeProblem("OpenCode's model probe timed out after 20 s (host load 3.0 per core)"),
    ).toBe(OPEN_CODE_MODELS_TIMED_OUT_BUSY);
    expect(humanizeOpenCodeModelProbeProblem("OpenCode's model probe timed out after 1 s")).toBe(
      OPEN_CODE_MODELS_TIMED_OUT_BUSY,
    );
  });

  it("replaces stopped-by-signal copy without surfacing signal names", () => {
    expect(
      humanizeOpenCodeModelProbeProblem("OpenCode's model probe was stopped by SIGTERM before it answered"),
    ).toBe(OPEN_CODE_MODELS_STOPPED_EARLY);
    expect(humanizeOpenCodeModelProbeProblem("OpenCode's model probe was stopped before it answered")).toBe(
      OPEN_CODE_MODELS_STOPPED_EARLY,
    );
  });

  it("replaces empty-catalog jargon", () => {
    expect(humanizeOpenCodeModelProbeProblem("opencode models answered nothing")).toBe(OPEN_CODE_ANSWERED_NO_MODELS);
    expect(
      humanizeOpenCodeModelProbeProblem("opencode models listed nothing (Unrecognized flag: --verbose)"),
    ).toBe(OPEN_CODE_LISTED_NO_MODELS);
    expect(humanizeOpenCodeModelProbeProblem("OpenCode returned no usable models")).toBe(OPEN_CODE_LISTED_NO_MODELS);
  });

  it("maps unrecognized developer text to a safe generic sentence", () => {
    expect(humanizeOpenCodeModelProbeProblem("ENOENT: no such binary")).toBe(OPEN_CODE_MODELS_LOAD_FAILED);
    expect(humanizeOpenCodeModelProbeProblem("Command failed: opencode models")).toBe(OPEN_CODE_MODELS_LOAD_FAILED);
    expect(openCodeModelProbeProblemIsUnknown("ENOENT: no such binary")).toBe(true);
    expect(openCodeModelProbeProblemIsUnknown("opencode models answered nothing")).toBe(false);
  });

  it("never passes through the word probe", () => {
    for (const raw of [
      "OpenCode's model probe timed out after 50 s",
      "opencode models listed nothing (Unrecognized flag: --verbose)",
      "spawn opencode ENOENT",
    ]) {
      expect(humanizeOpenCodeModelProbeProblem(raw).toLowerCase()).not.toContain("probe");
    }
  });
});
