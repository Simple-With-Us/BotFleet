// Which build is actually running, in a shape the renderer can print.
//
// The app ships under the 1.0.<commit_count> scheme (see
// scripts/ios-fleet/ship-testflight.sh), so the version string already carries
// the build number: the part after the last dot. We still parse it out rather
// than showing the raw string, because "which commit am I on" is the question
// this answers, and 1.0.<commit_count> is unreadable at a glance.
//
// Every field is derived from values Electron hands us. Nothing here reads the
// filesystem or the network, so it is safe to call from a settings panel that
// renders before the server is up.

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

/** The trailing component of a semantic version, or null when the version is
 *  not plain `x.y.z` (a dev build reading package.json verbatim, or a
 *  prerelease string). We would rather show "—" than a number that is not a
 *  build number. */
function buildNumberFromVersion(version) {
  const match = VERSION_PATTERN.exec(String(version ?? "").trim());
  return match ? match[3] : null;
}

function appRuntimeInfo({
  version,
  platform = process.platform,
  arch = process.arch,
  electron = process.versions.electron,
  node = process.versions.node,
  packaged = false,
  harness = null,
} = {}) {
  const clean = String(version ?? "").trim();
  return {
    // "unknown" rather than "0.0.0": a missing version must never render as
    // build 0, which reads like a real build someone could go looking for.
    version: clean || "unknown",
    build: clean ? buildNumberFromVersion(clean) : null,
    platform,
    arch,
    electron,
    node,
    packaged,
    harness,
  };
}

/** The one line the settings panel prints, e.g.
 *  "1.0.1284  ·  build 1284  ·  electron 38.1.0  ·  darwin arm64".
 *  Kept plain so it can go straight to the clipboard for a bug report. */
function appRuntimeSummary(info) {
  if (!info) return "";
  const parts = [info.version];
  if (info.build) parts.push(`build ${info.build}`);
  if (info.electron) parts.push(`electron ${info.electron}`);
  if (info.node) parts.push(`node ${info.node}`);
  const platform = info.platform && info.arch ? `${info.platform} ${info.arch}` : info.platform;
  if (platform) parts.push(platform);
  if (!info.packaged) parts.push("dev build");
  return parts.filter(Boolean).join("  ·  ");
}

module.exports = {
  appRuntimeInfo,
  appRuntimeSummary,
  buildNumberFromVersion,
};