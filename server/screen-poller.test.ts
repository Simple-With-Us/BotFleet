import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenPollers } from "./screen-poller.ts";

describe("screen capture demand", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("spends no capture calls without a viewer, then starts and stops with viewer demand", async () => {
    const viewers = new Set<string>();
    const capture = vi.fn(async () => ({ png: "frame", format: "png" }));
    const otherCapture = vi.fn(async () => ({ png: "other", format: "png" }));
    const publish = vi.fn();
    const pollers = new ScreenPollers((botId) => viewers.has(botId), publish);
    pollers.start("bot-a", capture);
    pollers.start("bot-b", otherCapture);

    await vi.advanceTimersByTimeAsync(18_000);
    expect(capture).not.toHaveBeenCalled();

    viewers.add("bot-a");
    pollers.viewerChanged();
    await vi.advanceTimersByTimeAsync(6_000);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(otherCapture).not.toHaveBeenCalled();

    viewers.delete("bot-a");
    pollers.viewerChanged();
    await vi.advanceTimersByTimeAsync(18_000);
    expect(capture).toHaveBeenCalledTimes(2);

    viewers.add("bot-a");
    pollers.viewerChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(3);
    expect(otherCapture).not.toHaveBeenCalled();
    pollers.stop("bot-a");
    pollers.stop("bot-b");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(capture).toHaveBeenCalledTimes(3);
  });

  it("retains tool activity and takes a fresh final frame without a viewer", async () => {
    const capture = vi.fn()
      .mockResolvedValueOnce({ png: "live", format: "jpeg" })
      .mockResolvedValueOnce({ png: "final", format: "png" });
    const pollers = new ScreenPollers(() => false, vi.fn());
    pollers.start("bot-a", capture);
    pollers.poke("bot-a");
    expect(capture).not.toHaveBeenCalled();
    expect(await pollers.final("bot-a")).toEqual({ png: "live", mime: "image/jpeg" });
    expect(capture).toHaveBeenCalledTimes(1);

    pollers.start("bot-a", capture);
    expect(await pollers.final("bot-a")).toBeNull();
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("waits for a viewer capture and then refreshes the final frame", async () => {
    let finishFirst: ((value: { png: string; format: string }) => void) | undefined;
    const viewers = new Set(["bot-a"]);
    const capture = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ png: "settled", format: "png" });
    const pollers = new ScreenPollers((botId) => viewers.has(botId), vi.fn());
    pollers.start("bot-a", capture, true);
    const final = pollers.final("bot-a");
    expect(capture).toHaveBeenCalledTimes(1);
    finishFirst?.({ png: "early", format: "png" });
    await expect(final).resolves.toEqual({ png: "settled", mime: "image/png" });
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight viewer capture across concurrent refresh requests", async () => {
    let finish: ((value: { png: string; format: string }) => void) | undefined;
    const capture = vi.fn(() => new Promise<{ png: string; format: string }>((resolve) => { finish = resolve; }));
    const pollers = new ScreenPollers(() => true, vi.fn());
    pollers.start("bot-a", capture);
    pollers.poke("bot-a");
    pollers.poke("bot-a");
    finish?.({ png: "one", format: "png" });
    await vi.advanceTimersByTimeAsync(0);
    expect(capture).toHaveBeenCalledTimes(1);
    pollers.stop("bot-a");
  });
});
