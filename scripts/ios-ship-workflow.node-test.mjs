import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  // Safety rails against a misconfigured secret: cap the list, reject malformed
  // entries, and never fail the ship when the appleId lookup breaks.
  assert.match(read("scripts/ios-fleet/asc-api.mjs"), /emails\.length\s*>\s*5/);
  assert.match(read("scripts/ios-fleet/asc-api.mjs"), /EMAIL_RE\s*=/);
  assert.match(syncStep, /appleid_rc/);
  // Reuse a tester stored with different letter case (create answers 409), and
  // never skip the review submission silently when buildBetaDetail can't be read.
  // The recovery helper does the app-scoped lookup, and both 409 paths (create
  // refused, or another app's record refused) go through it.
  assert.match(
    read("scripts/ios-fleet/asc-api.mjs"),
    /const recoverFromCrossApp[\s\S]*filter\[apps\]=[\s\S]*res\.status === 409[\s\S]*recoverFromCrossApp\(\)[\s\S]*res\.status === 409[\s\S]*recoverFromCrossApp\(\)/
  );
  assert.match(read("scripts/ios-fleet/asc-api.mjs"), /buildBetaDetail`\);\s*if \(!detail\.ok\)/);
  // Every group/tester/build mutation is gated on a successful tester listing.
  assert.match(read("scripts/ios-fleet/asc-api.mjs"), /if \(!inGroupRes\.ok\)/);
  assert.match(read("scripts/ios-fleet/ship-testflight.sh"), /sentry_redact/);
  // Sentry org is centralized, not triple-hardcoded: verified 2026-10-09 the
  // botfleet project lives in org simple-with-us while the vault token was
  // still scoped to the retired slug jays-services ("organization not found",
  // issue #1023).  A mismatch must name the rotation, never a secret value.
  const shipScript = read("scripts/ios-fleet/ship-testflight.sh");
  assert.match(shipScript, /sentry_org="\$\{SENTRY_ORG:-simple-with-us\}"/);
  assert.doesNotMatch(shipScript, /SENTRY_ORG=simple-with-us/);
  assert.match(shipScript, /sentry_org_mismatch_hint/);
  assert.match(shipScript, /organization not found\|embedded in token/);
  assert.match(shipScript, /mint an org token for/);
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

test("asc-api.mjs stays dependency-free: it runs from a bare directory with no node_modules", () => {
  // The hosted ios-ship workflow runs this client with plain `node` BEFORE any
  // `pnpm install`, so a package import (zod, an autofix's favorite) throws
  // ERR_MODULE_NOT_FOUND and breaks every TestFlight ship.  Running it from a
  // copy in a temp directory is the only check that cannot resolve a package
  // from this repo's node_modules.
  const src = read("scripts/ios-fleet/asc-api.mjs");
  const specs = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(specs.filter((spec) => !spec.startsWith("node:") && !spec.startsWith(".")), [], "asc-api.mjs may only import node: builtins");
  const tmp = mkdtempSync(join(tmpdir(), "asc-bare-"));
  try {
    const copy = join(tmp, "asc-api.mjs");
    writeFileSync(copy, src);
    const run = spawnSync(process.execPath, [copy, "latest-build-seq", "app.botfleet.ios", "1.0"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH || "", HOME: tmp },
    });
    assert.doesNotMatch(run.stderr, /ERR_MODULE_NOT_FOUND|Cannot find (package|module)/);
    assert.match(run.stderr, /no App Store Connect/, "must reach main() and stop on the missing key, not on an import");
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

// ---------------------------------------------------------------------------
// Internal TestFlight group (GH #1018): a new bundle ID is a new App Store
// Connect record with no groups, so 14 green ships reached no tester.  These
// tests drive the real helpers in asc-api.mjs against an in-memory fake of the
// handful of App Store Connect endpoints they use.
// ---------------------------------------------------------------------------
function fakeAsc({ groups = [], users = [], testers = [], failCreateGroup = false, usersReadable = true } = {}) {
  const state = {
    groups: groups.map((g) => ({ ...g, members: new Set(g.members || []) })),
    testers: testers.map((t) => ({ ...t })),
    calls: []
  };
  let nextId = 100;
  const ok = (data, status = 200) => ({ status, ok: true, parsed: { data }, text: "" });
  const bad = (status, code, detail) => ({ status, ok: false, parsed: { errors: [{ code, detail }] }, text: "" });
  const api = async (method, path, body) => {
    state.calls.push(`${method} ${path.split("?")[0]}`);
    const json = body ? JSON.parse(body) : null;
    if (method === "GET" && /^\/v1\/apps\/\d+\/betaGroups/.test(path)) {
      return ok(state.groups.map((g) => ({ id: g.id, type: "betaGroups", attributes: { name: g.name, isInternalGroup: g.isInternalGroup, hasAccessToAllBuilds: g.hasAccessToAllBuilds } })));
    }
    if (method === "POST" && path === "/v1/betaGroups") {
      if (failCreateGroup) return bad(409, "ENTITY_ERROR", "cannot create");
      const a = json.data.attributes;
      const g = { id: `g${nextId++}`, name: a.name, isInternalGroup: a.isInternalGroup === true, hasAccessToAllBuilds: a.hasAccessToAllBuilds === true, members: new Set(), created: a };
      state.groups.push(g);
      return ok({ id: g.id, type: "betaGroups", attributes: { name: g.name } }, 201);
    }
    if (method === "GET" && path.startsWith("/v1/users")) {
      return usersReadable ? ok(users.map((u) => ({ type: "users", id: u, attributes: { username: u } }))) : bad(403, "FORBIDDEN", "no");
    }
    let m = path.match(/^\/v1\/betaGroups\/([^/]+)\/betaTesters/);
    if (method === "GET" && m) {
      const g = state.groups.find((x) => x.id === m[1]);
      return ok([...g.members].map((e) => ({ type: "betaTesters", id: `t-${e}`, attributes: { email: e } })));
    }
    // Tester records are per app on Apple's side: an address has one record for
    // each app it was ever added to, and filter[email] alone returns them all.
    m = path.match(/^\/v1\/betaTesters\?filter\[email\]=([^&]+)(?:&filter\[apps\]=(\d+))?/);
    if (method === "GET" && m) {
      const e = decodeURIComponent(m[1]);
      const rows = state.testers.filter((t) => t.email === e && (!m[2] || t.appId === m[2]));
      return ok(rows.map((t) => ({ type: "betaTesters", id: t.id, attributes: { email: t.email } })));
    }
    m = path.match(/^\/v1\/betaGroups\/([^/]+)\/relationships\/betaTesters$/);
    if (method === "POST" && m) {
      const g = state.groups.find((x) => x.id === m[1]);
      const t = state.testers.find((x) => x.id === json.data[0].id);
      if ((t.appId || "1") !== "1") return bad(409, "STATE_ERROR", "Tester(s) cannot be assigned");
      g.members.add(t.email);
      return { status: 204, ok: true, parsed: {}, text: "" };
    }
    if (method === "POST" && path === "/v1/betaTesters") {
      const email = json.data.attributes.email;
      let rec = state.testers.find((t) => t.email === email && (t.appId || "1") === "1");
      if (!rec) {
        rec = { id: `t-${email}`, email, appId: "1" };
        state.testers.push(rec);
      }
      state.groups.find((x) => x.id === json.data.relationships.betaGroups.data[0].id).members.add(email);
      return ok({ type: "betaTesters", id: rec.id }, 201);
    }
    return bad(500, "UNEXPECTED", `${method} ${path}`);
  };
  return { api, state };
}

test("ensureInternalTesterGroup creates an all-builds internal group and adds only App Store Connect users, then is idempotent", async () => {
  const { ensureInternalTesterGroup, INTERNAL_GROUP_NAME } = await import("./ios-fleet/asc-api.mjs");
  const emails = ["alice@example.com", "bob@example.org", "carol@example.net"];
  const { api, state } = fakeAsc({
    groups: [{ id: "ext1", name: "Public Beta", isInternalGroup: false, hasAccessToAllBuilds: null, members: ["alice@example.com"] }],
    users: ["alice@example.com", "carol@example.net"],
    testers: [{ id: "t-alice@example.com", email: "alice@example.com" }]
  });
  const logs = [];
  const warns = [];
  const first = await ensureInternalTesterGroup({ api, appId: "1", emails, log: (m) => logs.push(m), warn: (m) => warns.push(m) });
  assert.equal(first.created, true);
  assert.equal(first.added, 2);
  assert.equal(first.external, 1, "bob is not an ASC user and stays external-only");
  assert.equal(first.warnings, 0);
  assert.deepEqual(warns, []);
  const group = state.groups.find((g) => g.id === first.groupId);
  assert.equal(group.name, INTERNAL_GROUP_NAME);
  assert.equal(group.isInternalGroup, true);
  assert.equal(group.hasAccessToAllBuilds, true, "the group must see every build, with no per-build assignment");
  assert.deepEqual([...group.members].sort(), ["alice@example.com", "carol@example.net"]);
  assert.equal(state.groups.find((g) => g.id === "ext1").members.size, 1, "the external group is untouched");
  assert.ok(!logs.join("\n").match(/alice|bob|carol/), `emails must be masked in logs: ${logs.join(" | ")}`);

  const callsAfterFirst = state.calls.length;
  const second = await ensureInternalTesterGroup({ api, appId: "1", emails, log: (m) => logs.push(m), warn: (m) => warns.push(m) });
  assert.equal(second.created, false);
  assert.equal(second.added, 0);
  assert.equal(second.alreadyIn, 2);
  assert.equal(state.groups.length, 2, "no duplicate group");
  assert.ok(
    state.calls.slice(callsAfterFirst).every((c) => c.startsWith("GET ")),
    "an idempotent re-run only reads"
  );
});

test("ensureInternalTesterGroup reuses an existing all-builds internal group whatever its name", async () => {
  const { ensureInternalTesterGroup } = await import("./ios-fleet/asc-api.mjs");
  const { api, state } = fakeAsc({
    groups: [{ id: "int1", name: "BotFleet Testers", isInternalGroup: true, hasAccessToAllBuilds: true, members: [] }],
    users: ["alice@example.com"],
    testers: [{ id: "t-alice@example.com", email: "alice@example.com" }]
  });
  const out = await ensureInternalTesterGroup({ api, appId: "1", emails: ["alice@example.com"], log: () => {}, warn: () => {} });
  assert.equal(out.created, false);
  assert.equal(out.groupId, "int1");
  assert.equal(out.added, 1);
  assert.ok(!state.calls.includes("POST /v1/betaGroups"), "must not create a second internal group");
});

test("ensureInternalTesterGroup warns loudly when nobody can be an internal tester, and never throws on API failure", async () => {
  const { ensureInternalTesterGroup } = await import("./ios-fleet/asc-api.mjs");
  const none = fakeAsc({ users: ["someone-else@example.com"] });
  const warns = [];
  const out = await ensureInternalTesterGroup({ api: none.api, appId: "1", emails: ["bob@example.org"], log: () => {}, warn: (m) => warns.push(m) });
  assert.equal(out.testers, 0);
  assert.ok(out.warnings >= 1);
  assert.match(warns.join("\n"), /nobody can install builds without Beta App Review/);

  const broken = fakeAsc({ failCreateGroup: true });
  const warns2 = [];
  const out2 = await ensureInternalTesterGroup({ api: broken.api, appId: "1", emails: ["bob@example.org"], log: () => {}, warn: (m) => warns2.push(m) });
  assert.equal(out2.groupId, null);
  assert.match(warns2.join("\n"), /could not create internal group.*create it by hand/);

  // An unreadable user list falls back to trying every email and letting Apple answer.
  const noUsers = fakeAsc({ usersReadable: false });
  const out3 = await ensureInternalTesterGroup({ api: noUsers.api, appId: "1", emails: ["bob@example.org"], log: () => {}, warn: () => {} });
  assert.equal(out3.added, 1);
});

test("addTesterToGroup does not attach another app's tester record to this app's group", async () => {
  const { ensureInternalTesterGroup } = await import("./ios-fleet/asc-api.mjs");
  // The first record filter[email] returns belongs to ANOTHER app; assigning it
  // here answers 409 STATE_ERROR.  This is the live failure from 2026-10-09.
  const { api, state } = fakeAsc({
    groups: [{ id: "int1", name: "Internal Testers", isInternalGroup: true, hasAccessToAllBuilds: true, members: [] }],
    users: ["alice@example.com"],
    testers: [
      { id: "t-other-app", email: "alice@example.com", appId: "9" },
      { id: "t-this-app", email: "alice@example.com", appId: "1" }
    ]
  });
  const warns = [];
  const out = await ensureInternalTesterGroup({ api, appId: "1", emails: ["alice@example.com"], log: () => {}, warn: (m) => warns.push(m) });
  assert.deepEqual(warns, []);
  assert.equal(out.added, 1);
  assert.deepEqual([...state.groups[0].members], ["alice@example.com"]);
  assert.equal(state.testers.length, 2, "reused this app's record, created nothing");
});

test("addTesterToGroup falls back to the app-scoped lookup when the create is refused", async () => {
  const { addTesterToGroup } = await import("./ios-fleet/asc-api.mjs");
  const calls = [];
  const api = async (method, path, body) => {
    calls.push(`${method} ${path.split("?")[0]}${path.includes("filter[apps]") ? " (apps)" : ""}`);
    if (method === "POST" && path === "/v1/betaTesters") return { status: 409, ok: false, parsed: { errors: [{ code: "ENTITY_ERROR" }] }, text: "" };
    if (method === "GET" && path.includes("filter[apps]=1&limit=5")) {
      return { status: 200, ok: true, parsed: { data: [{ id: "rec", attributes: { email: "Alice@Example.com" } }] }, text: "" };
    }
    if (method === "POST" && path === "/v1/betaGroups/g1/relationships/betaTesters") {
      assert.equal(JSON.parse(body).data[0].id, "rec");
      return { status: 204, ok: true, parsed: {}, text: "" };
    }
    return { status: 500, ok: false, parsed: {}, text: "" };
  };
  const out = await addTesterToGroup({ api, appId: "1", groupId: "g1", email: "alice@example.com", createFirst: true });
  assert.equal(out.ok, true);
  assert.equal(out.existing, true);
  assert.ok(calls[0] === "POST /v1/betaTesters" && calls[1] === "GET /v1/betaTesters (apps)", calls.join(" > "));
});

test("addTesterToGroup recovers from a 409 on another app's record with this app's own record", async () => {
  const { addTesterToGroup } = await import("./ios-fleet/asc-api.mjs");
  const calls = [];
  const api = async (method, path, body) => {
    calls.push(`${method} ${path.split("?")[0]}`);
    // The app-scoped lookup finds nothing, so the plain lookup returns a record
    // that belongs to another app.
    if (method === "GET" && path.includes("filter[email]=") && path.includes("filter[apps]=1")) {
      return { status: 200, ok: true, parsed: { data: [] }, text: "" };
    }
    if (method === "GET" && path.includes("filter[email]=")) {
      return { status: 200, ok: true, parsed: { data: [{ id: "foreign", attributes: { email: "alice@example.com" } }] }, text: "" };
    }
    if (method === "GET" && path.startsWith("/v1/betaTesters?filter[apps]=1&limit=200")) {
      return { status: 200, ok: true, parsed: { data: [{ id: "own", attributes: { email: "alice@example.com" } }] }, text: "" };
    }
    if (method === "POST" && path === "/v1/betaGroups/g1/relationships/betaTesters") {
      const id = JSON.parse(body).data[0].id;
      return id === "own"
        ? { status: 204, ok: true, parsed: {}, text: "" }
        : { status: 409, ok: false, parsed: { errors: [{ code: "STATE_ERROR", detail: "Tester(s) cannot be assigned" }] }, text: "" };
    }
    return { status: 500, ok: false, parsed: {}, text: "" };
  };
  const out = await addTesterToGroup({ api, appId: "1", groupId: "g1", email: "alice@example.com" });
  assert.equal(out.ok, true, "the 409 on the foreign record must not be the final answer");
  assert.equal(out.existing, true, "the recovered record is reported as an existing tester");
  assert.equal(calls.filter((c) => c === "POST /v1/betaGroups/g1/relationships/betaTesters").length, 2);
});

test("countInternalTesters counts only members of internal all-builds groups", async () => {
  const { countInternalTesters } = await import("./ios-fleet/asc-api.mjs");
  const empty = fakeAsc({
    groups: [{ id: "ext1", name: "Public Beta", isInternalGroup: false, hasAccessToAllBuilds: null, members: ["a@example.com", "b@example.com", "c@example.com"] }]
  });
  assert.deepEqual(await countInternalTesters({ api: empty.api, appId: "1" }), { ok: true, groups: 0, testers: 0 });
  const mixed = fakeAsc({
    groups: [
      { id: "ext1", name: "Public Beta", isInternalGroup: false, hasAccessToAllBuilds: null, members: ["a@example.com"] },
      { id: "int1", name: "Some Builds", isInternalGroup: true, hasAccessToAllBuilds: false, members: ["b@example.com"] },
      { id: "int2", name: "Internal Testers", isInternalGroup: true, hasAccessToAllBuilds: true, members: ["c@example.com", "d@example.com"] }
    ]
  });
  assert.deepEqual(await countInternalTesters({ api: mixed.api, appId: "1" }), { ok: true, groups: 1, testers: 2 });
  const failing = await countInternalTesters({ api: async () => ({ status: 500, ok: false, parsed: {}, text: "" }), appId: "1" });
  assert.equal(failing.ok, false, "an unreadable count is not reported as zero");
});

test("the ship no longer claims internal testers can install when none exist", () => {
  const sh = read("scripts/ios-fleet/ship-testflight.sh");
  const mjs = read("scripts/ios-fleet/asc-api.mjs");
  // asc-api exits 5 only when the count was READ and is zero.
  assert.match(mjs, /process\.exit\(nobody \? 5 : internalTesters\.ok \? 0 : 6\)/);
  assert.match(mjs, /const nobody = internalTesters\.ok && internalTesters\.testers === 0;/);
  // The wrapper turns rc=5 into a warning plus a CI annotation, not a success line.
  const rc5 = sh.slice(sh.indexOf("if [[ $rc -eq 5 ]]"), sh.indexOf("if [[ $rc -eq 3 ]]"));
  assert.match(rc5, /has no internal TestFlight tester/);
  assert.match(rc5, /::warning title=TestFlight has no internal tester::/);
  assert.doesNotMatch(rc5, /internal testers can install this build/);
  // An unreadable count (rc=6) must not print the success line either.
  const rc6 = sh.slice(sh.indexOf("if [[ $rc -eq 6 ]]"), sh.indexOf("if [[ $rc -eq 3 ]]"));
  assert.match(rc6, /installability is unverified/);
  assert.match(rc6, /::warning title=TestFlight installability unverified::/);
  assert.doesNotMatch(rc6, /internal testers can install this build/);
  // The only place the success line is printed is the rc=0 branch.
  assert.equal(sh.split("TestFlight internal testers can install this build").length - 1, 1);
  // The sync step creates the group, so the workflow must keep calling it.
  assert.match(mjs, /await ensureInternalTesterGroup\(/);
});
