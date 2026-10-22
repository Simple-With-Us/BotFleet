import { describe, expect, it } from "vitest";

import { parseBusyDelivery, wantsLiveSteer } from "./busy-send.ts";

describe("parseBusyDelivery", () => {
  it("treats an absent delivery as unset", () => {
    expect(parseBusyDelivery(undefined)).toBeUndefined();
  });

  it("accepts steer and queue", () => {
    expect(parseBusyDelivery("steer")).toBe("steer");
    expect(parseBusyDelivery("queue")).toBe("queue");
  });

  it.each([null, "", "hold", true, 1])("rejects %j", (value) => {
    expect(() => parseBusyDelivery(value)).toThrow("delivery must be steer or queue");
  });
});

describe("wantsLiveSteer", () => {
  it("queues when the sender asked to queue, even if the engine can steer", () => {
    expect(wantsLiveSteer("queue", true)).toBe(false);
    expect(wantsLiveSteer("queue", false)).toBe(false);
  });

  it("follows the engine when the sender asked to steer or said nothing", () => {
    expect(wantsLiveSteer("steer", true)).toBe(true);
    expect(wantsLiveSteer("steer", false)).toBe(false);
    expect(wantsLiveSteer(undefined, true)).toBe(true);
    expect(wantsLiveSteer(undefined, false)).toBe(false);
  });
});
