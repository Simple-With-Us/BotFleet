import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { link, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { prepareCursorEnvironment } from "./cursor-cloud-bootstrap.mjs";
import { trustedPythonInterpreter } from "./cursor-cloud-output.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Fixture-only values are never sent to a real provider.
const TOKEN = "sentinel-cursor-read-token-not-real";
const VALUE = "spaces = and 'quotes'\n$(touch SHOULD_NOT_RUN)";
const digest = (value) => createHash("sha256").update(value).digest("hex");

function markOwned(outputDir) {
  writeFileSync(join(outputDir, "BotFleet.manifest.json"), JSON.stringify({
    owner: "botfleet-cursor-bootstrap", version: 1, scopeFingerprint: digest("fixture-only-scope"),
    files: Object.fromEntries(["BotFleet.env", "BotFleet.source.sh"].map((name) =>
      [name, digest(readFileSync(join(outputDir, name), "utf8"))])),
  }), { mode: 0o600 });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cursor-bootstrap-"));
  const homeDir = join(root, "home with spaces");
  const outputDir = join(homeDir, ".cursor-cloud-env");
  mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(outputDir, "BotFleet.env"), "stale environment", { mode: 0o600 });
  writeFileSync(join(outputDir, "BotFleet.source.sh"), "stale source", { mode: 0o600 });
  writeFileSync(join(outputDir, "Other.env"), "unrelated environment");
  writeFileSync(join(outputDir, "Other.source.sh"), "unrelated source");
  writeFileSync(join(outputDir, ".BotFleet.lock"), JSON.stringify({ owner: "botfleet-cursor-bootstrap", version: 1 }) + "\n", { mode: 0o600 });
  markOwned(outputDir);
  const env = { HOME: homeDir, INFISICAL_TOKEN: TOKEN, INFISICAL_SECRET_PATH: "/cursor",
    BOTFLEET_CURSOR_SECRET_NAMES: "CURSOR_FIXTURE_KEY",
    BOTFLEET_CURSOR_INFISICAL_ORIGIN: "https://infisical.example",
    INFISICAL_PROJECT_ID: "cursor-project", INFISICAL_ENV: "prod", INFISICAL_DOMAIN: "https://infisical.example" };
  return { root, homeDir, outputDir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function assertInvalidated(f) {
  assert.equal(existsSync(join(f.outputDir, "BotFleet.env")), false);
  assert.equal(existsSync(join(f.outputDir, "BotFleet.source.sh")), false);
  assert.equal(readFileSync(join(f.outputDir, "Other.env"), "utf8"), "unrelated environment");
  assert.equal(readFileSync(join(f.outputDir, "Other.source.sh"), "utf8"), "unrelated source");
}

function provider(f, overrides = {}) {
  const calls = [];
  return { calls, fetchImpl: async (url, init) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, init });
    assert.equal(parsed.origin, "https://infisical.example");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    if (parsed.pathname === "/api/v2/service-token") {
      return new Response(JSON.stringify({ workspace: "cursor-project", expiresAt: null,
        permissions: ["read"], scopes: [{ environment: "prod", secretPath: f.env.INFISICAL_SECRET_PATH }],
        ...overrides,
      }), { status: overrides.metadataStatus ?? 200 });
    }
    assert.equal(parsed.pathname, "/api/v3/secrets/raw");
    assert.equal(parsed.searchParams.get("workspaceId"), "cursor-project");
    assert.equal(parsed.searchParams.get("environment"), "prod");
    assert.equal(parsed.searchParams.get("secretPath"), f.env.INFISICAL_SECRET_PATH);
    assert.equal(parsed.searchParams.get("recursive"), "false");
    assert.equal(parsed.searchParams.get("include_imports"), "false");
    assert.equal(parsed.searchParams.get("expandSecretReferences"), "false");
    if (overrides.fetchFailure) throw new Error(`${TOKEN} ${VALUE}`);
    return new Response(JSON.stringify({ secrets: [{ secretKey: "CURSOR_FIXTURE_KEY", secretValue: overrides.value ?? VALUE,
      workspace: overrides.rowProject ?? "cursor-project", environment: "prod", secretPath: f.env.INFISICAL_SECRET_PATH,
      secretValueHidden: false }, { secretKey: "UNDECLARED_FIXTURE_KEY", secretValue: "must-not-be-exported",
      workspace: "cursor-project", environment: "prod", secretPath: f.env.INFISICAL_SECRET_PATH, secretValueHidden: false }] }));
  } };
}

test("explicitly off, absent token and absent folder invalidate only owned outputs without network", async (t) => {
  for (const absent of ["off", "token", "folder", "blank-folder", "names", "blank-names", "origin"]) {
    await t.test(absent, async () => {
      const f = fixture();
      try {
        if (absent === "off") f.env.INFISICAL_TOKEN = "";
        if (absent === "token") delete f.env.INFISICAL_TOKEN;
        if (absent === "folder") delete f.env.INFISICAL_SECRET_PATH;
        if (absent === "blank-folder") f.env.INFISICAL_SECRET_PATH = " ";
        if (absent === "names") delete f.env.BOTFLEET_CURSOR_SECRET_NAMES;
        if (absent === "blank-names") f.env.BOTFLEET_CURSOR_SECRET_NAMES = " ";
        if (absent === "origin") delete f.env.BOTFLEET_CURSOR_INFISICAL_ORIGIN;
        // Legacy identity values cannot opt the service-token bootstrap in.
        f.env.INFISICAL_CLIENT_ID = "legacy-fixture-id";
        f.env.INFISICAL_CLIENT_SECRET = "legacy-fixture-secret";
        let calls = 0;
        const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} });
        assert.equal(result.state, "disabled");
        assert.equal(calls, 0);
        assertInvalidated(f);
      } finally { f.cleanup(); }
    });
  }
});

test("malformed explicit folders invalidate with zero network instead of defaulting to root", async (t) => {
  for (const secretPath of ["relative", "//", "/./", "/cursor/../", "/cursor//", "/cursor/*"]) {
    await t.test(secretPath, async () => {
      const f = fixture();
      try {
        f.env.INFISICAL_SECRET_PATH = secretPath;
        let calls = 0;
        const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} });
        assert.equal(result.state, "unavailable");
        assert.equal(calls, 0);
        assertInvalidated(f);
      } finally { f.cleanup(); }
    });
  }
});

