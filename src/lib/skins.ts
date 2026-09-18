// Skins are pure CSS. Every one of them is a block of custom properties in
// styles.css, selected by a `data-skin` attribute; this module only decides
// which one is active and remembers the choice. Nothing here knows a colour —
// that keeps the two halves from drifting apart, and it means adding a skin is
// one CSS block plus one line in SKINS.
import { useSyncExternalStore } from "react";

export const SKIN_IDS = [
  "system",
  "user-auto",
  "studio",
  "porcelain",
  "nordic",
  "sandstone",
  "solarized",
  "titanium",
  "midnight",
  "atelier",
  "foundry",
  "lagoon",
  "custom",
] as const;
export type SkinId = (typeof SKIN_IDS)[number];
/** Painted skins.  System Auto and User Auto are modes that resolve to one of these. */
export type ConcreteSkinId = Exclude<SkinId, "system" | "user-auto">;

export type UserAutoPair = {
  light: ConcreteSkinId;
  dark: ConcreteSkinId;
};

/** User Auto starts on the same pair System Auto uses, until the user picks others. */
export const DEFAULT_USER_AUTO_PAIR: UserAutoPair = {
  light: "studio",
  dark: "midnight",
};

export type Skin = {
  id: SkinId;
  name: string;
  /** One line, shown under the name in the picker. */
  tagline: string;
};

export const SKINS: readonly Skin[] = [
  { id: "system", name: "System Auto", tagline: "Follows this computer.  Dark uses Midnight; light uses Studio." },
  { id: "user-auto", name: "User Auto", tagline: "Follows this computer, using your light and dark themes." },
  { id: "studio", name: "Studio Clean", tagline: "Pure white, crisp modern macOS daylight." },
  { id: "porcelain", name: "Porcelain Light", tagline: "Ultra-clean Apple White minimalism with soft neutral shadows." },
  { id: "nordic", name: "Nordic Glacier", tagline: "Sub-arctic ice-white, frost cards, fjord navy ink, azure cyan." },
  { id: "sandstone", name: "Warm Sandstone", tagline: "Sunlit cream stone, warm natural linen surfaces, amber warmth." },
  { id: "solarized", name: "Solarized Daylight", tagline: "Soft cream ivory, deep olive slate typography, refined teal." },
  { id: "titanium", name: "Titanium Frost", tagline: "Brushed titanium and cool slate silver." },
  { id: "midnight", name: "Midnight", tagline: "The original. Cool and dark." },
  { id: "atelier", name: "Atelier", tagline: "Daylight on paper, warm and quiet." },
  { id: "foundry", name: "Foundry", tagline: "Night shift. Dark, warm, lit in brass." },
  { id: "lagoon", name: "Lagoon", tagline: "Cool daylight. Porcelain and deep teal." },
  { id: "custom", name: "Custom Palette", tagline: "Your tailored ground, surface, ink, and accent tones." },
];

export const ACCENT_PRESETS = [
  { name: "Royal Blue", hex: "#0969da" },
  { name: "Electric Blue", hex: "#1084fe" },
  { name: "Sky Cyan", hex: "#0284c7" },
  { name: "Nordic Teal", hex: "#0077cc" },
  { name: "Indigo", hex: "#4f46e5" },
  { name: "Violet", hex: "#7c3aed" },
  { name: "Emerald", hex: "#059669" },
  { name: "Warm Amber", hex: "#d97706" },
  { name: "Sandstone Rust", hex: "#c05621" },
  { name: "Crimson Rose", hex: "#e11d48" },
  { name: "Titanium Slate", hex: "#475569" },
] as const;

export type CustomThemeConfig = {
  appBg: string;
  panelBg: string;
  cardBg: string;
  inkColor: string;
  inkSecondaryColor: string;
  accentColor: string;
  hairlineColor: string;
};

export const DEFAULT_CUSTOM_THEME: CustomThemeConfig = {
  appBg: "#f8fafc",
  panelBg: "#ffffff",
  cardBg: "#ffffff",
  inkColor: "#0f172a",
  inkSecondaryColor: "#64748b",
  accentColor: "#0284c7",
  hairlineColor: "#e2e8f0",
};

function isSkinId(value: unknown): value is SkinId {
  return SKIN_IDS.includes(value as SkinId);
}

export function getDefaultSkin(): SkinId {
  return "system";
}

export function followsComputerLook(id: SkinId): boolean {
  return id === "system" || id === "user-auto";
}

export function isConcreteSkinId(value: unknown): value is ConcreteSkinId {
  return isSkinId(value) && value !== "system" && value !== "user-auto";
}

