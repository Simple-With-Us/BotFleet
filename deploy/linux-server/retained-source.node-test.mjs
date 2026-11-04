import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectLinuxClosure, discoverLinuxRetention, immutableGitSource, LINUX_ENTRY_POINTS, LINUX_REQUIRED_INPUTS, MAX_RETENTION_MANIFEST_BYTES, MissingLfsObjects, readPrivateRetentionReceipt, RETENTION_POLICY_PATH, sourceHash, verifyLinuxClosure, verifyRetainedWorkingTree } from "../../scripts/linux-retained-source.mjs";
import { exportLinuxClosure } from "../../scripts/collect-linux-retained-source.mjs";
import { inspectGitFiles, MAC_LOCAL_ROOTS } from "../../scripts/check-post-reboot-node.mjs";
import { linuxFixturePlan, runLinuxClosureFixture } from "./retained-fixture.mjs";
import { waitForExit } from "../../server/testing/cleanup.ts";
import { createFilteredLinuxCheckout, materializeOfflineLfs } from "../../scripts/linux-retained-checkout.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const posix = { skip: process.platform === "win32" ? "Private receipt ownership requires POSIX" : false };
const server = `import { createServer } from "node:http";
import { value } from "../shared/value.ts";
import "./proxy-paths.ts";
const server = createServer((request, response) => response.end(JSON.stringify({ value })));
server.listen(0, "127.0.0.1", () => process.send?.({ port: server.address().port }));
setTimeout(() => process.exit(0), 15000).unref();
`;

