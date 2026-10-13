import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import { FleetMatrixView } from "./FleetMatrixView";

describe("FleetMatrixView", () => {
  it("renders matrix mission control table without crashing", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(FleetMatrixView, {
          onSelectApp: () => {},
          onSelectBot: () => {},
          onOpenAppRoom: () => {},
          onSelectBotInApp: (_botId: string, _appId: string) => {},
        }),
      ),
    );

    expect(html).toContain("Fleet Matrix");
    expect(html).toContain("Mission control view");
    expect(html).toContain("Room Chat");
  });
});