// Only these two presets paint a dark ground (styles.css --color-app:
// midnight #070707, foundry #100e0b); everything else, including a "system"
// still waiting to resolve, is light. Kept as data rather than re-deriving it
// from CSS at runtime, same tradeoff scripts/check-skin-contrast.mjs makes.
const DARK_SKINS: ReadonlySet<SkinId> = new Set(["midnight", "foundry"]);

export const CONCRETE_SKIN_IDS: readonly ConcreteSkinId[] = SKIN_IDS.filter(isConcreteSkinId);

export const USER_AUTO_LIGHT_IDS: readonly ConcreteSkinId[] = CONCRETE_SKIN_IDS.filter(
  (id) => id === "custom" || !DARK_SKINS.has(id),
);

export const USER_AUTO_DARK_IDS: readonly ConcreteSkinId[] = CONCRETE_SKIN_IDS.filter(
  (id) => id === "custom" || DARK_SKINS.has(id),
);

function coerceUserAutoSide(side: keyof UserAutoPair, value: unknown): ConcreteSkinId {
  const allowed = side === "light" ? USER_AUTO_LIGHT_IDS : USER_AUTO_DARK_IDS;
  if (isConcreteSkinId(value) && allowed.includes(value)) return value;
  return DEFAULT_USER_AUTO_PAIR[side];
}

function relativeLightness(hex: string): number {
  const clean = hex.replace("#", "").trim();
  const full = clean.length === 3 ? [...clean].map((c) => c + c).join("") : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  return 0.299 * r + 0.587 * g + 0.114 * b; // 0 = black, 255 = white
}

