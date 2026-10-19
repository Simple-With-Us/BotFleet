import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { commitCountFor, planVersion, resolveBuildVersion } from "./stamp-commit-version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readManifest = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const run = (root, ...args) =>
  execFileSync(process.execPath, [join(ROOT, "scripts", "stamp-commit-version.mjs"), root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });

const roots = [];
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "commit-version-"));
  roots.push(root);
  return root;
}
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function initRepo(root, { shallow = false, version = "1.0.0" } = {}) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "seat@example.invalid");
  git("config", "user.name", "Seat");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "botfleet", version }, null, 2)}\n`);
  git("add", "package.json");
  git("commit", "--quiet", "-m", "one");
  for (let i = 2; i <= 4; i += 1) {
    writeFileSync(join(root, "file.txt"), `${i}\n`);
    git("add", "file.txt");
    git("commit", "--quiet", "-m", `commit ${i}`);
  }
  if (shallow) {
    // What actions/checkout's default fetch-depth: 1 leaves behind. The marker
    // file is the whole signal the script keys on, so writing it directly is
    // sufficient and independent of a remote existing.
    writeFileSync(join(root, ".git", "shallow"), "");
  }
  return root;
}

describe("version planning", () => {
  it("resolves 1.0.<commit_count>, the scheme the iOS client already ships", () => {
    assert.equal(planVersion({ commitCount: 2127 }).version, "1.0.2127");
    assert.equal(planVersion({ commitCount: 2127 }).floored, false);
  });

  it("refuses a count that is not a usable build number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "12", null, undefined]) {
      assert.throws(() => planVersion({ commitCount: bad }), /not a usable build number/);
    }
  });

  it("never numbers a build below a version already in package.json", () => {
    const plan = planVersion({ commitCount: 31, floorVersion: "1.0.900" });
    assert.equal(plan.version, "1.0.900");
    assert.equal(plan.floored, true);
  });

  it("leaves a floor it cannot parse alone rather than inventing one", () => {
    assert.equal(planVersion({ commitCount: 2127, floorVersion: "1.0.0-beta.3" }).version, "1.0.2127");
    assert.equal(planVersion({ commitCount: 2127, floorVersion: "latest" }).version, "1.0.2127");
    assert.equal(planVersion({ commitCount: 2127 }).version, "1.0.2127");
  });
});

describe("commit count", () => {
  it("counts real history", () => {
    assert.equal(commitCountFor(initRepo(tempRepo()), "HEAD"), 4);
  });

  it("refuses a shallow clone instead of reporting 1", () => {
    // The failure this prevents: fetch-depth 1 makes rev-list answer 1, every
    // build gets numbered 1.0.1, and CI looks green the whole time.
    assert.throws(() => commitCountFor(initRepo(tempRepo(), { shallow: true }), "HEAD"), /shallow clone/);
  });
});

describe("resolving a build version", () => {
  it("counts the repository and applies the floor", () => {
    assert.equal(resolveBuildVersion(initRepo(tempRepo())).version, "1.0.4");
    assert.equal(resolveBuildVersion(initRepo(tempRepo(), { version: "1.0.900" })).version, "1.0.900");
  });

  it("never writes to the working tree", () => {
    // The provenance gate refuses a dirty checkout, so this script must not
    // touch package.json even to record the build it produced.
    const root = initRepo(tempRepo());
    const before = readFileSync(join(root, "package.json"), "utf8");
    resolveBuildVersion(root);
    assert.equal(readFileSync(join(root, "package.json"), "utf8"), before);
    assert.equal(resolveBuildVersion(root).sourceDirty, undefined);
    const status = execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim();
    assert.equal(status, "", "resolving a version must leave the checkout pristine");
  });
});

describe("the command line", () => {
  it("compares the entrypoint with pathToFileURL, not a hand-built file:// string", () => {
    // The bug this pins: the naive `file://${process.argv[1]}` never equals
    // import.meta.url on Windows, so the CLI body silently did nothing there
    // and the Windows artifact shipped un-stamped while macOS did not.
    // Asserting the Windows result is not possible from a macOS host, because
    // pathToFileURL resolves a Windows path with this platform's rules -- so
    // this pins the fix rather than the symptom.
    const source = readFileSync(join(ROOT, "scripts", "stamp-commit-version.mjs"), "utf8");
    const code = source.split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
    assert.match(code, /pathToFileURL\(process\.argv\[1\]\)\.href/);
    assert.doesNotMatch(code, /`file:\/\/\$\{process\.argv\[1\]\}`/);
  });

  it("prints the version on stdout", () => {
    assert.equal(run(initRepo(tempRepo())).trim(), "1.0.4");
  });

  it("honours the local-build bypass", () => {
    const root = initRepo(tempRepo());
    const output = execFileSync(
      process.execPath,
      [join(ROOT, "scripts", "stamp-commit-version.mjs"), root],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, BOTFLEET_SKIP_VERSION_STAMP: "1" } },
    );
    assert.equal(output, "");
  });

  it("exits non-zero rather than shipping an unnumbered build", () => {
    const root = tempRepo();
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, ".git", "shallow"), "");
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "botfleet", version: "1.0.0" }, null, 2)}\n`);
    assert.throws(() => execFileSync(process.execPath, [join(ROOT, "scripts", "stamp-commit-version.mjs"), root], { stdio: ["ignore", "pipe", "pipe"] }));
  });
});

describe("workflow wiring", () => {
  const workflows = ["release.yml", "mac-commit-build.yml"].map((name) => ({
    name,
    text: readFileSync(join(ROOT, ".github", "workflows", name), "utf8"),
  }));

  it("checks out with full history everywhere a version is derived", () => {
    // The single line that keeps the scheme meaningful.  Without it every Mac
    // build is numbered 1.0.1 and nothing fails.
    for (const { name, text } of workflows) {
      assert.ok(text.includes("fetch-depth: 0"), `${name} must checkout with fetch-depth: 0`);
    }
  });

  it("never derives the version on a default-depth clone", () => {
    // Per job, not per string index: the thing that matters is that the job
    // which asks git for the commit count is the same job that asked for the
    // history it counts.
    for (const { name, text } of workflows) {
      const blocks = text.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).slice(1);
      for (const block of blocks) {
        if (!/stamp-commit-version\.mjs/.test(block)) continue;
        assert.ok(
          /fetch-depth: 0/.test(block),
          `${name}: job "${block.split("\n")[0].trim()}" derives the commit count but its checkout is not full-history`,
        );
      }
    }
  });

  it("passes the version to the build instead of editing package.json", () => {
    // The stamped value has to reach both halves: electron-builder for the app
    // bundle, and the server bundler for build-identity.json.
    for (const { name, text } of workflows) {
      assert.match(text, /BOTFLEET_BUILD_VERSION/, `${name} must pass the build version through the environment`);
      assert.match(text, /extraMetadata\.version/, `${name} must pass the build version to electron-builder`);
    }
  });

  it("stamps before the overwrite guard reads the version", () => {
    const release = workflows.find((w) => w.name === "release.yml").text;
    const stamp = release.indexOf("stamp-commit-version.mjs");
    const guard = release.indexOf("is already published");
    assert.ok(stamp !== -1 && guard !== -1 && stamp < guard, "the guard must see the stamped version, not the hand-typed one");
  });
});