test("bad token, write grant, wrong scope/project, rejected rows and fetch failures invalidate stale outputs", async (t) => {
  const cases = [
    { metadataStatus: 401 }, { permissions: ["read", "write"] }, { workspace: "other-project" },
    { scopes: [{ environment: "prod", secretPath: "/other" }] },
    { scopes: [{ environment: "staging", secretPath: "/cursor" }] },
    { rowProject: "other-project" }, { fetchFailure: true },
  ];
  for (const [index, overrides] of cases.entries()) {
    await t.test(String(index), async () => {
      const f = fixture();
      try {
        const wire = provider(f, overrides);
        const logs = [];
        const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: wire.fetchImpl, log: (message) => logs.push(message) });
        assert.equal(result.state, "unavailable");
        assertInvalidated(f);
        assert.equal(logs.join("\n").includes(TOKEN), false);
        assert.equal(logs.join("\n").includes(VALUE), false);
        assert.equal(wire.calls.some(({ url }) => /login|universal-auth/.test(url.pathname)), false);
      } finally { f.cleanup(); }
    });
  }
});

test("verified exact read scope writes shell-safe private outputs through same-directory atomic renames", async () => {
  const f = fixture();
  try {
    const wire = provider(f);
    const logs = [];
    const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: wire.fetchImpl, log: (message) => logs.push(message) });
    assert.deepEqual(result, { state: "written", count: 1 });
    assert.equal(wire.calls.length, 2);
    const exported = readFileSync(join(f.outputDir, "BotFleet.env"), "utf8");
    assert.equal(exported.includes("UNDECLARED_FIXTURE_KEY"), false);
    assert.equal(exported.includes("must-not-be-exported"), false);
    assert.equal(readFileSync(join(f.outputDir, "Other.env"), "utf8"), "unrelated environment");
    assert.equal(readdirSync(f.outputDir).some((name) => name.endsWith(".tmp")), false);
    if (process.platform !== "win32") {
      assert.equal(statSync(f.outputDir).mode & 0o777, 0o700);
      for (const name of ["BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"]) assert.equal(statSync(join(f.outputDir, name)).mode & 0o777, 0o600);
      const shell = spawnSync("bash", ["-c", '. "$HOME/.cursor-cloud-env/BotFleet.source.sh"; printf %s "$CURSOR_FIXTURE_KEY"'],
        { cwd: f.homeDir, env: { HOME: f.homeDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: "utf8" });
      assert.equal(shell.status, 0, shell.stderr);
      assert.equal(shell.stdout, VALUE);
      assert.equal(existsSync(join(f.homeDir, "SHOULD_NOT_RUN")), false);
    }
    assert.equal(logs.join("\n").includes(TOKEN), false);
    assert.equal(logs.join("\n").includes(VALUE), false);
  } finally { f.cleanup(); }
});

test("an explicit root grant is exact and never supplied as a missing-path default", async () => {
  const f = fixture();
  try {
    f.env.INFISICAL_SECRET_PATH = "/";
    const wire = provider(f);
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: wire.fetchImpl, log: () => {} })).state, "written");
    assert.equal(wire.calls[1].url.searchParams.get("secretPath"), "/");
  } finally { f.cleanup(); }
});

test("the configured Cursor start hook runs the service-token runner in an isolated repository fixture", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const wiring = JSON.parse(readFileSync(join(ROOT, ".cursor/environment.json"), "utf8"));
    assert.equal(wiring.start, "bash scripts/cursor-cloud-start.sh");
    const repo = join(f.root, "repo");
    mkdirSync(join(repo, "scripts"), { recursive: true });
    mkdirSync(join(repo, ".cursor"));
    writeFileSync(join(repo, "fcntl.py"), 'raise RuntimeError("repository modules must not override the OS lock")\n');
    for (const name of ["cursor-cloud-start.sh", "cursor-cloud-bootstrap.mjs", "cursor-cloud-output.mjs", "infisical-fetch.mjs"]) {
      copyFileSync(join(ROOT, "scripts", name), join(repo, "scripts", name));
    }
    // This is generated fixture metadata, never the user's committed env file.
    writeFileSync(join(repo, ".cursor/infisical.env"), "INFISICAL_PROJECT_ID=cursor-project\nINFISICAL_ENV=prod\nINFISICAL_DOMAIN=https://infisical.example\n");
    const preload = join(f.root, "fetch.mjs");
    writeFileSync(preload, `globalThis.fetch = async (url, init) => {
      if (String(url).includes("/api/v2/service-token")) return new Response(JSON.stringify({workspace:"cursor-project",scopes:[{environment:"prod",secretPath:"/cursor"}],permissions:["read"],expiresAt:null}));
      if (!String(url).includes("/api/v3/secrets/raw?")) throw new Error("Unexpected request");
      return new Response(JSON.stringify({secrets:[{secretKey:"FIXTURE",secretValue:"fixture-value",workspace:"cursor-project",environment:"prod",secretPath:"/cursor",secretValueHidden:false}]}));
    };`);
    const child = spawnSync("bash", ["-x", "-c", `export SHELLOPTS; ${wiring.start}`], { cwd: repo, encoding: "utf8",
      env: { HOME: f.homeDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, INFISICAL_TOKEN: TOKEN,
        INFISICAL_SECRET_PATH: "/cursor", BOTFLEET_CURSOR_SECRET_NAMES: "FIXTURE", BOTFLEET_CURSOR_INFISICAL_ORIGIN: "https://infisical.example", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    assert.equal(child.status, 0, child.stderr);
    assert.match(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), /FIXTURE='fixture-value'/);
    assert.equal(child.stdout.includes(TOKEN), false);
    assert.equal(child.stderr.includes(TOKEN), false);
    assert.equal(child.stdout.includes("fixture-value"), false);
    assert.equal(child.stderr.includes("fixture-value"), false);
    const linkedRepo = join(f.root, "linked-repo");
    symlinkSync(repo, linkedRepo);
    writeFileSync(join(f.outputDir, "BotFleet.env"), "stale linked entrypoint");
    markOwned(f.outputDir);
    const linked = spawnSync("bash", [join(linkedRepo, "scripts/cursor-cloud-start.sh")], { cwd: f.root, encoding: "utf8",
      env: { HOME: f.homeDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, INFISICAL_TOKEN: TOKEN,
        INFISICAL_SECRET_PATH: "/cursor", BOTFLEET_CURSOR_SECRET_NAMES: "FIXTURE", BOTFLEET_CURSOR_INFISICAL_ORIGIN: "https://infisical.example", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    assert.equal(linked.status, 0, linked.stderr);
    assert.match(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), /FIXTURE='fixture-value'/);
    // Default-off must not even source project metadata before clearing stale output.
    writeFileSync(join(repo, ".cursor/infisical.env"), "exit 89\n");
    writeFileSync(preload, 'globalThis.fetch = () => { throw new Error("unexpected network"); };');
    const disabled = spawnSync("bash", ["-c", wiring.start], { cwd: repo, encoding: "utf8",
      env: { HOME: f.homeDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, INFISICAL_TOKEN: TOKEN,
        INFISICAL_SECRET_PATH: "/cursor", BOTFLEET_CURSOR_INFISICAL_ORIGIN: "https://infisical.example", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    assert.equal(disabled.status, 0, disabled.stderr);
    assertInvalidated(f);
    const externalMetadata = join(f.root, "external-metadata.env");
    const sourcedMarker = join(f.root, "metadata-was-sourced");
    writeFileSync(externalMetadata, `touch '${sourcedMarker}'\n`);
    rmSync(join(repo, ".cursor/infisical.env"));
    symlinkSync(externalMetadata, join(repo, ".cursor/infisical.env"));
    writeFileSync(join(f.outputDir, "BotFleet.env"), "stale symlink metadata");
    writeFileSync(join(f.outputDir, "BotFleet.source.sh"), "stale symlink metadata");
    chmodSync(join(f.outputDir, "BotFleet.env"), 0o600);
    chmodSync(join(f.outputDir, "BotFleet.source.sh"), 0o600);
    markOwned(f.outputDir);
    const metadataLink = spawnSync("bash", ["-c", wiring.start], { cwd: repo, encoding: "utf8",
      env: { HOME: f.homeDir, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, INFISICAL_TOKEN: TOKEN,
        INFISICAL_SECRET_PATH: "/cursor", BOTFLEET_CURSOR_SECRET_NAMES: "FIXTURE", BOTFLEET_CURSOR_INFISICAL_ORIGIN: "https://infisical.example", NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    assert.equal(metadataLink.status, 0, metadataLink.stderr);
    assert.equal(existsSync(sourcedMarker), false);
    assert.equal(readFileSync(externalMetadata, "utf8"), `touch '${sourcedMarker}'\n`);
    assertInvalidated(f);
  } finally { f.cleanup(); }
});

test("declared reference values invalidate stale outputs without exporting expressions", async () => {
  const f = fixture();
  try {
    const wire = provider(f, { value: "prefix-${OTHER_SECRET}-suffix" });
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: wire.fetchImpl, log: () => {} })).state, "unavailable");
    assertInvalidated(f);
  } finally { f.cleanup(); }
});

test("symlinked output directories never touch external files or start network", { skip: process.platform === "win32" }, async (t) => {
  for (const enabled of [false, true]) {
    await t.test(String(enabled), async () => {
      const f = fixture();
      try {
        const outside = join(f.root, "outside");
        mkdirSync(outside, { mode: 0o755 });
        for (const name of ["BotFleet.env", "BotFleet.source.sh"]) writeFileSync(join(outside, name), "external sentinel");
        const originalMode = statSync(outside).mode;
        rmSync(f.outputDir, { recursive: true });
        symlinkSync(outside, f.outputDir);
        if (!enabled) delete f.env.INFISICAL_TOKEN;
        let calls = 0;
        assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} })).state, "unavailable");
        assert.equal(calls, 0);
        assert.equal(statSync(outside).mode, originalMode);
        assert.deepEqual(readdirSync(outside).sort(), ["BotFleet.env", "BotFleet.source.sh"]);
        for (const name of readdirSync(outside)) assert.equal(readFileSync(join(outside, name), "utf8"), "external sentinel");
      } finally { f.cleanup(); }
    });
  }
});

