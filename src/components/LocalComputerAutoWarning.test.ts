import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalComputerAutoWarning, shouldWarnBeforeAddingLocalAuto } from "./LocalComputerAutoWarning";

describe("LocalComputerAutoWarning", () => {
  const props = { open: true, onCancel() {}, onConfirm() {} };
  it("names every bot and the exact fleet count", () => {
    const html = renderToStaticMarkup(createElement(LocalComputerAutoWarning, {
      ...props, bots: [{ id: "a", name: "Ada <Review>" }, { id: "b", name: "Lin" }],
    }));
    expect(html).toContain("Allow Auto Mode on This Computer?");
    expect(html).toContain("these 2 bots");
    expect(html).toContain("Ada &lt;Review&gt;");
    expect(html).toContain("Lin");
    expect(html).not.toContain(">a</span>");
    expect(html).not.toContain(">b</span>");
    expect(html).toContain("Allow Auto Mode");
  });
  it("keeps the single-bot warning and blocks duplicate confirmation while applying", () => {
    const html = renderToStaticMarkup(createElement(LocalComputerAutoWarning, { ...props, busy: true }));
    expect(html).toContain("this bot click");
    expect(html).not.toContain("Bots Gaining Auto Access");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
    expect(html).toContain("Applying…");
  });
});

describe("shouldWarnBeforeAddingLocalAuto", () => {
  it("warns only when Auto is adding a new host grant", () => {
    expect(shouldWarnBeforeAddingLocalAuto(["cloud"], true)).toBe(true);
    expect(shouldWarnBeforeAddingLocalAuto(["cloud", "local"], true)).toBe(false);
    expect(shouldWarnBeforeAddingLocalAuto(["cloud"], false)).toBe(false);
  });
});
