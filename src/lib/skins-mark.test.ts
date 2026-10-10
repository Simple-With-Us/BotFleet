// @vitest-environment happy-dom
// The mark tone is the one token a palette must not own.
//
// Owner, 2026-10-10: the engine rail in the model picker painted most platform
// logos in the theme accent colour. The preset skins each declare their own
// `--color-mark`, so they could not be the cause; a Custom Palette writes its
// colours onto `documentElement` inline, which outranks every skin block. So
// the guard has to live here, where the palette is applied, and it has to be a
// behavior test rather than a reading of the CSS: these tests apply a real
// palette and read the computed custom properties back off the document.
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCustomTheme,
  applySkin,
  DEFAULT_CUSTOM_THEME,
  type CustomThemeConfig,
} from "./skins";

function palette(overrides: Partial<CustomThemeConfig> = {}): CustomThemeConfig {
  return { ...DEFAULT_CUSTOM_THEME, ...overrides };
}

function inline(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

/** A palette built to break the rule: main text painted in the accent, accent
 *  a saturated brand colour. This is the shape that turned logos into chips. */
const HOSTILE_PALETTE = palette({
  appBg: "#ffffff",
  panelBg: "#ffffff",
  cardBg: "#ffffff",
  inkColor: "#c05621",
  inkSecondaryColor: "#111827",
  accentColor: "#c05621",
  hairlineColor: "#e5e7eb",
});

afterEach(() => {
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-skin");
  document.documentElement.removeAttribute("data-skin-mode");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("custom palette mark tone", () => {
  it("never hands a logo the palette's accent or its main text", () => {
    applyCustomTheme(HOSTILE_PALETTE);
    const mark = inline("--color-mark");
    expect(mark).toBeTruthy();
    expect(mark.toLowerCase()).not.toBe(HOSTILE_PALETTE.accentColor.toLowerCase());
    expect(mark.toLowerCase()).not.toBe(HOSTILE_PALETTE.inkColor.toLowerCase());
  });

  it("reads as a mark on the ground it paints", () => {
    // Light ground, dark mark.
    applyCustomTheme(palette({ appBg: "#f5f5f5" }));
    const onLight = inline("--color-mark");
    applyCustomTheme(palette({ appBg: "#101014" }));
    const onDark = inline("--color-mark");
    expect(onLight).not.toBe(onDark);
    // Enough separation from its own ground to be seen at 14px.
    const luminance = (hex: string): number => {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16) / 255);
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    expect(luminance(onLight)).toBeLessThan(luminance(HOSTILE_PALETTE.appBg) - 0.3);
    expect(luminance(onDark)).toBeGreaterThan(luminance("#101014") + 0.3);
  });

  it("keeps one tone for a palette whose accent moves", () => {
    // Two palettes, identical ground, wildly different accents: the mark must
    // not move with the accent, or the logos still read as accent chips.
    applyCustomTheme(palette({ appBg: "#ffffff", accentColor: "#0969da" }));
    const blue = inline("--color-mark");
    applyCustomTheme(palette({ appBg: "#ffffff", accentColor: "#7c3aed" }));
    expect(inline("--color-mark")).toBe(blue);
  });

  it("drops the palette's mark tone when a preset skin takes over", () => {
    // Otherwise the inline value outlives the palette and every later skin
    // paints its logos with the old palette's tone.
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    applyCustomTheme(HOSTILE_PALETTE);
    expect(inline("--color-mark")).toBeTruthy();
    applySkin("midnight");
    expect(inline("--color-mark")).toBe("");
    expect(document.documentElement.dataset.skin).toBe("midnight");
  });
});