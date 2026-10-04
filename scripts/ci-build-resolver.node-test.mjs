import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  artifactNameFor,
  classifyResolutionFailure,
  downloadBuiltBundle,
  findCommitArtifact,
  manifestArtifactName,
  materializeBuild,
  ResolutionError,
  selectCommitRun,
  updateSourcePolicy,
  verifyManifest,
} from "./ci-build-resolver.mjs";

const run = promisify(execFile);
const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPO = "jaywedgeworth22/BotFleet";

function json(body, status = 200) {
  return async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
}

// Shaped like a real Actions API response: the resolver checks these fields
// before reading any of them.
const aRun = (fields) => ({
  id: 1,
  head_sha: COMMIT,
  status: "completed",
  conclusion: "success",
  event: "push",
  ...fields,
});
const anArtifact = (fields) => ({
  id: 1,
  name: artifactNameFor(COMMIT),
  expired: false,
  archive_download_url: "https://api.github.com/artifacts/1/zip",
  ...fields,
});
const successfulRuns = { workflow_runs: [aRun({})] };

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "ci-resolver-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return dir;
}

test("the hosted build is the default, and the bypass is explicit", () => {
  // The owner's 2026-10-01 ruling is that CI builds, always.  A default of
  // "local" would make the ruling opt-in and quietly restore the 15-minute
  // packaging that caused the outages.
  assert.equal(updateSourcePolicy({}), "ci");
  assert.equal(updateSourcePolicy({ BOTFLEET_UPDATE_SOURCE: "CI" }), "ci");
  assert.equal(updateSourcePolicy({ BOTFLEET_UPDATE_SOURCE: " auto " }), "auto");
  assert.equal(updateSourcePolicy({ BOTFLEET_UPDATE_SOURCE: "local" }), "local");
  assert.throws(() => updateSourcePolicy({ BOTFLEET_UPDATE_SOURCE: "github" }), /must be ci, auto, or local/);
});

test("a missing build, a throttled API, and a flaky network are three different problems", () => {
  // Collapsing these is the failure mode this resolver exists to avoid: the
  // operator's response to "CI never built this" and "GitHub was briefly
  // unreachable" are completely different, and only the first is safe to fall
  // back from.
  assert.equal(classifyResolutionFailure({ status: 404 }), "no-build");
  assert.equal(classifyResolutionFailure({ status: 429 }), "rate-limited");
  assert.equal(classifyResolutionFailure({ status: 403 }), "rate-limited");
  assert.equal(classifyResolutionFailure({ status: 401 }), "unauthorized");
  assert.equal(classifyResolutionFailure({ status: 503 }), "github-unavailable");
  assert.equal(classifyResolutionFailure({ timedOut: true }), "network-timed-out");
  assert.equal(classifyResolutionFailure({ spawnError: new Error("ENOTFOUND") }), "network-failed");
});

test("only a successful run for this exact commit is usable", () => {
  // A run for a different commit, a failed run, or a run from another event is
  // not a build of what we are about to install.
  assert.equal(selectCommitRun(successfulRuns.workflow_runs, COMMIT)?.id, 1);
  assert.equal(selectCommitRun(successfulRuns.workflow_runs, OTHER), null);
  assert.equal(selectCommitRun([aRun({ id: 2, conclusion: "failure" })], COMMIT), null);
  assert.equal(selectCommitRun([aRun({ id: 3, event: "schedule" })], COMMIT), null);
  assert.equal(selectCommitRun([aRun({ id: 4, conclusion: null, status: "in_progress" })], COMMIT), null);
  // A malformed entry is skipped rather than read: `conclusion: "success"` on an
  // object with no `id` is not a run we can download from.
  assert.equal(selectCommitRun([{ head_sha: COMMIT, conclusion: "success", event: "push" }], COMMIT), null);
  assert.equal(selectCommitRun("not an array", COMMIT), null);
  assert.equal(selectCommitRun([], COMMIT), null);
  assert.equal(selectCommitRun(undefined, COMMIT), null);
});

test("an expired artifact is not an artifact", () => {
  assert.equal(findCommitArtifact([anArtifact({})], COMMIT)?.name, artifactNameFor(COMMIT));
  // 30-day retention means this is a real, reachable state for a Mac that was
  // off for a month, and it must read as "no build", never as a valid one.
  assert.equal(findCommitArtifact([anArtifact({ expired: true })], COMMIT), null);
  assert.equal(findCommitArtifact([anArtifact({ name: "botfleet-mac-somethingelse" })], COMMIT), null);
  assert.equal(findCommitArtifact([{ name: artifactNameFor(COMMIT) }], COMMIT), null, "no download url is not an artifact");
  assert.equal(findCommitArtifact("not an array", COMMIT), null);
});

