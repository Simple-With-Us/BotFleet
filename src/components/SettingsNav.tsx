// The Settings modal's left rail: the search field and the section tabs.
//
// Split out of SettingsModal so the rail is a stateless view that a test can
// render on its own.  The modal owns the query and the section; this owns how
// they look.
import { Activity, Coins, Globe, KeyRound, Layers, Monitor, Search, Smartphone, Terminal, User, X } from "lucide-react";
import type { AppSettingsSection } from "@/state/store";
import type { SettingsSearchResult } from "@/lib/settings-search";
import { cn } from "@/lib/cn";

export interface SettingsSectionEntry {
  id: AppSettingsSection;
  label: string;
  icon: typeof User;
  keywords: string[];
}

export const SETTINGS_SECTIONS: SettingsSectionEntry[] = [
  { id: "general", label: "General", icon: User, keywords: ["profile", "name", "email", "skin", "theme", "appearance", "analytics", "updates", "tools", "tool calls", "simple", "projects", "threads", "workspace"] },
  { id: "connections", label: "Connections", icon: KeyRound, keywords: ["keys", "api", "composio", "box", "xai", "vps", "voice", "tts", "speech"] },
  // "Remote", not "Remote Access": the longer label wrapped to two lines in
  // the 164px rail.  The card inside keeps its full "Remote Access" heading.
  // This stays its own tab, not part of Phone: it is the tunnel that opens
  // BotFleet itself in a browser, while Phone pairs the companion app.
  { id: "remote", label: "Remote", icon: Globe, keywords: ["remote", "remote access", "url", "tunnel", "cloudflare", "access", "health"] },
  { id: "engines", label: "Engines", icon: Terminal, keywords: ["models", "claude", "grok", "providers", "cli"] },
  { id: "models", label: "Models", icon: Layers, keywords: ["model", "fallback", "primary", "engine", "per bot", "fleet"] },
  { id: "companion", label: "Phone", icon: Smartphone, keywords: ["companion", "phone", "pair", "mobile", "gateway", "sidecar"] },
  { id: "computers", label: "Computers", icon: Monitor, keywords: ["vm", "virtual", "desktop", "computer", "vps", "box", "mac", "sandbox"] },
  { id: "usage", label: "Usage", icon: Coins, keywords: ["tokens", "cost", "billing"] },
  { id: "observability", label: "Observability", icon: Activity, keywords: ["sentry", "errors", "crashes", "traces", "logs", "diagnostics"] },
  { id: "secrets", label: "Secrets", icon: KeyRound, keywords: ["infisical", "vault", "credentials", "secret", "provenance"] },
];

/** Width of the rail.  EngineCapabilitiesMatrix derives its width budget from
 *  this number, so change the two together. */
export const SETTINGS_NAV_WIDTH_CLASS = "w-[164px]";

/** The search pill.  A blend of two existing skin tokens rather than a new
 *  colour: `control` is the gray the field used to take at 70% opacity, and
 *  `raised` is the lighter surface next to it (white in the light skins, the
 *  same tone as `control` in the dark ones).  Light skins land a step closer
 *  to the panel, dark skins a step brighter, so the field reads as lighter in
 *  both. */
export const SETTINGS_SEARCH_FIELD_BG_CLASS =
  "bg-[color-mix(in_srgb,var(--color-control)_45%,var(--color-raised))]";

/** Space under the search field, before the first tab. */
export const SETTINGS_SEARCH_FIELD_GAP_CLASS = "mb-3";

/** Tab labels are bold; the active tab is told apart by its fill and full-ink
 *  text, an inactive one by the secondary text color and a hover fill. */
export const SETTINGS_TAB_BASE_CLASS = "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[14px] font-semibold";
/** While searching, each row also carries a match count, so it gives back a
 *  little padding and gap to keep bold labels like "Connections" whole. */
export const SETTINGS_SEARCH_TAB_CLASS = "gap-1.5 px-2 text-[13px]";
export const SETTINGS_TAB_ACTIVE_CLASS = "bg-control text-ink";
export const SETTINGS_TAB_IDLE_CLASS = "text-ink-secondary hover:bg-control/50 hover:text-ink";

