import { describe, expect, it } from "vitest";

import { cutText, formatByteSize } from "./text-format.ts";

describe("cutText", () => {
  it("leaves text within the limit alone", () => {
    expect(cutText("abc", 3)).toBe("abc");
  });

  it("cuts to the limit", () => {
    expect(cutText("abcdef", 4)).toBe("abcd");
  });

  it("never ends on the first half of a surrogate pair", () => {
    expect(cutText("ab😀cd", 3)).toBe("ab");
    expect(cutText("ab😀cd", 4)).toBe("ab😀");
  });

  it("answers an empty string for a limit of zero or less", () => {
    expect(cutText("abc", 0)).toBe("");
    expect(cutText("abc", -2)).toBe("");
  });
});

describe("formatByteSize", () => {
  it("says bytes, kilobytes and megabytes the way the composer chips do", () => {
    expect(formatByteSize(412)).toBe("412 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(10 * 1024)).toBe("10.0 KB");
    expect(formatByteSize(1.4 * 1024 * 1024)).toBe("1.4 MB");
  });
});
