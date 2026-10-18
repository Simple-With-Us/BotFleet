import { describe, expect, it } from "vitest";

import { plainPreview } from "./plain-preview";

describe("plainPreview", () => {
  it("never shows a person the six characters the copy rule forbids", () => {
    // the row that started this: a real message from the fleet's roster
    expect(plainPreview("**Inventory done.&nbsp; Merge not started.**&nbsp; Count is unchanged: **29 still open**.")).toBe(
      "Inventory done. Merge not started. Count is unchanged: 29 still open.",
    );
    expect(plainPreview("a&nbsp;b")).not.toContain("&nbsp;");
  });

  it("decodes the other entities a model writes, named and numeric", () => {
    expect(plainPreview("Tom &amp; Jerry &lt;here&gt; &quot;quoted&quot;")).toBe('Tom & Jerry <here> "quoted"');
    expect(plainPreview("&#39;single&#39; and &#x2014;")).toBe("'single' and —");
  });

  it("leaves an unknown entity alone rather than eating it", () => {
    expect(plainPreview("&notarealentity; stays")).toBe("&notarealentity; stays");
  });

  it("leaves out-of-range and surrogate numeric entities intact instead of throwing RangeError", () => {
    expect(plainPreview("bad &#1114112; &#x110000; &#999999999999; &#0; &#xd800; ok")).toBe(
      "bad &#1114112; &#x110000; &#999999999999; &#0; &#xd800; ok",
    );
  });

  it("keeps the words a heading, quote or list decorated", () => {
    expect(plainPreview("## Status\n> blocked\n- one\n- two")).toBe("Status blocked one two");
    expect(plainPreview("1. first\n2) second")).toBe("first second");
  });

  it("unwraps emphasis, including nested and mixed markers", () => {
    expect(plainPreview("**bold** and *italic* and ***both***")).toBe("bold and italic and both");
    expect(plainPreview("__under__ and _one_ and ~~struck~~")).toBe("under and one and struck");
    expect(plainPreview("**outer *inner* tail**")).toBe("outer inner tail");
  });

  it("reads a link as its text and an image as its alt", () => {
    expect(plainPreview("see [the report](https://example.com/x) now")).toBe("see the report now");
    expect(plainPreview("![a chart](chart.png)")).toBe("a chart");
    expect(plainPreview("<https://example.com/x>")).toBe("https://example.com/x");
  });

  it("keeps code content and drops its backticks and fences", () => {
    expect(plainPreview("run `pnpm test` first")).toBe("run pnpm test first");
    expect(plainPreview("```ts\nconst a = 1;\n```")).toBe("const a = 1;");
  });

  it("reads a table's cells, not its pipes and rules", () => {
    expect(plainPreview("| Count | Open |\n| --- | --- |\n| 13 | 0 |")).toBe("Count Open 13 0");
  });

  it("drops a horizontal rule without eating the text around it", () => {
    expect(plainPreview("before\n\n---\n\nafter")).toBe("before after");
  });

  it("collapses to one line, because a roster row is one line", () => {
    expect(plainPreview("first line\n\nsecond line")).toBe("first line second line");
  });

  it("keeps a stray marker rather than eating a word around it", () => {
    // an unmatched asterisk is far more likely a glob than emphasis
    expect(plainPreview("match **/*.ts files")).toContain("ts");
    expect(plainPreview("2 * 3 = 6")).toBe("2 * 3 = 6");
  });

  it("answers empty for nothing at all", () => {
    expect(plainPreview("")).toBe("");
    expect(plainPreview(undefined)).toBe("");
    expect(plainPreview(null)).toBe("");
  });
});
