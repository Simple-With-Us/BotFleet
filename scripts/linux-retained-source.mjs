// Exact Linux source retention, derived from immutable Git blobs.
// Reachability plus reviewed runtime assets is conservative, not a claim that
// arbitrary configuration-driven behavior has been exhaustively exercised.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { build } from "esbuild";
import { z } from "zod";

export const RETENTION_POLICY_PATH = "deploy/linux-server/retained-source.json";
export const MAX_RETENTION_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const text = z.string().min(1).max(512);
const sourceSha = z.string().regex(/^[0-9a-f]{40}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const policyPathSchema = z.string().regex(/^deploy\/linux-server\/retained-source(?:-[0-9a-f]{40})?\.json$/);
// oxlint-disable-next-line eslint/no-control-regex -- Reject control bytes at the untrusted relative-path boundary.
const pathSchema = text.refine((path) => !path.startsWith("/") && !/[\u0000-\u001f\\:]/.test(path) && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));
const category = z.enum(["runtime", "ui-build", "install", "deploy", "runtime-asset", "verification"]);
const entry = z.strictObject({ path: pathSchema, category, reason: text });
export const RetentionPolicySchema = z.strictObject({
  version: z.literal(1), maintainedRef: z.literal("main"),
  files: z.array(entry).min(1).max(10000).refine((files) => files.every((item, index) => index === 0 || files[index - 1].path < item.path)),
});
const toolchainSchema = z.strictObject({ nodeVersion: text, packageManager: text, lockSha256: hash, workspaceSha256: hash, installCompilerSha256: hash });
export const ClosureReceiptSchema = z.strictObject({
  version: z.literal(1), sourceSha, policySourceSha: sourceSha, policyPath: policyPathSchema, maintainedRef: z.literal("main"), policySha256: hash,
  toolchain: toolchainSchema,
  files: z.array(z.strictObject({ path: pathSchema, blob: sourceSha, sha256: hash, mode: z.enum(["100644", "100755"]), lfs: z.strictObject({ oid: hash, size: z.number().int().nonnegative().max(MAX_ASSET_BYTES) }).optional() })).min(1).max(10000),
});

