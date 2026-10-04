import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";

describe("SettingsModal", () => {
  beforeAll(() => {
    if (typeof window === "undefined" || !window.ogb?.updater) {
      (globalThis as unknown as { window: unknown }).window = {
        ogb: {
          updater: {
            setEnabled: () => {},
          },
        },
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
        matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      };
    }
  });

  it("renders Workspace Arrangement and update settings with proper copy and spacing", async () => {
    const { SettingsModal } = await import("./SettingsModal");
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(SettingsModal),
      ),
    );

    // Workspace Arrangement card header and subtitle
    expect(html).toContain("Workspace Arrangement");
    expect(html).toContain("Choose how your bots and channels are structured.\u00a0 Simple is Grok-style with named bots, while channels mode treats each channel as a category for threads.");

    // Projects mode subtitle
    expect(html).toContain("Categories with any number of threads under them.\u00a0 Each thread picks a model.\u00a0 Named bots stay hidden.");

    // Update settings label
    expect(html).toContain("Enable Automatic Update Checks");
  });
});
