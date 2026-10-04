import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it } from "vitest";
import { initialState, StoreContext, StoreProvider, type AppState } from "@/state/store";

describe("SettingsModal", () => {
  beforeAll(() => {
    interface TestWindow {
      ogb?: { updater?: { setEnabled: (val: boolean) => void } };
      addEventListener?: unknown;
      removeEventListener?: unknown;
      dispatchEvent?: unknown;
      matchMedia?: unknown;
      setTimeout?: unknown;
      clearTimeout?: unknown;
    }
    const globalObj = globalThis as typeof globalThis & { window?: TestWindow };
    const existing = globalObj.window ?? {};
    globalObj.window = Object.assign(existing, {
      ogb: {
        updater: {
          setEnabled: () => {},
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    });
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
    expect(html).toContain(
      "Choose how your bots and channels are structured.\u00a0 Simple is Grok-style with named bots, while channels mode treats each channel as a category for threads.",
    );

    // Projects mode subtitle
    expect(html).toContain(
      "Categories with any number of threads under them.\u00a0 Each thread picks a model.\u00a0 Named bots stay hidden.",
    );

    // Update settings label
    expect(html).toContain("Enable Automatic Update Checks");
  });

  it("renders Workspace Arrangement with representative singular and plural room labels", async () => {
    const { ConversationModeRow } = await import("./SettingsModal");

    // Case 1: Room / Rooms
    const roomsState: AppState = {
      ...initialState,
      config: {
        ...initialState.config!,
        roomLabels: { singular: "Room", plural: "Rooms" },
      },
    };
    const roomsHtml = renderToStaticMarkup(
      createElement(
        StoreContext.Provider,
        {
          value: {
            state: roomsState,
            dispatch: () => {},
            flushBotPatches: async () => {},
            refreshInstances: async () => {},
          },
        },
        createElement(ConversationModeRow),
      ),
    );
    expect(roomsHtml).toContain(
      "Choose how your bots and rooms are structured.\u00a0 Simple is Grok-style with named bots, while rooms mode treats each room as a category for threads.",
    );
    expect(roomsHtml).toContain("Rooms");

    // Case 2: App / Apps
    const appsState: AppState = {
      ...initialState,
      config: {
        ...initialState.config!,
        roomLabels: { singular: "App", plural: "Apps" },
      },
    };
    const appsHtml = renderToStaticMarkup(
      createElement(
        StoreContext.Provider,
        {
          value: {
            state: appsState,
            dispatch: () => {},
            flushBotPatches: async () => {},
            refreshInstances: async () => {},
          },
        },
        createElement(ConversationModeRow),
      ),
    );
    expect(appsHtml).toContain(
      "Choose how your bots and apps are structured.\u00a0 Simple is Grok-style with named bots, while apps mode treats each app as a category for threads.",
    );
    expect(appsHtml).toContain("Apps");
  });
});