test("invalid declared names invalidate only owned outputs with zero network", async (t) => {
  for (const names of ["BAD-NAME", "VALID,", "A,A", "A;touch nope", "A B", "=VALUE"]) {
    await t.test(names, async () => {
      const f = fixture();
      try {
        f.env.BOTFLEET_CURSOR_SECRET_NAMES = names;
        let calls = 0;
        const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} });
        assert.equal(result.state, "unavailable");
        assert.equal(calls, 0);
        assertInvalidated(f);
      } finally { f.cleanup(); }
    });
  }
});

test("a missing declared value invalidates stale outputs instead of exporting a partial environment", async () => {
  const f = fixture();
  try {
    f.env.BOTFLEET_CURSOR_SECRET_NAMES = "CURSOR_FIXTURE_KEY,MISSING_FIXTURE_KEY";
    const wire = provider(f);
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: wire.fetchImpl, log: () => {} })).state, "unavailable");
    assertInvalidated(f);
  } finally { f.cleanup(); }
});

test("hostile metadata stays data and cannot select a bearer destination or execute shell", async (t) => {
  const cases = [
    "INFISICAL_DOMAIN=https://attacker.example\n",
    "INFISICAL_PROJECT_ID=$(touch MARKER)\n",
    "INFISICAL_PROJECT_ID=`touch MARKER`\n",
    "INFISICAL_PROJECT_ID=one\nINFISICAL_PROJECT_ID=two\n",
    "INFISICAL_TOKEN=metadata-must-not-provide-credentials\n",
    "export INFISICAL_PROJECT_ID=project\n",
    "INFISICAL_PROJECT_ID=project;touch MARKER\n",
  ];
  for (const [index, contents] of cases.entries()) {
    await t.test(String(index), async () => {
      const f = fixture();
      try {
        const metadataFile = join(f.root, "metadata.env");
        const marker = join(f.root, "must-not-execute");
        writeFileSync(metadataFile, contents.replaceAll("MARKER", marker));
        let calls = 0;
        const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, metadataFile,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} });
        assert.equal(result.state, "unavailable");
        assert.equal(calls, 0);
        assert.equal(existsSync(marker), false);
        assertInvalidated(f);
      } finally { f.cleanup(); }
    });
  }
});

test("literal metadata maps only to the trusted process origin", async () => {
  const f = fixture();
  try {
    const metadataFile = join(f.root, "metadata.env");
    writeFileSync(metadataFile, '# fixture metadata\nINFISICAL_PROJECT_ID="cursor-project"\nINFISICAL_ENV=prod\nINFISICAL_DOMAIN=https://infisical.example\n');
    delete f.env.INFISICAL_PROJECT_ID;
    delete f.env.INFISICAL_ENV;
    delete f.env.INFISICAL_DOMAIN;
    const wire = provider(f);
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, metadataFile,
      fetchImpl: wire.fetchImpl, log: () => {} })).state, "written");
    assert.equal(wire.calls.length, 2);
    assert.ok(wire.calls.every(({ url }) => url.origin === "https://infisical.example"));
  } finally { f.cleanup(); }
});

test("invalid trusted origins reject before credential transmission", async (t) => {
  for (const origin of ["http://infisical.example", "https://user@infisical.example", "https://infisical.example/path", "https://infisical.example/", "https://infisical.example?query"]) {
    await t.test(origin, async () => {
      const f = fixture();
      try {
        f.env.BOTFLEET_CURSOR_INFISICAL_ORIGIN = origin;
        let calls = 0;
        assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} })).state, "unavailable");
        assert.equal(calls, 0);
        assertInvalidated(f);
      } finally { f.cleanup(); }
    });
  }
});

