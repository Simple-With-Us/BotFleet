import { describe, expect, it } from "vitest";

import { ALL_FIXTURES, engineFixture } from "./computer-capability.fixtures.ts";
import {
  DOOMED_POLICY,
  WISDOM,
  doomedReason,
  evaluateCapabilityGate,
  profileFor,
  requiredFor,
  worksInWorkspace,
  type CapabilityProfile,
} from "./capability-profile.ts";

describe("profileFor", () => {
  for (const fixture of ALL_FIXTURES) {
    it(`derives reach for ${fixture.displayName}`, () => {
      const profile = profileFor({
        instanceId: fixture.driverKind,
        driverKind: fixture.driverKind,
        capabilities: fixture.capabilities,
        model: "test-model",
      });
      expect(profile.transport).toBeDefined();
      expect(profile.reach).toMatchObject({
        box: expect.any(Boolean),
        vps: expect.any(Boolean),
        vm: expect.any(Boolean),
        local: expect.any(Boolean),
      });
    });
  }

  it("marks antigravity approvals auto-deny", () => {
    const agy = engineFixture("Antigravity");
    const profile = profileFor({
      instanceId: "antigravity",
      driverKind: agy.driverKind,
      capabilities: agy.capabilities,
      model: "test",
    });
    expect(profile.approvals).toBe("auto-deny");
  });

  it("marks grok API as without workspace tools", () => {
    const grok = engineFixture("Grok");
    const profile = profileFor({
      instanceId: "grok",
      driverKind: grok.driverKind,
      capabilities: grok.capabilities,
      model: "grok-4.7",
    });
    expect(profile.workspaceTools).toBe(false);
    expect(profile.images).toBe(false);
    expect(profile.shell).toBe("with_host_grant");
  });
});

describe("requiredFor", () => {
  it("detects image attachments in prompt text", () => {
    const required = requiredFor({ text: 'hello <attached-image path="/tmp/x.png" />', computers: [] });
    expect(required.has("images")).toBe(true);
  });

  it("adds vm when vm computer granted", () => {
    const required = requiredFor({ text: "run", computers: ["vm"] });
    expect(required.has("vm")).toBe(true);
  });

  it("merges routine needs", () => {
    const required = requiredFor({ text: "x", computers: [], routineNeeds: ["desktop_gui"] });
    expect(required.has("desktop_gui")).toBe(true);
  });

  it("treats an empty prompt as chat", () => {
    const required = requiredFor({ text: "" });
    expect(required.has("chat")).toBe(true);
    expect(required.size).toBe(1);
  });

  it("ignores a mention of the image marker that is not a real attachment tag", () => {
    const required = requiredFor({ text: "docs mention <attached-image without a path" });
    expect(required.has("images")).toBe(false);
    expect(required.has("chat")).toBe(true);
  });

  it("does not treat a computer grant as a coding task", () => {
    const required = requiredFor({ text: "hello", computers: ["local"] });
    expect(required.has("desktop_gui")).toBe(true);
    expect(required.has("coding")).toBe(false);
  });

  it("ignores echoed image markers when requested", () => {
    const required = requiredFor({
      text: '<attached-image path="/tmp/x.png" />',
      computers: [],
      ignorePromptImageMarkers: true,
    });
    expect(required.has("images")).toBe(false);
    expect(required.has("chat")).toBe(true);
  });
});

describe("doomedReason", () => {
  function grokProfile(): CapabilityProfile {
    const grok = engineFixture("Grok");
    return profileFor({
      instanceId: "grok",
      driverKind: grok.driverKind,
      capabilities: grok.capabilities,
      model: "grok-4.7",
    });
  }

  it("refuses image turns on grok API", () => {
    const profile = grokProfile();
    const required = requiredFor({ text: '<attached-image path="/a.png" />', computers: [] });
    const doomed = doomedReason(profile, required);
    expect(doomed?.taskClass).toBe("images");
    expect(doomed?.verdict).toBe("refuse");
  });

  it("refuses vm on engines without vm reach", () => {
    const grok = grokProfile();
    const required = requiredFor({ text: "vm task", computers: ["vm"] });
    const doomed = doomedReason(grok, required);
    expect(doomed?.taskClass).toBe("vm");
  });

  it("allows boxAgent coding on cloud via remoteAgent transport", () => {
    const box = engineFixture("ASCII.dev Box");
    const profile = profileFor({
      instanceId: "box",
      driverKind: box.driverKind,
      capabilities: box.capabilities,
      model: "default",
    });
    expect(profile.transport).toBe("remoteAgent");
    const required = requiredFor({ text: "edit workspace file", computers: ["cloud"], runOn: "cloud" });
    expect(doomedReason(profile, required, DOOMED_POLICY, { hostShellGranted: true })).toBeNull();
  });

  it("warns on antigravity desktop_gui per policy", () => {
    const agy = engineFixture("Antigravity");
    const profile = profileFor({
      instanceId: "antigravity",
      driverKind: agy.driverKind,
      capabilities: agy.capabilities,
      model: "test",
    });
    const required = requiredFor({ text: "gui", computers: ["local"] });
    // antigravity reaches local via mcp — satisfies desktop_gui; force missing by clearing reach
    const stripped: CapabilityProfile = { ...profile, reach: { box: false, vps: false, vm: false, local: false } };
    const missing = doomedReason(stripped, required, DOOMED_POLICY, { hostShellGranted: true });
    expect(missing?.taskClass).toBe("desktop_gui");
    expect(missing?.verdict).toBe("warn");
  });
});

