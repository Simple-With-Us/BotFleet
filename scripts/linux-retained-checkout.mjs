// An opt-in, independently owned, depth-one file:// Git fixture.
// No linked worktree, shared objects/refs/config, implicit LFS smudge or fetch.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ClosureReceiptSchema, immutableGitSource, RETENTION_POLICY_PATH, sourceHash, verifyLinuxClosure } from "./linux-retained-source.mjs";

export function filteredCheckoutCost(source, receipt) {
  const unique = new Map([...source.tree.values()].map((entry) => [entry.blob, entry.size]));
  return {
    commitCount: 1, uniqueBlobCount: unique.size,
    uncompressedUniqueBlobBytes: [...unique.values()].reduce((total, size) => total + size, 0),
    retainedWorkingBytes: receipt ? receipt.files.reduce((total, file) => total + (file.lfs?.size ?? source.tree.get(file.path).size), 0) : null,
    lfsObjectCount: receipt ? new Set(receipt.files.flatMap((file) => file.lfs ? [file.lfs.oid] : [])).size : null,
    excludesHistory: true, compressionAndTreeOverheadNotEstimated: true,
  };
}

/** Configure only a new fixture, after checkout; never smudge or fetch. */
export async function materializeOfflineLfs({ repo, source, receipt, env }) {
  const objects = join(repo, ".git/lfs/objects");
  const contract = {};
  for (const entry of receipt.files.filter((file) => file.lfs)) {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${entry.lfs.oid}\nsize ${entry.lfs.size}\n`;
    if (source.read(entry.path).toString("utf8") !== pointer) throw new Error("Offline clean requires canonical immutable LFS pointer bytes");
    const object = join(objects, entry.lfs.oid.slice(0, 2), entry.lfs.oid.slice(2, 4), entry.lfs.oid);
    if (!existsSync(object)) { mkdirSync(resolve(object, ".."), { recursive: true, mode: 0o700 }); writeFileSync(object, source.materialize(entry.path), { flag: "wx", mode: 0o600 }); }
    copyFileSync(object, join(repo, entry.path));
    chmodSync(join(repo, entry.path), entry.mode === "100755" ? 0o755 : 0o644);
    contract[entry.lfs.oid] = { size: entry.lfs.size, pointer };
  }
  const cleaner = join(repo, ".git/offline-lfs-clean.mjs");
  writeFileSync(join(repo, ".git/offline-lfs-contract.json"), JSON.stringify(contract), { flag: "wx", mode: 0o600 });
  writeFileSync(cleaner, [
    'import { createHash } from "node:crypto";',
    'import { readFileSync } from "node:fs";',
    'const expected = JSON.parse(readFileSync(new URL("./offline-lfs-contract.json", import.meta.url), "utf8"));',
    'const hash = createHash("sha256"); let size = 0;',
    'for await (const chunk of process.stdin) { size += chunk.length; if (size > 64 * 1024 * 1024) process.exit(1); hash.update(chunk); }',
    'const known = expected[hash.digest("hex")];',
    'if (!known || known.size !== size) process.exit(1);',
    'process.stdout.write(known.pointer);',
  ].join("\n") + "\n", { flag: "wx", mode: 0o600 });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const local = (...args) => execFileSync("git", ["-C", repo, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const tree = local("write-tree");
  local("config", "--local", "filter.lfs.clean", `${quote(process.execPath)} ${quote(cleaner)}`);
  local("config", "--local", "filter.lfs.required", "true");
  const paths = receipt.files.filter((file) => file.lfs).map((file) => file.path);
  execFileSync("git", ["--literal-pathspecs", "-C", repo, "add", "--renormalize", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: paths.join("\0") + "\0", stdio: ["pipe", "pipe", "pipe"] });
  if (local("write-tree") !== tree) throw new Error("Offline LFS clean must not change the immutable index tree");
}

/** No actual fleet fixture is created unless the caller explicitly opts in. */
export async function createFilteredLinuxCheckout({ repo, receipt: raw, output, execute = false, materializeLfs }) {
  const receipt = ClosureReceiptSchema.parse(raw);
  await verifyLinuxClosure(repo, receipt, receipt.sourceSha, receipt.policySourceSha, receipt.policyPath);
  const source = immutableGitSource(repo, receipt.sourceSha);
  const selected = receipt.files.map((file) => file.path);
  if (source.tree.has(RETENTION_POLICY_PATH)) selected.push(RETENTION_POLICY_PATH);
  selected.sort();
  const plan = { sourceSha: receipt.sourceSha, transport: "file://", depth: 1, selected, cost: filteredCheckoutCost(source, receipt), liveActions: [], implicitLfsSmudge: false };
  if (!execute) return { executed: false, plan };
  if (receipt.files.some((file) => file.lfs) && !materializeLfs) throw new Error("A reviewed offline LFS materializer/clean adapter is required");
  const origin = realpathSync(repo);
  const originalGit = (...args) => execFileSync("git", ["-C", origin, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } }).trim();
  const setting = (name) => { try { return originalGit("config", "--get", name); } catch (error) { if (error.status === 1) return null; throw error; } };
  const filePolicy = setting("protocol.file.allow");
  if (filePolicy === "never" || (filePolicy === null && setting("protocol.allow") === "never")) throw new Error("Existing Git file-transport policy refuses this fixture");
  const common = realpathSync(resolve(origin, originalGit("rev-parse", "--git-common-dir")));
  const commonConfig = readFileSync(join(common, "config"));
  const target = resolve(output);
  mkdirSync(target, { mode: 0o700 });
  const home = join(target, ".git", "fixture-home");
  const env = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1",
  };
  const git = (args, input) => execFileSync("git", args, { encoding: "utf8", env, input, timeout: 120000, maxBuffer: 8 * 1024 * 1024, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).trim();
  const local = (...args) => git(["-C", target, ...args]);
  git(["init", "--quiet", target]);
  mkdirSync(home, { mode: 0o700 });
  const protocols = ["-c", "protocol.allow=never", "-c", "protocol.file.allow=user", ...["http", "https", "ssh", "git", "ext"].flatMap((protocol) => ["-c", `protocol.${protocol}.allow=never`])];
  git([...protocols, "-C", target, "fetch", "--depth=1", "--no-tags", "--no-write-fetch-head", pathToFileURL(origin).href, receipt.sourceSha]);
  const patterns = selected.map((path) => `/${path.replace(/[\\*?[\]!]/g, "\\$&")}`).join("\n") + "\n";
  git(["-C", target, "sparse-checkout", "set", "--no-cone", "--stdin"], patterns);
  local("checkout", "--detach", receipt.sourceSha);
  if (materializeLfs) await materializeLfs({ repo: target, source, receipt, env });
  if (local("rev-parse", "HEAD") !== receipt.sourceSha || local("rev-list", "--count", "HEAD") !== "1" || local("status", "--porcelain", "--untracked-files=no") !== "") throw new Error("Filtered fixture does not preserve real clean depth-one identity");
  if (realpathSync(resolve(target, local("rev-parse", "--git-common-dir"))) !== realpathSync(join(target, ".git"))) throw new Error("Filtered fixture shares Git metadata");
  if (existsSync(join(target, ".git/objects/info/alternates")) || existsSync(join(target, ".git/commondir")) || local("for-each-ref", "--format=%(refname)")) throw new Error("Filtered fixture must not share objects, refs or worktrees");
  const present = [];
  const walk = (directory, gitObjects = false) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (!gitObjects && directory === target && entry.name === ".git") continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("Filtered fixture contains a linked path");
      if (stat.isDirectory()) walk(path, gitObjects);
      else if (gitObjects) { if (stat.nlink !== 1) throw new Error("Filtered Git objects must not be hardlinked"); }
      else { if (!stat.isFile() || stat.nlink !== 1) throw new Error("Filtered working files must be independent regular files"); present.push(path.slice(target.length + 1).replaceAll("\\", "/")); }
    }
  };
  walk(target); walk(join(target, ".git/objects"), true);
  if (existsSync(join(target, ".git/lfs/objects"))) walk(join(target, ".git/lfs/objects"), true);
  if (JSON.stringify(present.sort()) !== JSON.stringify(selected)) throw new Error("Filtered fixture contains an unselected or missing working file");
  for (const file of receipt.files) if (sourceHash(readFileSync(join(target, file.path))) !== file.sha256) throw new Error("Filtered working bytes differ from declared immutable/LFS content");
  if (!readFileSync(join(common, "config")).equals(commonConfig)) throw new Error("Source common configuration changed during fixture creation");
  return { executed: true, plan, sourceSha: receipt.sourceSha, cleanTrackedStatus: true, independentGitMetadata: true };
}

let isEntry = false;
try { isEntry = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { /* imported */ }
if (isEntry) {
  if (process.argv.length !== 4 || process.argv[2] !== "--estimate") {
    console.error("usage: node scripts/linux-retained-checkout.mjs --estimate <exact-source-sha>");
    process.exitCode = 2;
  } else {
    try { console.log(JSON.stringify(filteredCheckoutCost(immutableGitSource(process.cwd(), process.argv[3])), null, 2)); }
    catch { console.error("Filtered checkout estimate refused: source must be an available immutable local commit"); process.exitCode = 1; }
  }
}
