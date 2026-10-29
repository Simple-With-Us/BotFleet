import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { controlBuildVersion } from "./control-build-version.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

// Every throwaway repository is removed when the file is done, even when a
// git step threw half way through making one.
const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// A throwaway repository with a known number of commits, so the count is not
// the count of whatever checkout runs the tests.
function makeRepo(commits) {
  const root = mkdtempSync(path.join(tmpdir(), "control-build-version-"));
  roots.push(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  git("init", "-q");
  for (let index = 1; index <= commits; index += 1) {
    writeFileSync(path.join(root, "file.txt"), `${index}\n`);
    git("add", "file.txt");
    git("commit", "-q", "-m", `commit ${index}`);
  }
  return root;
}

test("a pinned BOTFLEET_BUILD_VERSION is the version Control carries", () => {
  const stamp = controlBuildVersion({ env: { BOTFLEET_BUILD_VERSION: "1.0.2222" }, repoRoot: "/nonexistent" });
  assert.deepEqual(stamp, { version: "1.0.2222", build: "2222", source: "BOTFLEET_BUILD_VERSION" });
});

test("a BOTFLEET_BUILD_VERSION that is not a build version is refused", () => {
  assert.throws(
    () => controlBuildVersion({ env: { BOTFLEET_BUILD_VERSION: "2.1.0-beta" }, repoRoot: "/nonexistent" }),
    /not a 1\.0\.<count> build version/,
  );
});

test("without a pin the version is the commit count of the checkout", () => {
  const root = makeRepo(3);
  const stamp = controlBuildVersion({ env: {}, repoRoot: root });
  assert.equal(stamp.version, "1.0.3");
  assert.equal(stamp.build, "3");
  assert.equal(stamp.source, "commit count");
});

test("the package.json floor holds Control's version up with the app's", () => {
  const root = makeRepo(2);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.2200" }));
  const stamp = controlBuildVersion({ env: {}, repoRoot: root });
  assert.equal(stamp.version, "1.0.2200");
  assert.equal(stamp.build, "2200");
  assert.equal(stamp.source, "package.json floor");
});

test("a shallow clone with no pin refuses to stamp a build", () => {
  // actions/checkout defaults to depth 1, where the commit count is 1.  The
  // old stamp numbered such a build 1.0.1; this one refuses, the way the app's
  // own stamp does.
  const root = makeRepo(2);
  writeFileSync(path.join(root, ".git", "shallow"), "0000000000000000000000000000000000000000\n");
  assert.throws(() => controlBuildVersion({ env: {}, repoRoot: root }), /shallow clone/);
});

test("the local stamp bypass keeps the package.json version, like the app", () => {
  // BOTFLEET_SKIP_VERSION_STAMP=1 is the owner's bypass for an unstamped
  // local build.  Control follows it so both bundles carry the same number,
  // and a shallow clone is no longer a refusal under it.
  const root = makeRepo(1);
  writeFileSync(path.join(root, ".git", "shallow"), "0000000000000000000000000000000000000000\n");
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "1.0.31" }));
  const stamp = controlBuildVersion({ env: { BOTFLEET_SKIP_VERSION_STAMP: "1" }, repoRoot: root });
  assert.deepEqual(stamp, { version: "1.0.31", build: "31", source: "package.json (stamp skipped)" });
});

test("the Control builder stamps through the shared helper and not its own commit count", () => {
  // The helper's tests prove the helper; this pins that the builder calls it.
  const builder = readFileSync(path.join(repoRoot, "electron/build-control-app.mjs"), "utf8");
  assert.match(builder, /import \{ controlBuildVersion \} from "\.\/control-build-version\.mjs"/);
  assert.match(builder, /controlBuildVersion\(\{ repoRoot: project \}\)/);
  assert.doesNotMatch(builder, /rev-list/);
});

test("every workflow job that packages the Mac app has the history the Control stamp needs", () => {
  // The stamp refuses a shallow clone unless BOTFLEET_BUILD_VERSION is
  // pinned, so a job that runs a package:mac script must either pin the
  // version or check out with full history in that same job.  A whole-file
  // check would be fooled by another job's fetch-depth, so each job is read
  // on its own.
  const workflows = path.join(repoRoot, ".github/workflows");
  const offenders = [];
  for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file))) {
    const text = readFileSync(path.join(workflows, name), "utf8");
    if (!text.includes("package:mac")) continue;
    const jobsAt = text.indexOf("\njobs:");
    const body = jobsAt === -1 ? text : text.slice(jobsAt);
    // A top-level job key is two spaces in, followed by a name and a colon.
    const blocks = body.split(/\n(?=  [A-Za-z0-9_-]+:\s*\n)/);
    for (const block of blocks) {
      if (!block.includes("package:mac")) continue;
      // Comments are dropped first, so a job that only documents the
      // requirement ("# fetch-depth: 0 is REQUIRED") does not pass on prose.
      const code = block.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
      const pinned = code.includes("BOTFLEET_BUILD_VERSION");
      const fullHistory = /fetch-depth:\s*0/.test(code);
      if (!pinned && !fullHistory) offenders.push(`${name}: ${block.trim().split("\n")[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `jobs that build Control on a shallow clone with no pin: ${offenders.join("; ")}`);
});
