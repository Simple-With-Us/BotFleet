import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoreProvider } from "@/state/store";
import { AppDeck, folderTagFor, memberAssignedBots } from "./AppDeck";

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

describe("folderTagFor (BF-2554)", () => {
  it("suppresses a tag that only repeats the app name", () => {
    expect(folderTagFor("BotFleet", "/Users/jay/Code/BotFleet")).toBeNull();
    expect(folderTagFor("botfleet ", "/Users/jay/Code/BotFleet/")).toBeNull();
  });

  it("keeps a folder tag that adds information", () => {
    expect(folderTagFor("Compiler", "/Users/jay/Code/BotFleet")).toBe("BotFleet");
    expect(folderTagFor("Compiler", "C:\\work\\BotFleet")).toBe("BotFleet");
    expect(folderTagFor("Compiler", null)).toBeNull();
    expect(folderTagFor("Compiler", "")).toBeNull();
  });
});

describe("memberAssignedBots", () => {
  const bots = [
    { id: "member", hidden: false, section: "Other" },
    { id: "hidden-member", hidden: true, section: "App" },
    { id: "section-name", hidden: false, section: "App" },
    { id: "section-label", hidden: false, section: "Finance" },
  ];

  it("keeps explicit members and ignores section-name inference", () => {
    expect(memberAssignedBots(["member", "hidden-member"], bots).map((b) => b.id)).toEqual(["member"]);
  });

  it("does not treat a matching section as membership when memberIds is empty", () => {
    expect(memberAssignedBots([], bots)).toEqual([]);
    expect(memberAssignedBots(undefined, bots)).toEqual([]);
  });
});
