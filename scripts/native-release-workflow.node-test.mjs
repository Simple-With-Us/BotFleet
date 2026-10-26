import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(ROOT, ".github/workflows/native-mac-release.yml"), "utf8");
const localScript = readFileSync(join(ROOT, "scripts/mac-package.sh"), "utf8");
const exportOptions = readFileSync(join(ROOT, "ios/ExportOptions-DeveloperID.plist"), "utf8");
const projectYml = readFileSync(join(ROOT, "ios/project.yml"), "utf8");

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

test("no secret is expanded into a command line", () => {
  // A traced run prints the command line, so a secret that reaches argv is
  // a secret in the log.  The here-string expands in the shell instead.
  for (const text of [workflow, localScript]) {
    assert.doesNotMatch(
      text,
      /echo "\$\{?(MAC_CERT_P12_BASE64|MAC_CERT_PASSWORD|APPLE_API_KEY_P8|SPARKLE_EDDSA_PRIVATE_KEY_B64)/,
    );
    assert.doesNotMatch(text, /printf '%s' "\$APPLE_API_KEY_P8/);
    // The Keychain is not an approved source for a provider credential.
    assert.doesNotMatch(text, /--keychain-profile/);
    assert.doesNotMatch(text, /NOTARY_PROFILE/);
  }
  assert.match(workflow, /base64 --decode <<< "\$APPLE_API_KEY_P8_BASE64"/);
  assert.match(workflow, /base64 --decode <<< "\$MAC_CERT_P12_BASE64"/);
  // The Sparkle key goes straight into sign_update's stdin: it never
  // touches the filesystem.
  assert.match(workflow, /sign_update --ed-key-file - "\$zip"/);
  assert.doesNotMatch(workflow, /sparkle-ed-key/);
  assert.match(localScript, /cat > "\$P8_FILE" <<< "\$APPLE_API_KEY_P8"/);
});

test("the native release reads Infisical with its own read-only service token", () => {
  // The shared action authenticates with a machine identity that has the
  // whole project; this app gets a token scoped to prod:/ instead.
  assert.match(workflow, /INFISICAL_NATIVE_RELEASE_READ_TOKEN/);
  assert.doesNotMatch(workflow, /INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/);
  assert.doesNotMatch(workflow, /uses: \.\/\.github\/actions\/infisical-secrets/);
  assert.match(workflow, /Authorization: Bearer \$\{INFISICAL_TOKEN\}/);
  assert.match(workflow, /data-urlencode "secretPath=\/"/);
  assert.match(workflow, /data-urlencode "environment=prod"/);
  // The values are masked before they reach GITHUB_ENV.
  assert.match(workflow, /::add-mask::/);
});

test("the local script reads the notary credentials from Infisical by their vault names", () => {
  // The vault holds the key base64-encoded as APPLE_API_KEY_P8_BASE64; the
  // PEM is what notarytool needs.
  assert.match(localScript, /infisical secrets get "\$name"/);
  assert.match(localScript, /APPLE_API_KEY_P8_BASE64/);
  assert.match(localScript, /base64 --decode <<< "\$APPLE_API_KEY_P8_BASE64" > "\$P8_FILE"/);
  assert.doesNotMatch(localScript, /fleet-secrets get APPLE_API/);
});

test("the bundle name is the one the target actually builds", () => {
  // PRODUCT_NAME defaults to the target name, so the export is
  // BotFleetMac.app; a gate that looked for BotFleet.app could never pass.
  assert.match(workflow, /export\/BotFleetMac\.app/);
  assert.doesNotMatch(workflow, /export\/BotFleet\.app/);
  assert.match(localScript, /export\/BotFleetMac\.app/);
  assert.doesNotMatch(localScript, /export\/BotFleet\.app/);
});

test("a failed version stamp fails the prepare job instead of publishing an empty version", () => {
  assert.match(
    workflow,
    /version="\$\(node scripts\/stamp-commit-version\.mjs \.\)" \|\| exit 1/,
  );
  assert.doesNotMatch(
    workflow,
    /echo "version=\$\(node scripts\/stamp-commit-version\.mjs \.\)"/,
  );
});

test("a rejected notarization prints the notary's own diagnostic before failing", () => {
  // A command substitution's status becomes the assignment's status, so a
  // bare assignment would exit before the captured output is ever printed.
  assert.match(workflow, /if ! out=\$\(xcrun notarytool submit/);
  assert.match(localScript, /if ! out="\$\(xcrun notarytool submit/);
  assert.match(workflow, /::error::notarization failed for the app ZIP/);
  assert.match(workflow, /::error::notarization failed for the DMG/);
});

test("sign_update is installed, and a provisioned key without the tool fails the job", () => {
  assert.match(workflow, /sparkle-project\/Sparkle\/releases\/download/);
  assert.match(workflow, /shasum -a 256 -c -/);
  assert.match(workflow, /command -v sign_update > \/dev\/null \|\| \{/);
  assert.match(workflow, /::error::sign_update is not installed/);
});

test("the native assets live on their own release, never on the Electron one", () => {
  // release.yml asserts that v<version> carries exactly the Electron asset
  // set and deletes everything else it finds there, so the native set needs
  // its own tag.
  assert.match(workflow, /tag="native-v\$VERSION"/);
  assert.match(workflow, /native-v\$\{\{ steps\.pin\.outputs\.version \}\}/);
  assert.match(workflow, /native-appcast\.mjs native-upload "\$VERSION" "native-v\$VERSION"/);
  assert.doesNotMatch(workflow, /tag="v\$VERSION"/);
});

test("the local script keeps un-notarized bytes out of the release directory", () => {
  assert.match(localScript, /OUT="\$OUT\/UNSIGNED"/);
  assert.match(localScript, /rm -f .*"\$OUT\/\$\{APP_NAME\}\.zip\.edsig"/);
  assert.match(localScript, /no appcast was generated/);
});

test("the exit trap cannot flip a successful run's status", () => {
  const cleanup = localScript.slice(
    localScript.indexOf("cleanup() {"),
    localScript.indexOf("trap cleanup EXIT"),
  );
  assert.match(cleanup, /return 0/);
  assert.doesNotMatch(cleanup, /\[ -n "\$P8_FILE"\] &&/);
});

test("the manual export names the signing certificate", () => {
  assert.match(
    exportOptions,
    /<key>signingCertificate<\/key>\s*<string>Developer ID Application<\/string>/,
  );
});

test("xcodegen cannot reset the shipped bundle version", () => {
  // xcodegen rewrites the generated plist, so the version keys have to be
  // declared in the project or they reset to 1.0 and 1.
  const macTarget = projectYml.slice(
    projectYml.indexOf("  BotFleetMac:"),
    projectYml.indexOf("schemes:"),
  );
  assert.match(macTarget, /CFBundleShortVersionString: \$\(MARKETING_VERSION\)/);
  assert.match(macTarget, /CFBundleVersion: \$\(CURRENT_PROJECT_VERSION\)/);
});

test("the local script refuses beta toolchains and labels dev builds", () => {
  assert.match(localScript, /grep -qi beta/);
  assert.match(localScript, /NOT DISTRIBUTABLE/);
  assert.match(localScript, /spctl --assess/);
});
