import { describe, expect, it } from "vitest";
import {
  BUBBLE_CHROME,
  BUBBLE_EDITOR_WIDTH,
  BUBBLE_GUTTER,
  BUBBLE_GUTTER_REM,
  BUBBLE_GUTTER_REM_WIDE,
  BUBBLE_MAX_WIDTH,
  BUBBLE_MAX_WIDTH_REM,
  BUBBLE_WIDTH,
  bubbleBox,
  bubbleRow,
  flowWidth,
} from "./bubble-metrics";

/** Every width the hover chrome has measured in a real transcript, plus room
 * either side.  Mounting the edit pencil is worth ~32px, a cross-day
 * timestamp another ~34px, and a bot's row also carries reply, regenerate
 * and the reaction bar. */
const CHROME_WIDTHS = [0, 90, 117, 149, 175, 208, 240, 360];

describe("a bubble's box ignores the chrome beside it", () => {
  it("keeps the same right edge and the same width whatever is mounted", () => {
    const boxes = CHROME_WIDTHS.map((chromeWidth) =>
      bubbleBox({ rowWidth: 800, chromeWidth, contentWidth: 1070 }),
    );
    const distinct = new Set(boxes.map((box) => `${box.left}/${box.right}/${box.width}`));
    expect([...distinct]).toEqual([`${boxes[0].left}/${boxes[0].right}/${boxes[0].width}`]);
  });

  it("holds at every transcript width, not just a wide one", () => {
    for (const rowWidth of [420, 640, 800, 1100, 1600]) {
      const widths = new Set(
        CHROME_WIDTHS.map(
          (chromeWidth) => bubbleBox({ rowWidth, chromeWidth, contentWidth: 1070 }).width,
        ),
      );
      expect(widths.size, `row ${rowWidth}px`).toBe(1);
    }
  });

  it("holds for a short bubble too — it hugs its text and still ends on the edge", () => {
    for (const chromeWidth of CHROME_WIDTHS) {
      const box = bubbleBox({ rowWidth: 800, chromeWidth, contentWidth: 83 });
      expect(box.width).toBe(83);
      expect(box.right).toBe(800);
    }
  });

  it("fails the moment the chrome is put back into the flow", () => {
    // the regression itself: chrome in the flow makes the box depend on it.
    const inFlow = (chromeWidth: number) =>
      Math.min(1070, BUBBLE_MAX_WIDTH_REM * 16, 800 - Math.max(BUBBLE_GUTTER_REM * 16, chromeWidth) - 6);
    expect(flowWidth("flex items-center gap-1.5", 360)).toBe(360);
    expect(new Set(CHROME_WIDTHS.map(inFlow)).size).toBeGreaterThan(1);
  });
});

describe("the classes that hold the invariant up", () => {
  it("parks the chrome out of the flow", () => {
    expect(BUBBLE_CHROME).toMatch(/(?:^|\s)absolute(?:\s|$)/);
    expect(flowWidth(BUBBLE_CHROME, 360)).toBe(0);
  });

  it("reserves a fixed lane that cannot be squeezed", () => {
    expect(BUBBLE_GUTTER).toContain(`w-[${BUBBLE_GUTTER_REM}rem]`);
    expect(BUBBLE_GUTTER).toContain("shrink-0");
  });

  it("grows the reserve once the container affords a single row again", () => {
    // narrow (stacked, three rows tall) needs less width than wide (one row)
    expect(BUBBLE_GUTTER_REM).toBeLessThan(BUBBLE_GUTTER_REM_WIDE);
    expect(BUBBLE_GUTTER).toContain(`@4xl/chat:w-[${BUBBLE_GUTTER_REM_WIDE}rem]`);
  });

  it("stacks the chrome by default and falls back to one row at @4xl/chat", () => {
    expect(BUBBLE_CHROME).toContain("flex-col");
    expect(BUBBLE_CHROME).toContain("@4xl/chat:flex-row");
  });

  it("caps every bubble with one number", () => {
    expect(BUBBLE_MAX_WIDTH).toBe(`max-w-[${BUBBLE_MAX_WIDTH_REM}rem]`);
    expect(BUBBLE_WIDTH).toContain(BUBBLE_MAX_WIDTH);
    expect(BUBBLE_EDITOR_WIDTH).toContain(BUBBLE_MAX_WIDTH);
  });

  it("lets a bubble shrink instead of overflowing its column", () => {
    // `min-w-0` is what stops one unbreakable token from pushing the box past
    // the cap and out of the column — the failure the nested wrapper used to
    // produce for every long message.
    expect(BUBBLE_WIDTH).toContain("min-w-0");
    expect(BUBBLE_EDITOR_WIDTH).toContain("min-w-0");
  });
});

describe("column layout", () => {
  it("puts the user's gutter before the bubble and a bot's after it", () => {
    expect(bubbleRow("user").gutterSide).toBe("leading");
    expect(bubbleRow("user").row).toContain("justify-end");
    expect(bubbleRow("bot").gutterSide).toBe("trailing");
    expect(bubbleRow("bot").row).toContain("justify-start");
  });

  it("anchors the chrome against the bubble on both sides", () => {
    expect(bubbleRow("user").chrome).toContain("right-0");
    expect(bubbleRow("bot").chrome).toContain("left-0");
  });

  it("hugs the near edge on every stacked row, then re-centers once it falls back to one row", () => {
    expect(bubbleRow("user").chrome).toContain("items-end");
    expect(bubbleRow("bot").chrome).toContain("items-start");
    expect(bubbleRow("user").chrome).toContain("@4xl/chat:items-center");
    expect(bubbleRow("bot").chrome).toContain("@4xl/chat:items-center");
  });

  it("gives both columns the identical box", () => {
    expect(bubbleRow("user").width).toBe(bubbleRow("bot").width);
    expect(bubbleRow("user").gutter).toBe(bubbleRow("bot").gutter);
    expect(bubbleRow("user").editorWidth).toBe(bubbleRow("bot").editorWidth);
  });

  it("hands the editor the same box the bubble had", () => {
    const row = bubbleRow("user");
    const cap = (value: string) => value.split(" ").filter((token) => token.startsWith("max-w-"));
    expect(cap(row.editorWidth)).toEqual(cap(row.width));
  });
});
