import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GithubMark } from "./GithubMark";

describe("GithubMark", () => {
  it("draws the GitHub mark at the requested size", () => {
    const html = renderToStaticMarkup(createElement(GithubMark, { size: 25, className: "text-ink-secondary" }));
    expect(html).toContain('width="25"');
    expect(html).toContain('height="25"');
    expect(html).toContain('class="text-ink-secondary"');
    expect(html).toContain("M15 22v-4");
    expect(html).toContain('aria-hidden="true"');
  });
});
