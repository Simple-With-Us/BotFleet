import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BypassPermissionsWarning } from "./BypassPermissionsWarning";

describe("BypassPermissionsWarning", () => {
  const baseProps = {
    open: true,
    onCancel() {},
    onConfirm() {},
    botName: "Fixer",
  };

  it("renders standard confirmation when model is not high risk", () => {
    const html = renderToStaticMarkup(
      createElement(BypassPermissionsWarning, {
        ...baseProps,
        model: "claude-3-7-sonnet-20250219",
      }),
    );
    expect(html).toContain("Enable Permission Bypass for Fixer?");
    expect(html).toContain("Enable Permission Bypass");
    expect(html).not.toContain("High-Risk Model: Permission Bypass Warning");
    expect(html).not.toContain("I Understand the Risks");
  });

  it("renders high-risk warning callout when model is lightweight or compact", () => {
    const html = renderToStaticMarkup(
      createElement(BypassPermissionsWarning, {
        ...baseProps,
        model: "claude-3-5-haiku-20241022",
      }),
    );
    expect(html).toContain("High-Risk Model: Permission Bypass Warning");
    expect(html).toContain("claude-3-5-haiku-20241022 is a lightweight or compact model");
    expect(html).toContain("I Understand the Risks, Enable Bypass");
    expect(html).toContain("bg-danger");
  });

  it("disables buttons and shows applying indicator when busy", () => {
    const html = renderToStaticMarkup(
      createElement(BypassPermissionsWarning, {
        ...baseProps,
        model: "gpt-4o-mini",
        busy: true,
      }),
    );
    expect(html).toContain("Applying…");
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });

  it("returns null when open is false", () => {
    const html = renderToStaticMarkup(
      createElement(BypassPermissionsWarning, {
        ...baseProps,
        model: "gpt-4o-mini",
        open: false,
      }),
    );
    expect(html).toBe("");
  });
});
