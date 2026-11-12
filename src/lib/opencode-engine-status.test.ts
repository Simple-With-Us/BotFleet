import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { openCodeEngineStatusChip, openCodeModelProbeSentence } from "./opencode-engine-status";

function openCode(snapshot: InstanceInfo["snapshot"]): InstanceInfo {
  return {
    instanceId: "opencode",
    driverKind: "opencodeGo",
    displayName: "OpenCode",
    models: { default: "", options: [] },
    snapshot,
  };
}

describe("openCode engine status copy", () => {
  it("reads timeout, empty catalog, and sign-in apart on the row", () => {
    const timeout = openCode({
      state: "unavailable",
      transient: true,
      modelProbeProblem: "OpenCode's model probe timed out after 20 s (host load 2.0 per core)",
    });
    expect(openCodeModelProbeSentence(timeout)).toContain("timed out");
    expect(openCodeEngineStatusChip(timeout)).toBe("Timed out under load");

    const empty = openCode({
      state: "available",
      authenticated: false,
      modelProbeProblem: "OpenCode answered but listed no models.",
    });
    expect(openCodeEngineStatusChip(empty)).toBe("No models listed");

    const signIn = openCode({ state: "available", authenticated: false, version: "1.0.0" });
    expect(openCodeModelProbeSentence(signIn)).toBeNull();
  });
});
