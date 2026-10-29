/**
 * TV-Face skin directories bundled into the Electron desktop package.
 * Keep in sync with shared/tv-face-packaging.ts and trimDesktopTvFaceSkins
 * in scripts/after-pack.mjs.
 */
export const DESKTOP_BUNDLED_TVFACE_SKIN_DIRS = new Set(["default"]);

export function tvFaceSkinDirectoryName(color) {
  if (color === "orange" || color === "default") return "default";
  return color;
}
