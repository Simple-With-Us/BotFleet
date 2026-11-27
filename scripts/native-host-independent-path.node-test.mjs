// The optional native headless host is an independent artifact path.
//
// BF-2635: the optional host must never be able to block the standard signed
// GUI release.  The GUI release jobs archive the app, sign it, notarize it,
// staple it, package the ZIP and the DMG, verify the asset set and attach it
// to a draft;  none of them builds the host.  A step that packaged the host
// inside one of those jobs, or a `needs` that reached the job that does, would
// turn a host build failure into a GUI release failure, so this file holds the
// separation in place.
//
// The host is built by its own opt-in dispatch input, in a job of its own that
// nothing in the GUI release chain needs.  The first test below proves that on
// the parsed workflow rather than by looking for the packager's name anywhere
// in the file:  the name is in the file now, and only the job graph says
// whether the job that uses it can reach the release.
//
// The host keeps a path of its own: its own packager, its own receipt and its
// own opt-in smoke command.  The identity proof over synthetic binaries stays
// in the standard test chain, because a fixture costs nothing and says
// nothing about a shipped artifact.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");
const pkg = JSON.parse(read("package.json"));
const workflow = read(".github/workflows/native-mac-release.yml");

// The jobs that are the standard signed GUI release, in dependency order, and
// the jobs that exist only for the optional host.
const GUI_RELEASE_JOBS = ["mac-native", "assemble", "draft"];
const HOST_BUILD_JOB = "mac-native-host";
const HOST_ATTACH_JOB = "native-host-draft";
const HOST_JOBS = [HOST_BUILD_JOB, HOST_ATTACH_JOB];
// Every spelling by which a release step could build the host.  The alias is a
// second spelling of the same packaging smoke, so a step that called it by
// alias would build the host inside a release job while a literal check
// stayed quiet.
const HOST_PACKAGER_SPELLINGS = ["package-native-host", "native-host-package-smoke", "smoke:native-host-package"];
const needsOf = (job) => [job.needs ?? []].flat();

test("the standard signed GUI release never packages the optional host, and never depends on the job that does", () => {
  const parsed = parseYaml(workflow);
  // No GUI release job names the packager or the smoke, by any spelling.
  for (const name of GUI_RELEASE_JOBS) {
    const job = JSON.stringify(parsed.jobs[name]);
    for (const spelling of HOST_PACKAGER_SPELLINGS) {
      assert.ok(!job.includes(spelling), `${name} invokes the optional host ${spelling}`);
    }
  }
  // Nothing in the GUI release chain needs a host job.  A job that nothing in
  // the chain needs can be skipped or can fail without skipping or failing the
  // release, and a single edge here is all it would take to tie them.
  for (const name of GUI_RELEASE_JOBS) {
    for (const dependency of needsOf(parsed.jobs[name])) {
      assert.ok(!HOST_JOBS.includes(dependency), `${name} needs ${dependency}, so the optional host can skip or fail the GUI release`);
    }
  }
  // The host job itself needs nothing from the GUI release chain but the pin
  // every job shares, and it runs only when the dispatch asks for it.
  assert.deepEqual(needsOf(parsed.jobs[HOST_BUILD_JOB]), ["prepare"]);
  assert.equal(parsed.on["workflow_dispatch"].inputs["native-host"].default, false);
  assert.equal(parsed.jobs[HOST_BUILD_JOB].if, "${{ inputs.native-host }}");
  // The GUI release jobs still do the GUI release, so the assertions above are
  // about the optional host and not about a workflow that lost its jobs.
  const steps = parsed.jobs["mac-native"].steps.map((step) => String(step.name));
  assert.ok(steps.includes("Archive BotFleetMac"));
  assert.ok(steps.some((name) => name.includes("Notarize")));
  assert.ok(steps.some((name) => name.includes("Package the final ZIP and DMG")));
  assert.deepEqual(needsOf(parsed.jobs.assemble), ["prepare", "mac-native"]);
  assert.deepEqual(needsOf(parsed.jobs.draft), ["prepare", "assemble"]);
});

test("the native host artifact joins a release only after both the host job and the app's draft job succeeded", () => {
  const attach = parseYaml(workflow).jobs[HOST_ATTACH_JOB];
  assert.deepEqual([...needsOf(attach)].sort(), ["draft", HOST_BUILD_JOB, "prepare"]);
  // `!cancelled()` is what lets a job be evaluated at all after a skipped
  // dependency.  Without the two result checks a failed host job would be
  // skipped past in silence, and `always()` alone would run the job after one.
  assert.match(attach.if, /!cancelled\(\)/);
  assert.doesNotMatch(attach.if, /always\(\)/);
  assert.match(attach.if, /inputs\.native-host/);
  assert.match(attach.if, /inputs\.draft && !inputs\.unsigned-draft/);
  assert.match(attach.if, /needs\.mac-native-host\.result == 'success'/);
  assert.match(attach.if, /needs\.draft\.result == 'success'/);
  assert.equal(attach.permissions.contents, "write");
});

