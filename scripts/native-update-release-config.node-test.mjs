import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { NATIVE_UPDATE_NAMES as names, NATIVE_UPDATE_PROJECT as projectId,
  resolveNativeUpdateReleaseConfig, writeNativeUpdateReleaseConfig } from "./native-update-release-config.mjs";

const feed = "https://updates.invalid/native/appcast.xml";
const key = Buffer.alloc(32, 7).toString("base64");
const env = { INFISICAL_NATIVE_RELEASE_READ_TOKEN: "st.fixture" };
const failure = "Native update release configuration could not be verified against canonical Infisical metadata.";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture({ grant = {}, rows, imports, fetchError } = {}) {
  const calls = [];
  const metadata = { workspace: projectId, permissions: ["read"], expiresAt: null,
    scopes: [{ environment: "prod", secretPath: "/" }], ...grant };
  const secrets = rows ?? names.map((name, index) => ({ secretKey: name,
    secretValue: [feed, key][index], workspace: projectId, environment: "prod", secretPath: "/", secretValueHidden: false }));
  return { calls, fetchImpl: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (fetchError) throw new Error("sensitive-response-body");
    return { ok: true, json: async () => calls.length === 1 ? metadata : { secrets, imports } };
  } };
}

for (const mirrors of [{}, Object.fromEntries(names.map((name, i) => [`MIRROR_${name}`, [feed, key][i]]))]) {
  test(`canonical public values resolve with ${Object.keys(mirrors).length ? "matching mirrors" : "no mirrors"}`, async () => {
    const fake = fixture();
    const result = await resolveNativeUpdateReleaseConfig({ env: { ...env, ...mirrors,
      INFISICAL_PROJECT_ID: "ambient-other-project", INFISICAL_ENVIRONMENT: "dev",
      INFISICAL_SITE_URL: "https://attacker.invalid", INFISICAL_SECRET_PATH: "/other" }, fetchImpl: fake.fetchImpl });
    assert.deepEqual(result, { [names[0]]: feed, [names[1]]: key });
    assert.equal(fake.calls.length, 2);
    assert.equal(fake.calls[0].url.origin, "https://app.infisical.com");
    assert.equal(fake.calls[0].url.pathname, "/api/v2/service-token");
    assert.equal(fake.calls[0].options.headers.authorization, "Bearer st.fixture");
    const query = fake.calls[1].url.searchParams;
    assert.equal(query.get("workspaceId"), projectId);
    assert.equal(query.get("environment"), "prod");
    assert.equal(query.get("secretPath"), "/");
    for (const name of ["expandSecretReferences", "include_imports", "recursive"]) assert.equal(query.get(name), "false");
  });
}

const validRows = () => names.map((name, index) => ({ secretKey: name, secretValue: [feed, key][index],
  workspace: projectId, environment: "prod", secretValueHidden: false, secretPath: "/" }));
const invalidCases = [
  ["missing canonical name", { rows: validRows().slice(0, 1) }],
  ["imported values", { rows: [], imports: [{ secrets: validRows() }] }],
  ["wrong project grant", { grant: { workspace: "other" } }],
  ["write grant", { grant: { permissions: ["read", "write"] } }],
  ["wrong environment grant", { grant: { scopes: [{ environment: "dev", secretPath: "/" }] } }],
  ["wrong folder grant", { grant: { scopes: [{ environment: "prod", secretPath: "/other" }] } }],
  ["malformed grant", { grant: { permissions: "read" } }],
  ["fetch failure", { fetchError: true }],
];
for (const [label, field, value] of [
  ["wrong row project", "workspace", "other"], ["wrong row environment", "environment", "dev"],
  ["wrong row folder", "secretPath", "/imported"], ["hidden row", "secretValueHidden", true],
  ["malformed row", "secretValue", 42], ["reference", "secretValue", "${prod.other.FEED}"],
  ["empty feed", "secretValue", ""], ["HTTP feed", "secretValue", "http://updates.invalid/feed"],
  ["credential feed", "secretValue", "https://user:password@updates.invalid/feed"],
  ["fragment feed", "secretValue", feed + "#fragment"], ["newline feed", "secretValue", feed + "\n"],
  ["empty user info", "secretValue", "https://@updates.invalid/feed"],
  ["empty fragment", "secretValue", feed + "#"],
  ["loose HTTPS syntax", "secretValue", "https:updates.invalid/feed"],
  ["tab in host", "secretValue", "https://updates.\tinvalid/feed"],
]) {
  const rows = validRows(); rows[0][field] = value;
  invalidCases.push([label, { rows }]);
}
for (const value of ["", "${prod.other.KEY}", "invalid", Buffer.alloc(31).toString("base64"), key + "\n"]) {
  const rows = validRows(); rows[1].secretValue = value;
  invalidCases.push(["invalid public key " + invalidCases.length, { rows }]);
}
for (const [label, options] of invalidCases) {
  test(`${label} refuses without exporting either value or exposing response details`, async () => {
    const fake = fixture(options), writes = [];
    await assert.rejects(writeNativeUpdateReleaseConfig({ env: { ...env,
      [`GH_FALLBACK_${names[0]}`]: feed, [`GH_FALLBACK_${names[1]}`]: key },
      output: "unused", fetchImpl: fake.fetchImpl, writeFileImpl: (...args) => writes.push(args) }),
    { message: failure });
    assert.deepEqual(writes, []);
  });
}

