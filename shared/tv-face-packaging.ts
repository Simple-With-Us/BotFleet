/** Keep in sync with shared/tv-face-packaging.ts (TypeScript source for the app). */
import type { BotColor } from "../src/lib/mascot";

export type TvFaceSkinColor = BotColor | "default" | "orange";

export const DESKTOP_BUNDLED_TVFACE_SKIN_DIRS: ReadonlySet<string> = new Set(["default"]);

export const DESKTOP_BUNDLED_TVFACE_SKINS: ReadonlySet<TvFaceSkinColor> = new Set<TvFaceSkinColor>([
  "orange",
]);

export function tvFaceSkinDirectoryName(color: string): string {
  if (color === "orange" || color === "default") return "default";
  return color;
}

export function tvFaceSkinDirForBundledDirs(
  color: string,
  bundledDirs: ReadonlySet<string>,
): string {
  const dir = tvFaceSkinDirectoryName(color);
  return bundledDirs.has(dir) ? dir : "default";
}

export function isDesktopBundledTvFaceSkin(color: TvFaceSkinColor): boolean {
  return DESKTOP_BUNDLED_TVFACE_SKINS.has(color);
}