test("unmarked, user-modified and corrupt outputs are preserved before any network or replacement", async (t) => {
  for (const change of ["unmarked", "modified", "corrupt", "owner", "scope", "filenames"]) {
    await t.test(change, async () => {
      const f = fixture();
      try {
        const manifestFile = join(f.outputDir, "BotFleet.manifest.json");
        if (change === "unmarked") rmSync(manifestFile);
        if (change === "modified") writeFileSync(join(f.outputDir, "BotFleet.env"), "user-owned edit");
        if (change === "corrupt") writeFileSync(manifestFile, "corrupt receipt");
        if (["owner", "scope", "filenames"].includes(change)) {
          const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
          if (change === "owner") manifest.owner = "another-generator";
          if (change === "scope") manifest.scopeFingerprint = "invalid";
          if (change === "filenames") manifest.files["../outside"] = digest("outside");
          writeFileSync(manifestFile, JSON.stringify(manifest));
        }
        const before = Object.fromEntries(readdirSync(f.outputDir).map((name) => [name, readFileSync(join(f.outputDir, name), "utf8")]));
        let calls = 0;
        for (const enabled of [false, true]) {
          const env = { ...f.env, INFISICAL_TOKEN: enabled ? TOKEN : "" };
          assert.equal((await prepareCursorEnvironment({ env, homeDir: f.homeDir,
            fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} })).state, "unavailable");
          assert.deepEqual(Object.fromEntries(readdirSync(f.outputDir).map((name) => [name, readFileSync(join(f.outputDir, name), "utf8")])), before);
        }
        assert.equal(calls, 0);
      } finally { f.cleanup(); }
    });
  }
});

test("symlinked active files or manifests preserve their targets and all output paths", { skip: process.platform === "win32" }, async (t) => {
  for (const name of ["BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"]) {
    await t.test(name, async () => {
      const f = fixture();
      try {
        const external = join(f.root, "external");
        writeFileSync(external, "external sentinel");
        rmSync(join(f.outputDir, name));
        symlinkSync(external, join(f.outputDir, name));
        const before = readdirSync(f.outputDir).sort();
        let calls = 0;
        assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} })).state, "unavailable");
        assert.equal(calls, 0);
        assert.deepEqual(readdirSync(f.outputDir).sort(), before);
        assert.equal(readFileSync(external, "utf8"), "external sentinel");
      } finally { f.cleanup(); }
    });
  }
});

test("output files owned by a different UID are preserved", { skip: process.getuid?.() !== 0 }, async () => {
  const f = fixture();
  try {
    const foreign = join(f.outputDir, "BotFleet.env");
    chownSync(foreign, 1, 1);
    let calls = 0;
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} })).state, "unavailable");
    assert.equal(calls, 0);
    assert.equal(statSync(foreign).uid, 1);
    assert.equal(readFileSync(foreign, "utf8"), "stale environment");
  } finally { f.cleanup(); }
});

test("first use creates a versioned receipt containing only scope and exact output hashes", async () => {
  const f = fixture();
  try {
    for (const name of ["BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"]) rmSync(join(f.outputDir, name));
    const wire = provider(f);
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: wire.fetchImpl, log: () => {} })).state, "written");
    const raw = readFileSync(join(f.outputDir, "BotFleet.manifest.json"), "utf8");
    const manifest = JSON.parse(raw);
    assert.equal(manifest.owner, "botfleet-cursor-bootstrap");
    assert.equal(manifest.version, 1);
    assert.equal(manifest.scopeFingerprint, digest(JSON.stringify({ siteUrl: "https://infisical.example", projectId: "cursor-project", environment: "prod", secretPath: "/cursor", names: ["CURSOR_FIXTURE_KEY"] })));
    assert.deepEqual(Object.keys(manifest.files).sort(), ["BotFleet.env", "BotFleet.source.sh"]);
    for (const name of Object.keys(manifest.files)) assert.equal(manifest.files[name], digest(readFileSync(join(f.outputDir, name), "utf8")));
    assert.equal(raw.includes(TOKEN), false);
    assert.equal(raw.includes(VALUE), false);
  } finally { f.cleanup(); }
});

test("an edit during fetch is preserved instead of overwritten or invalidated", async () => {
  const f = fixture();
  try {
    const wire = provider(f);
    const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: async (...args) => {
        const response = await wire.fetchImpl(...args);
        if (String(args[0]).includes("/api/v3/secrets/raw?")) writeFileSync(join(f.outputDir, "BotFleet.env"), "edit while fetching");
        return response;
      }, log: () => {} });
    assert.equal(result.state, "unavailable");
    assert.equal(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), "edit while fetching");
    assert.equal(readFileSync(join(f.outputDir, "BotFleet.source.sh"), "utf8"), "stale source");
  } finally { f.cleanup(); }
});

test("non-private output directories and files stop before network and remain unchanged", async (t) => {
  for (const name of ["directory", "BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"]) {
    await t.test(name, async () => {
      const f = fixture();
      try {
        const path = name === "directory" ? f.outputDir : join(f.outputDir, name);
        const mode = name === "directory" ? 0o777 : 0o644;
        chmodSync(path, mode);
        const before = readdirSync(f.outputDir).sort();
        let calls = 0;
        assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("unexpected network"); }, log: () => {} })).state, "unavailable");
        assert.equal(calls, 0);
        assert.equal(statSync(path).mode & 0o777, mode);
        assert.deepEqual(readdirSync(f.outputDir).sort(), before);
        assert.equal(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), "stale environment");
      } finally { f.cleanup(); }
    });
  }
});

test("overlapping enabled and off hooks serialize before invalidating owned output", { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    const wire = provider(f);
    let reachedMetadata;
    const reached = new Promise((resolve) => { reachedMetadata = resolve; });
    let releaseMetadata;
    const gate = new Promise((resolve) => { releaseMetadata = resolve; });
    const enabled = prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: async (...args) => {
        if (String(args[0]).includes("/api/v2/service-token")) { reachedMetadata(); await gate; }
        return wire.fetchImpl(...args);
      }, log: () => {} });
    await reached;
    let offFinished = false;
    const off = prepareCursorEnvironment({ env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir,
      fetchImpl: async () => { throw new Error("off hook must not fetch"); }, log: () => {} }).then((result) => {
      offFinished = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(offFinished, false);
    releaseMetadata();
    assert.equal((await enabled).state, "written");
    assert.equal((await off).state, "disabled");
    assertInvalidated(f);
    assert.equal(statSync(join(f.outputDir, ".BotFleet.lock")).mode & 0o777, 0o600);
  } finally { f.cleanup(); }
});

