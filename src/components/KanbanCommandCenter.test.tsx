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

  it("sanitizes avatar URLs to app-owned attachments only", () => {
    expect(safeAvatarUrl("http://evil.com/pic.png")).toBeNull();
    expect(safeAvatarUrl("https://user:pass@evil.com/pic.png")).toBeNull();
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
    // Unapproved remote host — must not become a tracking pixel.
    expect(safeAvatarUrl("https://images.example.com/avatar.png")).toBeNull();
    // App-owned attachment path is the only allowed origin.
    expect(
      safeAvatarUrl("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp"),
    ).toBe("/api/attachments/123e4567-e89b-12d3-a456-426614174000.webp");
  });

  it("accepts onSelectBotInApp without crashing and renders the columns", () => {
    const html = renderToStaticMarkup(
      createElement(
        StoreProvider,
        null,
        createElement(KanbanCommandCenter, {
          onSelectApp: () => {},
          onSelectBot: () => {},
          onSelectBotInApp: () => {},
          onOpenAppRoom: () => {},
          filterAppId: null,
        }),
      ),
    );

    expect(html).toContain("Attention Queue");
    expect(html).toContain("Filter tasks, bots, or apps...");
  });
});
