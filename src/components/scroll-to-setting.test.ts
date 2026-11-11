// Settings deep-link scroll: retries until the card mounts instead of
// racing a fixed timeout, then scrolls once and gives up after ~2s.
import { describe, expect, it, vi } from "vitest";
import { scrollToSettingDomId } from "./scroll-to-setting";

function element() {
  return {
    scrollIntoView: vi.fn(),
    classList: { add: vi.fn(), remove: vi.fn() },
  };
}

type StubElement = ReturnType<typeof element>;

function docReturning(values: Array<StubElement | null>) {
  const getElementById = vi.fn();
  for (const value of values) getElementById.mockReturnValueOnce(value);
  getElementById.mockReturnValue(null);
  return { getElementById };
}

describe("scrollToSettingDomId", () => {
  it("scrolls and highlights immediately when the card is already mounted", () => {
    const el = element();
    const doc = docReturning([el]);
    const scheduled: Array<{ ms: number }> = [];
    scrollToSettingDomId("setting-resources-host", doc, (fn, ms) => {
      scheduled.push({ ms });
      void fn;
    });
    expect(doc.getElementById).toHaveBeenCalledTimes(1);
    expect(doc.getElementById).toHaveBeenCalledWith("setting-resources-host");
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(el.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(el.classList.add).toHaveBeenCalledTimes(1);
    // Only the highlight-removal timer is scheduled: no scroll retry.
    expect(scheduled).toEqual([{ ms: 2600 }]);
  });

  it("retries until a slow card mounts instead of failing on the first miss", () => {
    const el = element();
    const doc = docReturning([null, null, el]);
    const pending: Array<() => void> = [];
    let nowValue = 1000;
    scrollToSettingDomId(
      "setting-resources-thresholds",
      doc,
      (fn) => {
        pending.push(fn);
      },
      () => nowValue,
    );
    expect(doc.getElementById).toHaveBeenCalledTimes(1);
    nowValue = 1100;
    pending.shift()!();
    expect(doc.getElementById).toHaveBeenCalledTimes(2);
    expect(el.scrollIntoView).not.toHaveBeenCalled();
    nowValue = 1200;
    pending.shift()!();
    expect(el.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(el.classList.add).toHaveBeenCalledTimes(1);
  });

  it("gives up after the deadline instead of polling forever", () => {
    const doc = docReturning([]);
    const pending: Array<() => void> = [];
    let nowValue = 0;
    scrollToSettingDomId(
      "setting-resources-headroom",
      doc,
      (fn) => {
        pending.push(fn);
      },
      () => nowValue,
    );
    expect(pending.length).toBe(1);
    // Past the ~2s deadline: the retry runs once more and schedules nothing.
    nowValue = 5000;
    pending.shift()!();
    expect(doc.getElementById).toHaveBeenCalledTimes(2);
    expect(pending.length).toBe(0);
  });
});
