import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import { KanbanCommandCenter } from "./KanbanCommandCenter";

describe("KanbanCommandCenter", () => {
  it("renders 4-column kanban command center without crashing", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(KanbanCommandCenter, {
          onSelectApp: () => {},
          onSelectBot: () => {},
          onOpenAppRoom: () => {},
        }),
      ),
    );

    expect(html).toContain("Attention Queue");
    expect(html).toContain("In Progress");
    expect(html).toContain("Ready &amp; Standby");
    expect(html).toContain("Completed");
    expect(html).toContain("Filter tasks, bots, or apps...");
  });
});
