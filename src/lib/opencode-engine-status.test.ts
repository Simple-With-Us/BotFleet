import { describe, expect, it } from "vitest";

import type { InstanceInfo } from "@/state/store";
import { OPEN_CODE_MODELS_TIMED_OUT_BUSY } from "../../shared/opencode-model-probe.ts";
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

  it("keeps an already-humanized timeout sentence instead of the generic fallback", () => {
    // The server stores BF-2666's plain sentence on the snapshot.  Humanizing
    // that text again must not turn it into "couldn't load… Try again".
    const timeout = openCode({
      state: "unavailable",
      transient: true,
      modelProbeProblem: OPEN_CODE_MODELS_TIMED_OUT_BUSY,
    });
    expect(openCodeModelProbeSentence(timeout)).toBe(OPEN_CODE_MODELS_TIMED_OUT_BUSY);
    expect(openCodeEngineStatusChip(timeout)).toBe("Timed out under load");
  });
});
