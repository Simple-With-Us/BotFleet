// Choosing a skin is a visual decision, so the options are shown visually: each
// card carries a working miniature of the app rendered in that skin, not a row
// of paint chips. That works because the skin blocks in styles.css are keyed on
// `[data-skin]` rather than `:root[data-skin]` — any element can open a skin
// context for its own subtree, so the miniature styles itself and can never
// drift from what picking it actually does.
import { useState } from "react";
import { Check } from "lucide-react";
import {
  SKINS,
  applySkin,
  readSkin,
  ACCENT_PRESETS,
  applyCustomAccent,
  readCustomAccent,
  readCustomTheme,
  saveCustomTheme,
  readUserAutoPair,
  saveUserAutoPair,
  USER_AUTO_LIGHT_IDS,
  USER_AUTO_DARK_IDS,
  followsComputerLook,
  osPrefersDark,
  resolveSkin,
  type SkinId,
  type ConcreteSkinId,
  type CustomThemeConfig,
  type UserAutoPair,
} from "@/lib/skins";
import { cn } from "@/lib/cn";

/**
 * The app's own layout at roughly 1/14 scale: rail, sidebar with a selected
 * row, thread, composer. The selected row and the send button are drawn in the
 * accent on purpose — a skin is mostly judged by where its colour lands, and a
 * single dot was too small to judge.
 */
function Miniature({ skin, pair }: { skin: SkinId; pair?: UserAutoPair }) {
  const painted = followsComputerLook(skin) ? resolveSkin(skin, pair ? { pair } : undefined) : skin;
  return (
    <div
      data-skin={painted}
      aria-hidden="true"
      className="flex h-[78px] w-full overflow-hidden rounded-lg bg-app ring-1 ring-hairline/60"
    >
      {/* rail */}
      <div className="flex w-[11px] shrink-0 flex-col items-center gap-[3px] bg-panel pt-[5px]">
        <span className="size-[5px] rounded-full bg-accent" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
        <span className="size-[5px] rounded-full bg-ink-secondary/40" />
      </div>
      {/* sidebar — the top row is the selected conversation */}
      <div className="flex w-[30px] shrink-0 flex-col gap-[3px] border-r border-hairline bg-panel p-[4px]">
        <span className="flex h-[9px] w-full items-center gap-[2px] rounded-sm bg-raised px-[2px]">
          <span className="size-[4px] shrink-0 rounded-full bg-accent" />
          <span className="h-[2px] flex-1 rounded-full bg-ink/50" />
        </span>
        <span className="h-[3px] w-[80%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[62%] rounded-full bg-ink-secondary/30" />
        <span className="h-[3px] w-[74%] rounded-full bg-ink-secondary/30" />
      </div>
      {/* thread */}
      <div className="flex min-w-0 flex-1 flex-col gap-[4px] p-[6px]">
        <span className="h-[13px] w-[62%] self-end rounded-md bg-bubble-user" />
        <div className="flex w-[88%] flex-col gap-[3px] rounded-md bg-card p-[4px]">
          <span className="h-[2px] w-full rounded-full bg-ink/45" />
          <span className="h-[2px] w-[85%] rounded-full bg-ink/45" />
          <span className="h-[2px] w-[60%] rounded-full bg-ink-secondary/40" />
        </div>
        <div className="mt-auto flex items-center gap-[4px]">
          <span className="h-[11px] flex-1 rounded-full bg-inset ring-1 ring-hairline" />
          {/* filled accent with its own ink — Foundry's inversion reads right
              here: bright brass carrying a dark mark, where the others carry
              a light one */}
          <span className="flex size-[11px] items-center justify-center rounded-full bg-accent">
            <span
              className="h-[1.5px] w-[5px] rounded-full"
              style={{ background: "var(--color-accent-ink)" }}
            />
          </span>
        </div>
      </div>
    </div>
  );
}

function skinName(id: SkinId): string {
  return SKINS.find((skin) => skin.id === id)?.name ?? id;
}

function adoptCustomIntoUserAuto(pair: UserAutoPair): UserAutoPair {
  const side = osPrefersDark() ? "dark" : "light";
  if (pair[side] === "custom") return pair;
  return { ...pair, [side]: "custom" };
}

