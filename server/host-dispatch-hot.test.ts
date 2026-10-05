import { describe, expect, it, vi } from "vitest";

import { DEFAULT_ADMISSION } from "./jobs/admission.ts";
import { MAX_INIT_LOAD_FACTOR } from "./drivers/acp/init-deadline.ts";
import { readHostDispatchHot, resetHostDispatchHotProbe } from "./host-dispatch-hot.ts";

vi.mock("./jobs/admission.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jobs/admission.ts")>();
  return {
    ...actual,
    createHostProbe: () => ({
      swapUsedPercent: () => 99,
    }),
  };
});

vi.mock("./drivers/acp/init-deadline.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./drivers/acp/init-deadline.ts")>();
  return {
    ...actual,
    readHostLoad: () => ({ load1m: 0, cores: 4 }),
  };
});

describe("readHostDispatchHot", () => {
  it("reuses the webhook dispatch hot gate", () => {
    resetHostDispatchHotProbe();
    expect(readHostDispatchHot()).toBe(true);
    expect(DEFAULT_ADMISSION.maxSwapPercent).toBeLessThanOrEqual(99);
    expect(MAX_INIT_LOAD_FACTOR).toBeGreaterThan(0);
  });
});
