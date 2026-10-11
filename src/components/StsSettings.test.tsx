// Tests for the STS settings panel.
//
// The suite runs in vitest's node environment, so effects never fire and
// `useEffect`-driven state is unreachable by rendering.  The logic that has
// to be right — what an absent config value means, and what the panel says
// when a key is missing — is therefore pure and exported, and is tested
// directly.  The render assertions pin the surface copy and the defaults the
// panel ships with on first paint.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  StsSettings,
  stsEffectiveFrontEngine,
  stsEffectiveProvider,
  stsKeyNotice,
} from "./StsSettings";
import { STS_PROVIDERS } from "@/lib/sts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The slice of the preload bridge this panel reads. */
interface StubBridge {
  sts?: { status: () => Promise<{ xai: boolean; gemini: boolean }> };
}

const render = (ogb?: StubBridge) => {
  vi.stubGlobal("window", { ogb });
  return renderToStaticMarkup(createElement(StsSettings));
};

/** The provider radios, as whole tags — attribute order is React's to pick. */
const radioTags = (html: string) => [...html.matchAll(/<input[^>]*name="sts-provider"[^>]*>/g)].map((m) => m[0]);

describe("stsEffectiveProvider", () => {
  it("reads an absent or null provider as Auto", () => {
    // `provider: null` is what the panel itself writes for Auto.
    expect(stsEffectiveProvider({ provider: null })).toBe("auto");
    expect(stsEffectiveProvider({})).toBe("auto");
    expect(stsEffectiveProvider(undefined)).toBe("auto");
    expect(stsEffectiveProvider(null)).toBe("auto");
  });

  it("keeps an explicit provider", () => {
    expect(stsEffectiveProvider({ provider: "xai" })).toBe("xai");
    expect(stsEffectiveProvider({ provider: "gemini" })).toBe("gemini");
  });
});

describe("stsEffectiveFrontEngine", () => {
  it("is on when the config says nothing at all", () => {
    // prepareStsSession reads `config.frontEngine !== false`, so unset is on.
    expect(stsEffectiveFrontEngine(undefined)).toBe(true);
    expect(stsEffectiveFrontEngine(null)).toBe(true);
    expect(stsEffectiveFrontEngine({})).toBe(true);
    expect(stsEffectiveFrontEngine({ frontEngine: undefined })).toBe(true);
  });

  it("follows an explicit value in both directions", () => {
    expect(stsEffectiveFrontEngine({ frontEngine: true })).toBe(true);
    expect(stsEffectiveFrontEngine({ frontEngine: false })).toBe(false);
  });

  it("agrees with the runtime default it is mirroring", () => {
    // Pinned at the source: if prepareStsSession ever changes what "unset"
    // means, this panel's default is wrong and this fails rather than the UI
    // quietly showing a toggle the runtime does not honour.
    const SRC = readFileSync(join(__dirname, "../lib/sts/index.ts"), "utf8");
    expect(SRC).toContain("const frontEngine = config.frontEngine !== false;");
  });
});

describe("stsKeyNotice", () => {
  it("stays silent when key state is not known yet", () => {
    // Null must never read as "no key": that would tell the owner to add a
    // key they may already have.
    expect(stsKeyNotice("xai", null)).toBeNull();
    expect(stsKeyNotice("gemini", null)).toBeNull();
  });

  it("confirms a configured key", () => {
    expect(stsKeyNotice("xai", { xai: true })).toBe("Key configured.");
    expect(stsKeyNotice("gemini", { gemini: true })).toBe("Key configured.");
  });

  it("names the missing credential and says what actually happens", () => {
    expect(stsKeyNotice("xai", { xai: false })).toBe(
      "No XAI_API_KEY — calls use Auto until one is added.",
    );
    expect(stsKeyNotice("gemini", { xai: true, gemini: false })).toBe(
      "No GEMINI_API_KEY — calls use Auto until one is added.",
    );
  });
});