test("the native host jobs produce and publish the artifact only, and fail honestly", () => {
  const parsed = parseYaml(workflow);
  const jobs = HOST_JOBS.map((name) => parsed.jobs[name]);
  const text = JSON.stringify(jobs);
  // Nothing is installed, registered with launchd, or started:  the packaged
  // executable is never run, and no service root is ever passed to it.
  for (const forbidden of ["launchctl", "LaunchAgents", "LaunchDaemons", "launchd", "--service-data", "sudo", "--identity"]) {
    assert.ok(!text.includes(forbidden), `a native host job names ${forbidden}`);
  }
  // The only repository scripts either job runs are the packager and the
  // verifier that checks what the packager produced.
  const invoked = [...new Set([...text.matchAll(/node (scripts\/[A-Za-z0-9./-]+)/g)].map((match) => match[1]))];
  assert.deepEqual(invoked, ["scripts/package-native-host.mjs", "scripts/verify-native-host-artifact.mjs"]);
  // Only a distributable artifact is produced;  the unsigned development
  // package is a local probe and never what a release run builds.
  assert.doesNotMatch(text, /--unsigned-dev/);
  // A failure inside either job fails that job:  no step is allowed to fail
  // without failing the job, no status is swallowed, and an upload with
  // nothing to upload is an error.
  for (const job of jobs) {
    assert.equal(job["continue-on-error"], undefined, `${job.name} swallows its own failure`);
    const verify = job.steps.find((step) => step.id === "verify");
    if (verify) assert.match(verify.run, /\|\| \{\s*\n\s*echo "::error::[^"]+"; exit 1; \}/);
    for (const step of job.steps) {
      assert.equal(step["continue-on-error"], undefined, `${job.name}: ${step.name} may fail without failing the job`);
      if (step.run) assert.doesNotMatch(step.run, /\|\| *(true|:)\s*$/m, `${job.name}: ${step.name} swallows a status`);
    }
    for (const step of job.steps.filter((entry) => String(entry.uses).startsWith("actions/upload-artifact"))) {
      assert.equal(step.with["if-no-files-found"], "error");
    }
  }
});

test("the optional host is produced by its own opt-in command, with its own receipt", () => {
  assert.equal(pkg.scripts["smoke:native-host-package"], "node scripts/native-host-package-smoke.mjs");
  const packager = read("scripts/package-native-host.mjs");
  assert.ok(packager.includes("artifact.json"), "the packager writes no receipt of its own");
  assert.ok(packager.includes('"wx"'), "the packager may overwrite a receipt it already wrote");
  // The exclusive flag has to belong to the receipt write itself.  A packager
  // that truncates the receipt while using "wx" for an unrelated file would
  // still pass the two checks above.
  assert.match(packager, /writeFileSync\([^;]*?artifact\.json[^;]*?["']wx["']/,
    "the packager writes the receipt without an exclusive create flag");
});

test("the standard test chain proves the host identity without building the host artifact", () => {
  assert.ok(pkg.scripts["test:native-release"].includes("scripts/native-host-artifact.node-test.mjs"));
  assert.ok(pkg.scripts.test.includes("pnpm test:native-release"));
  // The real packaging smoke builds the host for both slices, so it stays out
  // of the chain every pull request runs: a host build failure must not fail
  // CI for a change that never touches the host.
  assert.ok(!pkg.scripts.test.includes("smoke:native-host-package"));
  // The standard chain reaches the release tests through test:native-release,
  // so the same rule is proved there: the chain may run the packaging smoke's
  // own unit test file, which never builds the host, but it must never run
  // the packaging smoke itself, by alias or by script path.
  const nativeReleaseChain = pkg.scripts["test:native-release"];
  const chainWithoutSmokeUnitTests = nativeReleaseChain.replaceAll("scripts/native-host-package-smoke.node-test.mjs", "");
  assert.ok(!chainWithoutSmokeUnitTests.includes("smoke:native-host-package"),
    "the standard test chain runs the optional host packaging smoke alias through test:native-release");
  assert.ok(!chainWithoutSmokeUnitTests.includes("native-host-package-smoke.mjs"),
    "the standard test chain runs the optional host packaging smoke script through test:native-release");
  assert.ok(!chainWithoutSmokeUnitTests.includes("native-host-package-smoke"),
    "the standard test chain runs the optional host packaging smoke through test:native-release");
});
