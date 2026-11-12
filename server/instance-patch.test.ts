import { describe, expect, it } from "vitest";

import { InstancePatchBodySchema, instancePatchInputError } from "./instance-patch.ts";

describe("InstancePatchBodySchema", () => {
  it("rejects unknown keys", () => {
    const parsed = InstancePatchBodySchema.safeParse({ enabled: true, surprise: 1 });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(instancePatchInputError(parsed.error)).toBe("invalid instance patch body");
    }
  });

  it("accepts supported fields only", () => {
    expect(InstancePatchBodySchema.safeParse({ replyWaitMinutes: 20 }).success).toBe(true);
    expect(InstancePatchBodySchema.safeParse({ replyWaitMinutes: null }).success).toBe(true);
    expect(InstancePatchBodySchema.safeParse({ cli: "/bin/x" }).success).toBe(true);
  });
});