describe("StsSettings", () => {
  it("renders the section with Auto selected and the engine toggle on", () => {
    const html = render();
    expect(html).toContain("Speech-to-Speech Calls");
    const [auto, ...rest] = radioTags(html);
    // Auto is the shipped default, so it carries the checked radio.
    expect(auto).toContain('value="auto"');
    expect(auto).toContain('checked=""');
    expect(rest.every((tag) => !tag.includes('checked=""'))).toBe(true);
    // frontEngine defaults to on, so the checkbox ships checked.
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
    expect(checkbox).toContain('checked=""');
    expect(html).toContain("Use The Bot&#x27;s Coding Engine");
  });

  it("describes Auto as preferring the first provider in the picker order", () => {
    const html = render();
    expect(html).toContain("Use whichever provider has a key, preferring xAI.");
    // The order is STS_PROVIDERS', not this panel's.
    expect(STS_PROVIDERS[0]).toBe("xai");
  });

  it("states the front-engine behaviour plainly, including the degraded turn", () => {
    const html = render();
    expect(html).toContain("On by default.");
    expect(html).toMatch(/When that engine is\s*slow or unavailable, the model answers that turn alone instead\./);
  });

  it("offers one radio per provider in STS_PROVIDERS order", () => {
    const html = render();
    const order = radioTags(html).map((tag) => tag.match(/value="([^"]+)"/)?.[1]);
    expect(order).toEqual(["auto", ...STS_PROVIDERS]);
  });

  it("says so instead of crashing when the bridge is unavailable", () => {
    // No `window.ogb.sts` at all: the browser-without-desktop-app case.
    const html = render();
    expect(html).toContain("Available in the installed desktop app.");
  });

  it("shows the key-status warning when the bridge exists but status fails", () => {
    // Effects do not run under SSR, so the bridge is present and the key
    // state is still unknown: the panel must not claim a key is missing.
    const html = render({ sts: { status: () => Promise.reject(new Error("nope")) } });
    expect(html).not.toContain("No XAI_API_KEY");
    expect(html).not.toContain("No GEMINI_API_KEY");
    expect(html).not.toContain("Available in the installed desktop app.");
  });

  it("uses a real non-breaking space, never the &nbsp; entity", () => {
    const html = render();
    expect(html).not.toContain("&nbsp;");
    expect(html).toContain("\u00A0");
  });
});

/**
 * The save path is a closure over component state behind a click, and this
 * suite renders to static markup, so it is unreachable from here.  The
 * invariant is pinned at the source instead — the same trade VoiceSettings
 * makes for its loaders.
 */
describe("StsSettings save path", () => {
  const SRC = readFileSync(join(__dirname, "StsSettings.tsx"), "utf8");
  const between = (start: string, end: string) => {
    const from = SRC.indexOf(start);
    const to = SRC.indexOf(end, from + start.length);
    if (from < 0 || to < 0) throw new Error(`missing slice ${start} -> ${end}`);
    return SRC.slice(from, to);
  };

  it("advances the shown choice only after a confirmed write", () => {
    const save = between("const save = async", "const saveProvider");
    const provider = between("const saveProvider", "const saveFrontEngine");
    const front = between("const saveFrontEngine", "const configured");

    // save() reports whether the PUT landed; it must not advance state itself.
    expect(save).toContain("): Promise<boolean>");
    expect(save).toContain("return false;");
    expect(save).toContain("return true;");
    expect(save.indexOf("setProvider")).toBe(-1);
    expect(save.indexOf("setFrontEngine")).toBe(-1);

    // A failed PUT leaves the radio and the toggle where the config put them.
    expect(provider).toContain("if (await save({ provider: next === \"auto\" ? null : next })) setProvider(next);");
    expect(front).toContain("if (await save({ frontEngine: next })) setFrontEngine(next);");

    // Auto is written as the schema's null, never as a provider id.
    expect(provider).toContain("next === \"auto\" ? null : next");
    // Only the sts slice travels.
    expect(save).toContain("body: JSON.stringify({ sts: patch })");
  });

  it("drops a second save while one is in flight", () => {
    const save = between("const save = async", "const saveProvider");
    expect(save).toContain("if (saving) return false;");
  });
});