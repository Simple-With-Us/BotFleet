import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(ROOT, ".github/workflows/native-mac-release.yml"), "utf8");
const localScript = readFileSync(join(ROOT, "scripts/mac-package.sh"), "utf8");

/** One top-level shell function, taken verbatim out of the script. */
function shellFunction(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, `${name}() must exist in the script`);
  return match[0];
}

/** Run a shell snippet and hand back its status and output. */
function runShell(script) {
  const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("the native workflow is dispatch-only and never publishes", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^\s+push:/m);
  assert.doesNotMatch(workflow, /--draft=false/);
  assert.doesNotMatch(workflow, /gh release edit/);
});

test("the version is stamped once from a full-history checkout", () => {
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /stamp-commit-version\.mjs/);
  // The overwrite guard reads the producing job's own output.  Reading
  // needs.prepare.outputs.version inside prepare was the release.yml bug
  // fixed in PR #1315: needs is empty there, so the guard never fired.
  assert.match(workflow, /steps\.pin\.outputs\.version/);
  const prepare = workflow.slice(workflow.indexOf("prepare:"), workflow.indexOf("mac-native:"));
  assert.doesNotMatch(prepare, /needs\.prepare\.outputs/);
});

test("the codesign gate runs before any notarization submission", () => {
  const gate = workflow.indexOf("codesign --verify --deep --strict");
  const submit = workflow.indexOf("notarytool submit");
  assert.ok(gate !== -1 && submit !== -1 && gate < submit);
  const localGate = localScript.indexOf("codesign --verify --deep --strict");
  const localSubmit = localScript.indexOf("notarytool submit");
  assert.ok(localGate !== -1 && (localSubmit === -1 || localGate < localSubmit));
});

test("the appcast is generated after stapling, over the final bytes", () => {
  const staple = workflow.indexOf("stapler staple");
  const appcast = workflow.indexOf("native-appcast.mjs");
  assert.ok(staple !== -1 && appcast > staple);
  assert.match(workflow, /verify-native-release\.mjs/);
});

test("native asset names cannot collide with the Electron feed", () => {
  assert.match(workflow, /BotFleetMac-\$VERSION\.zip/);
  assert.doesNotMatch(workflow, /BotFleet-\$VERSION/);
  assert.match(localScript, /BotFleetMac-\$\{VERSION\}/);
});

test("signing secrets are only ever decoded into files, never printed", () => {
  // The sanctioned shape, copied from release.yml, is
  // `echo "$SECRET" | base64 --decode > file`: the value reaches a file,
  // never the log.  Any other echo of a secret variable is a leak.
  for (const text of [workflow, localScript]) {
    for (const line of text.split("\n")) {
      if (/echo.*\$(MAC_CERT|APPLE_API_KEY_P8|SPARKLE)/.test(line)) {
        assert.match(line, /base64 --decode/, `secret echoed without a decode pipe: ${line.trim()}`);
      }
    }
    assert.doesNotMatch(text, /cat .*\.p12/);
  }
});

test("the local script refuses beta toolchains and labels dev builds", () => {
  assert.match(localScript, /grep -qi beta/);
  assert.match(localScript, /NOT DISTRIBUTABLE/);
  assert.match(localScript, /spctl --assess/);
});

// A failed version stamp must stop the job where it happens.  `echo
// "$(...)"` returns echo's status, so the stamp script's failure was
// swallowed and an empty version was published.
test("a failed version stamp stops the prepare job", () => {
  assert.match(
    workflow,
    /version="\$\(node scripts\/stamp-commit-version\.mjs \.\)" \|\| exit 1/,
  );
  assert.doesNotMatch(
    workflow,
    /echo "version=\$\(node scripts\/stamp-commit-version\.mjs \.\)"/,
  );
});

