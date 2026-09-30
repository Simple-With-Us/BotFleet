// The picker's rail and status chip: an engine whose probe did not answer in
// time reads "Checking", never "Not installed" or "Sign-in required", and the
// Computer engine stays off the rail until a Box token is configured.
import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { engineStatus, railEngines } from "./ModelPicker";

function engine(
  instanceId: string,
  snapshot: InstanceInfo["snapshot"],
  extra: Partial<InstanceInfo> = {},
): InstanceInfo {
  return {
    instanceId,
    driverKind: `${instanceId}Agent`,
    displayName: instanceId,
    models: { default: `${instanceId}-1`, options: [{ id: `${instanceId}-1`, label: "One" }] },
    snapshot,
    ...extra,
  };
}

describe("engineStatus", () => {
  it("says Checking for a probe that did not answer in time", () => {
    const checking = engine("claude", { state: "unavailable", transient: true, reason: "Claude did not answer in time" });
    expect(engineStatus(checking)).toBe("Checking");
  });

  it("does not say Sign-in required when the auth probe could not tell", () => {
    expect(engineStatus(engine("claude", { state: "available", version: "2.1.284" }))).toBe("2.1.284");
  });

  it("still names real setup problems", () => {
    expect(engineStatus(engine("codex", { state: "unavailable", reason: "`codex` CLI not found" }))).toBe("Not installed");
    expect(engineStatus(engine("claude", { state: "available", authenticated: false, version: "2.1.284" }))).toBe(
      "Sign-in required",
    );
    expect(engineStatus(engine("kimi", { state: "unavailable", reason: "Disabled in settings" }))).toBe("Disabled");
  });
});

describe("railEngines", () => {
  const noBoxToken = {
    state: "unavailable" as const,
    hidden: true,
    reason: 'no Box token — add {"box":{"token":"…"}} to ~/.botfleet/config.json',
  };

  it("leaves the Computer engine off the rail until a Box token is configured", () => {
    const rail = railEngines(
      [
        engine("claude", { state: "available", version: "2.1.284" }),
        engine("computer", noBoxToken, { driverKind: "boxAgent" }),
      ],
      "claude",
    );
    expect(rail.map((i) => i.instanceId)).toEqual(["claude"]);
  });

  it("lists Computer once it is configured", () => {
    const rail = railEngines(
      [engine("computer", { state: "available", authenticated: true, version: null }, { driverKind: "boxAgent" })],
      "claude",
    );
    expect(rail.map((i) => i.instanceId)).toEqual(["computer"]);
  });

  it("keeps a hidden engine a bot is already set to, so the picker can explain it", () => {
    const rail = railEngines([engine("computer", noBoxToken, { driverKind: "boxAgent" })], "computer");
    expect(rail.map((i) => i.instanceId)).toEqual(["computer"]);
  });

  it("keeps an engine that is only being re-checked", () => {
    const rail = railEngines(
      [engine("cursor", { state: "unavailable", transient: true, reason: "Cursor did not answer in time" })],
      "claude",
    );
    expect(rail.map((i) => i.instanceId)).toEqual(["cursor"]);
  });
});
