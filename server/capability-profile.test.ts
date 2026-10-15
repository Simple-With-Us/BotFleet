import { describe, expect, it } from "vitest";

import { ALL_FIXTURES, engineFixture } from "./computer-capability.fixtures.ts";
import {
  DOOMED_POLICY,
  doomedReason,
  evaluateCapabilityGate,
  profileFor,
  requiredFor,
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
