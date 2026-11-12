import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RenameTitle } from "./RenameTitle";

describe("RenameTitle", () => {
  it("does not expose an inert profile button when onActivate is absent", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Maus",
      onCommit: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).not.toContain("Open Maus&#x27;s Profile");
    expect(markup).toContain('aria-label="Rename Maus"');
  });

  it("exposes the profile button when onActivate is provided", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Maus",
      onCommit: vi.fn(),
      onActivate: vi.fn(),
      showEditButton: true,
    }));

    expect(markup).toContain("Open Maus&#x27;s Profile");
  });

  it("omits role=button and tabIndex when embedded in an outer row", () => {
    const markup = renderToStaticMarkup(createElement(RenameTitle, {
      value: "Fixer",
      onCommit: vi.fn(),
      onActivate: vi.fn(),
      embedded: true,
    }));

    expect(markup).not.toContain('role="button"');
    expect(markup).not.toContain("tabindex");
    expect(markup).toContain("cursor-pointer");
    expect(markup).toContain("Fixer");
  });
});