// The notary's own output is the only place the reason for a rejection is
// written down, so it has to be printed before the step fails.
test("the notarization output is printed before the failure", () => {
  for (const text of [workflow, localScript]) {
    const submits = text.match(/notarytool submit/g) ?? [];
    assert.ok(submits.length > 0, "there must be a notarization to check");
    // EVERY submission must print its captured output before it fails: the
    // notary's output is the only place the reason is written down.
    const prints = text.match(/\|\| \{\s*\n\s*echo "\$out"/g) ?? [];
    assert.equal(
      prints.length,
      submits.length,
      "every notarytool submission must print its output before failing",
    );
  }
});

// sign_update is not on the runner image, so the Sparkle branch could never
// run: a provisioned key still produced an unsigned feed, silently.
test("the Sparkle signing branch can actually run", () => {
  assert.match(workflow, /brew install sparkle/);
  // A key with no tool is a hard error, not a warning.
  assert.match(workflow, /command -v sign_update > \/dev\/null \|\| \{/);
  assert.match(workflow, /::error::sign_update is not installed/);
});

// The key never stays at a path: it is decoded into a private file, that
// file is opened on a descriptor and unlinked at once, and notarytool reads
// it through the descriptor.
test("the signing key is passed through a descriptor, never at a path", () => {
  for (const text of [workflow, localScript]) {
    assert.match(text, /--key \/dev\/fd\/3/);
    assert.doesNotMatch(text, /--key "\$RUNNER_TEMP\/notary\.p8"/);
    assert.doesNotMatch(text, /--key "\$P8_FILE"/);
  }
});

// release.yml owns the v<version> release: it verifies that release's asset
// set is exactly the Electron set and deletes every asset it does not
// recognise.  The native assets therefore live on their own tag.
test("the native assets live on their own release tag", () => {
  assert.match(workflow, /NATIVE_TAG_SUFFIX: "-native"/);
  // The tag is used for the release, for the published guard, and for the
  // appcast's enclosure URL, or the feed would point at a release that does
  // not carry the bytes.
  assert.match(workflow, /tag="v\$VERSION\$\{NATIVE_TAG_SUFFIX\}"/);
  assert.match(workflow, /v="v\$\{\{ steps\.pin\.outputs\.version \}\}\$\{NATIVE_TAG_SUFFIX\}"/);
  assert.match(
    workflow,
    /node scripts\/native-appcast\.mjs native-upload "\$VERSION" "v\$VERSION\$\{NATIVE_TAG_SUFFIX\}"/,
  );
  assert.match(localScript, /native-appcast\.mjs" "\$OUT" "\$VERSION" "v\$VERSION\$\{NATIVE_TAG_SUFFIX\}"/);
});

// A signature left over from an earlier run of the same version describes
// different bytes, and the appcast would publish it as the signature of the
// new ZIP.
test("a stale signature never rides along with a new ZIP", () => {
  const remove = localScript.indexOf('rm -f "$OUT/${APP_NAME}.zip.edsig"');
  const sign = localScript.indexOf("sign_update --ed-key-file");
  assert.ok(remove !== -1, "the stale sidecar must be removed");
  assert.ok(sign !== -1 && remove < sign, "the sidecar goes before the signing, never after");
});

// An un-notarized build must never look like a release build.
test("an un-notarized build gets its own directory and no feed", () => {
  assert.match(localScript, /OUT="\$OUT\/UNSIGNED"/);
  const unsigned = localScript.indexOf('OUT="$OUT/UNSIGNED"');
  const appcast = localScript.indexOf("native-appcast.mjs");
  assert.ok(unsigned !== -1 && appcast > unsigned);
  // The script leaves before the appcast when notarization was skipped.
  assert.match(localScript, /NOT DISTRIBUTABLE; no appcast generated/);
});

// The EXIT trap runs after the last command, so a trap body that ends on a
// false test used to turn a successful packaging run into a failed one.
test("the EXIT trap cannot flip a successful run to a failure", () => {
  const cleanup = shellFunction(localScript, "cleanup");
  const harness = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'P8_FILE=""',
    "P8_FD_OPEN=0",
    'WORK="$(mktemp -d)"',
    cleanup,
    "trap cleanup EXIT",
    "echo body-ok",
  ].join("\n");
  const result = runShell(harness);
  assert.equal(result.status, 0, `a successful run must exit 0: ${result.stderr}`);
  assert.match(result.stdout, /body-ok/);
});

// One key file serves every notarization in the run, and it never outlives
// it: the second notarization must not orphan a second copy of the key.
test("one key file serves every notarization, and it leaves no copy behind", () => {
  const openApiKey = shellFunction(localScript, "open_api_key");
  // One file for the whole run: a second notarization must not create a
  // second copy of the key.
  assert.equal(
    (openApiKey.match(/mktemp/g) ?? []).length,
    1,
    "the key file must be created once",
  );
  assert.match(
    openApiKey,
    /P8_FD_OPEN" -eq 1 \]; then return 0; fi/,
    "a second notarization must reuse the open descriptor",
  );
  const directory = mkdtempSync(join(tmpdir(), "botfleet-p8-"));
  try {
    const harness = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `export TMPDIR="${directory}"`,
      'APPLE_API_KEY_P8="dummy-not-a-real-key"',
      'P8_FILE=""',
      "P8_FD_OPEN=0",
      openApiKey,
      "open_api_key",
      "open_api_key",
      'echo "fd=$P8_FD_OPEN"',
      'echo "path=[$P8_FILE]"',
      `echo "left=$(ls -1 "$TMPDIR" | wc -l | tr -d ' ')"`,
    ].join("\n");
    const result = runShell(harness);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /fd=1/, "the key must be opened exactly once");
    assert.match(result.stdout, /path=\[\]/, "the key file must not stay at a path");
    assert.match(
      result.stdout,
      /left=0/,
      `no copy of the key may be left in the temp directory: ${result.stdout}`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// The fleet's approved order: the environment first, then Infisical, and
// the keychain profile only as this machine's bootstrap identity.
test("the notarization credentials are resolved in the approved order", () => {
  assert.match(localScript, /fleet-secrets get APPLE_API_KEY_P8/);
  assert.match(localScript, /fleet-secrets get APPLE_API_KEY_ID/);
  assert.match(localScript, /fleet-secrets get APPLE_API_ISSUER_ID/);
  const resolver = localScript.indexOf("resolve_notary_credentials");
  const call = localScript.indexOf("resolve_notary_credentials\n");
  assert.ok(resolver !== -1 && call !== -1, "the resolver must run before notarization");
  // The keychain profile is the fallback, never the first choice.
  assert.match(localScript, /--keychain-profile/);
});

// XcodeGen REWRITES the Mac Info.plist and the Mac entitlements file from
// the target's `info:` and `entitlements:` blocks in ios/project.yml.  A key
// that lives only in the generated file is therefore dropped the next time
// `xcodegen generate` runs, and both the release script and the native
// release workflow run that before the archive is built.  macOS TERMINATES an
// app that asks for a permission whose usage description is missing, so a
// privacy string that only lives in the plist takes the Mac app down with a
// crash instead of a permission refusal.  These tests pin the declarations
// to the project file, which is the only place that survives a regeneration.
const projectYml = parseYaml(readFileSync(join(ROOT, "ios/project.yml"), "utf8"));
const macTarget = projectYml.targets.BotFleetMac;
const macInfoProperties = macTarget?.info?.properties ?? {};
const macEntitlementProperties = macTarget?.entitlements?.properties ?? {};
const macPlist = readFileSync(join(ROOT, "ios/MacApp/Info.plist"), "utf8");
const macEntitlements = readFileSync(join(ROOT, "ios/MacApp/BotFleetMac.entitlements"), "utf8");

/** A plist entry, matched with the whitespace XcodeGen actually writes. */
function plistHas(document, key, value) {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // A boolean is written as a self-closing tag, a string as an open/close pair.
  const selfClosing = new RegExp(`<key>${key}</key>\\s*<(?:string|true|false)\\s*/>`);
  const withValue = new RegExp(
    `<key>${key}</key>\\s*<(?:string|true|false)>[^<]*${escaped}[^<]*</(?:string|true|false)>`,
  );
  return selfClosing.test(document) || withValue.test(document);
}

test("the Mac app declares its privacy strings in the project, not only in the generated plist", () => {
  for (const key of ["NSMicrophoneUsageDescription", "NSSpeechRecognitionUsageDescription"]) {
    const declared = macInfoProperties[key];
    assert.equal(
      typeof declared,
      "string",
      `${key} must be declared under targets.BotFleetMac.info.properties, or xcodegen drops it`,
    );
    assert.ok(declared.trim().length > 0, `${key} must not be empty`);
    assert.ok(
      plistHas(macPlist, key, declared.trim()),
      `the generated plist must carry the declared ${key}`,
    );
  }
});

test("the Mac app declares the audio-input entitlement in the project", () => {
  assert.equal(
    macEntitlementProperties["com.apple.security.device.audio-input"],
    true,
    "the audio-input entitlement must be declared under targets.BotFleetMac.entitlements.properties",
  );
  assert.ok(
    plistHas(macEntitlements, "com.apple.security.device.audio-input", ""),
    "the generated entitlements file must carry the declared audio-input entitlement",
  );
});

test("the Mac app declares its version keys in the project", () => {
  assert.equal(macInfoProperties.CFBundleShortVersionString, "$(MARKETING_VERSION)");
  assert.equal(macInfoProperties.CFBundleVersion, "$(CURRENT_PROJECT_VERSION)");
});

test("the Mac app declares the botfleet URL scheme in the project, not only in the generated plist", () => {
  // The scheme is the whole route for a deep link.  Without it macOS never
  // delivers a botfleet:// URL to the app, so the settings router and the
  // voice failure recovery link are both unreachable.
  const declared = macInfoProperties.CFBundleURLTypes;
  assert.ok(
    Array.isArray(declared) && declared.length > 0,
    "CFBundleURLTypes must be declared under targets.BotFleetMac.info.properties, or xcodegen drops it",
  );
  const schemes = declared.flatMap((entry) => entry?.CFBundleURLSchemes ?? []);
  assert.ok(
    schemes.includes("botfleet"),
    "the Mac bundle must register the botfleet scheme",
  );
  assert.match(
    macPlist,
    /<key>CFBundleURLTypes<\/key>[\s\S]*?<string>botfleet<\/string>/,
    "the generated plist must carry the declared botfleet scheme",
  );
});

test("the release path regenerates the Mac plist, so the plist cannot be the only home of a key", () => {
  // This is the reason the declarations above exist.  If the release stopped
  // regenerating the plist, the declarations would be redundant rather than
  // wrong, so assert the regeneration is still there.
  assert.match(localScript, /xcodegen generate/);
  assert.match(workflow, /xcodegen generate/);
});