test("an editor at the atomic claim boundary is preserved for off and enabled hooks", async (t) => {
  for (const enabled of [false, true]) {
    await t.test(String(enabled), async () => {
      const f = fixture();
      try {
        let injected = false;
        const wire = provider(f);
        const active = join(f.outputDir, "BotFleet.env");
        const result = await prepareCursorEnvironment({ env: { ...f.env, INFISICAL_TOKEN: enabled ? TOKEN : "" },
          homeDir: f.homeDir, fetchImpl: wire.fetchImpl, log: () => {}, operations: {
            rename: async (from, to) => {
              if (from === active && !injected) { injected = true; writeFileSync(active, "editor at claim boundary"); }
              return rename(from, to);
            },
          } });
        assert.equal(result.state, "unavailable");
        assert.equal(readFileSync(active, "utf8"), "editor at claim boundary");
        assert.equal(readFileSync(join(f.outputDir, "BotFleet.source.sh"), "utf8"), "stale source");
        if (!enabled) assert.equal(wire.calls.length, 0);
      } finally { f.cleanup(); }
    });
  }
});

test("a new editor file at publication is never replaced by a no-replace link", async () => {
  const f = fixture();
  try {
    const active = join(f.outputDir, "BotFleet.env");
    const wire = provider(f);
    let injected = false;
    const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, fetchImpl: wire.fetchImpl,
      log: () => {}, operations: { link: async (from, to) => {
        if (to === active && !injected) { injected = true; writeFileSync(active, "new editor file", { flag: "wx", mode: 0o600 }); }
        return link(from, to);
      } } });
    assert.equal(result.state, "unavailable");
    assert.equal(readFileSync(active, "utf8"), "new editor file");
    assert.equal(readFileSync(join(f.outputDir, "BotFleet.source.sh"), "utf8"), "stale source");
  } finally { f.cleanup(); }
});

test("failure at each final publish step leaves no partial active secrets and remains recoverable", async (t) => {
  for (const fresh of [false, true]) {
    for (const afterLink of [false, true]) {
    for (const failedName of ["BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"]) {
      await t.test(`${fresh}:${afterLink}:${failedName}`, async () => {
        const f = fixture();
        try {
          if (fresh) for (const name of ["BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"]) rmSync(join(f.outputDir, name));
          const wire = provider(f);
          let injected = false;
          const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, fetchImpl: wire.fetchImpl,
            log: () => {}, operations: { link: async (from, to) => {
              if (to === join(f.outputDir, failedName) && !injected) {
                injected = true;
                if (afterLink) await link(from, to);
                throw new Error("injected publication failure");
              }
              return link(from, to);
            } } });
          assert.equal(result.state, "unavailable");
          assertInvalidated(f);
          assert.equal(statSync(join(f.outputDir, ".BotFleet.lock")).mode & 0o777, 0o600);
          assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
          assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, fetchImpl: wire.fetchImpl, log: () => {} })).state, "written");
        } finally { f.cleanup(); }
      });
    }
    }
  }
});

function crashWriter(f, phase, step) {
  const childFile = join(f.root, "crash-writer.mjs");
  writeFileSync(childFile, `
    import { prepareCursorEnvironment } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/cursor-cloud-bootstrap.mjs")).href)};
    import { link, rename, rm } from 'node:fs/promises';
    const env = ${JSON.stringify(f.env)};
    if (${JSON.stringify(phase)}.startsWith('off-')) env.INFISICAL_TOKEN = '';
    let calls = 0;
    const fetchImpl = async (url) => {
      if (String(url).includes('/api/v2/service-token')) return new Response(JSON.stringify({workspace:'cursor-project',scopes:[{environment:'prod',secretPath:'/cursor'}],permissions:['read'],expiresAt:null}));
      return new Response(JSON.stringify({secrets:[{secretKey:'CURSOR_FIXTURE_KEY',secretValue:'new-generation-value',workspace:'cursor-project',environment:'prod',secretPath:'/cursor',secretValueHidden:false}]}));
    };
    await prepareCursorEnvironment({env,homeDir:env.HOME,fetchImpl,log:()=>{},operations:{
      link: async (from,to) => { const value = await link(from,to); if (${JSON.stringify(phase)} === 'publish' && ++calls === ${step}) process.exit(91); return value; },
      rename: async (from,to) => { const value = await rename(from,to); if (['claim','off-claim'].includes(${JSON.stringify(phase)}) && ++calls === ${step}) process.exit(91); return value; },
      remove: async (path) => { const value = await rm(path); if (${JSON.stringify(phase)} === 'off-remove' && ++calls === ${step}) process.exit(91); return value; },
      cleanupRename: async (from,to) => {
        const value = await rename(from,to);
        const phase = ${JSON.stringify(phase)};
        if ((phase === 'dispose-old' && from.includes('/old-BotFleet.')) ||
            (phase === 'dispose-new' && from.includes('/new-BotFleet.')) ||
            (phase === 'dispose-journal' && from.endsWith('/journal.json')) ||
            (phase === 'off-dispose' && from.includes('/old-BotFleet.'))) {
          if (++calls === ${step}) process.exit(91);
        }
        return value;
      },
      journalRename: async (from,to) => {
        if (['temp-initial','off-journal-temp'].includes(${JSON.stringify(phase)}) && ++calls === ${step}) process.exit(91);
        return rename(from,to);
      }
    }});
    process.exit(92);
  `);
  return spawnSync(process.execPath, [childFile], { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
}

test("hard death after each claim or link releases the OS lock and recovers only journaled inodes", { skip: process.platform === "win32" }, async (t) => {
  for (const phase of ["claim", "publish"]) {
    for (const step of [1, 2, 3]) {
      await t.test(`${phase}:${step}`, async () => {
        const f = fixture();
        try {
          const child = crashWriter(f, phase, step);
          assert.equal(child.status, 91, child.stderr);
          assert.ok(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")));
          let calls = 0;
          const result = await prepareCursorEnvironment({ env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir,
            lockWaitMs: 1000, fetchImpl: async () => { calls++; throw new Error("off recovery must not fetch"); }, log: () => {} });
          assert.equal(result.state, "disabled");
          assert.equal(calls, 0);
          assertInvalidated(f);
          assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
          assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, fetchImpl: provider(f).fetchImpl, log: () => {} })).state, "written");
        } finally { f.cleanup(); }
      });
    }
  }
});

test("a changed inode after hard death is preserved and the source helper emits no environment", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    assert.equal(crashWriter(f, "publish", 2).status, 91);
    writeFileSync(join(f.outputDir, "BotFleet.env"), "editor after crash");
    let calls = 0;
    const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, lockWaitMs: 1000,
      fetchImpl: async () => { calls++; throw new Error("unverified recovery must not fetch"); }, log: () => {} });
    assert.equal(result.state, "unavailable");
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), "editor after crash");
    const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
      { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(source.status, 1, source.stderr);
    assert.equal(source.stdout, "");
    assert.equal(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), "editor after crash");
  } finally { f.cleanup(); }
});