test("ambient machine identity and generic tokens cannot replace the dedicated credential", async () => {
  const fake = fixture();
  await assert.rejects(resolveNativeUpdateReleaseConfig({ env: { INFISICAL_TOKEN: "st.other",
    INFISICAL_CLIENT_ID: "ambient-id", INFISICAL_CLIENT_SECRET: "ambient-secret",
    INFISICAL_UNIVERSAL_AUTH_CLIENT_ID: "ambient-id", INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET: "ambient-secret",
    [`GH_FALLBACK_${names[0]}`]: feed, [`GH_FALLBACK_${names[1]}`]: key }, fetchImpl: fake.fetchImpl }), { message: failure });
  assert.equal(fake.calls.length, 0);
});

for (const mirrors of [
  { [`MIRROR_${names[0]}`]: feed + " " },
  { [`MIRROR_${names[0]}`]: "https://attacker.invalid/feed", [`MIRROR_${names[1]}`]: Buffer.alloc(32, 9).toString("base64") },
]) {
  test("noncanonical mirrors cannot redirect the archive even with a matching attacker pair", async () => {
    const writes = [], fake = fixture();
    await assert.rejects(writeNativeUpdateReleaseConfig({ env: { ...env, ...mirrors }, output: "unused",
      fetchImpl: fake.fetchImpl, writeFileImpl: (...args) => writes.push(args) }), { message: failure });
    assert.deepEqual(writes, []);
  });
}

test("both canonical values are written together only after successful validation", async () => {
  const writes = [], fake = fixture();
  await writeNativeUpdateReleaseConfig({ env, output: "fixture.env", fetchImpl: fake.fetchImpl,
    writeFileImpl: (...args) => writes.push(args) });
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], `${names[0]}=${feed}\n${names[1]}=${key}\n`);
  assert.equal(writes[0][2].flag, "wx");
  assert.equal(writes[0][2].mode, 0o600);
});

test("explicit nondistributable empty configuration stays unavailable without a vault request", async () => {
  const fake = fixture();
  const result = await resolveNativeUpdateReleaseConfig({ allowUnconfigured: true, fetchImpl: fake.fetchImpl });
  assert.deepEqual(result, { [names[0]]: "", [names[1]]: "" });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(resolveNativeUpdateReleaseConfig({ allowUnconfigured: true,
    env: { [`MIRROR_${names[0]}`]: feed, [`MIRROR_${names[1]}`]: key }, fetchImpl: fake.fetchImpl }), { message: failure });
});

test("the CLI leaves no export file on missing dedicated credential and supports only explicit unsigned omission", () => {
  const home = mkdtempSync(join(tmpdir(), "bf-native-update-config-"));
  try {
    const output = join(home, "native.env");
    const base = ["scripts/native-update-release-config.mjs", "--output", output];
    const failed = spawnSync(process.execPath, base, { env: {}, encoding: "utf8" });
    assert.equal(failed.status, 1);
    assert.equal(failed.stderr.trim(), failure);
    assert.equal(existsSync(output), false);
    const unsigned = spawnSync(process.execPath, [...base, "--allow-unconfigured"], { env: {}, encoding: "utf8" });
    assert.equal(unsigned.status, 0);
    assert.equal(readFileSync(output, "utf8"), `${names[0]}=\n${names[1]}=\n`);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("local packaging refuses missing canonical config before archive; explicit unsigned omission reaches only a fake archive", () => {
  const directory = mkdtempSync(join(tmpdir(), "bf-native-package-gate-"));
  try {
    const log = join(directory, "archive-args");
    const node = process.execPath.replaceAll("'", "'\\''");
    writeFileSync(join(directory, "node"), `#!/bin/bash\ncase "$1" in\n*stamp-commit-version.mjs) echo 1.0.2200 ;;\n*native-update-release-config.mjs) exec '${node}' "$@" ;;\n*) exit 92 ;;\nesac\n`, { mode: 0o755 });
    writeFileSync(join(directory, "xcodebuild"), '#!/bin/bash\nif [ "$1" = "-version" ]; then echo "Xcode 27.2"; exit 0; fi\nprintf "%s\\n" "$@" > "$FIXTURE_COMMAND_LOG"\nexit 91\n', { mode: 0o755 });
    writeFileSync(join(directory, "xcodegen"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
    const fixtureEnv = { PATH: `${directory}:/usr/bin:/bin`, HOME: directory, FIXTURE_COMMAND_LOG: log };
    const run = (args, extraEnv = {}) => spawnSync("/bin/bash", [join(ROOT, "scripts/mac-package.sh"), ...args],
      { env: { ...fixtureEnv, ...extraEnv }, encoding: "utf8" });
    const failed = run([]);
    assert.equal(failed.status, 1, failed.stderr);
    assert.match(failed.stderr, /could not be verified against canonical Infisical metadata/);
    assert.throws(() => readFileSync(log));
    const unsignedWithUnverifiedPair = run(["--skip-notarize"], {
      BOTFLEET_NATIVE_UPDATE_FEED_URL: "https://attacker.invalid/feed",
      BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY: Buffer.alloc(32, 9).toString("base64"),
    });
    assert.equal(unsignedWithUnverifiedPair.status, 1, unsignedWithUnverifiedPair.stderr);
    assert.throws(() => readFileSync(log));
    const unsigned = run(["--skip-notarize"]);
    assert.equal(unsigned.status, 91, unsigned.stderr);
    const args = readFileSync(log, "utf8");
    assert.match(args, /^archive\n/);
    assert.match(args, /^BOTFLEET_NATIVE_UPDATE_FEED_URL=$/m);
    assert.match(args, /^BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY=$/m);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
