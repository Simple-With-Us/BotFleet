import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

test("ios-ship.yml targets botfleet / ios on the GitHub-hosted xcode-27 image", () => {
  const yml = read(".github/workflows/ios-ship.yml");
  const wrapper = read("scripts/ios-ship-testflight.sh");
  const prepare = read("scripts/ios-appstore-gm-prepare.sh");

  assert.match(yml, /ios\/\*\*/);
  assert.match(yml, /--path-prefix 'ios\/'/);
  assert.match(yml, /scripts\/ios-fleet\/\*\*/);
  assert.match(yml, /runs-on:\s*xcode-27\s*$/m);
  assert.doesNotMatch(yml, /runs-on:\s*macos-latest/);
  assert.doesNotMatch(yml, /runs-on:\s*\[self-hosted/);
  assert.match(yml, /DEVELOPER_DIR:\s*\/Applications\/Xcode_27\.0\.app\/Contents\/Developer/);
  assert.match(yml, /bash scripts\/ios-assert-xcode\.sh 27\.0/);
  // Standing TestFlight testers: emails only from the secret, never a red ship.
  assert.match(yml, /name: Sync standing TestFlight testers/);
  assert.match(yml, /ASC_STANDING_TESTERS:\s*\$\{\{\s*secrets\.ASC_STANDING_TESTERS\s*\}\}/);
  assert.match(yml, /ensure-standing-testers "\$appleid"/);
  assert.match(yml, /::add-mask::/);
  const syncStep = yml.slice(yml.indexOf("name: Sync standing TestFlight testers"));
  assert.match(syncStep, /continue-on-error:\s*true/);
  assert.match(read("scripts/ios-fleet/asc-api.mjs"), /method === "ensure-standing-testers"/);
  assert.match(read("scripts/ios-fleet/ship-testflight.sh"), /sentry_redact/);
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /\|\| 'xcode-27' \}\}/);
  assert.match(ci, /DEVELOPER_DIR:\s*\/Applications\/Xcode_27\.0\.app\/Contents\/Developer/);
  assert.match(yml, /fetch-depth:\s*0/);
  assert.match(yml, /cancel-in-progress:\s*false/);
  assert.match(yml, /github\.event\.repository\.fork == false/);
  assert.match(yml, /bash scripts\/ios-ship-testflight\.sh/);
  assert.doesNotMatch(yml, /--force-ship/);
  assert.match(yml, /ios-appstore-gm-prepare\.sh/);
  // Signing material comes from Infisical prod, through the shared
  // composite action; identity stays on GitHub.
  assert.match(yml, /Load Infisical signing secrets/);
  assert.match(yml, /secrets\.INFISICAL_PROJECT_ID/);
  assert.match(yml, /secrets\.INFISICAL_UNIVERSAL_AUTH_CLIENT_ID/);
  assert.match(yml, /secrets\.INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET/);
  assert.match(yml, /uses:\s*\.\/\.github\/actions\/infisical-secrets/);
  assert.match(yml, /APPLE_API_KEY_ID/);
  assert.match(yml, /IOS_CERT_P12_BASE64/);
  // SENTRY_DSN and SENTRY_AUTH_TOKEN come from Infisical prod at ship time,
  // with the GitHub secret as a synced fallback read from step env -- never
  // a job-level `secrets.SENTRY_DSN`, which is re-applied per step and
  // would fight the later GITHUB_ENV write. The actual warning text now
  // lives in scripts/infisical-fetch.mjs (asserted below), not the yml.
  assert.match(yml, /GH_FALLBACK_SENTRY_DSN/);
  assert.match(yml, /GH_FALLBACK_SENTRY_AUTH_TOKEN/);
  assert.doesNotMatch(yml, /^\s*SENTRY_DSN:\s*\$\{\{\s*secrets\.SENTRY_DSN\s*\}\}\s*$/m);
  assert.doesNotMatch(yml, /^\s*SENTRY_AUTH_TOKEN:\s*\$\{\{\s*secrets\.SENTRY_AUTH_TOKEN\s*\}\}\s*$/m);
  assert.doesNotMatch(yml, /secrets\.APPLE_API_KEY_ID/);
  assert.doesNotMatch(yml, /secrets\.APPLE_API_ISSUER_ID/);
  assert.doesNotMatch(yml, /secrets\.APPLE_API_KEY_P8_BASE64/);
  assert.doesNotMatch(yml, /secrets\.IOS_CERT_P12_BASE64/);
  assert.doesNotMatch(yml, /secrets\.IOS_CERT_PASSWORD/);
  assert.doesNotMatch(yml, /secrets\.ASC_KEY_ID/);
  assert.doesNotMatch(yml, /if:.*secrets\./);
  assert.match(yml, /cron:\s*'18,48 \* \* \* \*'/);
  assert.match(yml, /workflow_dispatch/);
  assert.match(yml, /xcodegen/);
  assert.doesNotMatch(yml, /ios-v\*/);
  assert.doesNotMatch(yml, /extra-ship/);
  assert.doesNotMatch(yml, /CloudAgent/);
  assert.doesNotMatch(yml, /Composer/);
  assert.doesNotMatch(yml, /IOS_PROVISIONING_PROFILE/);
  assert.doesNotMatch(yml, /--allow-dirty/);
  assert.doesNotMatch(yml, /--allow-unverified-seq/);
  assert.doesNotMatch(yml, /--version /);
  assert.doesNotMatch(yml, /--build /);

  // CI invokes the complete package test chain; ci-change-scope checks that
  // workflow contract.  Keep this ship contract included in the same chain.
  const testChain = JSON.parse(read("package.json")).scripts.test.split("&&").map((part) => part.trim());
  assert.ok(testChain.includes("pnpm test:ios-ship"));

  const project = read("ios/project.yml");
  assert.match(project, /DEVELOPMENT_TEAM:\s*CC8UTF7ATG/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER:\s*app\.botfleet\.ios/);
  assert.match(project, /MARKETING_VERSION:\s*"1\.0\.\d+"/);
  assert.match(project, /configs:\s*\n\s*Release:\s*\n\s*CODE_SIGN_STYLE:\s*Manual/);
  assert.match(project, /PROVISIONING_PROFILE_SPECIFIER:\s*"BotFleet iOS App Store \(API\)"/);
  assert.match(project, /PROVISIONING_PROFILE_SPECIFIER:\s*"BotFleet Widgets App Store \(API\)"/);
  assert.match(project, /INFOPLIST_KEY_CFBundleDisplayName:\s*BotFleet\r?\n/);
  assert.match(project, /INFOPLIST_KEY_CFBundleDisplayName:\s*BotFleet Widgets/);
  assert.match(yml, /IOS_MANUAL_SIGN:\s*"1"/);
  assert.match(yml, /scripts\/ios-install-appstore-profiles\.sh/);
  assert.match(project, /projectFormat:\s*xcode16_3/);
  assert.match(project, /xcodeVersion:\s*'27\.0'/);
  assert.match(project, /postGenCommand:\s*bash \.\.\/scripts\/ios-xcodegen-post\.sh/);
  assert.match(project, /IPHONEOS_DEPLOYMENT_TARGET:\s*'27\.0'/);
  assert.match(project, /INFOPLIST_KEY_LSApplicationCategoryType:\s*public\.app-category\.developer-tools/);
  // The shipped category is info.properties (XcodeGen writes App/Info.plist);
  // INFOPLIST_KEY_* only mirrors it for Xcode's General > App Category picker.
  assert.match(project, /^\s+LSApplicationCategoryType:\s*public\.app-category\.developer-tools\s*$/m);
  assert.match(read("scripts/ios-xcodegen-post.sh"), /objectVersion = 100/);
  assert.match(read("scripts/ios-xcodegen-post.sh"), /Xcode 27\.0/);

  assert.match(wrapper, /scripts\/ios-fleet\/ship-testflight\.sh/);
  assert.match(wrapper, /IN_REPO="\$\{ROOT\}\/scripts\/ios-fleet\/ship-testflight\.sh"/);
  assert.match(wrapper, /if \[\[ -f "\$IN_REPO" \]\]/);
  assert.match(wrapper, /exec bash "\$IN_REPO" botfleet --repo-root "\$ROOT"/);
  assert.match(wrapper, /botfleet --repo-root/);
  assert.doesNotMatch(wrapper, /--force-ship/);

  assert.match(prepare, /APPLE_API_KEY_P8_BASE64/);
  assert.match(prepare, /IOS_CERT_P12_BASE64/);
  assert.doesNotMatch(prepare, /echo "\$ASC_KEY_P8"/);
  assert.doesNotMatch(prepare, /echo "\$APPLE_API_KEY_P8/);
  assert.doesNotMatch(prepare, /echo "\$IOS_DIST_P12/);
  assert.doesNotMatch(prepare, /echo "\$IOS_CERT_P12/);
});

test("the shared Infisical action masks every value, warns rather than fails on a non-required empty name, and never prints one", () => {
  const action = read(".github/actions/infisical-secrets/action.yml");
  const fetcher = read("scripts/infisical-fetch.mjs");

  assert.match(action, /Fetch named secrets from Infisical/);
  assert.match(action, /run:\s*node "\$GITHUB_ACTION_PATH\/\.\.\/\.\.\/\.\.\/scripts\/infisical-fetch\.mjs"/);

  // Every resolved value (Infisical or GH_FALLBACK_<NAME>) is masked before
  // anything else touches it.
  assert.match(fetcher, /::add-mask::\$\{line\}/);
  // A name missing everywhere warns by default -- required is the only
  // path that fails the job, and it fails by throwing (a non-zero exit at
  // the CLI entry point), never a silent skip.
  assert.match(fetcher, /::warning::\$\{message\}/);
  assert.match(fetcher, /::error::\$\{message\}/);
  assert.match(fetcher, /is empty after the Infisical \$\{environment\} export and the GitHub secret fallback/);
  assert.match(fetcher, /required\.has\(name\)/);
  assert.match(fetcher, /Missing required Infisical name\(s\)/);
  // Never string-interpolate the login body -- a client secret containing
  // a quote must not be able to reshape the request.
  assert.match(fetcher, /JSON\.stringify\(\{\s*clientId,\s*clientSecret\s*\}\)/);
});

test("retired ios-testflight.yml is gone so hosted ships do not double-upload", () => {
  let existed = false;
  try {
    read(".github/workflows/ios-testflight.yml");
    existed = true;
  } catch (err) {
    assert.equal(err.code, "ENOENT");
  }
  assert.equal(existed, false);
});

test("vendored ios-fleet ships app.botfleet.ios on the 1.0.N train", () => {
  const apps = JSON.parse(read("scripts/ios-fleet/apps.json"));
  const botfleet = apps.apps.botfleet;
  assert.equal(apps.teamId, "CC8UTF7ATG");
  assert.equal(botfleet.bundleId, "app.botfleet.ios");
  assert.equal(botfleet.scheme, "BotFleet");
  assert.equal(botfleet.appleId, 6820175685);
  assert.equal(botfleet.xcodegenDir, "ios");
  assert.match(botfleet.marketingVersionDefault, /^1\.0\.\d+$/);
  assert.deepEqual(botfleet.extraBundleIds, ["app.botfleet.ios.widgets"]);
  assert.equal(Object.keys(apps.apps).join(","), "botfleet");

  const ship = read("scripts/ios-fleet/ship-testflight.sh");
  assert.match(ship, /MARKETING_VERSION\s+= 1\.0\.<seq>/);
  assert.match(ship, /CURRENT_PROJECT_VERSION = <UTC YYYYMMDDHHMM>/);
  assert.match(ship, /botfleet/);
  assert.match(ship, /DEFAULT_MIN_INTERVAL_SEC=3600/);
  assert.match(ship, /FORCE_SHIP=0/);
  assert.match(ship, /MANUAL_SIGN/);
  assert.match(ship, /ios-install-appstore-profiles\.sh/);
  assert.match(ship, /write_manual_export_plists/);
  assert.match(ship, /date -u \+%Y%m%d%H%M/);
  assert.match(ship, /-allowProvisioningUpdates/);

  const profileMap = JSON.parse(read("ios/appstore-profiles.json"));
  assert.deepEqual(profileMap, {
    "app.botfleet.ios": "BotFleet iOS App Store (API)",
    "app.botfleet.ios.widgets": "BotFleet Widgets App Store (API)",
  });

  const installer = read("scripts/ios-install-appstore-profiles.sh");
  assert.match(installer, /ensure-appstore-profiles/);
  assert.match(installer, /com\.apple\.security\.application-groups/);
  assert.match(installer, /IOS_REQUIRED_APP_GROUP/);

  const asc = read("scripts/ios-fleet/asc-api.mjs");
  assert.match(asc, /ensure-appstore-profiles/);
});

test("ship-testflight.sh --help lists botfleet and the case accepts it", () => {
  // Git bash on windows-latest may exist while /usr/bin/python3 does not.
  if (process.platform === "win32") return;
  const script = join(ROOT, "scripts/ios-fleet/ship-testflight.sh");
  const bash = spawnSync("bash", [script, "--help"], { encoding: "utf8" });
  if (bash.error && bash.error.code === "ENOENT") {
    return;
  }
  assert.equal(bash.status, 2);
  assert.match(bash.stdout, /botfleet/);
  assert.doesNotMatch(bash.stderr, /unknown arg: botfleet/);

  const accepted = spawnSync("bash", [script, "botfleet", "--help"], {
    encoding: "utf8",
  });
  assert.equal(accepted.status, 2);
  assert.doesNotMatch(accepted.stderr, /unknown arg: botfleet/);
  assert.match(accepted.stdout, /botfleet/);

  const rejected = spawnSync("bash", [script, "not-an-app"], {
    encoding: "utf8",
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /unknown app key or incomplete registry: not-an-app/);
});

test("scheduled-ship-gate skips empty last-ship on schedule", () => {
  if (process.platform === "win32") return;
  const script = join(ROOT, "scripts/ios-fleet/test-scheduled-ship-gate.sh");
  const run = spawnSync("bash", [script], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /scheduled-ship-gate: all tests passed/);
});

// A GitHub-hosted macos-latest runner has no ~/.secrets directory. Before
// 2026-10-02 asc-api.mjs read ONLY ~/.secrets/appstore-connect.env, so a
// runner holding a perfectly good APPLE_API_* credential in the environment
// still could not authenticate -- and ship-testflight.sh piped asc-api.mjs's
// stderr to /dev/null, so the reason never reached the run log.
test("asc-api.mjs resolves its credential from all three sources", () => {
  const asc = read("scripts/ios-fleet/asc-api.mjs");
  assert.match(asc, /function resolveCredential\(\)/);
  // Source 1: ASC_* already exported.  Source 2: the local env file.
  // Source 3: the APPLE_API_* names ios-ship.yml exports from Infisical.
  assert.match(asc, /process\.env\.ASC_KEY_ID/);
  assert.match(asc, /appstore-connect\.env/);
  assert.match(asc, /APPLE_API_KEY_P8_BASE64/);
  // The base64 p8 is materialized privately and unlinked on exit.
  assert.match(asc, /Buffer\.from\(cleaned, "base64"\)/);
  assert.match(asc, /mkdtempSync\(join\(tmpdir\(\), "asc-key-"\)\)/);
  assert.match(asc, /mode: 0o600/);
  assert.match(asc, /process\.on\("exit", cleanupTempKeys\)/);
  // Never print a value -- only the source and the key-id LENGTH.
  assert.match(asc, /key id length \$\{cred\.keyId\.length\}/);
  assert.doesNotMatch(asc, /console\.(log|error)\([^)]*privateKeyPem/);
});

test("asc-api.mjs says what it tried instead of failing on a missing file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "asc-nohome-"));
  try {
    const clean = { PATH: process.env.PATH || "", HOME: tmp };
    // No credential anywhere: name every source rather than dying on ENOENT.
    const none = spawnSync(process.execPath, [join(ROOT, "scripts/ios-fleet/asc-api.mjs"), "latest-build-seq", "app.botfleet.ios", "1.0"], {
      encoding: "utf8",
      env: clean,
    });
    assert.equal(none.status, 1);
    assert.match(none.stderr, /no App Store Connect credential found/);
    assert.match(none.stderr, /APPLE_API_KEY_P8_BASE64/);

    // APPLE_API_* present but undecodable: proves the env IS read, and says so.
    const bad = spawnSync(process.execPath, [join(ROOT, "scripts/ios-fleet/asc-api.mjs"), "latest-build-seq", "app.botfleet.ios", "1.0"], {
      encoding: "utf8",
      env: {
        ...clean,
        APPLE_API_KEY_ID: "AAAAAAAAAA",
        APPLE_API_ISSUER_ID: "00000000-0000-0000-0000-000000000000",
        APPLE_API_KEY_P8_BASE64: "bm90LWEtcGVt",
      },
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /APPLE_API_KEY_P8_BASE64 is set but did not decode to a PEM private key/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("asc_latest_seq surfaces asc-api stderr and does not require the env file", () => {
  const ship = read("scripts/ios-fleet/ship-testflight.sh");
  // The old line threw away the only diagnostic that says WHY (HTTP 401).
  assert.doesNotMatch(ship, /asc-api\.mjs" latest-build-seq[^\n]*2>\/dev\/null/);
  assert.match(ship, /2>"\$errf"/);
  assert.match(ship, /logerr "asc-seq: \$\{line\}"/);
  // A missing ~/.secrets file is no longer an automatic UNVERIFIED.
  assert.match(ship, /asc_credential_available\(\)/);
  assert.doesNotMatch(ship, /if \[\[ ! -f "\$SECRETS_ENV" \]\]; then\n\s*logerr "asc-seq: no /);
  // Cleanup must not write to the captured-value stream: an `rm` wrapper that
  // reports on stdout once turned a correct sequence into an arithmetic error.
  assert.match(ship, /rm -f "\$errf" >\/dev\/null 2>&1 \|\| true/);
});
