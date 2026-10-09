import { describe, expect, it } from "vitest";

import { DEFAULT_ADMISSION } from "./jobs/admission.ts";
import { MAX_INIT_LOAD_FACTOR } from "./drivers/acp/init-deadline.ts";
import { hostDispatchHotFromMetrics } from "./host-dispatch-hot.ts";

describe("hostDispatchHotFromMetrics", () => {
  it("reuses the webhook dispatch hot gate", () => {
    expect(
      hostDispatchHotFromMetrics({
        swapUsedPercent: 99,
        load: { load1: 0, cores: 4 },
      }),
    ).toBe(true);
    expect(DEFAULT_ADMISSION.maxSwapPercent).toBeLessThanOrEqual(99);
    expect(MAX_INIT_LOAD_FACTOR).toBeGreaterThan(0);
  });
});
