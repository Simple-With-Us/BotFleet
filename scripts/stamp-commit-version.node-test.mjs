import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { commitCountFor, planVersion, setVersion, stampCommitVersion } from "./stamp-commit-version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readManifest = (root) => JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const roots = [];
function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), "commit-version-"));
  roots.push(root);
  return root;
}
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

function initRepo(root, { shallow = false } = {}) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
  git("init", "--quiet");
  git("config", "user.email", "seat@example.invalid");
  git("config", "user.name", "Seat");
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "botfleet", version: "1.0.0" }, null, 2)}\n`);
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
    // both sufficient and independent of a remote existing.
    writeFileSync(join(root, ".git", "shallow"), "");
  }
  return root;
}

describe("version planning", () => {
  it("stamps 1.0.<commit_count>, the scheme the iOS client already ships", () => {
    assert.deepEqual(planVersion({ commitCount: 2127, currentVersion: "1.0.31" }), {
      version: "1.0.2127", floored: false, commitCount: 2127, current: "1.0.31",
    });
  });

  it("refuses a count that is not a usable build number", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "12", null, undefined]) {
      assert.throws(() => planVersion({ commitCount: bad, currentVersion: "1.0.31" }), /not a usable build number/);
    }
  });

  it("never stamps below a version already in package.json", () => {
    const plan = planVersion({ commitCount: 31, currentVersion: "1.0.900" });
    assert.equal(plan.version, "1.0.900");
    assert.equal(plan.floored, true);
  });

  it("leaves a version it cannot parse alone rather than inventing a floor", () => {
    const plan = planVersion({ commitCount: 2127, currentVersion: "1.0.0-beta.3" });
    assert.equal(plan.version, "1.0.2127");
    assert.equal(plan.floored, false);
  });
});

describe("commit count", () => {
  it("counts real history", () => {
    const root = initRepo(tempRepo());
    assert.equal(commitCountFor(root, "HEAD"), 4);
  });

  it("refuses a shallow clone instead of reporting 1", () => {
    // The failure this prevents: fetch-depth 1 makes rev-list answer 1, every
    // Mac build gets stamped 1.0.1, and CI looks green the whole time.
    const root = initRepo(tempRepo(), { shallow: true });
    assert.throws(() => commitCountFor(root, "HEAD"), /shallow clone/);
  });
});

describe("workflow wiring", () => {
  const workflows = ["release.yml", "mac-commit-build.yml"].map((name) => ({
    name,
    text: readFileSync(join(ROOT, ".github", "workflows", name), "utf8"),
  }));

  it("checks out with full history everywhere a version is derived", () => {
    // The single line that keeps the scheme meaningful.  Without it every Mac
    // build stamps 1.0.1 and nothing fails.
    for (const { name, text } of workflows) {
      assert.ok(text.includes("fetch-depth: 0"), `${name} must checkout with fetch-depth: 0`);
    }
  });

  it("never derives the version on a default-depth clone", () => {
    // Per job, not per string index: the thing that matters is that the job
    // which calls git for the commit count is the same job that asked for the
    // history the commit count is counted from.
    for (const { name, text } of workflows) {
      const blocks = text.split(/^ {2}(?=[a-z][a-z0-9-]*:\s*$)/m).slice(1);
      for (const block of blocks) {
        if (!/stamp-commit-version\.mjs \.(?!\s+--set)/.test(block)) continue;
        assert.ok(
          /fetch-depth: 0/.test(block),
          `${name}: job "${block.split("\n")[0].trim()}" derives the commit count but its checkout is not full-history`,
        );
      }
    }
  });

  it("stamps release builds from the version prepare pinned, not their own git", () => {
    // Four jobs re-checkout the same commit.  Deriving in each is four chances
    // to disagree, and a release whose Mac and Windows artifacts disagree about
    // their own version is worse than no stamp at all.
    const release = workflows.find((w) => w.name === "release.yml").text;
    const applied = [...release.matchAll(/stamp-commit-version\.mjs \. --set "\$\{\{ needs\.prepare\.outputs\.version \}\}"/g)];
    assert.ok(applied.length >= 4, `expected the pinned version applied across the release jobs, saw ${applied.length}`);
  });

  it("stamps before the overwrite guard reads the version", () => {
    const release = workflows.find((w) => w.name === "release.yml").text;
    const stamp = release.indexOf("stamp-commit-version.mjs .");
    const guard = release.indexOf("is already published");
    assert.ok(stamp !== -1 && guard !== -1 && stamp < guard, "the guard must see the stamped version, not the hand-typed one");
  });
});

describe("applying an upstream version", () => {
  it("writes the version it was given without touching git", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "botfleet", version: "1.0.31" }, null, 2)}\n`);
    const result = setVersion(root, "1.0.2127");
    assert.equal(result.version, "1.0.2127");
    assert.equal(result.previous, "1.0.31");
    assert.equal(readManifest(root).version, "1.0.2127");
  });

  it("refuses anything that is not a plain version", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "botfleet", version: "1.0.31" }, null, 2)}\n`);
    for (const bad of ["", "latest", "1.0", "1.0.2127 && rm -rf /", null, undefined]) {
      assert.throws(() => setVersion(root, bad), /unrecognised version/);
    }
  });

  it("is idempotent", () => {
    const root = tempRepo();
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "botfleet", version: "1.0.31" }, null, 2)}\n`);
    setVersion(root, "1.0.2127");
    const again = setVersion(root, "1.0.2127");
    assert.equal(again.changed, false);
  });
});

describe("stamping", () => {
  it("writes the version and reports the transition", () => {
    const root = initRepo(tempRepo());
    const result = stampCommitVersion(root);
    assert.equal(result.version, "1.0.4");
    assert.equal(result.previous, "1.0.0");
    assert.equal(result.changed, true);
    assert.equal(readManifest(root).version, "1.0.4");
  });

  it("is idempotent, so a rerun of the same commit stamps the same number", () => {
    const root = initRepo(tempRepo());
    const first = stampCommitVersion(root);
    const second = stampCommitVersion(root);
    assert.equal(first.version, second.version);
    assert.equal(second.changed, false);
  });

  it("honours the floor across repeated stamps", () => {
    const root = initRepo(tempRepo());
    writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "botfleet", version: "1.0.900" }, null, 2)}\n`);
    const result = stampCommitVersion(root);
    assert.equal(result.version, "1.0.900");
    assert.equal(result.floored, true);
    assert.equal(result.changed, false);
  });

  it("preserves the rest of the manifest", () => {
    const root = tempRepo();
    execFileSync("git", ["-C", root, "init", "--quiet"]);
    execFileSync("git", ["-C", root, "config", "user.email", "seat@example.invalid"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Seat"]);
    writeFileSync(
      join(root, "package.json"),
      `${JSON.stringify({ name: "botfleet", version: "1.0.0", scripts: { test: "x" }, dependencies: { zod: "3" } }, null, 2)}\n`,
    );
    execFileSync("git", ["-C", root, "add", "package.json"]);
    execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "one"]);
    stampCommitVersion(root);
    const manifest = readManifest(root);
    assert.deepEqual(manifest.scripts, { test: "x" });
    assert.deepEqual(manifest.dependencies, { zod: "3" });
    assert.equal(manifest.name, "botfleet");
  });
});