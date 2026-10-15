import { describe, expect, it } from "vitest";

import {
  doomedReason,
  profileFor,
  requiredFor,
  worksInWorkspace,
  WISDOM,
} from "./capability-profile.ts";

describe("profileFor", () => {
  it("marks grok as workspace-less with host-gated shell", () => {
    const profile = profileFor({
      driverKind: "grok",
      model: "grok-4",
      capabilities: { toolLoop: true, localComputerMcp: true },
    });
    expect(profile.workspaceTools).toBe(false);
    expect(profile.shell).toBe("with_host_grant");
    expect(profile.images).toBe(false);
  });

  it("marks antigravity approvals auto-deny", () => {
    const profile = profileFor({
      driverKind: "antigravityAgent",
      model: "default",
      capabilities: { computerMcp: true, localComputerMcp: true },
    });
    expect(profile.approvals).toBe("auto-deny");
    expect(profile.reach.local).toBe(true);
  });

  it("marks DSH agent MCP unverified", () => {
    const profile = profileFor({
      driverKind: "dshAgent",
      model: "default",
      capabilities: { computerMcp: true },
    });
    expect(profile.mcp.verified).toBe(false);
  });
});

describe("requiredFor", () => {
  it("requires images when the prompt carries an attachment tag", () => {
    const required = requiredFor({ text: "see <attached-image path=x>", computers: [] });
    expect(required.has("images")).toBe(true);
  });

  it("requires vm when the bot grants vm", () => {
    const required = requiredFor({ text: "hi", computers: ["vm"] });
    expect(required.has("vm")).toBe(true);
  });
});

describe("doomedReason", () => {
  it("refuses grok coding without host grant when coding is required", () => {
    const profile = profileFor({
      driverKind: "grok",
      model: "grok-4",
      capabilities: { toolLoop: true },
    });
    const required = new Set(["coding" as const]);
    const verdict = doomedReason(profile, required, { hasHostComputer: false });
    expect(verdict?.taskClass).toBe("coding");
    expect(verdict?.verdict).toBe("refuse");
  });

  it("warns on antigravity desktop_gui instead of refusing", () => {
    const profile = profileFor({
      driverKind: "antigravityAgent",
      model: "default",
      capabilities: { computerMcp: true, localComputerMcp: true },
    });
    const required = requiredFor({ text: "click", computers: ["local"] });
    const verdict = doomedReason(profile, required, { hasHostComputer: true });
    expect(verdict?.taskClass).toBe("desktop_gui");
    expect(verdict?.verdict).toBe("warn");
  });

  it("refuses image turns on non-image engines", () => {
    const profile = profileFor({
      driverKind: "minimax",
      model: "default",
      capabilities: { toolLoop: true },
    });
    const required = requiredFor({ text: "<attached-image path=a>", computers: [] });
    const verdict = doomedReason(profile, required);
    expect(verdict?.verdict).toBe("refuse");
    expect(verdict?.taskClass).toBe("images");
  });
});

describe("worksInWorkspace", () => {
  it("matches the historical grok/box exclusion", () => {
    expect(worksInWorkspace("claudeAgent")).toBe(true);
    expect(worksInWorkspace("grok")).toBe(false);
    expect(worksInWorkspace("boxAgent")).toBe(false);
  });
});

describe("WISDOM", () => {
  it("ships at least the director seeds", () => {
    expect(WISDOM.length).toBeGreaterThanOrEqual(3);
  });
});
