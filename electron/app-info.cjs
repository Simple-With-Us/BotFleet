// Which build is actually running, in a shape the renderer can print.
//
// One thing this file deliberately does NOT do: call the patch component of the
// version a "build number".  That trick is only valid for the iOS client, which
// ships as 1.0.<commit_count> (scripts/ios-fleet/ship-testflight.sh).  The Mac
// app does not — it carries a hand-maintained semver, and its latest release is
// v0.1.38 — so its "31" is a patch number somebody typed, not a build anybody
// can go and look for.  Printing `build 31` would be confidently wrong, which is
// worse than printing nothing.  A real commit identity has to be stamped into
// the Mac bundle at build time; until that exists, the version is the truth and
// this file reports it plainly.
//
// Every field is derived from values Electron hands us. Nothing here reads the
// filesystem or the network, so it is safe to call from a settings panel that
// renders before the server is up.

/** Trim a version to something safe to render, never inventing a value. */
function cleanVersion(version) {
  const raw = String(version ?? "").trim();
  if (!raw) return "unknown";
  // package.json versions are plain semver; an Electron release build prefixes
  // them with "v". Keep the caller's value rather than guessing at a scheme.
  return raw.length <= 64 ? raw : raw.slice(0, 64);
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
  return {
    version: cleanVersion(version),
    platform,
    arch,
    electron,
    node,
    packaged,
    harness,
  };
}

/** The one line the settings panel prints, e.g.
 *  "v1.0.31  ·  electron 44.7.2  ·  node 22.14.0  ·  darwin arm64".
 *  Kept plain so it can go straight to the clipboard for a bug report. */
function appRuntimeSummary(info) {
  if (!info) return "";
  const parts = [info.version];
  if (info.electron) parts.push(`electron ${info.electron}`);
  if (info.node) parts.push(`node ${info.node}`);
  const platform = info.platform && info.arch ? `${info.platform} ${info.arch}` : info.platform;
  if (platform) parts.push(platform);
  if (info.harness) parts.push(info.harness);
  // "dev" is the harness value for an unpackaged run, and it is the difference
  // between "my build is broken" and "that is the source tree, not a release".
  if (!info.packaged) parts.push("dev build");
  return parts.filter(Boolean).join("  ·  ");
}

module.exports = {
  appRuntimeInfo,
  appRuntimeSummary,
  cleanVersion,
};