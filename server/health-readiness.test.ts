import { describe, expect, it } from "vitest";

import { healthReadiness } from "./health-readiness.ts";

describe("health readiness", () => {
  it("reports not-ready and not degraded while booting cleanly", () => {
    expect(healthReadiness({ booting: true, webhookIngressError: null })).toEqual({
      ready: false,
      booting: true,
      degraded: false,
      webhookIngressError: null,
    });
  });

  it("reports ready and not degraded after a clean boot", () => {
    expect(healthReadiness({ booting: false, webhookIngressError: null })).toEqual({
      ready: true,
      booting: false,
      degraded: false,
      webhookIngressError: null,
    });
  });

  // `ready` must stay true here: electron/server-boot-probe polls while
  // `ready` is false, so holding it false for a webhook failure would
  // burn the whole boot budget and report a timeout.  The failure is
  // exposed as the top-level `degraded` flag instead.
  it("keeps the boot-probe contract but flags degradation when webhook ingress failed", () => {
    expect(
      healthReadiness({ booting: false, webhookIngressError: "port 8800 in use" }),
    ).toEqual({
      ready: true,
      booting: false,
      degraded: true,
      webhookIngressError: "port 8800 in use",
    });
  });

  it("flags degradation even while still booting", () => {
    expect(healthReadiness({ booting: true, webhookIngressError: "nope" })).toEqual({
      ready: false,
      booting: true,
      degraded: true,
      webhookIngressError: "nope",
    });
  });
});