test("unknown recovery journals preserve all existing output and prevent network", async () => {
  const f = fixture();
  try {
    const recovery = join(f.outputDir, ".BotFleet.transaction-unknown");
    mkdirSync(recovery, { mode: 0o700 });
    writeFileSync(join(recovery, "journal.json"), "unknown journal", { mode: 0o600 });
    let calls = 0;
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); }, log: () => {} })).state, "unavailable");
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), "stale environment");
    assert.equal(readFileSync(join(recovery, "journal.json"), "utf8"), "unknown journal");
  } finally { f.cleanup(); }
});

test("off-hook death persists invalidation and the loader never restores disabled values", { skip: process.platform === "win32" }, async (t) => {
  for (const phase of ["off-claim", "off-remove"]) {
    for (const step of phase === "off-claim" ? [1, 2, 3] : [1, 2]) {
      await t.test(`${phase}:${step}`, () => {
        const f = fixture();
        try {
          const child = crashWriter(f, phase, step);
          assert.equal(child.status, 91, child.stderr);
          const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
            { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
          assert.equal(source.status, 1, source.stderr);
          assert.equal(source.stdout, "");
          assertInvalidated(f);
        } finally { f.cleanup(); }
      });
    }
  }
});

test("a replacement at a private cleanup pathname is preserved after atomic disposal claim", async () => {
  const f = fixture();
  try {
    let replaced;
    const result = await prepareCursorEnvironment({ env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir,
      log: () => {}, operations: { cleanupRename: async (from, to) => {
        assert.ok(dirname(from).startsWith(join(f.outputDir, ".BotFleet.transaction-")));
        const value = await rename(from, to);
        if (!replaced && from.endsWith("old-BotFleet.env")) {
          replaced = from;
          writeFileSync(from, "private editor replacement", { flag: "wx", mode: 0o600 });
        }
        return value;
      } } });
    assert.equal(result.state, "disabled");
    assertInvalidated(f);
    assert.ok(replaced);
    assert.equal(readFileSync(replaced, "utf8"), "private editor replacement");
  } finally { f.cleanup(); }
});

test("loss of the OS helper before a journal prevents network and preserves output", { timeout: 5000 }, async () => {
  const f = fixture();
  try {
    let markLost;
    const lost = new Promise((resolve) => { markLost = resolve; });
    let calls = 0;
    const result = await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
      fetchImpl: async () => { calls++; throw new Error("unexpected fetch"); }, log: () => {}, operations: {
        onLockAcquired: async (pid) => { process.kill(pid, "SIGTERM"); await lost; }, onLockLost: markLost,
      } });
    assert.equal(result.state, "unavailable");
    assert.equal(calls, 0);
    assert.equal(readFileSync(join(f.outputDir, "BotFleet.env"), "utf8"), "stale environment");
    assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
  } finally { f.cleanup(); }
});

