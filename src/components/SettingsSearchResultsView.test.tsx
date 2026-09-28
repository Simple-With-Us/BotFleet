import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsSearchResultsView } from "./SettingsSearchResultsView";
import { searchSettings } from "@/lib/settings-search";
import { Activity, Coins, Globe, KeyRound, Layers, Monitor, Smartphone, Terminal, User } from "lucide-react";
import type { AppSettingsSection } from "@/state/store";

const SECTION_ICONS: Record<AppSettingsSection, typeof User> = {
  general: User,
  connections: KeyRound,
  remote: Globe,
  engines: Terminal,
  models: Layers,
  companion: Smartphone,
  computers: Monitor,
  usage: Coins,
  observability: Activity,
  secrets: KeyRound,
};

describe("SettingsSearchResultsView Component", () => {
  it("renders matching result cards with section breadcrumbs and jump links", () => {
    const searchResult = searchSettings("vps");
    const html = renderToStaticMarkup(
      createElement(SettingsSearchResultsView, {
        query: "vps",
        searchResult,
        selectedSectionFilter: null,
        onSelectSectionFilter: () => {},
        onNavigateToSetting: () => {},
        onClearSearch: () => {},
        onSelectChipQuery: () => {},
        sectionIcons: SECTION_ICONS,
      }),
    );

    expect(html).toContain("Search Results");
    expect(html).toContain("Shared ");
    expect(html).toContain("VPS</mark>");
    expect(html).toContain("Connection");
    expect(html).toContain("Jump to setting");
    expect(html).toContain("Computers");
  });

  it("highlights matched search terms inside title and subtitle", () => {
    const searchResult = searchSettings("sandbox");
    const html = renderToStaticMarkup(
      createElement(SettingsSearchResultsView, {
        query: "sandbox",
        searchResult,
        selectedSectionFilter: null,
        onSelectSectionFilter: () => {},
        onNavigateToSetting: () => {},
        onClearSearch: () => {},
        onSelectChipQuery: () => {},
        sectionIcons: SECTION_ICONS,
      }),
    );

    expect(html).toContain("<mark");
    expect(html).toContain("sandbox</mark>");
  });

  it("renders empty state with suggestion chips when query has 0 matches", () => {
    const searchResult = searchSettings("nonexistentquery9999");
    const html = renderToStaticMarkup(
      createElement(SettingsSearchResultsView, {
        query: "nonexistentquery9999",
        searchResult,
        selectedSectionFilter: null,
        onSelectSectionFilter: () => {},
        onNavigateToSetting: () => {},
        onClearSearch: () => {},
        onSelectChipQuery: () => {},
        sectionIcons: SECTION_ICONS,
      }),
    );

    expect(html).toContain("No settings found matching");
    expect(html).toContain("nonexistentquery9999");
    expect(html).toContain("Shared VPS");
    expect(html).toContain("Voice &amp; Audio");
    expect(html).toContain("Infisical Secrets");
    expect(html).toContain("Clear Search");
  });

  it("filters results to single section when selectedSectionFilter is set", () => {
    const searchResult = searchSettings("model");
    const html = renderToStaticMarkup(
      createElement(SettingsSearchResultsView, {
        query: "model",
        searchResult,
        selectedSectionFilter: "models",
        onSelectSectionFilter: () => {},
        onNavigateToSetting: () => {},
        onClearSearch: () => {},
        onSelectChipQuery: () => {},
        sectionIcons: SECTION_ICONS,
      }),
    );

    expect(html).toContain("Filtered to");
    expect(html).toContain("Fleet ");
    expect(html).toContain("Model</mark>");
    expect(html).toContain("Show all sections");
  });
});
