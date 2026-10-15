import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUSY_SEND_DEFAULT,
  parseBusyDeliveryOverride,
  parseBusySendDefault,
} from "./busy-send-default.ts";

describe("busy-send-default", () => {
  it("defaults unset values to steer for backward compatibility", () => {
    expect(parseBusySendDefault(undefined)).toBe(DEFAULT_BUSY_SEND_DEFAULT);
    expect(parseBusySendDefault("nope")).toBe(DEFAULT_BUSY_SEND_DEFAULT);
  });

  it("accepts queue and steer", () => {
    expect(parseBusySendDefault("queue")).toBe("queue");
    expect(parseBusySendDefault("steer")).toBe("steer");
  });

  it("parses per-send overrides strictly", () => {
    expect(parseBusyDeliveryOverride("queue")).toBe("queue");
    expect(parseBusyDeliveryOverride("steer")).toBe("steer");
    expect(parseBusyDeliveryOverride(undefined)).toBeUndefined();
    expect(parseBusyDeliveryOverride("")).toBeUndefined();
    expect(parseBusyDeliveryOverride(1)).toBeUndefined();
    expect(parseBusyDeliveryOverride({})).toBeUndefined();
    expect(parseBusyDeliveryOverride(null)).toBeUndefined();
    expect(parseBusyDeliveryOverride(false)).toBeUndefined();
  });
});
