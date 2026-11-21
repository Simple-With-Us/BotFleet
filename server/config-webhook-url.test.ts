import { describe, expect, it } from "vitest";

import {
  parseConfigPatch,
  webhookPublicIngressUrl,
  webhookPublicIngressUrlEffective,
} from "./config.ts";

describe("the dedicated webhook public URL", () => {
  it("keeps the dedicated webhook URL https-only, because the secret rides in the path", () => {
    // A plain-http override would send the capability secret in the clear,
    // so it is ignored in favor of the general public URL.
    expect(
      webhookPublicIngressUrl({
        ingress: {
          publicUrl: "https://botfleet.jays.services",
          webhookPublicUrl: "http://agents.jays.services",
        },
      }),
    ).toBe("https://botfleet.jays.services");
    expect(webhookPublicIngressUrl({ ingress: { webhookPublicUrl: "http://agents.jays.services" } })).toBeNull();
  });

  it("trims whitespace and strips trailing slashes so credential paths never get a double slash", () => {
    expect(
      webhookPublicIngressUrl({
        ingress: { webhookPublicUrl: "  https://hooks.example.com/  " },
      }),
    ).toBe("https://hooks.example.com");
  });

  it("webhookPublicIngressUrlEffective falls back to publicUrl when the dedicated URL is switched off", () => {
    expect(
      webhookPublicIngressUrlEffective({
        ingress: {
          publicUrl: "https://botfleet.jays.services",
          webhookPublicUrl: "https://agents.jays.services",
          webhookEnabled: false,
        },
      }),
    ).toBe("https://botfleet.jays.services");
    expect(
      webhookPublicIngressUrlEffective({
        ingress: { webhookPublicUrl: "https://agents.jays.services", webhookEnabled: false },
      }),
    ).toBeNull();
    // an absent flag defaults to on, matching `enabled`
    expect(
      webhookPublicIngressUrlEffective({
        ingress: { webhookPublicUrl: "https://agents.jays.services" },
      }),
    ).toBe("https://agents.jays.services");
    // the dedicated toggle does not rescue a config whose whole ingress is off
    expect(
      webhookPublicIngressUrlEffective({
        ingress: {
          publicUrl: "https://botfleet.jays.services",
          webhookPublicUrl: "https://agents.jays.services",
          enabled: false,
          webhookEnabled: true,
        },
      }),
    ).toBeNull();
  });

  it("parseConfigPatch accepts an https webhook URL and refuses a plain-http one", () => {
    expect(parseConfigPatch({ ingress: { webhookPublicUrl: "https://hooks.example.com" } })).toEqual({
      ingress: { webhookPublicUrl: "https://hooks.example.com" },
    });
    // the empty string is the documented clear-the-field path
    expect(parseConfigPatch({ ingress: { webhookPublicUrl: "" } })).toEqual({
      ingress: { webhookPublicUrl: "" },
    });
    expect(() => parseConfigPatch({ ingress: { webhookPublicUrl: "http://hooks.example.com" } })).toThrow(
      /absolute https/,
    );
    expect(() => parseConfigPatch({ ingress: { webhookPublicUrl: "not-a-url" } })).toThrow();
  });
});