test("a manifest is only accepted for the commit that was asked for, with matching bytes", () => {
  const bytes = Buffer.from("pretend this is a zip");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const manifest = { schemaVersion: 1, commit: COMMIT, artifact: "BotFleet-mac-arm64.zip", sha256: digest };
  const verified = verifyManifest(manifest, { commit: COMMIT, bytes });
  assert.equal(verified.verifiedBytes, bytes.length);

  // The case that matters most: a perfectly signed build of the WRONG commit
  // would pass the caller's signature check, because the signature is valid —
  // it is just for another build.
  assert.throws(
    () => verifyManifest(manifest, { commit: OTHER, bytes }),
    (error) => error instanceof ResolutionError && /names commit/.test(error.message),
  );
  assert.throws(
    () => verifyManifest({ ...manifest, sha256: "0".repeat(64) }, { commit: COMMIT, bytes }),
    (error) => error.cause === "checksum-mismatch",
  );
  assert.throws(
    () => verifyManifest({ ...manifest, schemaVersion: 99 }, { commit: COMMIT, bytes }),
    (error) => error.cause === "bad-manifest",
  );
  assert.throws(
    () => verifyManifest({ ...manifest, artifact: "BotFleet.app" }, { commit: COMMIT, bytes }),
    (error) => error.cause === "bad-manifest",
  );
});

test("a commit with no hosted build says so, and says how to make one", async (t) => {
  await assert.rejects(
    downloadBuiltBundle({ commit: COMMIT, destination: await fixture(t), fetchImpl: json({ workflow_runs: [] }) }),
    (error) => {
      assert.ok(error instanceof ResolutionError);
      assert.equal(error.cause, "no-build");
      // An operator must be able to act on this without reading the source.
      assert.match(error.message, /gh workflow run mac-commit-build\.yml/);
      assert.match(error.message, /BOTFLEET_UPDATE_SOURCE=local/);
      assert.match(error.message, new RegExp(COMMIT));
      return true;
    },
  );
});

test("a target that is not a full commit is refused before any request", async (t) => {
  let called = false;
  await assert.rejects(
    downloadBuiltBundle({
      commit: "abc1234",
      destination: await fixture(t),
      fetchImpl: async () => { called = true; return json({}); },
    }),
    (error) => error.cause === "bad-target",
  );
  assert.equal(called, false, "must not hit the network with an ambiguous target");
});

test("a throttled API is reported as a budget, not as a missing build", async (t) => {
  // Falling back to a local package here would turn a 60-request/hour limit
  // into a silent 15-minute build and hide the real cause.
  await assert.rejects(
    downloadBuiltBundle({
      commit: COMMIT,
      destination: await fixture(t),
      fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }),
    }),
    (error) => {
      assert.equal(error.cause, "rate-limited");
      assert.match(error.message, /NOT a missing build|budget/i);
      return true;
    },
  );
});

test("the artifact name is a name, never a path out of the scratch directory", () => {
  // The manifest arrives over the network and its `artifact` field is the one
  // value that becomes a filesystem path, so it is refused unless it is a plain
  // basename.  The sha256 check still guards the bytes.
  assert.equal(manifestArtifactName({ artifact: "BotFleet-mac-arm64.zip" }), "BotFleet-mac-arm64.zip");
  for (const name of [
    "../../../../somewhere/evil.zip",
    "/etc/evil.zip",
    "nested/dir/evil.zip",
    "..",
    "BotFleet.app",
    "",
    null,
  ]) {
    assert.throws(
      () => manifestArtifactName({ artifact: name }),
      (error) => error instanceof ResolutionError && error.cause === "bad-manifest",
      `${JSON.stringify(name)} must not become a path`,
    );
  }

  // Verification applies the same rule, so a manifest cannot pass here and only
  // be refused later at the path `materializeBuild` builds from it.
  const bytes = Buffer.from("pretend this is a zip");
  const digest = createHash("sha256").update(bytes).digest("hex");
  assert.throws(
    () => verifyManifest({ schemaVersion: 1, commit: COMMIT, artifact: "../../evil.zip", sha256: digest }, { commit: COMMIT, bytes }),
    (error) => error.cause === "bad-manifest",
  );
});

test("a client error the server will keep returning is not retried", async (t) => {
  // A 410 cannot become a 200 by waiting, so all three attempts would only
  // delay the real reason by 15 seconds and the backoff sleeps between them.
  let calls = 0;
  const responses = [
    async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => successfulRuns };
    },
    async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          artifacts: [{ id: 9, name: artifactNameFor(COMMIT), expired: false, archive_download_url: "https://example.test/a.zip" }],
        }),
      };
    },
    async () => {
      calls += 1;
      return { ok: false, status: 410, arrayBuffer: async () => new ArrayBuffer(0) };
    },
  ];
  await assert.rejects(
    downloadBuiltBundle({ commit: COMMIT, destination: await fixture(t), fetchImpl: () => responses.shift()() }),
    (error) => {
      assert.ok(error instanceof ResolutionError);
      assert.match(error.message, /HTTP 410/);
      return true;
    },
  );
  // Two lookups plus exactly one download attempt: the third attempt, and both
  // backoff sleeps, are the part the fatal flag removes.
  assert.equal(calls, 3);
});