describe("evaluateCapabilityGate", () => {
  it("returns ok for ordinary chat on claude", () => {
    const claude = engineFixture("Claude");
    const result = evaluateCapabilityGate(
      {
        instanceId: "claude",
        driverKind: claude.driverKind,
        capabilities: { ...claude.capabilities, images: true },
        model: "claude-sonnet",
      },
      { text: "hello", computers: [] },
      { hostShellGranted: true },
    );
    expect(result.action).toBe("ok");
  });

  it("refuses image turns on engines that cannot read attachments", () => {
    const grok = engineFixture("Grok");
    const profile = profileFor({
      instanceId: "grok",
      driverKind: grok.driverKind,
      capabilities: grok.capabilities,
      model: "grok-4.7",
    });
    const required = requiredFor({ text: '<attached-image path="/tmp/a.png" />', computers: [] });
    const verdict = doomedReason(profile, required);
    expect(verdict?.verdict).toBe("refuse");
    expect(verdict?.taskClass).toBe("images");
  });

  it("lets a box agent code on the machine it is already running on", () => {
    const box = engineFixture("ASCII.dev Box");
    const profile = profileFor({
      instanceId: "box",
      driverKind: box.driverKind,
      capabilities: box.capabilities,
      model: "box",
    });
    const required = requiredFor({ text: "edit the file", routineNeeds: ["coding"] });
    expect(doomedReason(profile, required)).toBeNull();
  });

  it("warns when connected apps are required and the engine cannot mount them", () => {
    const claude = engineFixture("Claude");
    const profile = profileFor({
      instanceId: "claude",
      driverKind: claude.driverKind,
      capabilities: { ...claude.capabilities, composioMcp: false },
      model: "claude-sonnet",
    });
    const required = requiredFor({ text: "call", skillCaps: ["phoneMcp"] });
    const doomed = doomedReason(profile, required);
    expect(doomed?.taskClass).toBe("connected_apps");
    expect(doomed?.verdict).toBe("warn");
  });

  it("refuses grok coding without a host grant when coding is required", () => {
    const profile = profileFor({
      instanceId: "grok",
      driverKind: engineFixture("Grok").driverKind,
      capabilities: engineFixture("Grok").capabilities,
      model: "grok-4.7",
    });
    const required = requiredFor({ text: "edit", routineNeeds: ["coding"] });
    const doomed = doomedReason(profile, required, DOOMED_POLICY, { hostShellGranted: false });
    expect(doomed?.taskClass).toBe("coding");
    expect(doomed?.verdict).toBe("refuse");
  });

  it("refuses image attachments on grok API", () => {
    const grok = engineFixture("Grok");
    const result = evaluateCapabilityGate(
      {
        instanceId: "grok",
        driverKind: grok.driverKind,
        capabilities: grok.capabilities,
        model: "grok-4.7",
      },
      { text: '<attached-image path="/tmp/x.png" />', computers: [] },
      { hostShellGranted: true },
    );
    expect(result.action).toBe("refuse");
    expect(result.taskClass).toBe("images");
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
  it("ships director seeds including DSH rows", () => {
    expect(WISDOM.length).toBeGreaterThanOrEqual(4);
    expect(WISDOM.some((row) => row.engine === "dshAgent")).toBe(true);
    expect(WISDOM.some((row) => row.engine === "dsh")).toBe(true);
  });
});