// A generated throwaway repository, never a fleet checkout or a production
// receipt; it has no remote, credential, account or service configuration.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bf-linux-closure-"));
  const source = join(root, "source");
  mkdirSync(source, { mode: 0o700 });
  const put = (path, content) => {
    mkdirSync(dirname(join(source, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(source, path), content, { mode: 0o644 });
  };
  const git = (...args) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = () => { git("add", "."); git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Synthetic source fixture"); return git("rev-parse", "HEAD"); };
  for (const path of [...LINUX_ENTRY_POINTS.map(([path]) => path), ...LINUX_REQUIRED_INPUTS]) put(path, path.endsWith(".json") ? "{}" : "");
  put("server/index.ts", server);
  put("server/proxy-paths.ts", 'function resolveProxy(name) { return name; } export const SPAWNED_PROXIES = { fixture: resolveProxy("fixture-proxy") };');
  put("server/fixture-proxy.ts", 'export const fixture = true;');
  put("shared/value.ts", 'export const value = "prior";');
  put("deploy/linux-server/owner-gate.mjs", 'export { allowed } from "../../electron/infisical-read.mjs";');
  put("electron/infisical-read.mjs", 'export const allowed = true;');
  put("electron/main.mjs", 'throw new Error("unretained Mac application must never load");');
  put("src/main.tsx", 'export { ui } from "./ui.js";');
  put("src/ui.ts", 'export const ui = true;');
  put("public/retained.txt", "synthetic UI asset");
  put("package.json", JSON.stringify({ name: "synthetic-linux-fixture", version: "0.1.0", type: "module", packageManager: "pnpm@12.16.1" }));
  put("deploy/linux-server/common.sh", 'NODE_VERSION="${NODE_VERSION:-24.18.0}"\n');
  put("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  put("pnpm-workspace.yaml", "packages: ['.']\n");
  git("init", "-q");
  const basis = commit();
  const policy = await discoverLinuxRetention(immutableGitSource(source, basis));
  put(RETENTION_POLICY_PATH, JSON.stringify(policy));
  const prior = commit();
  put("shared/value.ts", 'export const value = "candidate";');
  const candidate = commit();
  const previous = await collectLinuxClosure(immutableGitSource(source, prior));
  const current = await collectLinuxClosure(immutableGitSource(source, candidate));
  const receiptPath = join(root, "receipt.json");
  writeFileSync(receiptPath, JSON.stringify(current), { mode: 0o600 });
  return { root, source, put, git, commit, prior, candidate, previous, current, receiptPath, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("immutable closure binds exact imports, assets, modes, policy and pinned toolchain", posix, async () => {
  const f = await fixture();
  try {
    const paths = await verifyLinuxClosure(f.source, readPrivateRetentionReceipt(f.receiptPath), f.candidate);
    for (const path of ["electron/infisical-read.mjs", "shared/value.ts", "src/ui.ts", "public/retained.txt", "server/fixture-proxy.ts"]) assert.ok(paths.has(path), path);
    assert.ok(!paths.has("electron/main.mjs"));
    assert.equal(f.current.toolchain.nodeVersion, "24.18.0");
    assert.equal(f.current.toolchain.packageManager, "pnpm@12.16.1");
    assert.equal(f.current.files.find((file) => file.path === "shared/value.ts").mode, "100644");
    const result = spawnSync(process.execPath, [join(repo, "scripts/collect-linux-retained-source.mjs"), "verify", f.receiptPath, "--source-sha", f.candidate], { cwd: f.source, encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /immutable-source-consistency-only/);
    assert.equal(linuxFixturePlan(f.current, f.previous).maintainedRef, "main");
  } finally { f.close(); }
});

test("mismatched blobs, modes, source, policy, toolchain and unknown extras cannot be exempted", posix, async () => {
  const f = await fixture();
  try {
    for (const fault of ["blob", "mode", "source", "policy", "toolchain", "extra"]) {
      const changed = structuredClone(f.current);
      if (fault === "blob") changed.files[0].blob = "0".repeat(40);
      if (fault === "mode") changed.files[0].mode = "100755";
      if (fault === "source") changed.sourceSha = f.prior;
      if (fault === "policy") changed.policySha256 = "0".repeat(64);
      if (fault === "toolchain") changed.toolchain.nodeVersion = "1.0.0";
      if (fault === "extra") changed.files.push({ path: "electron/main.mjs", mode: "100644", blob: "0".repeat(40), sha256: "0".repeat(64) });
      await assert.rejects(verifyLinuxClosure(f.source, changed, f.candidate), undefined, fault);
    }
    const owned = await verifyRetainedWorkingTree(f.source, f.current, f.candidate);
    assert.deepEqual(inspectGitFiles(["server/index.ts", "server/unowned.ts", "electron/main.mjs", "shared/value.ts"], MAC_LOCAL_ROOTS, owned), ["electron/main.mjs", "server/unowned.ts"]);
    assert.deepEqual(inspectGitFiles(["server/index.ts"], MAC_LOCAL_ROOTS, ["server"]), ["server/index.ts"]);
    f.put("shared/value.ts", 'export const value = "tampered";');
    await assert.rejects(verifyRetainedWorkingTree(f.source, f.current, f.candidate), /differs/);
  } finally { f.close(); }
});

test("private receipts refuse links, shared permissions, oversized data and malformed input", posix, async () => {
  const f = await fixture();
  try {
    const bytes = readFileSync(f.receiptPath);
    for (const fault of ["symlink", "hardlink", "permissions", "oversize", "malformed"]) {
      unlinkSync(f.receiptPath);
      const other = join(f.root, "other.json");
      writeFileSync(other, bytes, { mode: 0o600 });
      if (fault === "symlink") symlinkSync(other, f.receiptPath);
      if (fault === "hardlink") linkSync(other, f.receiptPath);
      if (fault === "permissions") { writeFileSync(f.receiptPath, bytes, { mode: 0o600 }); chmodSync(f.receiptPath, 0o640); }
      if (fault === "oversize") writeFileSync(f.receiptPath, Buffer.alloc(MAX_RETENTION_MANIFEST_BYTES + 1), { mode: 0o600 });
      if (fault === "malformed") writeFileSync(f.receiptPath, "{", { mode: 0o600 });
      assert.throws(() => readPrivateRetentionReceipt(f.receiptPath), undefined, fault);
      unlinkSync(f.receiptPath); writeFileSync(f.receiptPath, bytes, { mode: 0o600 });
      unlinkSync(other);
    }
  } finally { f.close(); }
});

test("new relative imports and unreviewed runtime proxy expressions fail policy drift", posix, async () => {
  const f = await fixture();
  try {
    f.put("server/index.ts", server + '\nimport "./new-required.ts";\n');
    f.put("server/new-required.ts", "export const dependency = true;");
    const changed = f.commit();
    await assert.rejects(collectLinuxClosure(immutableGitSource(f.source, changed)), /policy drift/);
    f.put("server/proxy-paths.ts", 'function resolveProxy(name) { return name; } const unknown = "fixture-proxy"; export const SPAWNED_PROXIES = { fixture: resolveProxy(unknown) };');
    const dynamic = f.commit();
    await assert.rejects(discoverLinuxRetention(immutableGitSource(f.source, dynamic)), /proxy inventory/);
  } finally { f.close(); }
});

test("filtered exports refuse existing destinations and contain only exact immutable files", posix, async () => {
  const f = await fixture();
  try {
    const output = join(f.root, "export");
    await exportLinuxClosure(f.source, f.current, output, f.candidate);
    assert.equal(readFileSync(join(output, "shared/value.ts"), "utf8"), 'export const value = "candidate";');
    assert.equal(existsSync(join(output, "electron/main.mjs")), false);
    assert.equal(existsSync(join(output, ".git")), false);
    await assert.rejects(exportLinuxClosure(f.source, f.current, output, f.candidate), /EEXIST/);
    assert.equal(existsSync(join(f.root, "unowned")), false);
  } finally { f.close(); }
});

test("fixture execution defaults to no actions and restores an actual isolated prior child after candidate health failure", posix, async () => {
  const f = await fixture();
  const children = new Map();
  const ports = new Map();
  try {
    const output = join(f.root, "fixture-run");
    const preview = await runLinuxClosureFixture({ repo: f.source, candidate: f.current, prior: f.previous, output });
    assert.equal(preview.executed, false);
    assert.equal(existsSync(output), false);
    await assert.rejects(runLinuxClosureFixture({ repo: f.source, candidate: f.current, prior: f.previous, output, execute: true, adapters: {} }), /adapters are required/);
    assert.equal(existsSync(output), false);
    const adapters = {
      installDependencies: async ({ exportRoot }) => ({ ok: existsSync(join(exportRoot, "pnpm-lock.yaml")) }),
      buildUi: async ({ exportRoot }) => { mkdirSync(join(exportRoot, "dist")); writeFileSync(join(exportRoot, "dist/index.html"), "synthetic UI"); return { ok: true }; },
      start: async ({ slot, exportRoot }) => {
        assert.equal(children.size, 0, "a failed update must not create a second writer");
        const child = spawn(process.execPath, [join(exportRoot, "server/index.ts")], { cwd: exportRoot, env: { VITEST: "true" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
        children.set(slot, child);
        const message = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("fixture readiness expired")), 5000);
          child.once("message", (value) => { clearTimeout(timer); resolve(value); });
          child.once("error", (error) => { clearTimeout(timer); reject(error); });
          child.once("exit", () => { clearTimeout(timer); reject(new Error("fixture child ended before ready")); });
        });
        ports.set(slot, message.port);
        return { ok: true };
      },
      health: async ({ slot }) => { const response = await fetch(`http://127.0.0.1:${ports.get(slot)}`); const body = await response.json(); return { ok: slot === "prior" && body.value === "prior" }; },
      stop: async ({ slot }) => {
        const child = children.get(slot);
        if (!child) return { ok: true };
        await waitForExit(child, { signal: "SIGTERM", graceMs: 1000 });
        children.delete(slot);
        return { ok: true };
      },
    };
    const result = await runLinuxClosureFixture({ repo: f.source, candidate: f.current, prior: f.previous, output, execute: true, adapters });
    assert.equal(result.candidateHealthy, false);
    assert.equal(result.rollbackHealthy, true);
    assert.deepEqual(result.cleanupFailures, []);
    assert.equal(children.size, 0);
    assert.equal(result.trace.filter((step) => step.action === "health" && step.slot === "prior").length, 2);
    assert.equal(result.preservation, "external-runtime-acceptance-still-required");
  } finally {
    for (const child of children.values()) await waitForExit(child, { signal: "SIGKILL", graceMs: 100 });
    f.close();
  }
});

test("an uncertain start whose Stop cannot be confirmed prevents a second writer", posix, async () => {
  const f = await fixture();
  try {
    const started = [];
    const result = await runLinuxClosureFixture({
      repo: f.source, candidate: f.current, prior: f.previous, output: join(f.root, "uncertain"), execute: true,
      adapters: {
        installDependencies: async () => ({ ok: true }), buildUi: async () => ({ ok: true }),
        start: async ({ slot }) => { started.push(slot); if (slot === "candidate") throw new Error("private executor detail"); return { ok: true }; },
        health: async () => ({ ok: true }),
        stop: async ({ slot }) => ({ ok: slot !== "candidate" }),
      },
    });
    assert.deepEqual(started, ["prior", "candidate"]);
    assert.equal(result.rollbackHealthy, false);
    assert.deepEqual(result.cleanupFailures, ["candidate"]);
    assert.ok(!JSON.stringify(result).includes("private executor detail"));
  } finally { f.close(); }
});

test("a prepared private fixture root retains toolchain inputs and refuses reused or linked slots before adapters", posix, async () => {
  const f = await fixture();
  try {
    const output = join(f.root, "prepared");
    mkdirSync(output, { mode: 0o700 });
    const sentinel = join(output, "private-toolchain");
    mkdirSync(sentinel, { mode: 0o700 });
    writeFileSync(join(sentinel, "keep"), "private input");
    let calls = 0;
    const adapters = Object.fromEntries(["installDependencies", "buildUi", "start", "health", "stop"].map((action) => [action, async () => { calls++; return { ok: true }; }]));
    const options = { repo: f.source, candidate: f.current, prior: f.previous, output, execute: true, adapters, preparedRoot: true };
    chmodSync(output, 0o750);
    await assert.rejects(runLinuxClosureFixture(options), /owned private real directory/);
    chmodSync(output, 0o700);
    for (const slot of ["prior", "candidate"]) {
      const destination = join(output, slot);
      symlinkSync(join(f.root, "absent"), destination);
      await assert.rejects(runLinuxClosureFixture(options), /destination already exists/);
      assert.equal(calls, 0);
      assert.equal(existsSync(join(output, slot === "prior" ? "candidate" : "prior")), false);
      unlinkSync(destination);
    }
    const linkedRoot = join(f.root, "linked-root");
    symlinkSync(output, linkedRoot);
    await assert.rejects(runLinuxClosureFixture({ ...options, output: linkedRoot }), /owned private real directory/);
    const result = await runLinuxClosureFixture(options);
    assert.equal(result.candidateHealthy, true);
    assert.equal(result.rollbackHealthy, true);
    assert.equal(readFileSync(join(sentinel, "keep"), "utf8"), "private input");
    assert.equal(calls, 13);
    await assert.rejects(runLinuxClosureFixture(options), /destination already exists/);
    assert.equal(calls, 13);
  } finally { f.close(); }
});

test("an unjoined candidate build prevents rollback and preserves only bounded adapter evidence", posix, async () => {
  const f = await fixture();
  try {
    const started = [];
    const result = await runLinuxClosureFixture({
      repo: f.source, candidate: f.current, prior: f.previous, output: join(f.root, "unjoined-build"), execute: true,
      adapters: {
        installDependencies: async () => ({ ok: true }),
        buildUi: async ({ slot }) => { if (slot === "candidate") throw new Error("private build detail"); return { ok: true, uiHash: "a".repeat(64) }; },
        start: async ({ slot }) => { started.push(slot); return { ok: true, pid: 42, executable: "/usr/bin/node", httpPort: 32123, privateDetail: "never publish this" }; },
        health: async () => ({ ok: true, pid: 42, uiHash: "a".repeat(64), version: "0.1.0" }),
        stop: async () => ({ ok: true, pid: 42, joined: true }),
        cleanup: async () => ({ ok: false }),
      },
    });
    assert.deepEqual(started, ["prior"]);
    assert.equal(result.candidateHealthy, false);
    assert.equal(result.rollbackHealthy, false);
    assert.deepEqual(result.cleanupFailures, ["adapter-processes"]);
    const health = result.trace.find((step) => step.action === "health");
    assert.deepEqual(health.evidence, { pid: 42, uiHash: "a".repeat(64), version: "0.1.0" });
    const start = result.trace.find((step) => step.action === "start");
    assert.deepEqual(start.evidence, { pid: 42, httpPort: 32123, executable: "/usr/bin/node" });
    assert.ok(!JSON.stringify(result).includes("private build detail"));
    assert.ok(!JSON.stringify(result).includes("never publish this"));
  } finally { f.close(); }
});

test("official sparse worktrees preserve real identity and exact selected files when worktree config is already isolated", posix, async () => {
  const f = await fixture();
  try {
    const configPath = join(f.source, ".git/config");
    const unsupportedBefore = readFileSync(configPath);
    const unsupported = join(f.root, "sparse-needs-extension");
    f.git("worktree", "add", "--detach", unsupported, f.prior);
    execFileSync("git", ["-C", unsupported, "sparse-checkout", "set", "--no-cone", "--stdin"], { input: "/server/index.ts\n", stdio: ["pipe", "pipe", "pipe"] });
    assert.notDeepEqual(readFileSync(configPath), unsupportedBefore, "Git enables a common extension when it was absent; the fleet route must refuse that precondition");
    assert.equal(f.git("config", "--local", "--get", "extensions.worktreeConfig"), "true");
    f.git("worktree", "remove", "--force", unsupported);

    const before = readFileSync(configPath);
    const sourceStatus = f.git("status", "--porcelain");
    const selected = join(f.root, "sparse-isolated");
    f.git("worktree", "add", "--detach", selected, f.prior);
    const expected = [...f.previous.files.map((entry) => entry.path), RETENTION_POLICY_PATH].sort();
    execFileSync("git", ["-C", selected, "sparse-checkout", "set", "--no-cone", "--stdin"], { input: expected.map((path) => `/${path}`).join("\n") + "\n", stdio: ["pipe", "pipe", "pipe"] });
    const probe = (...args) => execFileSync("git", ["-C", selected, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    assert.deepEqual(readFileSync(configPath), before, "per-worktree sparse configuration must not change common configuration");
    assert.equal(f.git("status", "--porcelain"), sourceStatus);
    assert.equal(probe("rev-parse", "HEAD"), f.prior);
    assert.equal(probe("status", "--porcelain", "--untracked-files=no"), "");
    assert.equal(existsSync(join(selected, "electron/main.mjs")), false);
    assert.match(probe("ls-files", "-t", "--", "electron/main.mjs"), /^S /);
    const present = [];
    const walk = (prefix = "") => {
      for (const entry of readdirSync(join(selected, prefix), { withFileTypes: true })) {
        if (entry.name === ".git" && !prefix) continue;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path); else present.push(path);
      }
    };
    walk();
    assert.deepEqual(present.sort(), expected);
  } finally { f.close(); }
});

test("the repository policy owns Linux-required libraries and verified import/asset inputs exactly", posix, async () => {
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const actual = JSON.parse(readFileSync(join(repo, RETENTION_POLICY_PATH), "utf8"));
  const discovered = await discoverLinuxRetention(immutableGitSource(repo, head));
  assert.deepEqual(actual, discovered, "review and regenerate the exact policy when Linux inputs change");
  const paths = new Set(actual.files.map((entry) => entry.path));
  for (const name of ["config-file-lock", "persist-on-exit-policy", "workspace-credentials", "runtime-identity", "harness-ownership", "credential-restore", "infisical-read"]) assert.ok(paths.has(`electron/${name}.mjs`));
  assert.ok(paths.has("scripts/compile-clutch-dep.mjs"));
  assert.ok(paths.has("deploy/linux-server/retained-source.node-test.mjs"));
  assert.ok(!paths.has("electron/main.mjs"));
  assert.ok(!paths.has("scripts/botfleet-server-start.sh"));
});

test("depth-one file transport creates independent sparse Git identity without source configuration changes", posix, async () => {
  const f = await fixture();
  try {
    const output = join(f.root, "independent");
    const before = readFileSync(join(f.source, ".git/config"));
    const preview = await createFilteredLinuxCheckout({ repo: f.source, receipt: f.previous, output });
    assert.equal(preview.executed, false);
    assert.equal(existsSync(output), false);
    const actual = await createFilteredLinuxCheckout({ repo: f.source, receipt: f.previous, output, execute: true });
    assert.equal(actual.sourceSha, f.prior);
    assert.equal(actual.cleanTrackedStatus, true);
    assert.equal(actual.independentGitMetadata, true);
    assert.equal(existsSync(join(output, "electron/main.mjs")), false);
    assert.equal(existsSync(join(output, ".git/objects/info/alternates")), false);
    assert.deepEqual(readFileSync(join(f.source, ".git/config")), before);
    assert.equal(f.git("status", "--porcelain"), "");
  } finally { f.close(); }
});

test("LFS closure refuses missing objects and binds/materializes offline content with truthful Git clean semantics", posix, async () => {
  const f = await fixture();
  try {
    const content = Buffer.from("synthetic offline LFS asset\n");
    const oid = sourceHash(content);
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${content.length}\n`;
    f.put("public/lfs.bin", pointer);
    f.put(".gitattributes", "public/lfs.bin filter=lfs -text\n");
    const basis = f.commit();
    const policy = await discoverLinuxRetention(immutableGitSource(f.source, basis));
    f.put(RETENTION_POLICY_PATH, JSON.stringify(policy));
    const sha = f.commit();
    let missing;
    try { await collectLinuxClosure(immutableGitSource(f.source, sha)); }
    catch (error) { assert.ok(error instanceof MissingLfsObjects); missing = error.missing; }
    assert.deepEqual(missing, [{ path: "public/lfs.bin", oid, size: content.length }]);
    const object = join(f.source, ".git/lfs/objects", oid.slice(0, 2), oid.slice(2, 4), oid);
    mkdirSync(dirname(object), { recursive: true, mode: 0o700 });
    writeFileSync(object, content, { mode: 0o600 });
    const receipt = await collectLinuxClosure(immutableGitSource(f.source, sha));
    const asset = receipt.files.find((file) => file.path === "public/lfs.bin");
    assert.equal(asset.sha256, oid);
    assert.deepEqual(asset.lfs, { oid, size: content.length });
    const output = join(f.root, "lfs-independent");
    await assert.rejects(createFilteredLinuxCheckout({ repo: f.source, receipt, output, execute: true }), /offline LFS materializer/);
    assert.equal(existsSync(output), false);
    const actual = await createFilteredLinuxCheckout({ repo: f.source, receipt, output, execute: true, materializeLfs: materializeOfflineLfs });
    assert.equal(actual.cleanTrackedStatus, true);
    assert.deepEqual(readFileSync(join(output, "public/lfs.bin")), content);
    assert.equal(execFileSync("git", ["-C", output, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sha);
    assert.equal(execFileSync("git", ["-C", output, "write-tree"], { encoding: "utf8" }).trim(), execFileSync("git", ["-C", output, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim());
    const changed = Buffer.from(content); changed[0] ^= 1;
    writeFileSync(join(output, "public/lfs.bin"), changed);
    assert.throws(() => execFileSync(process.execPath, [join(output, ".git/offline-lfs-clean.mjs")], { input: changed, stdio: ["pipe", "pipe", "pipe"] }), undefined, "the clean adapter must reject changed bytes rather than hide them");
    const status = spawnSync("git", ["-C", output, "status", "--porcelain", "--untracked-files=no"], { env: { PATH: process.env.PATH, HOME: join(output, ".git/fixture-home"), GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" }, encoding: "utf8" });
    assert.ok(status.status !== 0 || status.stdout.trim() !== "", "Git must refuse or report changed materialized bytes");
  } finally { f.close(); }
});
