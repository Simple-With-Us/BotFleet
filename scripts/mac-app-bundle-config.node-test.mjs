import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("BotFleetMac app icon and Settings scene wiring", () => {
  it("wires MacApp/Assets.xcassets and AppIcon cleanly without duplicate sources in ios/project.yml", () => {
    const projectYml = readFileSync(join(REPO_ROOT, "ios", "project.yml"), "utf8");
    const macSectionStart = projectYml.indexOf("  BotFleetMac:");
    const schemesStart = projectYml.indexOf("schemes:");
    assert.ok(macSectionStart !== -1 && schemesStart > macSectionStart, "BotFleetMac target section exists");
    const macSection = projectYml.slice(macSectionStart, schemesStart);

    assert.match(macSection, /- path:\s*MacApp\b/);
    assert.doesNotMatch(macSection, /- path:\s*MacApp\/Assets\.xcassets/);
    assert.ok(existsSync(join(REPO_ROOT, "ios", "MacApp", "Assets.xcassets", "Contents.json")));
    assert.match(macSection, /ASSETCATALOG_COMPILER_APPICON_NAME:\s*AppIcon/);
  });

  it("provides all 10 macOS icon slots under ios/MacApp/Assets.xcassets/AppIcon.appiconset", () => {
    const appIconDir = join(REPO_ROOT, "ios", "MacApp", "Assets.xcassets", "AppIcon.appiconset");
    const contents = JSON.parse(readFileSync(join(appIconDir, "Contents.json"), "utf8"));
    const expectedSlots = [
      "16x16:1x:icon_16x16.png",
      "16x16:2x:icon_16x16@2x.png",
      "32x32:1x:icon_32x32.png",
      "32x32:2x:icon_32x32@2x.png",
      "128x128:1x:icon_128x128.png",
      "128x128:2x:icon_128x128@2x.png",
      "256x256:1x:icon_256x256.png",
      "256x256:2x:icon_256x256@2x.png",
      "512x512:1x:icon_512x512.png",
      "512x512:2x:icon_512x512@2x.png",
    ];
    const actualSlots = contents.images.map((img) => {
      assert.equal(img.idiom, "mac");
      const pngPath = join(appIconDir, img.filename);
      assert.ok(existsSync(pngPath), `Missing PNG asset ${img.filename}`);
      assert.ok(statSync(pngPath).size > 0, `Empty PNG asset ${img.filename}`);
      return `${img.size}:${img.scale}:${img.filename}`;
    });
    assert.deepEqual(actualSlots, expectedSlots);
  });

  it("bridges SwiftUI openSettings into MacSession.presentSettingsScene before AppKit selectors", () => {
    const rootView = readFileSync(join(REPO_ROOT, "ios", "MacApp", "MacRootView.swift"), "utf8");
    const macSession = readFileSync(join(REPO_ROOT, "ios", "MacApp", "MacSession.swift"), "utf8");

    assert.match(rootView, /@Environment\(\\\.openSettings\)\s+private\s+var\s+openSettings/);
    assert.match(rootView, /session\.registerSettingsSceneOpener\s*\{\s*openSettings\(\)\s*\}/);

    const presentStart = macSession.indexOf("public func presentSettingsScene()");
    assert.ok(presentStart !== -1, "presentSettingsScene() exists");
    const presentBody = macSession.slice(presentStart, presentStart + 800);
    const openerCallIndex = presentBody.indexOf("if let opener = settingsSceneOpener");
    const menuFallbackIndex = presentBody.indexOf("Self.triggerMainMenuSettingsItem()");
    const legacySelectorIndex = presentBody.indexOf("showSettingsWindow:");
    assert.ok(openerCallIndex !== -1, "presentSettingsScene invokes registered SwiftUI opener");
    assert.ok(menuFallbackIndex > openerCallIndex, "menu item fallback follows opener");
    assert.ok(legacySelectorIndex > menuFallbackIndex, "legacy AppKit selector stays last fallback");
  });
});