export interface SettingsNavProps {
  section: AppSettingsSection;
  query: string;
  onQueryChange: (query: string) => void;
  /** Clear button, or Escape with text in the field. */
  onClearQuery: () => void;
  /** Escape with an empty field. */
  onEscapeEmpty: () => void;
  searchResult: SettingsSearchResult;
  selectedSectionFilter: AppSettingsSection | null;
  onSelectSectionFilter: (section: AppSettingsSection | null) => void;
  onSelectSection: (section: AppSettingsSection) => void;
}

export function SettingsNav({
  section,
  query,
  onQueryChange,
  onClearQuery,
  onEscapeEmpty,
  searchResult,
  selectedSectionFilter,
  onSelectSectionFilter,
  onSelectSection,
}: SettingsNavProps) {
  const trimmedQuery = query.trim();
  const visibleSections = SETTINGS_SECTIONS.filter((entry) => searchResult.matchingSectionIds.has(entry.id));

  return (
    <nav className={cn("flex shrink-0 flex-col gap-0.5 border-r border-hairline/40 p-3", SETTINGS_NAV_WIDTH_CLASS)}>
      <div id="app-settings-title" className="px-2 pb-2 pt-1 text-[15px] font-semibold text-ink">
        Settings
      </div>
      <div
        data-testid="settings-search-field"
        className={cn(
          "flex items-center gap-2 rounded-lg px-2.5 py-1.5",
          SETTINGS_SEARCH_FIELD_GAP_CLASS,
          SETTINGS_SEARCH_FIELD_BG_CLASS,
        )}
      >
        <Search size={14} className="shrink-0 text-ink-secondary" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            if (query) onClearQuery();
            else onEscapeEmpty();
          }}
          placeholder="Search"
          aria-label="Search Settings"
          className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-secondary focus:outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={onClearQuery}
            aria-label="Clear search"
            className="shrink-0 rounded p-0.5 text-ink-secondary hover:text-ink"
          >
            <X size={13} />
          </button>
        ) : null}
      </div>

      {trimmedQuery ? (
        searchResult.totalMatches === 0 ? (
          <div className="px-2.5 py-4 text-[12px] leading-relaxed text-ink-secondary">
            No matches for &ldquo;{trimmedQuery}&rdquo;
          </div>
        ) : (
          <>
            <button
              onClick={() => onSelectSectionFilter(null)}
              aria-current={selectedSectionFilter === null ? "page" : undefined}
              className={cn(
                SETTINGS_TAB_BASE_CLASS,
                SETTINGS_SEARCH_TAB_CLASS,
                selectedSectionFilter === null ? SETTINGS_TAB_ACTIVE_CLASS : SETTINGS_TAB_IDLE_CLASS,
              )}
            >
              <Search size={14} className="shrink-0 text-accent" />
              <span className="truncate">All Results</span>
              <span className="ml-auto shrink-0 rounded-full bg-accent/15 px-1 py-0.5 text-[11px] font-medium text-accent">
                {searchResult.totalMatches}
              </span>
            </button>
            {visibleSections.map(({ id, label, icon: Icon }) => {
              const matchCount = searchResult.matchCountBySection[id] ?? 0;
              const isSelected = selectedSectionFilter === id;
              return (
                <button
                  key={id}
                  onClick={() => onSelectSectionFilter(isSelected ? null : id)}
                  aria-current={isSelected ? "page" : undefined}
                  className={cn(
                    SETTINGS_TAB_BASE_CLASS,
                    SETTINGS_SEARCH_TAB_CLASS,
                    isSelected ? SETTINGS_TAB_ACTIVE_CLASS : SETTINGS_TAB_IDLE_CLASS,
                  )}
                >
                  <Icon size={14} className="shrink-0" />
                  <span className="truncate">{label}</span>
                  {matchCount > 0 ? (
                    <span className="ml-auto shrink-0 rounded-full bg-hairline/60 px-1 py-0.5 text-[11px] font-medium text-ink-secondary">
                      {matchCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </>
        )
      ) : (
        SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onSelectSection(id)}
            aria-current={section === id ? "page" : undefined}
            className={cn(SETTINGS_TAB_BASE_CLASS, section === id ? SETTINGS_TAB_ACTIVE_CLASS : SETTINGS_TAB_IDLE_CLASS)}
          >
            <Icon size={15} className="shrink-0" />
            <span className="truncate">{label}</span>
          </button>
        ))
      )}
    </nav>
  );
}
