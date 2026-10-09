// The native app against the sidecar's allowlist.
//
// The allowlist in routes.ts is default-deny, so a control the app offers
// before anyone adds its route here does not fail in review.  It fails in the
// person's hand, every time, with "no route" or "can only be changed in
// BotFleet on your computer".  That happened twice running: #323 narrowed the
// profile fields, then #709 put the controls back without touching the list;
// and the voice-recording playback and review calls shipped with no route.
//
// This reads the Swift client as text, because the two sides are written in
// different languages and nothing else ties them together.  It checks the
// part a script can: every route the client builds is on the list, and every
// field a profile save can carry is either on the list or deliberately not
// sent.  It cannot check a field's VALUE (the harness decides those, see
// proxy.test.ts) or a screen's wording.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { bypassCoverageNote } from "../../shared/bypass-coverage.ts";
import { COMPANION_PROFILE_PATCH_FIELDS, denyReason } from "../src/routes.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = join(HERE, "..", "..", "ios", "Sources", "CompanionCore");
const read = (file: string) => readFileSync(join(CLIENT_DIR, file), "utf8");

/** Every request the client builds with a literal method and path, with each
 * `\(interpolation)` standing in as a plain id so the path can be matched. */
function clientRoutes(): Array<{ method: string; path: string }> {
  const source = read("Client.swift");
  const found = new Map<string, { method: string; path: string }>();
  for (const call of source.matchAll(/makeRequest\(\s*"(GET|POST|PATCH|PUT|DELETE)",\s*"((?:[^"\\]|\\.)*)"/g)) {
    const path = call[2].replace(/\\\([^)]*\)/g, "1");
    found.set(`${call[1]} ${path}`, { method: call[1], path });
  }
  return [...found.values()];
}

describe("the native client against the allowlist", () => {
  it("finds the routes it is meant to check", () => {
    // A guard that matched nothing would pass forever.
    const routes = clientRoutes();
    expect(routes.length).toBeGreaterThan(40);
    expect(routes).toContainEqual({ method: "PATCH", path: "/api/bots/1/profile" });
    expect(routes).toContainEqual({ method: "GET", path: "/api/threads/1/messages/1/recording" });
  });

  it("builds no request the sidecar answers 'no route' or refuses", () => {
    const refused = clientRoutes()
      .map((route) => ({ route, denial: denyReason({ ...route, authenticated: true }) }))
      .filter(({ denial }) => denial !== null)
      .map(({ route, denial }) => `${route.method} ${route.path} -> ${denial!.status} ${denial!.error}`);
    expect(refused).toEqual([]);
  });

  it("sends no profile field the sidecar refuses", () => {
    const source = read("Models.swift");
    const patch = source.slice(source.indexOf("public struct BotProfilePatch"));
    const keys = patch.match(/private enum CodingKeys: String, CodingKey \{\s*case ([^\n]+)/)?.[1];
    expect(keys, "BotProfilePatch.CodingKeys").toBeTruthy();
    const sendable = keys!.split(",").map((key) => key.trim());
    expect(sendable.length).toBeGreaterThan(10);

    // `section` is declared and never sent by any screen.  Anything else the
    // type can carry must be on the list, so the compiler, not a reviewer,
    // is what stops the sheet asking for a field that will be refused.
    const declaredButUnused = new Set(["section"]);
    const allowed = new Set<string>(COMPANION_PROFILE_PATCH_FIELDS);
    const refused = sendable.filter((key) => !declaredButUnused.has(key) && !allowed.has(key));
    expect(refused).toEqual([]);
  });
});

describe("the native app's copies of what the desktop decides", () => {
  // Two lists the phone cannot import, because they are written in the other
  // language.  Each is copied once, and these fail when the copy drifts.
  it("warns about the same models before a bypass as the desktop does", () => {
    const desktop = readFileSync(join(HERE, "..", "..", "shared", "model-safety.ts"), "utf8");
    const desktopBlock = desktop.match(/const HIGH_RISK_PATTERNS[^=]*= \[([\s\S]*?)\n\];/)?.[1] ?? "";
    const desktopPatterns = [...desktopBlock.matchAll(/^\s*\/(.+)\/i,\s*$/gm)].map((match) => match[1]);

    const swift = read("BotExecutionPolicy.swift");
    const swiftBlock = swift.match(/static let highRiskPatterns: \[String\] = \[([\s\S]*?)\n    \]/)?.[1] ?? "";
    const swiftPatterns = [...swiftBlock.matchAll(/#"(.+)"#/g)].map((match) => match[1]);

    expect(desktopPatterns.length).toBeGreaterThan(8);
    expect(swiftPatterns).toEqual(desktopPatterns);
  });

  it("says the same thing as the desktop where Bypass Permissions does not simply work", () => {
    const swift = read("BotExecutionPolicy.swift");
    for (const coverage of ["native", "none"] as const) {
      const note = bypassCoverageNote(coverage)!;
      // The Swift source spells a no-break space as an escape.
      const asSwift = note.replaceAll("\u00A0", "\\u{00A0}");
      expect(swift, coverage).toContain(`"${asSwift}"`);
    }
    // The wire names the phone decodes are the ones the computer sends.
    expect(swift).toMatch(/case asks\s+case native\s+case none/);
  });
});