export const LINUX_ENTRY_POINTS = [
  ["server/index.ts", "runtime"], ["deploy/linux-server/owner-gate.mjs", "runtime"],
  ["vite.config.ts", "ui-build"], ["src/main.tsx", "ui-build"],
  ["scripts/compile-clutch-dep.mjs", "install"],
  ["deploy/linux-server/dependency-install.node-test.mjs", "verification"],
  ["deploy/linux-server/start.node-test.mjs", "verification"],
  ["deploy/linux-server/start-token.node-test.mjs", "verification"],
  ["deploy/linux-server/owner-gate.node-test.mjs", "verification"],
  ["deploy/linux-server/render-resources.node-test.mjs", "verification"],
  ["deploy/linux-server/retained-source.node-test.mjs", "verification"],
];
// Explicit non-import consumers; each emitted policy row remains an exact file.
export const LINUX_REQUIRED_INPUTS = [
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "index.html", ".gitattributes",
  "tsconfig.json",
  "apps/docs/package.json", "apps/site/package.json", "patches/clutch@0.4.0.patch",
  "deploy/linux-server/common.sh", "deploy/linux-server/install.sh", "deploy/linux-server/update.sh",
  "deploy/linux-server/uninstall.sh", "deploy/linux-server/start.sh", "deploy/linux-server/check-storage.mjs",
  "deploy/linux-server/read-harness-token.mjs", "deploy/linux-server/render-resources.mjs",
  "deploy/linux-server/botfleet-server.service.in", "deploy/linux-server/botfleet-owner-gate.service.in",
  "server/drivers/pi-mcp-extension.ts", "scripts/computer-vm-cli/manifest.json",
];
const FORBIDDEN_MAC_PATHS = /^(?:electron\/(?:main|preload|updater[^/]*)\.|scripts\/(?:botfleet-server-start\.sh|launchd\/))/;
export function sourceHash(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
const git = (repo, args, maxBuffer = 16 * 1024 * 1024) => execFileSync("git", ["-C", repo, ...args], { maxBuffer, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });

export class MissingLfsObjects extends Error {
  constructor(missing) { super("Required offline LFS objects are missing"); this.missing = missing; }
}

function lfsPointer(bytes) {
  if (!bytes.subarray(0, 42).toString().startsWith("version https://git-lfs.github.com/spec/v1")) return null;
  const pointer = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([0-9a-f]{64})\nsize (0|[1-9][0-9]*)\n?$/.exec(bytes.toString("utf8"));
  if (!pointer || !Number.isSafeInteger(Number(pointer[2])) || Number(pointer[2]) > MAX_ASSET_BYTES) throw new Error("Malformed or oversized LFS pointer");
  return { oid: pointer[1], size: Number(pointer[2]) };
}

function readOfflineLfsObject(root, path, pointer) {
  const target = join(root, pointer.oid.slice(0, 2), pointer.oid.slice(2, 4), pointer.oid);
  let fd;
  try {
    if (realpathSync(target) !== target) throw new Error("Offline LFS path must not contain links");
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd), listed = lstatSync(target);
    if (!before.isFile() || before.nlink !== 1 || before.size !== pointer.size || before.dev !== listed.dev || before.ino !== listed.ino) throw new Error("Offline LFS object is not the declared regular file");
    const bytes = Buffer.alloc(pointer.size + 1);
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd), current = lstatSync(target);
    if (length !== pointer.size || sourceHash(bytes.subarray(0, length)) !== pointer.oid || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 || current.isSymbolicLink() || realpathSync(target) !== target) throw new Error("Offline LFS object changed or its materialized hash differs");
    return bytes.subarray(0, length);
  } catch (error) {
    if (error.code === "ENOENT") throw new MissingLfsObjects([{ path, ...pointer }]);
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function immutableGitSource(repo, sha) {
  sourceSha.parse(sha);
  const actual = git(repo, ["rev-parse", "--verify", `${sha}^{commit}`]).toString().trim();
  if (actual !== sha) throw new Error("Source must be an exact immutable commit SHA");
  const tree = new Map();
  for (const row of git(repo, ["ls-tree", "-rlz", sha]).toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) blob ([0-9a-f]{40})\s+(\d+)\t(.+)$/.exec(row);
    if (match) tree.set(match[4], { mode: match[1], blob: match[2], size: Number(match[3]) });
  }
  const cache = new Map();
  const common = git(repo, ["rev-parse", "--git-common-dir"]).toString().trim();
  const lfsRoot = join(realpathSync(resolve(repo, common)), "lfs", "objects");
  const read = (path) => {
    pathSchema.parse(path);
    const entry = tree.get(path);
    if (!entry || !["100644", "100755"].includes(entry.mode) || /(?:^|\/)\.env(?:\.|$)/.test(path)) throw new Error(`Unretained or unsafe source: ${path}`);
    if (cache.has(path)) return cache.get(path);
    const bytes = git(repo, ["cat-file", "blob", entry.blob], MAX_SOURCE_BYTES);
    if (bytes.length <= 1024 || /\.(?:[cm]?[jt]sx?|json|ya?ml|css|sh|in|html|patch)$/.test(path)) cache.set(path, bytes);
    return bytes;
  };
  const materialize = (path) => { const bytes = read(path); const pointer = lfsPointer(bytes); return pointer ? readOfflineLfsObject(lfsRoot, path, pointer) : bytes; };
  return { sha, tree, read, materialize };
}

