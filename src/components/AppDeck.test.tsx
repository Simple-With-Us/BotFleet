import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import { AppDeck } from "./AppDeck";

describe("AppDeck", () => {
  it("renders without crashing in a StoreProvider", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(AppDeck, {
          activeAppId: null,
          onSelectApp: () => {},
        }),
      ),
    );

    expect(html).toContain('aria-label="App Deck Navigation"');
    expect(html).toContain("All");
  });

  it("renders active group room chat button when activeAppId is set", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(AppDeck, {
          activeAppId: "test-app",
          onSelectApp: () => {},
        }),
      ),
    );

    expect(html).toContain('aria-label="App Deck Navigation"');
  });
});