test("a writer whose OS helper dies during fetch cannot publish over a newer off hook", { timeout: 10000 }, async () => {
  const f = fixture();
  let child;
  try {
    const writer = join(f.root, "lost-lock-writer.mjs");
    writeFileSync(writer, `
      import { prepareCursorEnvironment } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/cursor-cloud-bootstrap.mjs")).href)};
      const env = ${JSON.stringify(f.env)};
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      process.on('message', message => { if (message === 'release') release(); });
      let calls = 0;
      try {
        await prepareCursorEnvironment({env,homeDir:env.HOME,log:()=>{},operations:{
          onLockAcquired: pid => process.send({kind:'helper',pid}), onLockLost:()=>process.send({kind:'lost'})
        },fetchImpl:async()=>{calls++;process.send({kind:'fetch'});await gate;return new Response(JSON.stringify({workspace:'cursor-project',scopes:[{environment:'prod',secretPath:'/cursor'}],permissions:['read'],expiresAt:null}));}});
      } catch {}
      process.send({kind:'done',calls});
      process.exit(0);
    `);
    child = spawn(process.execPath, [writer], { env: { HOME: f.homeDir, PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const messages = [];
    const waitMessage = (kind) => new Promise((resolve) => {
      const existing = messages.find((message) => message.kind === kind);
      if (existing) { resolve(existing); return; }
      const listener = (message) => { if (message.kind === kind) { child.off("message", listener); resolve(message); } };
      child.on("message", listener);
    });
    child.on("message", (message) => messages.push(message));
    const helper = await waitMessage("helper");
    await waitMessage("fetch");
    process.kill(helper.pid, "SIGTERM");
    await waitMessage("lost");
    let calls = 0;
    const offOptions = { env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir, log: () => {},
      fetchImpl: async () => { calls++; throw new Error("off hook must not fetch"); } };
    const off = prepareCursorEnvironment(offOptions);
    const exited = once(child, "exit");
    child.send("release");
    const done = await waitMessage("done");
    await exited;
    assert.equal(done.calls, 1, "lost metadata lock prevents a follow-on secrets request");
    assert.equal((await off).state, "disabled");
    assert.equal(calls, 0);
    assertInvalidated(f);
  } finally { child?.kill(); f.cleanup(); }
});

test("death after old, staged or journal disposal rename recovers the exact completed generation", { skip: process.platform === "win32" }, async (t) => {
  for (const phase of ["dispose-old", "dispose-new", "dispose-journal"]) {
    await t.test(phase, () => {
      const f = fixture();
      try {
        const child = crashWriter(f, phase, 1);
        assert.equal(child.status, 91, child.stderr);
        const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
          { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
        assert.equal(source.status, 0, source.stderr);
        assert.match(source.stdout, /CURSOR_FIXTURE_KEY='new-generation-value'/);
        assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
      } finally { f.cleanup(); }
    });
  }
});

test("off disposal rename death still finishes invalidation before a loader can return values", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    assert.equal(crashWriter(f, "off-dispose", 1).status, 91);
    const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
      { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(source.status, 1, source.stderr);
    assert.equal(source.stdout, "");
    assertInvalidated(f);
    assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
  } finally { f.cleanup(); }
});

test("death after invalidation recovery rename remains recoverable without restoring disabled values", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    assert.equal(crashWriter(f, "off-claim", 1).status, 91);
    const recoveryChild = join(f.root, "crash-recovery.mjs");
    writeFileSync(recoveryChild, `
      import { withCursorOutputTransaction } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/cursor-cloud-output.mjs")).href)};
      import { rename } from 'node:fs/promises';
      await withCursorOutputTransaction({homeDir:${JSON.stringify(f.homeDir)},log:()=>{},operations:{recoveryRename:async(from,to)=>{await rename(from,to);if(to.includes('/invalidate-'))process.exit(91);}}},({readEnvironment})=>readEnvironment());
      process.exit(92);
    `);
    const crashed = spawnSync(process.execPath, [recoveryChild], { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(crashed.status, 91, crashed.stderr);
    const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
      { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(source.status, 1, source.stderr);
    assert.equal(source.stdout, "");
    assertInvalidated(f);
    assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
  } finally { f.cleanup(); }
});

test("an edited disposal residue is preserved and blocks environment loading", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    assert.equal(crashWriter(f, "dispose-old", 1).status, 91);
    const directory = join(f.outputDir, readdirSync(f.outputDir).find((name) => name.startsWith(".BotFleet.transaction-")));
    const residue = join(directory, readdirSync(directory).find((name) => name.startsWith("dispose-old-")));
    writeFileSync(residue, "user-edited private residue");
    const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
      { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(source.status, 1, source.stderr);
    assert.equal(source.stdout, "");
    assert.equal(readFileSync(residue, "utf8"), "user-edited private residue");
  } finally { f.cleanup(); }
});

test("an empty private generated transaction directory can be retired without adopting unknown residue", async () => {
  const f = fixture();
  try {
    const empty = join(f.outputDir, ".BotFleet.transaction-Ab12Cd");
    mkdirSync(empty, { mode: 0o700 });
    assert.equal((await prepareCursorEnvironment({ env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir, log: () => {} })).state, "disabled");
    assert.equal(existsSync(empty), false);
    assertInvalidated(f);
  } finally { f.cleanup(); }
});

const activeSnapshot = (f) => Object.fromEntries(["BotFleet.env", "BotFleet.source.sh", "BotFleet.manifest.json"].map((name) => {
  const path = join(f.outputDir, name);
  return [name, existsSync(path) ? { content: readFileSync(path, "utf8"), ino: statSync(path).ino, mode: statSync(path).mode } : null];
}));

test("pre-existing recover/invalidate destination collisions preserve sentinel and every active pathname", { skip: process.platform === "win32" }, async (t) => {
  for (const [phase, sentinel] of [["publish", "recover-BotFleet.env"], ["off-claim", "invalidate-BotFleet.source.sh"]]) {
    await t.test(phase, () => {
      const f = fixture();
      try {
        assert.equal(crashWriter(f, phase, 1).status, 91);
        const directory = join(f.outputDir, readdirSync(f.outputDir).find((name) => name.startsWith(".BotFleet.transaction-")));
        const path = join(directory, sentinel);
        writeFileSync(path, "user sentinel", { mode: 0o600 });
        const before = activeSnapshot(f);
        const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
          { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
        assert.equal(source.status, 1, source.stderr);
        assert.equal(source.stdout, "");
        assert.equal(readFileSync(path, "utf8"), "user sentinel");
        assert.deepEqual(activeSnapshot(f), before);
      } finally { f.cleanup(); }
    });
  }
});

test("a single validated pre-mutation journal temp is recoverable", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    assert.equal(crashWriter(f, "temp-initial", 1).status, 91);
    const result = await prepareCursorEnvironment({ env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir,
      log: () => {}, fetchImpl: async () => { throw new Error("off temp recovery must not fetch"); } });
    assert.equal(result.state, "disabled");
    assertInvalidated(f);
    assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
  } finally { f.cleanup(); }
});

test("a valid off-intent temp supersedes its matching pre-mutation journal without returning disabled values", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    assert.equal(crashWriter(f, "off-journal-temp", 2).status, 91);
    const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
      { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(source.status, 1, source.stderr);
    assert.equal(source.stdout, "");
    assertInvalidated(f);
    assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.transaction-")), false);
  } finally { f.cleanup(); }
});

test("malformed, multiple or post-mutation journal temps remain untouched with active outputs unchanged", { skip: process.platform === "win32" }, async (t) => {
  for (const change of ["malformed", "multiple", "mismatched"]) {
    await t.test(change, () => {
      const f = fixture();
      try {
        assert.equal(crashWriter(f, "temp-initial", 1).status, 91);
        const directory = join(f.outputDir, readdirSync(f.outputDir).find((name) => name.startsWith(".BotFleet.transaction-")));
        const temporary = join(directory, readdirSync(directory).find((name) => name.endsWith(".tmp")));
        if (change === "malformed") writeFileSync(temporary, "malformed journal");
        if (change === "multiple") writeFileSync(join(directory, "journal-00000000-0000-0000-0000-000000000000.tmp"), readFileSync(temporary), { mode: 0o600 });
        if (change === "mismatched") writeFileSync(join(f.outputDir, "BotFleet.env"), "editor after temp");
        const before = activeSnapshot(f);
        const entries = Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")]));
        const source = spawnSync(process.execPath, [join(ROOT, "scripts/cursor-cloud-output.mjs"), "--read-environment", f.homeDir],
          { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
        assert.equal(source.status, 1, source.stderr);
        assert.equal(source.stdout, "");
        assert.deepEqual(activeSnapshot(f), before);
        assert.deepEqual(Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(join(directory, name), "utf8")])), entries);
      } finally { f.cleanup(); }
    });
  }
});

test("crash after exclusive canonical lock creation leaves a reusable private empty sentinel", { skip: process.platform === "win32" }, async () => {
  const f = fixture();
  try {
    const lock = join(f.outputDir, ".BotFleet.lock");
    rmSync(lock);
    const childFile = join(f.root, "crash-lock-create.mjs");
    writeFileSync(childFile, `
      import { prepareCursorEnvironment } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/cursor-cloud-bootstrap.mjs")).href)};
      await prepareCursorEnvironment({env:${JSON.stringify(f.env)},log:()=>{},operations:{onLockCreated:()=>process.exit(91)},fetchImpl:async()=>{throw new Error('must not fetch');}});
      process.exit(92);
    `);
    const child = spawnSync(process.execPath, [childFile], { env: { HOME: f.homeDir, PATH: process.env.PATH }, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 91, child.stderr);
    assert.equal(readFileSync(lock, "utf8"), "");
    const before = statSync(lock);
    assert.equal(before.mode & 0o777, 0o600);
    let calls = 0;
    assert.equal((await prepareCursorEnvironment({ env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir,
      log: () => {}, fetchImpl: async () => { calls++; throw new Error("off hook must not fetch"); } })).state, "disabled");
    assert.equal(calls, 0);
    assert.equal(statSync(lock).ino, before.ino);
    assert.equal(readFileSync(lock, "utf8"), "");
    assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.lock-new-")), false);
    assertInvalidated(f);
  } finally { f.cleanup(); }
});

test("concurrent first creators share one persistent sentinel without lock staging", async () => {
  const f = fixture();
  try {
    const lock = join(f.outputDir, ".BotFleet.lock");
    rmSync(lock);
    let creations = 0;
    const options = { env: { ...f.env, INFISICAL_TOKEN: "" }, homeDir: f.homeDir, log: () => {},
      operations: { onLockCreated: () => { creations++; } }, fetchImpl: async () => { throw new Error("off hook must not fetch"); } };
    const results = await Promise.all([prepareCursorEnvironment(options), prepareCursorEnvironment(options)]);
    assert.deepEqual(results.map((result) => result.state), ["disabled", "disabled"]);
    assert.equal(creations, 1);
    assert.equal(readFileSync(lock, "utf8"), "");
    assert.equal(statSync(lock).mode & 0o777, 0o600);
    assert.equal(readdirSync(f.outputDir).some((name) => name.startsWith(".BotFleet.lock-new-")), false);
    assertInvalidated(f);
  } finally { f.cleanup(); }
});

test("the legacy private lock marker remains unchanged and usable", async () => {
  const f = fixture();
  try {
    const lock = join(f.outputDir, ".BotFleet.lock");
    const contents = readFileSync(lock, "utf8");
    const before = statSync(lock);
    assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir, fetchImpl: provider(f).fetchImpl, log: () => {} })).state, "written");
    assert.equal(readFileSync(lock, "utf8"), contents);
    assert.equal(statSync(lock).ino, before.ino);
    assert.equal(statSync(lock).mtimeMs, before.mtimeMs);
  } finally { f.cleanup(); }
});

