import { describe, expect, it } from "vitest";

import { voiceMasterEnabled } from "./voice-master.ts";

describe("voiceMasterEnabled", () => {
  it("defaults to on so existing workspaces keep current behavior", () => {
    expect(voiceMasterEnabled(undefined)).toBe(true);
    expect(voiceMasterEnabled({})).toBe(true);
    expect(voiceMasterEnabled({ enabled: true })).toBe(true);
  });

  it("turns off only when enabled is false", () => {
    expect(voiceMasterEnabled({ enabled: false })).toBe(false);
  });
});