test("a manifest artifact name is reduced to a basename before it becomes a path", () => {
  // The name is concatenated into a filesystem path, so a traversal is the case
  // that matters; requiring a plain basename is the whole defence.
  const bytes = Buffer.from("pretend this is a zip");
  const manifest = {
    schemaVersion: 1,
    commit: COMMIT,
    artifact: "BotFleet-mac-arm64.zip",
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  for (const name of ["../../../../tmp/evil.zip", "nested/BotFleet.zip", "/abs/BotFleet.zip", ".zip"]) {
    assert.throws(
      () => verifyManifest({ ...manifest, artifact: name }, { commit: COMMIT, bytes }),
      (error) => error.cause === "bad-manifest",
      `${name} must be refused`,
    );
  }
  assert.ok(verifyManifest(manifest, { commit: COMMIT, bytes }).artifact === "BotFleet-mac-arm64.zip");
});

test("materialising a verified build produces a real app directory", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("needs ditto with --sequesterRsrc, which is macOS only");
    return;
  }
  const scratch = await fixture(t);
  const staging = join(scratch, "staging");
  await run("mkdir", ["-p", join(scratch, "inner", "BotFleet.app", "Contents", "Resources")]);
  await run("sh", ["-c", 'echo staged > "$1/Contents/Resources/marker.txt"', "_", join(scratch, "inner", "BotFleet.app")]);

  // Build the two-level shape GitHub actually produces: the artifact wrapper
  // holds the manifest and the bundle zip, and the bundle zip holds the app.
  const innerZip = join(scratch, "BotFleet-mac-arm64.zip");
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", join(scratch, "inner", "BotFleet.app"), innerZip]);
  const innerBytes = await readFile(innerZip);
  const manifest = {
    schemaVersion: 1,
    commit: COMMIT,
    artifact: "BotFleet-mac-arm64.zip",
    sha256: createHash("sha256").update(innerBytes).digest("hex"),
  };

  // GitHub nests every entry under a directory named for the artifact, which is
  // why the resolver extracts with -j.  Reproduce that here or the test proves
  // nothing about the real artifact layout.
  const wrapperRoot = join(scratch, "wrapper");
  const wrapperDir = join(wrapperRoot, artifactNameFor(COMMIT));
  await run("mkdir", ["-p", wrapperDir]);
  await writeFile(join(wrapperDir, "BotFleet-mac-arm64.zip"), innerBytes);
  await writeFile(join(wrapperDir, "build-manifest.json"), JSON.stringify(manifest));
  await run("zip", ["-q", "-r", join(scratch, "artifact.zip"), artifactNameFor(COMMIT)], { cwd: wrapperRoot });
  const artifactBytes = await readFile(join(scratch, "artifact.zip"));

  const destination = join(staging, "hosted");
  const built = await materializeBuild({ artifactBytes, commit: COMMIT, destination, manifest });
  assert.equal(built.appPath, join(destination, "BotFleet.app"));
  assert.ok((await stat(built.appPath)).isDirectory());
  // The resource fork is why `ditto` is used instead of a plain unzip: a build
  // that lost it would differ from a locally built one invisibly.
  assert.equal((await readFile(join(built.appPath, "Contents/Resources/marker.txt"), "utf8")).trim(), "staged");

  // A second attempt must replace rather than merge into the previous unpack.
  await writeFile(join(built.appPath, "Contents/Resources/marker.txt"), "second\n");
  await materializeBuild({ artifactBytes, commit: COMMIT, destination, manifest });
  assert.equal((await readFile(join(built.appPath, "Contents/Resources/marker.txt"), "utf8")).trim(), "staged");
});

test("a run that did not succeed is a build failure, not a GitHub outage", async (t) => {
  // Reporting this as a GitHub-side problem sent the operator to retry
  // something retrying cannot fix, and blocked the `auto` fallback.
  for (const [fields, label] of [
    [{ conclusion: "failure", status: "completed" }, "failure"],
    [{ conclusion: "cancelled", status: "completed" }, "cancelled"],
    [{ conclusion: null, status: "in_progress" }, "still running"],
  ]) {
    await assert.rejects(
      downloadBuiltBundle({
        commit: COMMIT,
        destination: await fixture(t),
        fetchImpl: json({ workflow_runs: [aRun({ id: 9, ...fields })] }),
      }),
      (error) => {
        assert.equal(error.cause, "build-failed", `${label} must not read as a GitHub outage`);
        assert.match(error.message, /did not succeed/);
        assert.match(error.message, new RegExp(label));
        assert.match(error.message, /BOTFLEET_UPDATE_SOURCE=local/);
        assert.doesNotMatch(error.message, /GitHub returned HTTP/);
        return true;
      },
    );
  }
});
