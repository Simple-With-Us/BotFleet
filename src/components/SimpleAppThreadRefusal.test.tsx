import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { simpleAppThreadRefusal } from "@/lib/simple-app-thread-switch";
import { SimpleAppThreadRefusal } from "./SimpleAppThreadRefusal";

describe("SimpleAppThreadRefusal", () => {
  it("shows the refusal in plain words with a way to dismiss it", () => {
    const message = simpleAppThreadRefusal("Build the deck", "belongs to another App");
    const html = renderToStaticMarkup(
      createElement(SimpleAppThreadRefusal, { message, onDismiss: () => {} }),
    );
    expect(html).toContain('data-testid="simple-app-thread-refusal"');
    expect(html).toContain('role="status"');
    expect(html).toContain("This Stays Separate");
    expect(html).toContain("Build the deck");
    expect(html).toContain("cannot be opened from here, because it belongs to a different App than the open conversation.");
    expect(html).toContain("Nothing was switched, and the open conversation stayed as it is.");
    expect(html).toContain("Switch to Projects in Settings to open it.");
    expect(html).toContain('aria-label="Dismiss Notice"');
    expect(html).not.toContain("switchTask");
    expect(html).not.toContain("&nbsp;");
  });
});
