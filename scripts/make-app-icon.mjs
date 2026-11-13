// Generates the iOS app icon matching build/icon-1024.png.
//
//   node scripts/make-app-icon.mjs
//
// iOS App Store requirements:
//   - 1024x1024 uncropped full-bleed square with sharp 90-degree corners
//   - No alpha channel (RGB 24-bit)
//
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "ios", "App", "Assets.xcassets", "AppIcon.appiconset");
const SRC_ICON = join(ROOT, "build", "icon-1024.png");

mkdirSync(OUT_DIR, { recursive: true });

if (existsSync(SRC_ICON)) {
  const destIcon = join(OUT_DIR, "icon-1024.png");
  copyFileSync(SRC_ICON, destIcon);
  try {
    execFileSync("python3", ["-c", `from PIL import Image; Image.open('${destIcon}').convert('RGB').save('${destIcon}', 'PNG')`], { stdio: "ignore" });
  } catch {
    // ignore
  }
}

writeFileSync(
  join(OUT_DIR, "Contents.json"),
  JSON.stringify(
    {
      images: [{ filename: "icon-1024.png", idiom: "universal", platform: "ios", size: "1024x1024" }],
      info: { author: "xcode", version: 1 },
    },
    null,
    2,
  ) + "\n",
);

console.log("wrote 1024x1024 icon to ios/App/Assets.xcassets/AppIcon.appiconset/");