function resolveImport(source, importer, specifier) {
  const clean = specifier.split("?")[0];
  if (!clean.startsWith(".") && !clean.startsWith("@/")) return null;
  const base = clean.startsWith("@/") ? `src/${clean.slice(2)}` : posix.normalize(posix.join(posix.dirname(importer), clean));
  pathSchema.parse(base);
  const uiAliases = importer.startsWith("src/") && base.endsWith(".js") ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx"] : [];
  const candidates = [base, ...uiAliases, ...[".ts", ".tsx", ".mjs", ".js", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.js"].map((suffix) => base + suffix)];
  const found = candidates.find((path) => source.tree.has(path));
  if (!found) throw new Error(`Unresolved Linux source import: ${importer} -> ${specifier}`);
  return found;
}

export async function discoverLinuxRetention(source) {
  const rows = new Map();
  const queue = [];
  const add = (path, category, reason) => {
    if (rows.has(path)) return;
    if (FORBIDDEN_MAC_PATHS.test(path)) throw new Error(`Mac launch or updater path cannot be retained: ${path}`);
    pathSchema.parse(path);
    const entry = source.tree.get(path);
    if (!entry || !["100644", "100755"].includes(entry.mode)) throw new Error(`Retained source must be a regular immutable blob: ${path}`);
    rows.set(path, { path, category, reason });
    queue.push(path);
  };
  for (const [path, category] of LINUX_ENTRY_POINTS) {
    if (path === "deploy/linux-server/retained-source.node-test.mjs" && !source.tree.has(path)) continue;
    add(path, category, "Linux entry point");
  }
  for (const path of LINUX_REQUIRED_INPUTS) add(path, path.startsWith("deploy/") ? "deploy" : "install", "Reviewed Linux delivery or build input");
  for (const path of source.tree.keys()) if (path.startsWith("public/")) add(path, "runtime-asset", "Vite copies this public asset into the Linux UI");
  const proxySource = source.read("server/proxy-paths.ts").toString("utf8");
  const proxyInventory = /\bSPAWNED_PROXIES\s*=\s*\{([\s\S]*?)\}\s*(?:as const)?\s*;/.exec(proxySource)?.[1] ?? "";
  const proxyCalls = [...proxyInventory.matchAll(/resolveProxy\("([A-Za-z0-9_/-]+)"\)/g)];
  if (!proxyCalls.length || proxyCalls.length !== [...proxyInventory.matchAll(/\bresolveProxy\s*\(/g)].length) throw new Error("The runtime proxy inventory requires explicit review");
  for (const match of proxyCalls) add(`server/${match[1]}.ts`, "runtime-asset", "Declared subprocess in server/proxy-paths.ts");
  const seeds = [...queue];
  const graph = await build({
    entryPoints: seeds.filter((path) => /\.(?:[cm]?[jt]sx?)$/.test(path)),
    bundle: true, write: false, metafile: true, platform: "node", format: "esm",
    outdir: "/retained-source-never-written", logLevel: "silent",
    plugins: [{ name: "immutable-git-source", setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === "entry-point") return { path: posix.normalize(args.path), namespace: "retained-git" };
        const target = resolveImport(source, args.importer, args.path);
        return target ? { path: target, namespace: "retained-git" } : { path: args.path, external: true };
      });
      builder.onLoad({ filter: /.*/, namespace: "retained-git" }, (args) => {
        const extension = args.path.split(".").at(-1);
        const loader = ({ ts: "ts", tsx: "tsx", js: "js", mjs: "js", cjs: "js", jsx: "jsx", json: "json", css: "css" })[extension] ?? "file";
        return { contents: source.read(args.path), loader };
      });
    } }],
  });
  const inputs = graph.metafile.inputs;
  for (let index = 0; index < queue.length; index++) {
    const path = queue[index];
    const edges = inputs[`retained-git:${path}`]?.imports ?? [];
    for (const edge of [...edges].sort((a, b) => a.path < b.path ? -1 : 1)) {
      if (!edge.external) add(edge.path.replace(/^retained-git:/, ""), rows.get(path).category, `Import from ${path}`);
    }
  }
  return RetentionPolicySchema.parse({ version: 1, maintainedRef: "main", files: [...rows.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}

export async function collectLinuxClosure(source, policySource = source, policyPath = RETENTION_POLICY_PATH) {
  policyPathSchema.parse(policyPath);
  if (policyPath !== RETENTION_POLICY_PATH && policyPath !== `deploy/linux-server/retained-source-${source.sha}.json`) throw new Error("Prior policy must name its exact source SHA");
  const policyBytes = policySource.read(policyPath);
  const policy = RetentionPolicySchema.parse(JSON.parse(policyBytes.toString("utf8")));
  const discovered = await discoverLinuxRetention(source);
  if (JSON.stringify(policy) !== JSON.stringify(discovered)) throw new Error("Retention policy drift: review and regenerate exact file ownership");
  const manifest = JSON.parse(source.read("package.json"));
  const node = /NODE_VERSION="\$\{NODE_VERSION:-([0-9.]+)\}"/.exec(source.read("deploy/linux-server/common.sh").toString());
  if (!node || !/^pnpm@\d+\.\d+\.\d+$/.test(manifest.packageManager ?? "")) throw new Error("Linux toolchain must be exactly pinned");
  const files = [];
  const missing = [];
  for (const { path } of policy.files) {
    try {
      const raw = source.read(path);
      const pointer = lfsPointer(raw);
      const tree = source.tree.get(path);
      const entry = { path, blob: tree.blob, mode: tree.mode, sha256: sourceHash(pointer ? source.materialize(path) : raw) };
      if (pointer) entry.lfs = pointer;
      files.push(entry);
    } catch (error) {
      if (error instanceof MissingLfsObjects) missing.push(...error.missing); else throw error;
    }
  }
  if (missing.length) throw new MissingLfsObjects(missing);
  return ClosureReceiptSchema.parse({
    version: 1, sourceSha: source.sha, policySourceSha: policySource.sha, policyPath, maintainedRef: "main", policySha256: sourceHash(policyBytes),
    toolchain: { nodeVersion: node[1], packageManager: manifest.packageManager, lockSha256: sourceHash(source.read("pnpm-lock.yaml")), workspaceSha256: sourceHash(source.read("pnpm-workspace.yaml")), installCompilerSha256: sourceHash(source.read("scripts/compile-clutch-dep.mjs")) },
    files,
  });
}

/** Private bounded receipt read; source files use Git blobs, not this path. */
export function readPrivateRetentionReceipt(path) {
  const absolute = join(realpathSync(dirname(resolve(path))), basename(path));
  const directory = lstatSync(dirname(absolute));
  if (!process.getuid || directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0) throw new Error("Receipt directory must be private");
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd), listed = lstatSync(absolute);
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid() || (before.mode & 0o077) !== 0 || before.dev !== listed.dev || before.ino !== listed.ino || listed.isSymbolicLink()) throw new Error("Receipt must be a private single-link regular file");
    if (before.size > MAX_RETENTION_MANIFEST_BYTES) throw new Error("Retention receipt too large");
    const bytes = Buffer.alloc(MAX_RETENTION_MANIFEST_BYTES + 1);
    let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    const after = fstatSync(fd), current = lstatSync(absolute), root = lstatSync(dirname(absolute));
    if (length > MAX_RETENTION_MANIFEST_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.dev !== current.dev || after.ino !== current.ino || current.nlink !== 1 || current.isSymbolicLink() || current.uid !== process.getuid() || (current.mode & 0o077) !== 0 || root.dev !== directory.dev || root.ino !== directory.ino || root.uid !== process.getuid() || (root.mode & 0o077) !== 0) throw new Error("Retention receipt changed or exceeds its bound");
    return ClosureReceiptSchema.parse(JSON.parse(bytes.subarray(0, length).toString("utf8")));
  } finally { closeSync(fd); }
}

