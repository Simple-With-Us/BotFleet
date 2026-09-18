// The registry and the stylesheet are two halves of one contract: a skin listed
// here without a matching CSS block renders as whatever was active before, with
// no error anywhere. That failure is silent, so it gets a test.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_USER_AUTO_PAIR,
  followsComputerLook,
  getDefaultSkin,
  isDarkSkin,
  isConcreteSkinId,
  readSkin,
  readUserAutoPair,
  resolveSkin,
  SKINS,
  SKIN_IDS,
  USER_AUTO_DARK_IDS,
  USER_AUTO_LIGHT_IDS,
} from "./skins";

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, "../styles.css"), "utf8");
const indexHtml = readFileSync(join(here, "../../index.html"), "utf8");

const blocks = new Set(
  [...css.matchAll(/\[data-skin="([a-z-]+)"\]/g)].map(([, id]) => id),
);

/** Modes and the custom palette have no static CSS block. */
const STYLE_SKIN_IDS = SKIN_IDS.filter((id) => id !== "system" && id !== "user-auto" && id !== "custom");

describe("skins", () => {
  it("gives every registered skin a stylesheet block", () => {
    for (const id of STYLE_SKIN_IDS) expect(blocks).toContain(id);
  });

  it("registers every stylesheet block", () => {
    // SAFETY: the assertion only fits toContain()'s parameter type — the
    // assertion IS the check, and an unregistered block fails the test.
    for (const id of blocks) expect(SKIN_IDS).toContain(id as (typeof SKIN_IDS)[number]);
  });

  it("defines the same tokens in every skin", () => {
    const tokensOf = (id: string) => {
      const body = css.match(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([^}]*)\\}`))?.[1] ?? "";
      return new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map(([, name]) => name));
    };
    const reference = tokensOf("midnight");
    expect(reference.size).toBeGreaterThan(15);
    for (const id of STYLE_SKIN_IDS) {
      expect([...reference].filter((t) => !tokensOf(id).has(t))).toEqual([]);
    }
  });

  it("describes each skin exactly once", () => {
    expect(SKINS.map((s) => s.id).sort()).toEqual([...SKIN_IDS].sort());
    for (const skin of SKINS) {
      expect(skin.name.length).toBeGreaterThan(0);
      expect(skin.tagline.length).toBeGreaterThan(0);
    }
  });

  it("defaults @theme and :root to Studio so a no-JS paint stays light", () => {
    expect(css).toMatch(/Defaults = Studio \(light-first\)/);
    const theme = css.match(/@theme \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const root = css.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(theme).toContain("--color-app: #f6f8fa");
    expect(theme).toContain("--color-ink: #111418");
    expect(root).toContain("--color-scrollbar: #c2cbd4");
    expect(root).toContain("--color-maus-line: #57606a");
    expect(css).toContain('[data-skin="midnight"]');
  });

  it("does not give System Auto or User Auto their own CSS blocks", () => {
    expect(blocks.has("system")).toBe(false);
    expect(blocks.has("user-auto")).toBe(false);
  });

  it("stamps System Auto or User Auto on the first paint from index.html", () => {
    expect(indexHtml).toContain('localStorage.getItem("omb-skin") || "system"');
    expect(indexHtml).toContain('stored === "user-auto"');
    expect(indexHtml).toContain('omb-user-auto-pair');
  });

  it("wires User Auto pair controls through Settings and SkinPicker", () => {
    const picker = readFileSync(join(here, "../components/SkinPicker.tsx"), "utf8");
    const settings = readFileSync(join(here, "../components/SettingsModal.tsx"), "utf8");
    const main = readFileSync(join(here, "../main.tsx"), "utf8");
    expect(settings).toContain("<SkinPicker />");
    expect(picker).toContain('useState<SkinId>(() => readSkin())');
    expect(picker).toContain("Light And Dark Themes");
    expect(picker).toContain("When This Computer Is Light");
    expect(picker).toContain("When This Computer Is Dark");
    expect(picker).toContain("When this computer is dark, BotFleet uses Midnight.");
    expect(picker).toContain("followsComputerLook(skin) ? resolveSkin");
    expect(settings).toContain("System Auto uses Midnight when this computer is dark");
    expect(main).toContain("followsComputerLook(pref)");
  });

  it("labels the two auto modes in Title Case", () => {
    expect(SKINS.find((skin) => skin.id === "system")?.name).toBe("System Auto");
    expect(SKINS.find((skin) => skin.id === "user-auto")?.name).toBe("User Auto");
    expect(SKINS.find((skin) => skin.id === "system")?.tagline).toBe(
      "Follows this computer.  Dark uses Midnight; light uses Studio.",
    );
    expect(SKINS.find((skin) => skin.id === "user-auto")?.tagline).toBe(
      "Follows this computer, using your light and dark themes.",
    );
  });

  it("site claim matches getDefaultSkin() System Auto", () => {
    const features = readFileSync(join(here, "../../apps/site/features.json"), "utf8");
    const html = readFileSync(join(here, "../../apps/site/index.html"), "utf8");
    expect(getDefaultSkin()).toBe("system");
    expect(features).toContain("First visit uses System Auto");
    expect(features).not.toMatch(/First visit uses Studio \(light\)/);
    expect(html).toContain("First visit uses System Auto");
  });
});

describe("theme mode resolution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("defaults a first visit with no stored preference to System Auto", () => {
    expect(getDefaultSkin()).toBe("system");
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(readSkin()).toBe("system");
  });

  it("keeps a stored manual theme instead of forcing System Auto", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key === "omb-skin" ? "foundry" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(readSkin()).toBe("foundry");
  });

  it("maps System Auto through the built-in studio/midnight pair only", () => {
    const pair = { light: "lagoon" as const, dark: "foundry" as const };
    expect(resolveSkin("system", { osDark: false, pair })).toBe("studio");
    expect(resolveSkin("system", { osDark: true, pair })).toBe("midnight");
  });

  it("maps User Auto through the caller's light and dark themes", () => {
    const pair = { light: "porcelain" as const, dark: "foundry" as const };
    expect(resolveSkin("user-auto", { osDark: false, pair })).toBe("porcelain");
    expect(resolveSkin("user-auto", { osDark: true, pair })).toBe("foundry");
  });

  it("lets User Auto paint a custom palette on either side", () => {
    expect(resolveSkin("user-auto", { osDark: false, pair: { light: "custom", dark: "midnight" } })).toBe("custom");
    expect(resolveSkin("user-auto", { osDark: true, pair: { light: "studio", dark: "custom" } })).toBe("custom");
  });

  it("falls back to the System Auto skins when a User Auto side is missing", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "omb-user-auto-pair" ? JSON.stringify({ light: "system", dark: "nope" }) : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(readUserAutoPair()).toEqual(DEFAULT_USER_AUTO_PAIR);
    expect(resolveSkin("user-auto", { osDark: false })).toBe("studio");
    expect(resolveSkin("user-auto", { osDark: true })).toBe("midnight");
  });

  it("rejects a dark theme on the light User Auto side and the reverse", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "omb-user-auto-pair" ? JSON.stringify({ light: "midnight", dark: "studio" }) : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(readUserAutoPair()).toEqual(DEFAULT_USER_AUTO_PAIR);
  });

  it("passes a locked theme through unchanged", () => {
    expect(resolveSkin("atelier", { osDark: true })).toBe("atelier");
    expect(resolveSkin("foundry", { osDark: false })).toBe("foundry");
    expect(isConcreteSkinId("studio")).toBe(true);
    expect(isConcreteSkinId("system")).toBe(false);
    expect(isConcreteSkinId("user-auto")).toBe(false);
    expect(followsComputerLook("system")).toBe(true);
    expect(followsComputerLook("user-auto")).toBe(true);
    expect(followsComputerLook("midnight")).toBe(false);
  });

  it("offers lighter themes for light computers and darker themes for dark computers", () => {
    expect(USER_AUTO_LIGHT_IDS).toContain("studio");
    expect(USER_AUTO_LIGHT_IDS).toContain("custom");
    expect(USER_AUTO_LIGHT_IDS).not.toContain("midnight");
    expect(USER_AUTO_DARK_IDS).toEqual(["midnight", "foundry", "custom"]);
  });
});

// isDarkSkin() picks the Shiki theme for code fences
// (a11y-theme-copy:code-fence-dark-shiki-on-light-default) — a wrong answer
// here means dark-on-dark or light-on-light tokens somewhere.
describe("isDarkSkin", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is true only for the two dark presets", () => {
    for (const id of STYLE_SKIN_IDS) {
      expect(isDarkSkin(id)).toBe(id === "midnight" || id === "foundry");
    }
  });

  it("reads custom from the palette the user actually picked, not a guess", () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "omb-custom-palette" ? JSON.stringify({ appBg: "#0b0d10" }) : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(isDarkSkin("custom")).toBe(true);

    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "omb-custom-palette" ? JSON.stringify({ appBg: "#f8fafc" }) : null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(isDarkSkin("custom")).toBe(false);
  });

  it("falls back to the light default custom palette when nothing is stored", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    });
    expect(isDarkSkin("custom")).toBe(false);
  });

  it("answers System Auto from the built-in mapping, not a user pair", () => {
    expect(isDarkSkin("system", { osDark: false, pair: { light: "foundry", dark: "studio" } })).toBe(false);
    expect(isDarkSkin("system", { osDark: true, pair: { light: "foundry", dark: "studio" } })).toBe(true);
  });

  it("answers User Auto from the pair the user picked", () => {
    expect(isDarkSkin("user-auto", { osDark: false, pair: { light: "studio", dark: "foundry" } })).toBe(false);
    expect(isDarkSkin("user-auto", { osDark: true, pair: { light: "studio", dark: "foundry" } })).toBe(true);
  });
});
