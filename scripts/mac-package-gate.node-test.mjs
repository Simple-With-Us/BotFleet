import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isMacPackagingPath, isPackagingPath } from "./ci-change-scope.mjs";
import { shouldRunMacPackageGate } from "./mac-package-gate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

const run = (changedPaths, extra = {}) =>
  shouldRunMacPackageGate({ changedPaths, ...extra });

test("runs on the paths that actually broke Mac packaging", () => {
  // #943: the driver bump changed package.json and pnpm-lock.yaml.
  assert.deepEqual(run(["package.json", "pnpm-lock.yaml"]), {
    run: true,
    reason: "mac-packaging-path",
  });
  assert.deepEqual(run(["electron-builder.yml"]), { run: true, reason: "mac-packaging-path" });
  assert.deepEqual(run(["scripts/prepare-cua.mjs"]), { run: true, reason: "mac-packaging-path" });
  assert.deepEqual(run(["scripts/prepare-cua-linux.mjs"]), {
    run: true,
    reason: "mac-packaging-path",
  });
  // The post-merge build this gate pre-empts.
  assert.deepEqual(run([".github/workflows/mac-commit-build.yml"]), {
    run: true,
    reason: "mac-packaging-path",
  });
});

test("runs unconditionally for Renovate, whatever it touched", () => {
  // PR #919 was `app/renovate` on `renovate/non-major-dependencies`, and the
  // break arrived through a pnpm override rather than a path anyone would
  // have guessed to filter on.
  assert.deepEqual(run(["docs/whatever.md"], { actors: ["app/renovate"] }), {
    run: true,
    reason: "renovate",
  });
  assert.deepEqual(run(["src/App.tsx"], { actors: ["renovate[bot]"] }), {
    run: true,
    reason: "renovate",
  });
  assert.deepEqual(run(["README.md"], { headRef: "renovate/non-major-dependencies" }), {
    run: true,
    reason: "renovate",
  });
  // A human pushing a branch that merely mentions renovate must not trip it.
  assert.equal(run(["README.md"], { headRef: "minimax/renovate-notes" }).reason, "unrelated-paths");
});

test("skips unrelated pull requests", () => {
  assert.deepEqual(run(["docs/plans/something.md", "src/App.tsx"]), {
    run: false,
    reason: "unrelated-paths",
  });
});

test("fails closed when there is no changed-path information", () => {
  // The workflow emits an empty diff when it cannot resolve a base SHA.  A
  // skipped gate is the exact failure this change exists to prevent, so the
  // classifier answers by running.
  assert.deepEqual(run([]), { run: true, reason: "no-changed-path-information" });
  assert.deepEqual(run([null, undefined, ""]), {
    run: true,
    reason: "no-changed-path-information",
  });
});

test("widens the packaging predicate without narrowing the Linux one", () => {
  // ci.yml already consumes isPackagingPath; it must keep exactly the meaning
  // it had, or the Linux package job silently changes scope.
  assert.equal(isMacPackagingPath(".github/workflows/mac-commit-build.yml"), true);
  for (const path of ["package.json", "pnpm-lock.yaml", "electron-builder.yml", "electron/main.mjs", "scripts/prepare-cloudflared.mjs", "third_party/x"]) {
    assert.equal(isMacPackagingPath(path), true, path);
    assert.equal(isPackagingPath(path), true, path);
  }
  // mac-commit-build.yml is new to the Mac gate only.
  assert.equal(isPackagingPath(".github/workflows/mac-commit-build.yml"), false);
  // Rewiring the gate's own YAML must not cost a macOS runner; its logic lives
  // in scripts/mac-package-gate.mjs, which is tracked and unit-tested.
  assert.equal(isMacPackagingPath(".github/workflows/mac-package-gate.yml"), false);
});

test("the workflow classifies cheaply and packages only when told to", () => {
  const yml = read(".github/workflows/mac-package-gate.yml");
  // The header explains what the gate deliberately skips, so the "must not"
  // assertions below read the de-commented body.  Asserting against the raw
  // file would just match the prose describing the omission.
  const body = yml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

  // Must run on every pull request: a path filter would make this a required
  // check that never reports, which blocks a pull request forever.
  assert.match(yml, /pull_request:\n\s+types: \[opened, synchronize, reopened, ready_for_review]/);
  assert.doesNotMatch(body, /paths:/);

  assert.match(yml, /if: \$\{\{ needs\.scope\.outputs\.run == 'true' && !cancelled\(\) \}\}/);
  assert.match(yml, /runs-on: macos-14/);

  // Unsigned, and provably so.
  assert.match(body, /CSC_IDENTITY_AUTO_DISCOVERY:\s*"false"/);
  assert.match(body, /the gate build is signed/);
  // No certificate, no notarization, no artifact publication.
  assert.doesNotMatch(body, /security import/);
  assert.doesNotMatch(body, /notariz/i);
  assert.doesNotMatch(body, /MAC_CERT/);
  assert.doesNotMatch(body, /upload-artifact/);
  assert.doesNotMatch(body, /codesign --verify/);

  // Both #943 and #946 must be reachable from here.
  assert.match(body, /run: pnpm build:cua/);
  assert.match(body, /run: pnpm package:mac:local/);
  assert.match(body, /plutil -lint/);
  // Reuse the real installer rather than a divergent copy.
  assert.match(body, /pnpm install --frozen-lockfile/);
  assert.match(body, /rm -rf dist dist-server dist-native release/);
});

test("the workflow passes both identities Renovate can present", () => {
  const yml = read(".github/workflows/mac-package-gate.yml");
  assert.match(yml, /GATE_ACTORS: \$\{\{ github\.actor \}\},\$\{\{ github\.event\.pull_request\.user\.login \}\}/);
  assert.match(yml, /GATE_HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/);
});

test("the classifier never echoes a changed filename into GITHUB_OUTPUT", () => {
  // Pull requests control those bytes, so the reason must come from a fixed
  // set.  Same rule scripts/ci-change-scope.mjs follows.
  const src = read("scripts/mac-package-gate.mjs");
  const reasons = [...src.matchAll(/reason: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(new Set(reasons), new Set(["no-changed-path-information", "renovate", "mac-packaging-path", "unrelated-paths"]));
  assert.match(src, /Never echo a changed filename/);
});