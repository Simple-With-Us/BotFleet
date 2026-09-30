// The Settings rail: bold tab labels that never wrap, a lighter search field
// with room under it, and "Remote" as its own tab next to Phone.
//
// The rail is a stateless view, so these render it as markup and, for the
// click and keyboard paths, walk the element tree it returns.
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { searchSettings } from "@/lib/settings-search";
import type { AppSettingsSection } from "@/state/store";
import {
  SETTINGS_NAV_WIDTH_CLASS,
  SETTINGS_SEARCH_FIELD_BG_CLASS,
  SETTINGS_SEARCH_FIELD_GAP_CLASS,
  SETTINGS_SECTIONS,
  SettingsNav,
  type SettingsNavProps,
} from "./SettingsNav";

const TAB_ORDER: AppSettingsSection[] = [
  "general",
  "connections",
  "remote",
  "engines",
  "models",
  "companion",
  "computers",
  "usage",
  "observability",
  "secrets",
];

function props(overrides: Partial<SettingsNavProps> = {}): SettingsNavProps {
  return {
    section: "general",
    query: "",
    onQueryChange: () => {},
    onClearQuery: () => {},
    onEscapeEmpty: () => {},
    searchResult: searchSettings(""),
    selectedSectionFilter: null,
    onSelectSectionFilter: () => {},
    onSelectSection: () => {},
    ...overrides,
  };
}

function render(overrides: Partial<SettingsNavProps> = {}): string {
  return renderToStaticMarkup(createElement(SettingsNav, props(overrides)));
}

/** Every tab button in the markup: opening tag, inner HTML, and label.  The
 *  search field's clear button is not a tab and has no label span. */
function buttons(html: string): Array<{ open: string; inner: string; label: string }> {
  return [...html.matchAll(/<button([^>]*)>(.*?)<\/button>/gs)]
    .map((match) => ({
      open: match[1]!,
      inner: match[2]!,
      label: (match[2]!.match(/<span class="truncate">([^<]*)<\/span>/)?.[1] ?? "").trim(),
    }))
    .filter((tab) => tab.label !== "");
}

function classOf(openTag: string): string {
  return openTag.match(/class="([^"]*)"/)?.[1] ?? "";
}

/** Depth-first search of the element tree a stateless component returns. */
function findAll(node: ReactNode, test: (element: ReactElement<Record<string, unknown>>) => boolean): Array<ReactElement<Record<string, unknown>>> {
  const found: Array<ReactElement<Record<string, unknown>>> = [];
  const visit = (child: ReactNode) => {
    if (!isValidElement(child)) return;
    const element = child as ReactElement<Record<string, unknown>>;
    if (test(element)) found.push(element);
    Children.forEach(element.props.children as ReactNode, visit);
  };
  visit(node);
  return found;
}

describe("Settings rail tabs", () => {
  it("lists the ten tabs in order, with Remote as its own tab between Connections and Engines", () => {
    expect(SETTINGS_SECTIONS.map((entry) => entry.id)).toEqual(TAB_ORDER);
    expect(buttons(render()).map((tab) => tab.label)).toEqual([
      "General",
      "Connections",
      "Remote",
      "Engines",
      "Models",
      "Phone",
      "Computers",
      "Usage",
      "Observability",
      "Secrets",
    ]);
  });

  it("says Remote, not Remote Access, so the label cannot take two lines", () => {
    const html = render();
    const remote = SETTINGS_SECTIONS.find((entry) => entry.id === "remote");
    expect(remote?.label).toBe("Remote");
    expect(html).not.toContain(">Remote Access<");
    // The words people used to type still find the tab.
    expect(remote?.keywords).toContain("remote access");
  });

  it("keeps Remote Access out of Phone: Phone is still the only companion tab", () => {
    // Remote is the tunnel that opens BotFleet itself in a browser; Phone pairs
    // the companion app.  The two stay separate tabs.
    const companionTabs = SETTINGS_SECTIONS.filter((entry) => entry.id === "companion");
    expect(companionTabs).toHaveLength(1);
    expect(companionTabs[0]!.label).toBe("Phone");
    expect(companionTabs[0]!.keywords).not.toContain("remote access");
  });

  it("gives every tab a single-word label, so it can only ever truncate, never wrap", () => {
    for (const { id, label } of SETTINGS_SECTIONS) {
      expect(label, `${id} tab label`).not.toMatch(/\s/);
    }
    const tabs = buttons(render());
    expect(tabs).toHaveLength(TAB_ORDER.length);
    for (const tab of tabs) {
      expect(tab.inner).toContain(`<span class="truncate">${tab.label}</span>`);
    }
  });

  it("renders every tab label in bold", () => {
    for (const tab of buttons(render())) {
      const cls = classOf(tab.open).split(/\s+/);
      expect(cls, tab.label).toContain("font-semibold");
      expect(cls, tab.label).not.toContain("font-medium");
      expect(cls, tab.label).not.toContain("font-normal");
    }
  });

  it("still tells the active tab from the rest: fill and full-ink text versus secondary text and a hover fill", () => {
    const tabs = buttons(render({ section: "companion" }));
    const active = tabs.filter((tab) => tab.open.includes('aria-current="page"'));
    expect(active.map((tab) => tab.label)).toEqual(["Phone"]);
    const activeClass = classOf(active[0]!.open).split(/\s+/);
    expect(activeClass).toContain("bg-control");
    expect(activeClass).toContain("text-ink");
    expect(activeClass).not.toContain("text-ink-secondary");

    const idle = tabs.find((tab) => tab.label === "Remote")!;
    const idleClass = classOf(idle.open).split(/\s+/);
    expect(idleClass).toContain("text-ink-secondary");
    expect(idleClass).toContain("hover:bg-control/50");
    expect(idleClass).toContain("hover:text-ink");
    expect(idleClass).not.toContain("bg-control");
  });

  it("keeps the rail at 164px, the width the Engines matrix budget is derived from", () => {
    expect(SETTINGS_NAV_WIDTH_CLASS).toBe("w-[164px]");
    expect(render()).toMatch(/<nav class="[^"]*\bw-\[164px\]/);
  });

  it("opens a section by id on click, including the Remote and Phone tabs", () => {
    const onSelectSection = vi.fn();
    const tree = SettingsNav(props({ onSelectSection }));
    const tabButtons = findAll(tree, (element) => element.type === "button");
    expect(tabButtons).toHaveLength(TAB_ORDER.length);
    tabButtons.forEach((button) => (button.props.onClick as () => void)());
    expect(onSelectSection.mock.calls.map(([id]) => id)).toEqual(TAB_ORDER);
  });
});