export function osPrefersDark(osDark?: boolean): boolean {
  if (typeof osDark === "boolean") return osDark;
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

/**
 * Turn a stored preference into the skin that actually paints.
 * System Auto always maps OS dark → Midnight and OS light → Studio.
 * User Auto uses the caller's light/dark pair (or the stored pair).
 */
export function resolveSkin(
  id: SkinId,
  options?: { osDark?: boolean; pair?: UserAutoPair },
): ConcreteSkinId {
  const dark = osPrefersDark(options?.osDark);
  if (id === "system") {
    return dark ? "midnight" : "studio";
  }
  if (id === "user-auto") {
    const pair = options?.pair ?? readUserAutoPair();
    const chosen = dark ? pair.dark : pair.light;
    return isConcreteSkinId(chosen) ? chosen : (dark ? "midnight" : "studio");
  }
  return id;
}

/** Whether a *resolved* skin paints a dark ground — used to pick a light- or
 * dark-mode syntax theme for code fences (a11y-theme-copy:code-fence-dark-shiki-on-light-default).
 * "custom" has no fixed answer: it is decided by the ground colour the user
 * actually picked, the same one `[data-skin="custom"]`'s inline
 * `--color-inset` override renders (applyCustomTheme sets `--color-inset` to
 * `appBg` directly). "system" and "user-auto" resolve first, then this
 * answers for the painted skin. */
export function isDarkSkin(id: SkinId, options?: { osDark?: boolean; pair?: UserAutoPair }): boolean {
  if (followsComputerLook(id)) return isDarkSkin(resolveSkin(id, options), options);
  if (id === "custom") return relativeLightness(readCustomTheme().appBg) < 128;
  return DARK_SKINS.has(id);
}

const skinWatchers = new Set<() => void>();

function notifySkinChange(): void {
  for (const fn of [...skinWatchers]) fn();
}

/** The resolved skin actually painted on `<html data-skin>` right now, live —
 * re-renders the caller whenever `applySkin`/`saveCustomTheme` changes it.
 * Falls back to `readSkin()` before the DOM attribute exists (SSR/tests). */
export function useResolvedSkin(): SkinId {
  return useSyncExternalStore(
    (fn) => {
      skinWatchers.add(fn);
      return () => skinWatchers.delete(fn);
    },
    () => (typeof document === "undefined" ? readSkin() : (document.documentElement.dataset.skin as SkinId) || readSkin()),
    () => readSkin(),
  );
}

const KEY = "omb-skin";
const ACCENT_KEY = "omb-custom-accent";
const CUSTOM_THEME_KEY = "omb-custom-palette";
const USER_AUTO_KEY = "omb-user-auto-pair";

function getStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function readSkin(): SkinId {
  try {
    const stored = getStore()?.getItem(KEY);
    return isSkinId(stored) ? stored : getDefaultSkin();
  } catch {
    return getDefaultSkin();
  }
}

export function readUserAutoPair(): UserAutoPair {
  try {
    const raw = getStore()?.getItem(USER_AUTO_KEY);
    if (!raw) return { ...DEFAULT_USER_AUTO_PAIR };
    const parsed = JSON.parse(raw) as Partial<UserAutoPair>;
    return {
      light: coerceUserAutoSide("light", parsed?.light),
      dark: coerceUserAutoSide("dark", parsed?.dark),
    };
  } catch {
    return { ...DEFAULT_USER_AUTO_PAIR };
  }
}

export function saveUserAutoPair(pair: UserAutoPair): void {
  const next: UserAutoPair = {
    light: coerceUserAutoSide("light", pair.light),
    dark: coerceUserAutoSide("dark", pair.dark),
  };
  try {
    getStore()?.setItem(USER_AUTO_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  if (readSkin() === "user-auto") applySkin("user-auto");
}

export function readCustomAccent(): string | null {
  try {
    return getStore()?.getItem(ACCENT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function readCustomTheme(): CustomThemeConfig {
  try {
    const raw = getStore()?.getItem(CUSTOM_THEME_KEY);
    if (!raw) return DEFAULT_CUSTOM_THEME;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CUSTOM_THEME, ...parsed };
  } catch {
    return DEFAULT_CUSTOM_THEME;
  }
}

export function saveCustomTheme(theme: CustomThemeConfig): void {
  try {
    getStore()?.setItem(CUSTOM_THEME_KEY, JSON.stringify(theme));
  } catch {
    // ignore
  }
  applyCustomTheme(theme);
  // The custom skin's darkness can change without `data-skin` changing (it
  // stays "custom") — isDarkSkin() consumers (code fences) need to hear it.
  notifySkinChange();
}

export function applyCustomTheme(theme: CustomThemeConfig): void {
  const root = document.documentElement;
  root.style.setProperty("--color-app", theme.appBg);
  root.style.setProperty("--color-panel", theme.panelBg);
  root.style.setProperty("--color-card", theme.cardBg);
  root.style.setProperty("--color-raised", theme.cardBg);
  root.style.setProperty("--color-raised-hover", theme.appBg);
  root.style.setProperty("--color-inset", theme.appBg);
  root.style.setProperty("--color-control", theme.hairlineColor);
  root.style.setProperty("--color-hairline", theme.hairlineColor);
  root.style.setProperty("--color-ink", theme.inkColor);
  root.style.setProperty("--color-ink-secondary", theme.inkSecondaryColor);
  root.style.setProperty("--color-accent", theme.accentColor);
  root.style.setProperty("--color-accent-border", theme.accentColor);
  root.style.setProperty("--color-accent-text", theme.accentColor);
  root.style.setProperty("--color-focus", theme.accentColor);
  root.style.setProperty("--color-accent-ink", "#ffffff");
  root.style.setProperty("--color-bubble-user", `${theme.accentColor}20`);
}

export function applyCustomAccent(hex: string | null): void {
  const root = document.documentElement;
  if (!hex) {
    try {
      getStore()?.removeItem(ACCENT_KEY);
    } catch {
      // ignore
    }
    root.style.removeProperty("--color-accent");
    root.style.removeProperty("--color-accent-border");
    root.style.removeProperty("--color-accent-text");
    root.style.removeProperty("--color-focus");
    return;
  }

  try {
    getStore()?.setItem(ACCENT_KEY, hex);
  } catch {
    // ignore
  }

  root.style.setProperty("--color-accent", hex);
  root.style.setProperty("--color-accent-border", hex);
  root.style.setProperty("--color-accent-text", hex);
  root.style.setProperty("--color-focus", hex);
}

export function applySkin(id: SkinId): void {
  try {
    getStore()?.setItem(KEY, id);
  } catch {
    /* quota / private mode — the skin still applies for this session */
  }

  const resolvedId = resolveSkin(id);

  document.documentElement.dataset.skin = resolvedId;
  document.documentElement.dataset.skinMode = id;

  if (resolvedId === "custom") {
    const customTheme = readCustomTheme();
    applyCustomTheme(customTheme);
  } else {
    // Clear custom palette overrides if switching back to preset skin
    const root = document.documentElement;
    root.style.removeProperty("--color-app");
    root.style.removeProperty("--color-panel");
    root.style.removeProperty("--color-card");
    root.style.removeProperty("--color-raised");
    root.style.removeProperty("--color-raised-hover");
    root.style.removeProperty("--color-inset");
    root.style.removeProperty("--color-control");
    root.style.removeProperty("--color-hairline");
    root.style.removeProperty("--color-ink");
    root.style.removeProperty("--color-ink-secondary");
    root.style.removeProperty("--color-bubble-user");

    const customAccent = readCustomAccent();
    if (customAccent) {
      applyCustomAccent(customAccent);
    }
  }
  
  try {
    void window.ogb?.applySkin?.(resolvedId)?.catch(() => undefined);
  } catch {
    /* no bridge */
  }

  notifySkinChange();
}