test("unknown content, permissive modes and symlink lock sentinels are preserved without network", { skip: process.platform === "win32" }, async (t) => {
  for (const change of ["content", "mode", "symlink"]) {
    await t.test(change, async () => {
      const f = fixture();
      try {
        const lock = join(f.outputDir, ".BotFleet.lock");
        const external = join(f.root, "external-lock");
        if (change === "content") writeFileSync(lock, "user lock sentinel");
        if (change === "mode") chmodSync(lock, 0o644);
        if (change === "symlink") { writeFileSync(external, "external sentinel", { mode: 0o600 }); rmSync(lock); symlinkSync(external, lock); }
        const contents = readFileSync(lock, "utf8");
        const before = activeSnapshot(f);
        let calls = 0;
        assert.equal((await prepareCursorEnvironment({ env: f.env, homeDir: f.homeDir,
          fetchImpl: async () => { calls++; throw new Error("must not fetch"); }, log: () => {} })).state, "unavailable");
        assert.equal(calls, 0);
        assert.equal(readFileSync(lock, "utf8"), contents);
        assert.deepEqual(activeSnapshot(f), before);
      } finally { f.cleanup(); }
    });
  }
});

function interpreterFilesystem(change) {
  const item = (kind, mode = 0o755, uid = 0) => ({ uid, mode,
    isFile: () => kind === "file", isDirectory: () => kind === "directory", isSymbolicLink: () => kind === "symlink" });
  const files = new Map([["/", item("directory")], ["/usr", item("directory")], ["/usr/bin", item("directory")],
    ["/usr/bin/python3", item("symlink", 0o777)], ["/usr/bin/python3.13", item("file")]]);
  let target = "python3.13";
  if (change === "missing") files.delete("/usr/bin/python3");
  if (change === "file-owner") files.set("/usr/bin/python3.13", item("file", 0o755, 1000));
  if (change === "link-owner") files.set("/usr/bin/python3", item("symlink", 0o777, 1000));
  if (change === "file-writable") files.set("/usr/bin/python3.13", item("file", 0o775));
  if (change === "ancestor-writable") files.set("/usr", item("directory", 0o775));
  if (change === "ancestor-owner") files.set("/usr/bin", item("directory", 0o755, 1000));
  if (change === "non-executable") files.set("/usr/bin/python3.13", item("file", 0o644));
  if (change === "cycle") target = "python3";
  if (change === "unsafe-target") { target = "/tmp/python3"; files.set("/tmp", item("directory", 0o1777)); files.set("/tmp/python3", item("file")); }
  return { platform: "linux", lstatImpl: async (path) => {
    if (!files.has(path)) throw Object.assign(new Error("missing fixture path"), { code: "ENOENT" });
    return files.get(path);
  }, readlinkImpl: async () => target, accessImpl: async () => {
    if (change === "access-denied") throw Object.assign(new Error("denied fixture access"), { code: "EACCES" });
  } };
}

test("trusted interpreter selection validates every system path component and never falls back to PATH", async (t) => {
  assert.equal(await trustedPythonInterpreter(interpreterFilesystem("valid")), "/usr/bin/python3.13");
  for (const change of ["missing", "file-owner", "link-owner", "file-writable", "ancestor-writable", "ancestor-owner", "non-executable", "cycle", "unsafe-target", "access-denied"]) {
    await t.test(change, async () => {
      await assert.rejects(trustedPythonInterpreter(interpreterFilesystem(change)), /trusted system Python3 interpreter is unavailable/);
    });
  }
  await assert.rejects(trustedPythonInterpreter({ platform: "unsupported" }), /trusted system Python3 interpreter is unavailable/);
});

test("supported CI platforms provide an absolute trusted interpreter with fcntl", { skip: !["linux", "darwin"].includes(process.platform) }, async () => {
  const interpreter = await trustedPythonInterpreter();
  assert.ok(interpreter.startsWith("/"));
  const child = spawnSync(interpreter, ["-I", "-S", "-c", "import fcntl; print('system-lock-ready')"], { env: { LANG: "C" }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "system-lock-ready\n");
});

test("a malicious python3 on inherited PATH is never selected", { skip: process.platform === "win32" }, () => {
  const f = fixture();
  try {
    const fakeBin = join(f.root, "fake-bin");
    mkdirSync(fakeBin);
    const marker = join(f.root, "malicious-helper-ran");
    const shim = join(fakeBin, "python3");
    writeFileSync(shim, `#!/bin/sh\n: > '${marker.replace(/'/g, "'\\''")}'\nexit 93\n`, { mode: 0o755 });
    const childFile = join(f.root, "fake-path.mjs");
    writeFileSync(childFile, `
      import { prepareCursorEnvironment } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/cursor-cloud-bootstrap.mjs")).href)};
      const env = ${JSON.stringify(f.env)};
      let calls = 0;
      const result = await prepareCursorEnvironment({env,homeDir:env.HOME,log:()=>{},fetchImpl:async(url)=>{
        calls++;
        if(String(url).includes('/api/v2/service-token'))return new Response(JSON.stringify({workspace:'cursor-project',scopes:[{environment:'prod',secretPath:'/cursor'}],permissions:['read'],expiresAt:null}));
        return new Response(JSON.stringify({secrets:[{secretKey:'CURSOR_FIXTURE_KEY',secretValue:'fixture-value',workspace:'cursor-project',environment:'prod',secretPath:'/cursor',secretValueHidden:false}]}));
      }});
      if(result.state!=='written'||calls!==2)process.exit(92);
    `);
    const child = spawnSync(process.execPath, [childFile], { env: { HOME: f.homeDir, PATH: fakeBin, PYTHONPATH: fakeBin }, encoding: "utf8", timeout: 5000 });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(existsSync(marker), false);
  } finally { f.cleanup(); }
});