export async function verifyLinuxClosure(repo, raw, expectedSourceSha, expectedPolicySourceSha = expectedSourceSha, expectedPolicyPath = RETENTION_POLICY_PATH) {
  const receipt = ClosureReceiptSchema.parse(raw);
  if (receipt.sourceSha !== expectedSourceSha) throw new Error("Retention receipt is for a different source");
  if (receipt.policySourceSha !== expectedPolicySourceSha) throw new Error("Retention receipt is for a different reviewed policy source");
  if (receipt.policyPath !== expectedPolicyPath) throw new Error("Retention receipt is for a different reviewed policy file");
  const expected = await collectLinuxClosure(immutableGitSource(repo, expectedSourceSha), immutableGitSource(repo, expectedPolicySourceSha), expectedPolicyPath);
  if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw new Error("Retention receipt does not match exact immutable blobs, modes, policy or toolchain");
  return new Set(receipt.files.map((entry) => entry.path));
}

export async function verifyRetainedWorkingTree(repo, raw, expectedSourceSha) {
  const receipt = ClosureReceiptSchema.parse(raw);
  const retained = await verifyLinuxClosure(repo, receipt, expectedSourceSha);
  const root = realpathSync(repo);
  for (const entry of [...receipt.files, { path: RETENTION_POLICY_PATH, sha256: receipt.policySha256, mode: "100644" }]) {
    const target = join(root, entry.path);
    if (realpathSync(target) !== target) throw new Error("Retained working tree contains a linked path");
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd), listed = lstatSync(target);
      const bound = entry.lfs?.size ?? MAX_SOURCE_BYTES;
      if (!before.isFile() || before.nlink !== 1 || before.dev !== listed.dev || before.ino !== listed.ino || before.size > bound) throw new Error("Retained working file is unsafe");
      const bytes = Buffer.alloc(bound + 1);
      let length = 0;
      while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
      const after = fstatSync(fd), current = lstatSync(target);
      if (length > bound || (entry.lfs && length !== entry.lfs.size) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1 || current.isSymbolicLink() || realpathSync(target) !== target || ((before.mode & 0o111) ? "100755" : "100644") !== entry.mode || sourceHash(bytes.subarray(0, length)) !== entry.sha256) throw new Error("Retained working file differs from its immutable source or declared LFS content");
    } finally { closeSync(fd); }
  }
  return retained;
}
