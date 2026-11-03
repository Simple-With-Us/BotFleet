// The packaged bundle set must agree with the pinned release (BF-2531).
//
// Each stamper is covered by its own suite -- control-build-version,
// bundle-server through the release workflow wiring, the Swift handshake --
// but no suite reads the packaged bytes back.  These fixtures prove the new
// check refuses the combinations the old surface waved through: a Control
// bundle on the retired commit-count number riding with a server on the
// merge-stamp app version, and a server with no release build at all (the
// shape every pre-policy bundle shipped, e.g. the installed 1.0.2304 whose
// build-identity.json carries no build).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyPackagedVersions } from "./verify-packaged-versions.mjs";

const STAMP = "202611030100";
const APP = `1.0.${STAMP}`;
const COMMIT = "a".repeat(40);

function packagedApp(t, { control, server }) {
  const root = mkdtempSync(path.join(tmpdir(), "botfleet-packaged-versions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = path.join(root, "BotFleet.app");
  if (control !== null) {
    const bundle = path.join(app, "Contents", "Resources", "BotFleet Control.app", "Contents");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      path.join(bundle, "Info.plist"),
      `<plist><dict>\n` +
        `<key>CFBundleIdentifier</key><string>app.botfleet.control.macos</string>\n` +
        `<key>CFBundleShortVersionString</key><string>${control.version}</string>\n` +
        `<key>CFBundleVersion</key><string>${control.build}</string>\n` +
        `</dict></plist>`,
    );
  }
  if (server !== null) {
    const directory = path.join(app, "Contents", "Resources", "server");
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "build-identity.json"), JSON.stringify(server));
  }
  return app;
}

const freshControl = { version: APP, build: STAMP };
const freshServer = {
  app: "botfleet",
  version: APP,
  build: STAMP,
  apiVersion: 1,
  sourceCommit: COMMIT,
  sourceDirty: false,
  uiHash: null,
};

test("a packaged set that agrees with the pinned release passes", (t) => {
  const app = packagedApp(t, { control: freshControl, server: freshServer });
  assert.deepEqual(verifyPackagedVersions(app, { version: APP, build: STAMP }), {
    control: freshControl,
    server: { version: APP, build: STAMP },
  });
});

test("the retired commit-count shape still passes when it is the pinned release", (t) => {
  // A pin that names no marketing version is the retired 1.0.<count> shape
  // (control-build-version.mjs): 1.0.2222 still means version 1.0.2222 and
  // build 2222.  The check must not force the new scheme on it.
  const app = packagedApp(t, {
    control: { version: "1.0.2222", build: "2222" },
    server: { ...freshServer, version: "1.0.2222", build: "2222" },
  });
  assert.deepEqual(verifyPackagedVersions(app, { version: "1.0.2222", build: "2222" }), {
    control: { version: "1.0.2222", build: "2222" },
    server: { version: "1.0.2222", build: "2222" },
  });
});

test("a stale Control bundle riding with a newer server is refused", (t) => {
  // The failure this check exists to catch: Control stamped without the pin
  // (the retired number) inside a release whose server carries the merge
  // stamp.  The updater orders by the app version, so the app installs; the
  // explicit Control update then refuses the stale copy as "not newer" (or
  // installs it over an older install), and the handshake reports mismatch
  // for the life of the release.
  const app = packagedApp(t, {
    control: { version: "1.0.2222", build: "2222" },
    server: freshServer,
  });
  assert.throws(
    () => verifyPackagedVersions(app, { version: APP, build: STAMP }),
    /Control bundle.*disagrees with its own release: it carries 1\.0\.2222 \(build 2222\)/,
  );
});

test("a Control bundle newer than the pinned release is refused too", (t) => {
  const app = packagedApp(t, {
    control: { version: "1.0.202612010000", build: "202612010000" },
    server: freshServer,
  });
  assert.throws(
    () => verifyPackagedVersions(app, { version: APP, build: STAMP }),
    /Control bundle.*carries 1\.0\.202612010000/,
  );
});

test("a server without its release build is refused", (t) => {
  // Every pre-policy bundle shipped this shape -- version with no build --
  // and against it the handshake can only report unknown order, never newer
  // or older.  A pinned release must not ship it.
  const app = packagedApp(t, {
    control: freshControl,
    server: { ...freshServer, build: undefined },
  });
  assert.throws(
    () => verifyPackagedVersions(app, { version: APP, build: STAMP }),
    /packaged server.*reports 1\.0\.202611030100 \(build none\)/,
  );
});

test("a server on a different version than the pinned release is refused", (t) => {
  const app = packagedApp(t, {
    control: freshControl,
    server: { ...freshServer, version: "1.0.2222", build: "2222" },
  });
  assert.throws(
    () => verifyPackagedVersions(app, { version: APP, build: STAMP }),
    /packaged server.*disagrees with its own release/,
  );
});

test("a missing or unreadable bundle member is refused, not read as agreement", (t) => {
  const noControl = packagedApp(t, { control: null, server: freshServer });
  assert.throws(
    () => verifyPackagedVersions(noControl, { version: APP, build: STAMP }),
    /unknown release version or build/,
  );
  const noServer = packagedApp(t, { control: freshControl, server: null });
  assert.throws(
    () => verifyPackagedVersions(noServer, { version: APP, build: STAMP }),
    /missing or invalid build-identity\.json/,
  );
});

test("a malformed expected release is refused before anything is read", (t) => {
  const app = packagedApp(t, { control: freshControl, server: freshServer });
  assert.throws(() => verifyPackagedVersions(app, { version: "0.1", build: STAMP }), /not an x\.y\.z version/);
  assert.throws(() => verifyPackagedVersions(app, { version: APP, build: "" }), /not a number/);
});

test("the CLI passes a consistent set and refuses a stale one", (t) => {
  const script = fileURLToPath(new URL("./verify-packaged-versions.mjs", import.meta.url));
  const good = packagedApp(t, { control: freshControl, server: freshServer });
  const out = execFileSync(process.execPath, [script, good, "--version", APP, "--build", STAMP], {
    encoding: "utf8",
  });
  assert.match(out, /Control bundle and server agree with the pinned release/);
  const stale = packagedApp(t, {
    control: { version: "1.0.2222", build: "2222" },
    server: freshServer,
  });
  assert.throws(
    () => execFileSync(process.execPath, [script, stale, "--version", APP, "--build", STAMP], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
    /disagrees with its own release/,
  );
});

test("the CLI refuses a repeated version or build flag instead of last-wins", () => {
  const script = fileURLToPath(new URL("./verify-packaged-versions.mjs", import.meta.url));
  for (const flag of ["--version", "--build"]) {
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [script, "BotFleet.app", flag, "1.0.1", flag, "1.0.2"],
          { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
        ),
      new RegExp(`duplicate ${flag}`),
    );
  }
});

test("the CLI refuses a flag where a value belongs", () => {
  const script = fileURLToPath(new URL("./verify-packaged-versions.mjs", import.meta.url));
  assert.throws(
    () =>
      execFileSync(process.execPath, [script, "BotFleet.app", "--version", "--build", STAMP], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /missing value for --version/,
  );
});