export function SkinPicker() {
  const [active, setActive] = useState<SkinId>(() => readSkin());
  const [customAccent, setCustomAccent] = useState<string | null>(() => readCustomAccent());
  const [customTheme, setCustomTheme] = useState<CustomThemeConfig>(() => readCustomTheme());
  const [userAutoPair, setUserAutoPair] = useState<UserAutoPair>(() => readUserAutoPair());

  const handleSelectSkin = (id: SkinId) => {
    setActive(id);
    applySkin(id);
  };

  const handleSelectAccent = (hex: string | null) => {
    setCustomAccent(hex);
    applyCustomAccent(hex);
  };

  const handleUserAutoSide = (side: keyof UserAutoPair, id: ConcreteSkinId) => {
    const next = { ...userAutoPair, [side]: id };
    setUserAutoPair(next);
    saveUserAutoPair(next);
    if (active !== "user-auto") {
      setActive("user-auto");
      applySkin("user-auto");
    }
  };

  const applyCustomOnUserAuto = () => {
    const next = adoptCustomIntoUserAuto(userAutoPair);
    setUserAutoPair(next);
    saveUserAutoPair(next);
    setActive("user-auto");
    applySkin("user-auto");
  };

  const handleUpdateCustomField = (key: keyof CustomThemeConfig, value: string) => {
    const next = { ...customTheme, [key]: value };
    setCustomTheme(next);
    saveCustomTheme(next);
    if (active === "user-auto") {
      applyCustomOnUserAuto();
      return;
    }
    if (active !== "custom") {
      setActive("custom");
      applySkin("custom");
    }
  };

  const handleApplyPreset = (preset: Partial<CustomThemeConfig>) => {
    const next = { ...customTheme, ...preset };
    setCustomTheme(next);
    saveCustomTheme(next);
    if (active === "user-auto") {
      applyCustomOnUserAuto();
      return;
    }
    if (active !== "custom") {
      setActive("custom");
      applySkin("custom");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="mb-2 text-[13px] font-medium text-ink">Theme Presets</div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {SKINS.map((skin) => {
            const selected = skin.id === active;
            return (
              <button
                key={skin.id}
                type="button"
                onClick={() => handleSelectSkin(skin.id)}
                aria-pressed={selected}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
                  selected
                    ? "border-accent-border bg-control ring-1 ring-accent/30"
                    : "border-hairline/60 hover:border-hairline hover:bg-control/50",
                )}
              >
                <Miniature skin={skin.id} pair={userAutoPair} />
                <div className="flex items-start gap-1.5 px-0.5 pb-0.5">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink">{skin.name}</div>
                    <div className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-ink-secondary" title={skin.tagline}>
                      {skin.tagline}
                    </div>
                  </div>
                  {selected && <Check size={13} className="mt-0.5 shrink-0 text-accent-text" />}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {active === "system" && (
        <div className="rounded-xl border border-hairline/60 bg-control/40 p-3.5">
          <div className="text-[13px] font-medium text-ink">System Auto</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">
            When this computer is dark, BotFleet uses Midnight.  When it is light, BotFleet uses Studio.
          </div>
        </div>
      )}

      {active === "user-auto" && (
        <div className="rounded-xl border border-hairline/60 bg-control/40 p-3.5">
          <div className="text-[13px] font-medium text-ink">Light And Dark Themes</div>
          <div className="mt-0.5 text-[11.5px] leading-snug text-ink-secondary">
            When this computer is light, BotFleet uses the light theme you pick.  When it is dark, BotFleet uses the dark theme you pick.
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink">When This Computer Is Light</span>
              <select
                value={userAutoPair.light}
                onChange={(event) => handleUserAutoSide("light", event.target.value as ConcreteSkinId)}
                className="rounded-lg border border-hairline bg-raised px-2.5 py-1.5 text-[13px] text-ink"
              >
                {USER_AUTO_LIGHT_IDS.map((id) => (
                  <option key={id} value={id}>
                    {skinName(id)}
                  </option>
                ))}
              </select>
              <Miniature skin={userAutoPair.light} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12px] font-medium text-ink">When This Computer Is Dark</span>
              <select
                value={userAutoPair.dark}
                onChange={(event) => handleUserAutoSide("dark", event.target.value as ConcreteSkinId)}
                className="rounded-lg border border-hairline bg-raised px-2.5 py-1.5 text-[13px] text-ink"
              >
                {USER_AUTO_DARK_IDS.map((id) => (
                  <option key={id} value={id}>
                    {skinName(id)}
                  </option>
                ))}
              </select>
              <Miniature skin={userAutoPair.dark} />
            </label>
          </div>
        </div>
      )}

      {/* Accent Color Section */}
      <div className="rounded-xl border border-hairline/60 bg-control/40 p-3.5">
        <div className="flex items-center justify-between">
          <div className="text-[13px] font-medium text-ink">Accent Color</div>
          {customAccent && (
            <button
              type="button"
              onClick={() => handleSelectAccent(null)}
              className="text-[12px] text-accent hover:underline"
            >
              Reset to theme default
            </button>
          )}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {ACCENT_PRESETS.map((preset) => {
            const isSelected = customAccent?.toLowerCase() === preset.hex.toLowerCase();
            return (
              <button
                key={preset.hex}
                type="button"
                onClick={() => handleSelectAccent(preset.hex)}
                title={preset.name}
                className={cn(
                  "flex size-7 items-center justify-center rounded-full transition-transform hover:scale-110",
                  isSelected ? "ring-2 ring-ink ring-offset-2 ring-offset-app" : "opacity-85 hover:opacity-100",
                )}
                style={{ backgroundColor: preset.hex }}
              >
                {isSelected && <Check size={13} className="text-white drop-shadow" />}
              </button>
            );
          })}
          <div className="flex items-center gap-1.5 pl-1.5">
            <label className="relative flex size-7 cursor-pointer items-center justify-center rounded-full border border-hairline bg-raised hover:bg-raised-hover" title="Custom accent color picker">
              <span className="text-[12px]">🎨</span>
              <input
                type="color"
                value={customAccent || "#0969da"}
                onChange={(e) => handleSelectAccent(e.target.value)}
                className="sr-only"
              />
            </label>
            <span className="text-[11.5px] text-ink-secondary">Custom</span>
          </div>
        </div>
      </div>

      {/* Custom Theme Palette Builder */}
      <div className="rounded-xl border border-hairline/60 bg-control/40 p-3.5">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[13px] font-medium text-ink">Custom Palette Builder</div>
            <div className="text-[11.5px] text-ink-secondary">Tailor every layer: background, sidebars, cards, and typography.</div>
          </div>
          {active === "custom" && (
            <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent">Active Theme</span>
          )}
        </div>

        {/* Quick Style Starters */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-[11.5px] font-medium text-ink-secondary">Presets:</span>
          <button
            type="button"
            onClick={() => handleApplyPreset({
              appBg: "#f8f9fa",
              panelBg: "#ffffff",
              cardBg: "#ffffff",
              inkColor: "#111827",
              inkSecondaryColor: "#4b5563",
              accentColor: "#2563eb",
              hairlineColor: "#e5e7eb",
            })}
            className="rounded-md border border-hairline bg-raised px-2 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover"
          >
            Clean Paper
          </button>
          <button
            type="button"
            onClick={() => handleApplyPreset({
              appBg: "#f5f3ef",
              panelBg: "#faf8f5",
              cardBg: "#ffffff",
              inkColor: "#292524",
              inkSecondaryColor: "#78716c",
              accentColor: "#ea580c",
              hairlineColor: "#e7e5e4",
            })}
            className="rounded-md border border-hairline bg-raised px-2 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover"
          >
            Warm Linen
          </button>
          <button
            type="button"
            onClick={() => handleApplyPreset({
              appBg: "#f0fdf4",
              panelBg: "#f8fafc",
              cardBg: "#ffffff",
              inkColor: "#064e3b",
              inkSecondaryColor: "#047857",
              accentColor: "#059669",
              hairlineColor: "#dcfce7",
            })}
            className="rounded-md border border-hairline bg-raised px-2 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover"
          >
            Mint Forest
          </button>
          <button
            type="button"
            onClick={() => handleApplyPreset({
              appBg: "#0f172a",
              panelBg: "#1e293b",
              cardBg: "#334155",
              inkColor: "#f8fafc",
              inkSecondaryColor: "#94a3b8",
              accentColor: "#38bdf8",
              hairlineColor: "#475569",
            })}
            className="rounded-md border border-hairline bg-raised px-2 py-1 text-[11.5px] font-medium text-ink hover:bg-raised-hover"
          >
            Midnight Slate
          </button>
        </div>

        {/* Color Inputs */}
        <div className="mt-3.5 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <div className="flex items-center justify-between rounded-lg border border-hairline/60 bg-raised/50 p-2">
            <span className="text-[12px] text-ink">App Ground</span>
            <input
              type="color"
              value={customTheme.appBg}
              onChange={(e) => handleUpdateCustomField("appBg", e.target.value)}
              className="size-6 cursor-pointer rounded border border-hairline"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-hairline/60 bg-raised/50 p-2">
            <span className="text-[12px] text-ink">Sidebar Panel</span>
            <input
              type="color"
              value={customTheme.panelBg}
              onChange={(e) => handleUpdateCustomField("panelBg", e.target.value)}
              className="size-6 cursor-pointer rounded border border-hairline"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-hairline/60 bg-raised/50 p-2">
            <span className="text-[12px] text-ink">Card Surface</span>
            <input
              type="color"
              value={customTheme.cardBg}
              onChange={(e) => handleUpdateCustomField("cardBg", e.target.value)}
              className="size-6 cursor-pointer rounded border border-hairline"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-hairline/60 bg-raised/50 p-2">
            <span className="text-[12px] text-ink">Main Text</span>
            <input
              type="color"
              value={customTheme.inkColor}
              onChange={(e) => handleUpdateCustomField("inkColor", e.target.value)}
              className="size-6 cursor-pointer rounded border border-hairline"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-hairline/60 bg-raised/50 p-2">
            <span className="text-[12px] text-ink">Secondary Text</span>
            <input
              type="color"
              value={customTheme.inkSecondaryColor}
              onChange={(e) => handleUpdateCustomField("inkSecondaryColor", e.target.value)}
              className="size-6 cursor-pointer rounded border border-hairline"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border border-hairline/60 bg-raised/50 p-2">
            <span className="text-[12px] text-ink">Border Line</span>
            <input
              type="color"
              value={customTheme.hairlineColor}
              onChange={(e) => handleUpdateCustomField("hairlineColor", e.target.value)}
              className="size-6 cursor-pointer rounded border border-hairline"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
