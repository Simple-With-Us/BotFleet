import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

test("ios-ship.yml targets botfleet / ios on GitHub-hosted macos-latest", () => {
  const yml = read(".github/workflows/ios-ship.yml");
  const wrapper = read("scripts/ios-ship-testflight.sh");
  const prepare = read("scripts/ios-appstore-gm-prepare.sh");

  assert.match(yml, /ios\/\*\*/);
  assert.match(yml, /--path-prefix 'ios\/'/);
  assert.match(yml, /scripts\/ios-fleet\/\*\*/);
  assert.match(yml, /runs-on:\s*macos-latest/);
  assert.doesNotMatch(yml, /runs-on:\s*\[self-hosted/);
  assert.match(yml, /DEVELOPER_DIR:\s*\/Applications\/Xcode\.app\/Contents\/Developer/);
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
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER:\s*app\.botfleet/);
  assert.match(project, /MARKETING_VERSION:\s*"1\.0\.\d+"/);
  assert.match(project, /CODE_SIGN_STYLE:\s*Automatic/);

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

test("vendored ios-fleet ships app.botfleet on the 1.0.N train", () => {
  const apps = JSON.parse(read("scripts/ios-fleet/apps.json"));
  const botfleet = apps.apps.botfleet;
  assert.equal(apps.teamId, "CC8UTF7ATG");
  assert.equal(botfleet.bundleId, "app.botfleet");
  assert.equal(botfleet.scheme, "BotFleet");
  assert.equal(botfleet.appleId, 6806379515);
  assert.equal(botfleet.xcodegenDir, "ios");
  assert.match(botfleet.marketingVersionDefault, /^1\.0\.\d+$/);
  assert.deepEqual(botfleet.extraBundleIds, ["app.botfleet.widgets"]);
  assert.equal(Object.keys(apps.apps).join(","), "botfleet");

  const ship = read("scripts/ios-fleet/ship-testflight.sh");
  assert.match(ship, /MARKETING_VERSION\s+= 1\.0\.<seq>/);
  assert.match(ship, /CURRENT_PROJECT_VERSION = <UTC YYYYMMDDHHMM>/);
  assert.match(ship, /botfleet/);
  assert.match(ship, /DEFAULT_MIN_INTERVAL_SEC=3600/);
  assert.match(ship, /FORCE_SHIP=0/);
  assert.match(ship, /CODE_SIGN_STYLE=Automatic/);
  assert.match(ship, /date -u \+%Y%m%d%H%M/);
  assert.match(ship, /-allowProvisioningUpdates/);
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
