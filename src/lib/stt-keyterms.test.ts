import { describe, expect, it, vi } from "vitest";
import { formatKeyterms, keytermsDirty, parseKeyterms, persistKeyterms, sessionKeyterms } from "./stt-keyterms";

describe("saved STT vocabulary", () => {
  it("enables Save for edits and returns clean after the saved baseline advances", () => {
    const saved = parseKeyterms("  BotFleet, botfleet ");
    const current = parseKeyterms("Mavis");
    expect(keytermsDirty(current, saved)).toBe(true);
    expect(keytermsDirty(current, current)).toBe(false);
    expect(keytermsDirty(parseKeyterms("BotFleet"), saved)).toBe(false);
  });

  it("enables saving [] when a saved vocabulary is cleared", () => {
    expect(keytermsDirty([], parseKeyterms("BotFleet"))).toBe(true);
    expect(keytermsDirty([], [])).toBe(false);
  });

  it("saves edits and clears, but leaves the baseline dirty on a failed PUT", async () => {
    let saved = parseKeyterms("BotFleet");
    const current = parseKeyterms("Mavis");
    const request = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(persistKeyterms(current, request)).rejects.toThrow("503");
    expect(keytermsDirty(current, saved)).toBe(true);
    request.mockResolvedValue({ ok: true, status: 200 });
    saved = await persistKeyterms(current, request);
    expect(keytermsDirty(current, saved)).toBe(false);
    saved = await persistKeyterms([], request);
    expect(saved).toEqual([]);
    expect(JSON.parse(request.mock.lastCall![1].body)).toEqual({ callStt: { keyterms: [] } });
    expect(formatKeyterms(saved)).toBe("");
  });

  it("reserves the streaming cap for bot and group names", () => {
    const global = Array.from({ length: 100 }, (_, i) => `term-${i}`);
    const terms = sessionKeyterms(["Mavis", "ALPHA", "Mavis"], global);
    expect(terms).toHaveLength(100);
    expect(terms.slice(0, 2)).toEqual(["Mavis", "ALPHA"]);
    expect(terms).not.toContain("term-99");
  });
});