describe("Settings rail search field", () => {
  const field = (html: string) => html.match(/<div data-testid="settings-search-field" class="([^"]*)"/)?.[1] ?? "";

  it("leaves a step more room under the field than the old 6px", () => {
    expect(SETTINGS_SEARCH_FIELD_GAP_CLASS).toBe("mb-3");
    const cls = field(render()).split(/\s+/);
    expect(cls).toContain("mb-3");
    expect(cls).not.toContain("mb-1.5");
  });

  it("is lighter than the old bg-control/70, built from skin tokens and no literal color", () => {
    const cls = field(render());
    expect(cls).not.toContain("bg-control/70");
    expect(SETTINGS_SEARCH_FIELD_BG_CLASS).toContain("var(--color-control)");
    expect(SETTINGS_SEARCH_FIELD_BG_CLASS).toContain("var(--color-raised)");
    expect(SETTINGS_SEARCH_FIELD_BG_CLASS).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i);
    expect(cls).toContain(SETTINGS_SEARCH_FIELD_BG_CLASS);
  });

  it("keeps the input, its label, and the placeholder", () => {
    const html = render();
    expect(html).toContain('aria-label="Search Settings"');
    expect(html).toContain('placeholder="Search"');
    expect(html).not.toContain('aria-label="Clear search"');
    expect(render({ query: "vps" })).toContain('aria-label="Clear search"');
  });

  it("clears on Escape with text in the field, closes on Escape when it is empty", () => {
    const onClearQuery = vi.fn();
    const onEscapeEmpty = vi.fn();
    const press = (query: string) => {
      const tree = SettingsNav(props({ query, onClearQuery, onEscapeEmpty }));
      const [input] = findAll(tree, (element) => element.type === "input");
      const stopPropagation = vi.fn();
      (input!.props.onKeyDown as (event: { key: string; stopPropagation: () => void }) => void)({ key: "Escape", stopPropagation });
      expect(stopPropagation).toHaveBeenCalledOnce();
    };
    press("vps");
    expect(onClearQuery).toHaveBeenCalledOnce();
    expect(onEscapeEmpty).not.toHaveBeenCalled();
    press("");
    expect(onEscapeEmpty).toHaveBeenCalledOnce();
  });
});

describe("Settings rail while searching", () => {
  it("lists All Results plus only the matching sections, all in bold", () => {
    const html = render({ query: "tunnel", searchResult: searchSettings("tunnel") });
    const tabs = buttons(html);
    expect(tabs[0]!.label).toBe("All Results");
    expect(tabs.map((tab) => tab.label)).toContain("Remote");
    expect(tabs.map((tab) => tab.label)).not.toContain("Secrets");
    for (const tab of tabs) {
      expect(classOf(tab.open).split(/\s+/), tab.label).toContain("font-semibold");
    }
  });

  it("gives rows with a match count a little less padding, so bold labels stay whole", () => {
    const tabs = buttons(render({ query: "e", searchResult: searchSettings("e") }));
    expect(tabs.length).toBeGreaterThan(2);
    for (const tab of tabs) {
      const cls = classOf(tab.open).split(/\s+/);
      expect(cls, tab.label).toContain("px-2");
      expect(cls, tab.label).toContain("gap-1.5");
      expect(cls, tab.label).toContain("text-[13px]");
      expect(cls, tab.label).not.toContain("px-2.5");
    }
  });

  it("finds the Remote Access card under the Remote tab, by either name", () => {
    for (const query of ["remote", "remote access", "tunnel", "test connection"]) {
      const result = searchSettings(query);
      expect(result.matchingItemIds.has("remote:access"), query).toBe(true);
      expect(result.matchingSectionIds.has("remote"), query).toBe(true);
    }
  });

  it("marks the selected section filter as current", () => {
    const html = render({
      query: "tunnel",
      searchResult: searchSettings("tunnel"),
      selectedSectionFilter: "remote",
    });
    const current = buttons(html).filter((tab) => tab.open.includes('aria-current="page"'));
    expect(current.map((tab) => tab.label)).toEqual(["Remote"]);
  });

  it("says so when nothing matches", () => {
    const html = render({ query: "zzzzqqqq", searchResult: searchSettings("zzzzqqqq") });
    expect(html).toContain("No matches for");
    expect(buttons(html)).toHaveLength(0);
  });
});
