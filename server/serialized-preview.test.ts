import { describe, expect, it } from "vitest";

import { fitListToBudget, serializedPreview } from "./serialized-preview.ts";

const serializedBytes = (value: string) => Buffer.byteLength(JSON.stringify(value), "utf8") - 2;

describe("serializedPreview", () => {
  it("keeps ASCII at the same 160-character cut as before", () => {
    const text = "x".repeat(2_000);
    expect(serializedPreview(text, 160)).toEqual({ preview: "x".repeat(160), truncated: true });
    expect(serializedPreview("short", 160)).toEqual({ preview: "short", truncated: false });
  });

  it("bounds CJK and NUL-heavy text by serialized size", () => {
    for (const text of ["漢".repeat(2_000), "\u0000".repeat(2_000), "\"\\".repeat(2_000)]) {
      const { preview, truncated } = serializedPreview(text, 160);
      expect(truncated).toBe(true);
      expect(serializedBytes(preview)).toBeLessThanOrEqual(160);
      expect(preview.length).toBeGreaterThan(0);
    }
  });

  it("never splits an emoji surrogate pair at the boundary", () => {
    const text = "a" + "😀".repeat(100);
    const { preview } = serializedPreview(text, 160);
    expect(preview).toBe("a" + "😀".repeat(39));
    expect(/[\uD800-\uDBFF]$/.test(preview)).toBe(false);
  });

  it("keeps 100 worst-case previews under the 50 KB list target", () => {
    const worst = serializedPreview("\u0000".repeat(2_000), 160).preview;
    expect(Buffer.byteLength(JSON.stringify(Array(100).fill({ instructionsPreview: worst })), "utf8")).toBeLessThan(50_000);
  });
});

describe("fitListToBudget", () => {
  const row = (index: number, name: string, preview: string) => ({
    id: `routine-${index.toString().padStart(26, "0")}`,
    name,
    instructionsPreview: preview,
    instructionsPreviewTruncated: true,
    enabled: false,
    runOn: "bot",
    durationMinutes: 30,
    schedule: {
      type: "weekly",
      time: "10:00",
      weekdays: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
      timeZone: "America/Argentina/ComodRivadavia",
    },
    nextRunAt: "2026-09-28T15:00:00.000Z",
  });
  const envelope = { now: "2026-09-24T20:00:00.000Z", timeZone: "America/Chicago" };
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  it("leaves a list that already fits untouched", () => {
    const rows = [row(0, "Daily digest", "Summarize"), row(1, "Weekly", "Report")];
    expect(fitListToBudget(envelope, rows, 48_000)).toEqual({ routines: rows });
  });

  it("keeps 100 worst-case NUL names and previews under the 50 KB target", () => {
    const nul = "\u0000";
    const name = serializedPreview(nul.repeat(80), 80).preview;
    const preview = serializedPreview(nul.repeat(2_000), 160).preview;
    const rows = Array.from({ length: 100 }, (_, index) => row(index, name, preview));
    expect(size({ ...envelope, routines: rows })).toBeGreaterThan(50_000);
    const fitted = fitListToBudget(envelope, rows, 48_000);
    expect(size({ ...envelope, ...fitted })).toBeLessThanOrEqual(48_000);
    // Previews go first, from the end; every row survives here.
    expect(fitted.routines).toHaveLength(100);
    expect(fitted.routinesOmitted).toBeUndefined();
    expect(fitted.routines[0].instructionsPreview).toBe(preview);
    expect(fitted.routines[99]).toMatchObject({ instructionsPreview: "", instructionsPreviewTruncated: true });
  });

  it("counts rows the caller already cut, even when everything else fits", () => {
    const rows = [row(0, "Daily digest", "Summarize")];
    expect(fitListToBudget(envelope, rows, 48_000, 7)).toEqual({ routines: rows, routinesOmitted: 7 });
    expect(fitListToBudget(envelope, rows, 48_000, 0)).toEqual({ routines: rows });
    const many = Array.from({ length: 100 }, (_, index) => row(index, "n".repeat(400), ""));
    const fitted = fitListToBudget(envelope, many, 20_000, 5);
    expect(fitted.routinesOmitted).toBe(5 + 100 - fitted.routines.length);
    expect(size({ ...envelope, ...fitted })).toBeLessThanOrEqual(20_000);
  });

  it("drops trailing rows and reports the count when clearing previews is not enough", () => {
    const rows = Array.from({ length: 100 }, (_, index) => row(index, "n".repeat(400), ""));
    const fitted = fitListToBudget(envelope, rows, 20_000);
    expect(size({ ...envelope, ...fitted })).toBeLessThanOrEqual(20_000);
    expect(fitted.routinesOmitted).toBe(100 - fitted.routines.length);
    expect(fitted.routines[0].id).toBe(rows[0].id);
  });
});
