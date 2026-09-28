import React, { useMemo } from "react";
import { ArrowRight, Search, Sparkles, X } from "lucide-react";
import type { AppSettingsSection } from "@/state/store";
import {
  segmentMatchText,
  type SettingsSearchItem,
  type SettingsSearchResult,
} from "@/lib/settings-search";
import { cn } from "@/lib/cn";

export interface SettingsSearchResultsViewProps {
  query: string;
  searchResult: SettingsSearchResult;
  selectedSectionFilter: AppSettingsSection | null;
  onSelectSectionFilter: (section: AppSettingsSection | null) => void;
  onNavigateToSetting: (item: SettingsSearchItem) => void;
  onClearSearch: () => void;
  onSelectChipQuery: (term: string) => void;
  sectionIcons: Record<AppSettingsSection, React.ComponentType<{ size?: number; className?: string }>>;
}

const COMMON_SUGGESTIONS = [
  "Models & Fallbacks",
  "Shared VPS",
  "Voice & Audio",
  "Infisical Secrets",
  "API Keys",
  "mcode",
  "Trace Sampling",
  "Turn Timeout",
  "Skin & Appearance",
  "Engine CLIs",
];

function HighlightedText({ text, query }: { text: string; query: string }) {
  const segments = useMemo(() => segmentMatchText(text, query), [text, query]);
  return (
    <span>
      {segments.map((segment, i) =>
        segment.matched ? (
          <mark
            key={i}
            className="rounded bg-accent/20 px-0.5 font-semibold text-accent-text dark:bg-accent/30"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={i}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function SettingsSearchResultsView({
  query,
  searchResult,
  selectedSectionFilter,
  onSelectSectionFilter,
  onNavigateToSetting,
  onClearSearch,
  onSelectChipQuery,
  sectionIcons,
}: SettingsSearchResultsViewProps) {
  const displayedItems = useMemo(() => {
    if (!selectedSectionFilter) return searchResult.matchingItems;
    return searchResult.matchingItems.filter(
      (item) => item.sectionId === selectedSectionFilter,
    );
  }, [searchResult.matchingItems, selectedSectionFilter]);

  const activeSectionsWithMatches = useMemo(() => {
    return Array.from(searchResult.matchingSectionIds);
  }, [searchResult.matchingSectionIds]);

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 pb-6">
      {/* Top Header & Summary */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-hairline/40 bg-card p-4 shadow-sm">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <Search size={16} className="text-accent" />
            <span>Search Results</span>
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[12px] font-medium text-accent">
              {displayedItems.length} {displayedItems.length === 1 ? "match" : "matches"}
            </span>
          </div>
          <div className="mt-1 text-[13px] text-ink-secondary">
            {selectedSectionFilter ? (
              <span>
                Filtered to{" "}
                <strong className="text-ink">
                  {searchResult.itemsBySection[selectedSectionFilter]?.[0]?.sectionLabel ?? selectedSectionFilter}
                </strong>{" "}
                for &ldquo;{query}&rdquo;
              </span>
            ) : (
              <span>
                Showing all settings matching &ldquo;<strong className="text-ink">{query}</strong>&rdquo;
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedSectionFilter && (
            <button
              type="button"
              onClick={() => onSelectSectionFilter(null)}
              className="rounded-lg border border-hairline/50 bg-inset px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-control"
            >
              Show all sections ({searchResult.totalMatches})
            </button>
          )}
          <button
            type="button"
            onClick={onClearSearch}
            className="flex items-center gap-1 rounded-lg border border-hairline/50 bg-raised px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-control shadow-xs"
          >
            <X size={13} />
            Clear
          </button>
        </div>
      </div>

      {/* Filter Tabs by Section if multiple sections match */}
      {activeSectionsWithMatches.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-hairline/30 pb-2">
          <button
            type="button"
            onClick={() => onSelectSectionFilter(null)}
            className={cn(
              "rounded-lg px-2.5 py-1 text-[12.5px] font-medium transition-colors",
              selectedSectionFilter === null
                ? "bg-accent text-white"
                : "bg-control/60 text-ink-secondary hover:bg-control hover:text-ink",
            )}
          >
            All Sections ({searchResult.totalMatches})
          </button>
          {activeSectionsWithMatches.map((secId) => {
            const count = searchResult.matchCountBySection[secId] ?? 0;
            const label = searchResult.itemsBySection[secId]?.[0]?.sectionLabel ?? secId;
            const Icon = sectionIcons[secId];
            return (
              <button
                key={secId}
                type="button"
                onClick={() => onSelectSectionFilter(secId === selectedSectionFilter ? null : secId)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] font-medium transition-colors",
                  selectedSectionFilter === secId
                    ? "bg-accent text-white"
                    : "bg-control/60 text-ink-secondary hover:bg-control hover:text-ink",
                )}
              >
                {Icon && <Icon size={13} />}
                <span>{label}</span>
                <span
                  className={cn(
                    "rounded-full px-1.5 py-0.2 text-[10.5px]",
                    selectedSectionFilter === secId
                      ? "bg-white/20 text-white"
                      : "bg-hairline/50 text-ink-secondary",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* Results List */}
      {displayedItems.length > 0 ? (
        <div className="flex flex-col gap-3">
          {displayedItems.map((item) => {
            const Icon = sectionIcons[item.sectionId];
            // Check if query matched any keyword that isn't in title
            const qLower = query.toLowerCase();
            const matchingKeyword = item.keywords.find(
              (k) => k.toLowerCase().includes(qLower) && !item.title.toLowerCase().includes(k.toLowerCase()),
            );

            return (
              <div
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => onNavigateToSetting(item)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onNavigateToSetting(item);
                  }
                }}
                className="group relative flex flex-col gap-2 rounded-xl border border-hairline/50 bg-card p-4 text-left shadow-xs transition-all hover:border-accent hover:bg-raised-hover hover:shadow-md cursor-pointer focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="flex items-center gap-1.5 rounded-md bg-control/80 px-2 py-0.5 text-[11.5px] font-medium text-ink-secondary group-hover:text-ink">
                      {Icon && <Icon size={12} className="text-accent" />}
                      <span>{item.sectionLabel}</span>
                    </span>
                    {item.badge && (
                      <span className="rounded-md border border-hairline/40 bg-inset px-1.5 py-0.5 text-[11px] font-medium text-ink-secondary">
                        {item.badge}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-1 text-[12px] font-medium text-accent opacity-80 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all">
                    <span>Jump to setting</span>
                    <ArrowRight size={13} />
                  </div>
                </div>

                <div>
                  <div className="text-[14.5px] font-semibold text-ink group-hover:text-accent">
                    <HighlightedText text={item.title} query={query} />
                  </div>
                  <div className="mt-0.5 text-[13px] leading-relaxed text-ink-secondary">
                    <HighlightedText text={item.subtitle} query={query} />
                  </div>
                </div>

                {matchingKeyword && (
                  <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                    <span className="font-medium text-ink-secondary/80">Matched term:</span>
                    <span className="rounded bg-inset px-1.5 py-0.2 font-mono text-[11px] text-ink">
                      {matchingKeyword}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* Empty State */
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-hairline/70 bg-card/50 px-6 py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-control/70 text-ink-secondary mb-3">
            <Search size={22} />
          </div>
          <div className="text-[15px] font-semibold text-ink">
            No settings found matching &ldquo;{query}&rdquo;
          </div>
          <div className="mt-1 max-w-md text-[13px] leading-relaxed text-ink-secondary">
            Check your spelling, or click any topic below to jump directly to related settings:
          </div>

          <div className="mt-5 flex max-w-lg flex-wrap justify-center gap-2">
            {COMMON_SUGGESTIONS.map((term) => (
              <button
                key={term}
                type="button"
                onClick={() => onSelectChipQuery(term)}
                className="flex items-center gap-1.5 rounded-full border border-hairline/60 bg-card px-3 py-1 text-[12px] font-medium text-ink hover:border-accent hover:bg-raised-hover hover:text-accent shadow-2xs transition-all"
              >
                <Sparkles size={11} className="text-accent" />
                <span>{term}</span>
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onClearSearch}
            className="mt-6 rounded-lg border border-hairline/50 bg-inset px-4 py-1.5 text-[12.5px] font-medium text-ink hover:bg-control"
          >
            Clear Search
          </button>
        </div>
      )}
    </div>
  );
}
