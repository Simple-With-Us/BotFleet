// Verify the bundle set one packaged BotFleet.app ships is self-consistent.
//
// Why this exists (BF-2531): three version carriers leave the build in three
// different places.  The Electron updater feed orders releases by the app
// version alone (scripts/electron-release-version.mjs).  The explicit Update
// Control transaction compares the bundled Control's Info.plist release
// against the installed one (electron/server-controls.mjs).  The version
// handshake compares the packaged server's build-identity.json against the
// Control bundle (mac-control/.../ControlBuildIdentity.swift,
// server/index.ts `/api/system/control`).  Each stamper is unit-tested in
// isolation, and the release workflow test pins their wiring as text, but
// nothing reads the packaged bytes back: a Control bundle stamped without
// the pin -- the retired 1.0.<commit_count> number from a checkout that
// never saw BOTFLEET_BUILD_VERSION -- would ride inside a release whose feed
// and server carry the 1.0.<merge_stamp> app version with every gate green.
// The updated app would then install a server newer than its own bundled
// Control, the explicit update would refuse the stale copy as "not newer"
// (or install it over an older install), and the handshake would report
// mismatch for the life of the release: a stale BotFleet Control bundle
// outliving its server, shipped by the pipeline.
//
// This check runs after packaging, against the bytes, with the pinned
// release as the expected value.  It refuses any disagreement rather than
// ordering it, because a shipped disagreement is never the right order.
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { controlRelease } from "../electron/server-controls.mjs";
import { readPackagedBuildIdentity } from "../electron/runtime-identity.mjs";

const VERSION = /^\d+\.\d+\.\d+$/;
const BUILD = /^[0-9]+$/;

/**
 * Refuse a packaged app whose bundled Control or server disagrees with the
 * pinned release.  Returns the two releases that agreed.
 */
export function verifyPackagedVersions(appDir, { version, build } = {}) {
  const wantVersion = String(version ?? "").trim();
  const wantBuild = String(build ?? "").trim();
  if (!VERSION.test(wantVersion)) {
    throw new Error(`the expected release version is not an x.y.z version: ${wantVersion || "(missing)"}`);
  }
  if (!BUILD.test(wantBuild)) {
    throw new Error(`the expected release build is not a number: ${wantBuild || "(missing)"}`);
  }

  let control = null;
  try {
    control = controlRelease(join(appDir, "Contents", "Resources", "BotFleet Control.app"));
  } catch {
    control = null;
  }
  if (!control) {
    throw new Error(
      `the Control bundle in ${appDir} carries an unknown release version or build, ` +
        `so the shipped set cannot be proven consistent with release ${wantVersion} (build ${wantBuild})`,
    );
  }
  if (control.version !== wantVersion || control.build !== wantBuild) {
    throw new Error(
      `the Control bundle in ${appDir} disagrees with its own release: ` +
        `it carries ${control.version} (build ${control.build}) ` +
        `and the release pins ${wantVersion} (build ${wantBuild}); ` +
        `shipping it would strand a stale Control next to a newer server`,
    );
  }

  let identity = null;
  try {
    identity = readPackagedBuildIdentity(join(appDir, "Contents", "Resources", "server"));
  } catch {
    identity = null;
  }
  if (!identity) {
    throw new Error(
      `the packaged server in ${appDir} has a missing or invalid build-identity.json, ` +
        `so the shipped set cannot be proven consistent with release ${wantVersion} (build ${wantBuild})`,
    );
  }
  const serverBuild = identity.build ?? null;
  if (identity.version !== wantVersion || serverBuild !== wantBuild) {
    throw new Error(
      `the packaged server in ${appDir} disagrees with its own release: ` +
        `it reports ${identity.version} (build ${serverBuild ?? "none"}) ` +
        `and the release pins ${wantVersion} (build ${wantBuild}); ` +
        `a server without its release build leaves the version handshake at unknown order`,
    );
  }
  return { control, server: { version: identity.version, build: serverBuild } };
}

function usage() {
  return "usage: node scripts/verify-packaged-versions.mjs <BotFleet.app> --version <x.y.z> --build <n>";
}

// Compare physical paths.  Node's ESM loader realpaths the entry module, so an
// invocation through a symlinked directory (macOS /var -> /private/var) never
// matches process.argv[1] when compared as text.
function isEntryModule() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryModule()) {
  const [appDir, ...rest] = process.argv.slice(2);
  let version = "";
  let build = "";
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    // A flag where a value belongs is a typo, not a value.  Consuming it
    // would verify the wrong release without an error, so it fails fast.
    const take = (flag) => {
      index += 1;
      const value = rest[index] ?? "";
      if (value === "" || value.startsWith("--")) {
        console.error(`missing value for ${flag}`);
        process.exit(2);
      }
      return value;
    };
    if (arg === "--version") {
      if (version !== "") {
        console.error("duplicate --version");
        process.exit(2);
      }
      version = take(arg);
    } else if (arg === "--build") {
      if (build !== "") {
        console.error("duplicate --build");
        process.exit(2);
      }
      build = take(arg);
    }
    else {
      console.error(`unknown argument: ${arg}`);
      console.error(usage());
      process.exit(2);
    }
  }
  if (!appDir) {
    console.error(usage());
    process.exit(2);
  }
  try {
    const agreed = verifyPackagedVersions(appDir, { version, build });
    console.log(
      `packaged ${agreed.control.version} (build ${agreed.control.build}): ` +
        `Control bundle and server agree with the pinned release`,
    );
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
