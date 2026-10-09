// shared/bypass-coverage.ts says, per engine, what a bot's Bypass Permissions
// switch does.  The table is keyed by driver kind, so a typo in it is a silent
// "asks" for the engine it was meant to describe; this ties every name to a
// real driver, and pins the answers the audit of 2026-10-09 reached.
import { describe, expect, it } from "vitest";

import {
  INSTANCE_AUTONOMOUS_MODE_NO_OP_NOTE,
  bypassCoverage,
  bypassCoverageNote,
  instanceAutonomousModeApplies,
} from "../shared/bypass-coverage.ts";
import { BUILT_IN_DRIVERS } from "./drivers/builtIn.ts";

const KINDS = BUILT_IN_DRIVERS.map((driver) => driver.driverKind);

describe("bypassCoverage", () => {
  it("names only engines that exist", () => {
    for (const kind of ["boxAgent", "cli-wrapper", "piAgent", "antigravityAgent", "minimax", "openai-compat", "grok"]) {
      expect(KINDS, kind).toContain(kind);
    }
  });

  it("says Box, a wrapped CLI and Pi never ask, and Antigravity has a native mode", () => {
    for (const kind of ["boxAgent", "cli-wrapper", "piAgent"]) expect(bypassCoverage(kind), kind).toBe("none");
    expect(bypassCoverage("antigravityAgent")).toBe("native");
  });

  it("leaves every engine that raises asks to the broker, and an unknown one too", () => {
    for (const kind of [
      "claudeAgent", "codex", "grokAgent", "cursorAgent", "droidAgent", "kimiAgent", "deepseekAgent", "qwenAgent",
      "hermesAgent", "opencodeGo", "mcodeAgent", "museAgent", "dshAgent", "minimax", "openai-compat", "grok",
    ]) {
      expect(bypassCoverage(kind), kind).toBe("asks");
    }
    expect(bypassCoverage("some-future-engine")).toBe("asks");
    expect(bypassCoverage(undefined)).toBe("asks");
  });

  it("writes a note only where the switch does not simply work", () => {
    expect(bypassCoverageNote("asks")).toBeNull();
    expect(bypassCoverageNote("none")).toMatch(/never asks for approval/);
    expect(bypassCoverageNote("native")).toMatch(/skip-permissions mode for turns that do not control This Mac/);
    // A no-break space and a space between sentences, never two ASCII spaces.
    for (const coverage of ["none", "native"] as const) {
      const note = bypassCoverageNote(coverage)!;
      expect(note).not.toContain(".  ");
      expect(note).not.toMatch(/\. [A-Z]/);
    }
  });
});

describe("instanceAutonomousModeApplies", () => {
  it("is false exactly where the box in Settings > Engines is read by nothing", () => {
    for (const kind of ["boxAgent", "cli-wrapper", "piAgent", "minimax", "openai-compat", "grok"]) {
      expect(KINDS, kind).toContain(kind);
      expect(instanceAutonomousModeApplies(kind), kind).toBe(false);
    }
    for (const kind of ["claudeAgent", "codex", "antigravityAgent", "grokAgent", "cursorAgent", "droidAgent", "dshAgent", "kimiAgent"]) {
      expect(instanceAutonomousModeApplies(kind), kind).toBe(true);
    }
    expect(instanceAutonomousModeApplies(undefined)).toBe(true);
    expect(INSTANCE_AUTONOMOUS_MODE_NO_OP_NOTE).toMatch(/changes nothing/);
  });
});
