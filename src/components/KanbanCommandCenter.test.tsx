import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import { KanbanCommandCenter, safeAvatarUrl } from "./KanbanCommandCenter";

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

  it("sanitizes avatar URLs rejecting non-https and embedded credentials", () => {
    expect(safeAvatarUrl("http://evil.com/pic.png")).toBeNull();
    expect(safeAvatarUrl("https://user:pass@evil.com/pic.png")).toBeNull();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    expect(safeAvatarUrl("https://images.example.com/avatar.png")).toBe("https://images.example.com/avatar.png");
  });
});
