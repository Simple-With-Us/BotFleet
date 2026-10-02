// Every engine's job lane, pinned (jobs P2, requirement 12).
//
// Two things are asserted, and the second is the one that matters: the table
// must cover every engine the fleet ships.  A new engine that lands without a
// row here fails this test rather than silently inheriting a lane.
import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "../drivers/builtIn.ts";
import { jobLane, type JobLaneSettings } from "./engine-lanes.ts";
import { JOB_ENGINE_FIXTURES } from "./engine-fixtures.ts";

const ON: JobLaneSettings = { enabled: true, cliLanes: true };

describe("the job lane of every engine", () => {
  for (const engine of JOB_ENGINE_FIXTURES) {
    it(`mounts ${engine.displayName} on ${engine.lane} — ${engine.because}`, () => {
      expect(jobLane(engine.capabilities, ON, true).lane).toBe(engine.lane);
    });
  }

  it("covers every engine the fleet ships", () => {
    const stated = JOB_ENGINE_FIXTURES.map((engine) => engine.driverKind).sort();
    const shipped = BUILT_IN_DRIVERS.map((driver) => driver.driverKind).sort();
    expect(stated).toEqual(shipped);
  });
});

describe("a refused lane says why", () => {
  it("refuses an engine whose own background work dies with the turn", () => {
    const out = jobLane({ backgroundJobs: "native" }, ON, true);
    expect(out.lane).toBe("none");
    expect(out.reason).toMatch(/dies when the turn settles/);
  });

  it("refuses an engine that mounts no MCP server, even a job-capable one", () => {
    const out = jobLane({ backgroundJobs: "emulated", agentsMcp: false }, ON, true);
    expect(out.lane).toBe("none");
    expect(out.reason).toMatch(/no MCP server/);
  });

  it("refuses every engine when the owner turned jobs off", () => {
    for (const engine of JOB_ENGINE_FIXTURES) {
      expect(jobLane(engine.capabilities, { enabled: false, cliLanes: true }, true).lane).toBe("none");
    }
  });

  it("returns only the tool-loop lane to the HTTP lane when the owner turns off cliLanes", () => {
    const off: JobLaneSettings = { enabled: true, cliLanes: false };
    const lanes = JOB_ENGINE_FIXTURES.map((engine) => jobLane(engine.capabilities, off, true).lane);
    expect(lanes).toContain("http");
    expect(lanes).not.toContain("mcp");
  });

  it("refuses a bot with no host shell, on every lane", () => {
    for (const engine of JOB_ENGINE_FIXTURES) {
      expect(jobLane(engine.capabilities, ON, false).lane).toBe("none");
    }
  });

  it("prefers the tool-loop lane when an engine declares both", () => {
    // The HTTP lane needs no mount, so it is the one that cannot be turned
    // off by the cliLanes switch and must win when an engine has both.
    expect(jobLane({ toolLoop: true, agentsMcp: true, backgroundJobs: "emulated" }, ON, true).lane).toBe("http");
  });
});
