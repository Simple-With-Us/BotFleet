import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  artifactNameFor,
  assertExtractedBundleContained,
  assertSafeArchiveEntries,
  authHeaders,
  BUNDLE_ROOT,
  classifyResolutionFailure,
  downloadBuiltBundle,
  findCommitArtifact,
  inspectArchive,
  listUpdateCandidates,
  manifestArtifactName,
  readInstalledSourceCommit,
  readSymlinkTargets,
  maskedKeyPreview,
  materializeBuild,
  resetGhAuthCacheForTests,
  ResolutionError,
  selectCommitRun,
  selectNewestGreenCommit,
  selectUpdateTarget,
  SELECTION_WINDOW,
  updateSourcePolicy,
  verifyManifest,
} from "./ci-build-resolver.mjs";

const run = promisify(execFile);
const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
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

test("an archive whose entries would escape the destination is refused", () => {
  // The manifest's `artifact` FILENAME is checked to be a basename, but that
  // says nothing about the archive's own entry names — and an entry called
  // ../../.ssh/authorized_keys is the actual Zip Slip vector.  Judging type
  // from the archive rather than the name matters too: `__MACOSX/._*` sidecars
  // are legitimate (they carry the resource fork --sequesterRsrc exists to
  // preserve) and are ordinary files, so a name-based rule would refuse every
  // real build.
  const entry = (name, mode = "-rw-r--r--") => ({ name, mode });
  const directory = (name) => entry(name, "drwxr-xr-x");

  // A genuine app bundle, sidecars and all, is fine.
  assert.doesNotThrow(() => assertSafeArchiveEntries([
    directory("BotFleet.app/"),
    directory("__MACOSX/"),
    entry("BotFleet.app/Contents/MacOS/BotFleet"),
    entry("__MACOSX/BotFleet.app/._BotFleet"),
  ], { label: "app bundle" }));

  for (const [name, why] of [
    ["../../../../.ssh/authorized_keys", "traverses out of the destination"],
    ["BotFleet.app/../../escape", "traverses out of the destination"],
    ["/etc/authorized_keys", "absolute path"],
    ["BotFleet.app/Contents/link", "symlink entry"],
  ]) {
    const mode = why === "symlink entry" ? "lrwxrwxrwx" : "-rw-r--r--";
    assert.throws(
      () => assertSafeArchiveEntries([entry(name, mode)], { label: "app bundle" }),
      (error) => {
        assert.equal(error.cause, "unsafe-archive");
        assert.match(error.message, new RegExp(why), `"${name}" must be refused as ${why}`);
        return true;
      },
    );
  }
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

test("an entry name crafted to defeat a column parser is still checked", () => {
  // The first version of the guard parsed `zipinfo -l` with a regex over the
  // mode/size/version/os/flags/date/time columns.  A name containing something
  // that broke the pattern made the WHOLE LINE unparseable, and unparseable
  // lines were skipped — so a traversal could be hidden by being shaped to look
  // unparseable.  The guard now takes names from `zipinfo -1`, one per line,
  // where there are no columns to get wrong, and matches types by name.
  const entries = [
    { name: "BotFleet.app/Contents/MacOS/BotFleet", mode: "-rwxr-xr-x" },
    { name: "../../../../.ssh/authorized_keys", mode: "-rw-r--r--" },
    { name: "  leading-whitespace-evil.zip", mode: "-rw-r--r--" },
    { name: "tabs\tand  spaces/BotFleet.app", mode: "-rw-r--r--" },
  ];
  // Every one of them reaches the checker, whatever their shape.
  for (const { name } of entries) {
    const label = JSON.stringify(name);
    assert.throws(
      () => assertSafeArchiveEntries(entries, { label }),
      (error) => {
        assert.equal(error.cause, "unsafe-archive", `${label} must be refused`);
        assert.match(error.message, new RegExp(escapeForRegExp(label)), `${label} must be named in the refusal`);
        return true;
      },
    );
  }
  // And the shape that must NOT be refused: an ordinary bundle with sidecars.
  assert.doesNotThrow(() => assertSafeArchiveEntries([
    { name: "BotFleet.app/Contents/MacOS/BotFleet", mode: "-rwxr-xr-x" },
    { name: "__MACOSX/BotFleet.app/._BotFleet", mode: "-rw-r--r--" },
  ], { label: "app bundle" }));
});

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("authHeaders falls back to gh auth token when env tokens are absent", () => {
  resetGhAuthCacheForTests();
  const GH_PREFIX = "ghp";
  const cliToken = [GH_PREFIX, "cli_fallback_token_0123456789abcd"].join("_");
  let ghCalls = 0;
  const execFileSyncImpl = (command, args) => {
    ghCalls += 1;
    assert.equal(command, "gh");
    assert.deepEqual(args, ["auth", "token"]);
    return `${cliToken}\n`;
  };
  assert.deepEqual(authHeaders({}, { execFileSyncImpl }), { authorization: `Bearer ${cliToken}` });
  assert.equal(ghCalls, 1, "gh is consulted once and then cached");
  assert.deepEqual(authHeaders({}, { execFileSyncImpl }), { authorization: `Bearer ${cliToken}` });
  assert.equal(ghCalls, 1, "the cached token is reused");
});

test("authHeaders skips gh when an env token is present", () => {
  resetGhAuthCacheForTests();
  const execFileSyncImpl = () => {
    throw new Error("gh must not run when GITHUB_TOKEN is set");
  };
  assert.deepEqual(
    authHeaders({ GITHUB_TOKEN: "env-only-token" }, { execFileSyncImpl }),
    { authorization: "Bearer env-only-token" },
  );
  assert.deepEqual(
    authHeaders({ GH_TOKEN: "gh-env-token" }, { execFileSyncImpl }),
    { authorization: "Bearer gh-env-token" },
  );
});

test("authHeaders swallows gh failures and leaves authorization unset", () => {
  resetGhAuthCacheForTests();
  const execFileSyncImpl = (command) => {
    throw new Error(`${command} unavailable`);
  };
  assert.deepEqual(authHeaders({}, { execFileSyncImpl }), {});
});

test("an artifact download 401 names the commit and explains token setup", async (t) => {
  resetGhAuthCacheForTests();
  const execFileSyncImpl = () => {
    throw new Error("no gh in this fixture");
  };
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (calls === 1) {
      return { ok: true, status: 200, json: async () => successfulRuns };
    }
    if (calls === 2) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ artifacts: [anArtifact({})] }),
      };
    }
    return { ok: false, status: 401, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await assert.rejects(
    downloadBuiltBundle({
      commit: COMMIT,
      destination: await fixture(t),
      fetchImpl,
      env: {},
      execFileSyncImpl,
    }),
    (error) => {
      assert.equal(error.cause, "unauthorized");
      assert.match(error.message, new RegExp(COMMIT));
      assert.match(error.message, /gh auth login/);
      assert.match(error.message, /GITHUB_TOKEN/);
      assert.doesNotMatch(error.message, /public repo/);
      assert.doesNotMatch(error.message, /not a full commit/);
      return true;
    },
  );
  assert.equal(calls, 3, "two lookups plus one download attempt");
});

test("a rejected key is named by a masked preview, never printed", async () => {
  // A 401 that cannot say WHICH key was rejected is not a diagnosis, and the
  // answer must never be the key itself.
  assert.equal(maskedKeyPreview({}), null);
  assert.equal(maskedKeyPreview({ authorization: "Bearer " }), null);
  assert.equal(maskedKeyPreview({ authorization: "Bearer ghp_short" }), "a key too short to identify safely");
  // Assembled, never written literally: a token-SHAPED string in source is a
  // real token to a secret scanner and to every future one, and inventing "this
  // one is fake" is not a property the file can carry.  Same characters, same
  // assertions, no literal for gitleaks to find.
  const GH_PREFIX = "ghp";
  const sampleKey = [GH_PREFIX, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("_");
  assert.equal(
    maskedKeyPreview({ authorization: `Bearer ${sampleKey}` }),
    `${GH_PREFIX}_ABCD…6789`,
  );

  const token = [GH_PREFIX, "rejectedsessionkey0123456789abcd"].join("_");
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(
    () => downloadBuiltBundle({ commit: COMMIT, fetchImpl, env: { GITHUB_TOKEN: token } }),
    (error) => {
      assert.equal(error.cause, "unauthorized");
      assert.match(error.message, new RegExp(`${GH_PREFIX}_reje…abcd`));
      assert.equal(error.message.includes(token), false, "the whole key must never reach the message");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// In-bundle framework symlinks.
//
// On 2026-10-08 the safe updater refused the green hosted build of main
// 8ccf02725, because the guard treated every symlink as a Zip Slip.  A real
// Electron bundle always carries framework links, so the hosted path could
// never install a real build.  These tests pin the replacement rule: links
// strictly inside BotFleet.app/ with relative, non-climbing targets are
// accepted.  Every way a link could carry a write or a resolution out of the
// bundle is still refused.

const FW = `${BUNDLE_ROOT}/Contents/Frameworks`;
const fileEntry = (name) => ({ name, mode: "-rw-r--r--" });
const dirEntry = (name) => ({ name, mode: "drwxr-xr-x" });
const linkEntry = (name, target) => ({ name, mode: "lrwxr-xr-x", target });

/** The entry list ditto produces for one framework, sidecars included. */
function frameworkEntries(framework = "Squirrel", binary = framework) {
  const root = `${FW}/${framework}.framework`;
  return [
    dirEntry(`${BUNDLE_ROOT}/`),
    dirEntry(`${BUNDLE_ROOT}/Contents/`),
    dirEntry(`${FW}/`),
    dirEntry(`${root}/`),
    dirEntry(`${root}/Versions/`),
    dirEntry(`${root}/Versions/A/`),
    dirEntry(`${root}/Versions/A/Resources/`),
    fileEntry(`${root}/Versions/A/${binary}`),
    fileEntry(`${root}/Versions/A/Resources/Info.plist`),
    linkEntry(`${root}/Versions/Current`, "A"),
    linkEntry(`${root}/Resources`, "Versions/Current/Resources"),
    linkEntry(`${root}/${binary}`, `Versions/Current/${binary}`),
    // ditto writes a sidecar for a link too.  It is an ordinary file under
    // __MACOSX/, not an entry under the link.
    fileEntry(`__MACOSX/${root}/Versions/._Current`),
  ];
}

function assertRefused(entries, why, message) {
  assert.throws(
    () => assertSafeArchiveEntries(entries, { label: "app bundle", symlinkRoot: BUNDLE_ROOT }),
    (error) => {
      assert.equal(error.cause, "unsafe-archive", message);
      assert.match(error.message, why, message);
      return true;
    },
    message,
  );
}

test("in-bundle framework links are accepted, and only inside the bundle", () => {
  // The shape of the real 8ccf02725 bundle, including a framework whose name
  // has a space in it.
  const real = [...frameworkEntries("Squirrel"), ...frameworkEntries("Electron Framework").slice(3)];
  assert.doesNotThrow(() => assertSafeArchiveEntries(real, { label: "app bundle", symlinkRoot: BUNDLE_ROOT }));

  // GitHub's wrapper is checked with no symlinkRoot, and there even a
  // well-formed link is refused, exactly as before.
  assert.throws(
    () => assertSafeArchiveEntries(real, { label: "artifact" }),
    (error) => error.cause === "unsafe-archive" && /symlink entry/.test(error.message),
  );
});

test("a link whose target is absolute, climbs, or cannot be read is refused", () => {
  const base = frameworkEntries();
  for (const [target, why] of [
    ["/etc", /absolute target/],
    ["/Users/someone/.ssh", /absolute target/],
    ["../../../../../../outside", /climbs with \.\./],
    // A sibling of the bundle: `<destination>/Sibling.app`.
    ["../../../Sibling.app/Contents", /climbs with \.\./],
    // The lexical trap.  `b -> ..` looks contained, and `c -> b/../x` looks
    // contained, but the kernel applies `..` after following `b`, so `c`
    // lands outside the bundle.  Refusing every `..` refuses both halves.
    ["..", /climbs with \.\./],
    ["b/../x", /climbs with \.\./],
    ["", /empty target/],
    ["A\0/x", /contains NUL/],
    [undefined, /could not be read/],
  ]) {
    assertRefused(
      [...base, linkEntry(`${BUNDLE_ROOT}/Contents/escape`, target)],
      why,
      `a link to ${JSON.stringify(target)} must be refused`,
    );
  }
});

test("a link outside BotFleet.app is refused, wherever it sits", () => {
  const base = frameworkEntries();
  for (const name of ["Sibling", "__MACOSX/BotFleet.app/Contents/link"]) {
    assertRefused([...base, linkEntry(name, "A")], /outside BotFleet\.app\//, `${name} must be refused`);
  }
  // The bundle itself as a link would make every other entry a write through
  // it, to wherever it points.
  assertRefused([linkEntry(BUNDLE_ROOT, "Contents")], /outside BotFleet\.app\//, "the bundle itself as a link");
  assertRefused([...base, linkEntry("botfleet.APP", "Contents")], /duplicate entry/, "a case-variant bundle link collides with the bundle");
});

test("nothing may be written through a link, however the name is spelled", () => {
  const base = frameworkEntries();
  const current = `${FW}/Squirrel.framework/Versions/Current`;
  for (const name of [
    `${current}/payload`,
    `${current}/nested/dir/`,
    // APFS is case-insensitive, so this lands inside `Versions/Current`.
    `${BUNDLE_ROOT.toLowerCase()}/contents/frameworks/squirrel.framework/VERSIONS/current/payload`,
  ]) {
    assertRefused([...base, fileEntry(name)], /written through the symlink entry/, `${name} must be refused`);
  }

  // APFS is normalization-insensitive too.  A link spelled with a composed é
  // and a payload spelled with a decomposed one are the same directory.
  assertRefused(
    [...base, linkEntry(`${BUNDLE_ROOT}/Contents/café`, "Frameworks"), fileEntry(`${BUNDLE_ROOT}/Contents/café/payload`)],
    /written through the symlink entry/,
    "a normalization-variant spelling must still be caught",
  );
});

test("duplicates, climbing directories, and special files are refused", () => {
  const base = frameworkEntries();
  assertRefused(
    [...base, fileEntry(`${BUNDLE_ROOT}/contents/frameworks/SQUIRREL.framework/Versions/A/Squirrel`)],
    /duplicate entry/,
    "a case-folded duplicate would replace the first copy",
  );
  // Directory entries used to be skipped outright, so a climbing directory was
  // never looked at.
  assertRefused([...base, dirEntry(`${BUNDLE_ROOT}/../../escape/`)], /traverses out of the destination/, "a climbing directory");
  assertRefused([...base, dirEntry("/abs/dir/")], /absolute path/, "an absolute directory");
  assertRefused([...base, { name: `${BUNDLE_ROOT}/Contents/fifo`, mode: "prw-r--r--" }], /FIFO/, "a FIFO entry");
});

// Reading targets.  A per-read timeout alone let 256 links read one after
// another hold the updater lock for over two hours, so the reads share one
// wall-clock budget and run a few at a time.

const manyLinks = (count) => Array.from({ length: count }, (_, index) => linkEntry(`${FW}/L${index}.framework/Versions/Current`, undefined));

/** A stand-in reader that records how many reads are in flight at once. */
function trackingReader(settle) {
  const seen = { calls: 0, inFlight: 0, maxInFlight: 0, timeouts: [] };
  const read = (_archive, name, timeoutMs) => {
    seen.calls += 1;
    seen.inFlight += 1;
    seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
    seen.timeouts.push(timeoutMs);
    return settle(name, timeoutMs).finally(() => {
      seen.inFlight -= 1;
    });
  };
  return { read, seen };
}

test("a read that hangs forever still hits the overall budget, and the archive is refused", async () => {
  // This reader ignores its timeout entirely and never settles.  Only the
  // shared deadline can end the wait.
  const { read, seen } = trackingReader(() => new Promise(() => {}));
  const started = Date.now();
  await assert.rejects(
    readSymlinkTargets("unused.zip", manyLinks(256), { budgetMs: 150, readTarget: read }),
    (error) => {
      assert.equal(error.cause, "unsafe-archive");
      assert.match(error.message, /256 symlink targets took longer than 150ms/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 5_000, "the budget, not 256 per-read timeouts, bounds the wait");
  assert.equal(seen.maxInFlight, 8, "no more than eight reads run at once");
  assert.equal(seen.calls, 8, "no new read starts once the budget is spent");
});

test("slow reads that honour their timeouts cannot stretch the budget either", async () => {
  // This reader behaves like runBoundedText: it gives up when its timeout
  // passes.  Every timeout it is handed must fit inside what is left of the
  // budget, so the last read cannot run past the deadline.
  const { read, seen } = trackingReader((_name, timeoutMs) => new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error("killed at its timeout")), timeoutMs);
  }));
  const started = Date.now();
  await assert.rejects(
    readSymlinkTargets("unused.zip", manyLinks(256), { budgetMs: 200, readTarget: read }),
    (error) => error.cause === "unsafe-archive" && /took longer than 200ms/.test(error.message),
  );
  assert.ok(Date.now() - started < 5_000);
  assert.ok(seen.maxInFlight <= 8);
  assert.ok(seen.timeouts.every((ms) => ms > 0 && ms <= 200), `every read fits inside the budget: ${seen.timeouts}`);
});

test("link targets are read in parallel, and a pattern-shaped name is never handed to unzip", async () => {
  const { read, seen } = trackingReader(async (name) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return `target-of-${name.split("/").at(-3)}`;
  });
  const entries = [...manyLinks(20), linkEntry(`${FW}/W[1].framework/Versions/Current`, undefined), fileEntry(`${FW}/plain`)];
  await readSymlinkTargets("unused.zip", entries, { readTarget: read });
  assert.equal(seen.calls, 20, "the wildcard-named link is not read, and plain files never are");
  assert.equal(seen.maxInFlight, 8);
  assert.equal(entries[0].target, "target-of-L0.framework");
  assert.equal(entries[19].target, "target-of-L19.framework");
  assert.equal(entries[20].target, undefined, "an unread link stays unread, which the checker refuses");

  // Over the cap, nothing is read at all.
  const capped = trackingReader(async () => "A");
  await assert.rejects(
    readSymlinkTargets("unused.zip", manyLinks(257), { readTarget: capped.read }),
    (error) => error.cause === "unsafe-archive" && /257 symlink entries, more than the 256/.test(error.message),
  );
  assert.equal(capped.seen.calls, 0);
});

const posixOnly = process.platform === "win32" ? "symlinks need privileges on Windows" : false;
const macOnly = process.platform === "darwin" ? false : "needs ditto, which is macOS only";

/** A real BotFleet.app tree on disk, with frameworks shaped like Electron's. */
async function stageBundle(root) {
  const app = join(root, BUNDLE_ROOT);
  for (const [framework, binary] of [["Squirrel", "Squirrel"], ["Electron Framework", "Electron Framework"]]) {
    const fw = join(app, "Contents", "Frameworks", `${framework}.framework`);
    await mkdir(join(fw, "Versions", "A", "Resources"), { recursive: true });
    await writeFile(join(fw, "Versions", "A", binary), `${framework} binary\n`);
    await writeFile(join(fw, "Versions", "A", "Resources", "Info.plist"), `${framework} plist\n`);
    await symlink("A", join(fw, "Versions", "Current"));
    await symlink("Versions/Current/Resources", join(fw, "Resources"));
    await symlink(`Versions/Current/${binary}`, join(fw, binary));
  }
  await mkdir(join(app, "Contents", "Resources"), { recursive: true });
  await writeFile(join(app, "Contents", "Resources", "marker.txt"), "staged\n");
  return app;
}

/** Pack an app the way the hosted workflow does. */
async function packBundle(app, zipPath) {
  await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zipPath]);
  return zipPath;
}

/** Wrap a bundle zip the way GitHub does, with a manifest that matches it. */
async function wrapBundle(scratch, innerZip) {
  const innerBytes = await readFile(innerZip);
  const manifest = {
    schemaVersion: 1,
    commit: COMMIT,
    artifact: "BotFleet-mac-arm64.zip",
    sha256: createHash("sha256").update(innerBytes).digest("hex"),
  };
  const wrapperDir = await mkdtemp(join(scratch, "wrapper-"));
  await writeFile(join(wrapperDir, "BotFleet-mac-arm64.zip"), innerBytes);
  await writeFile(join(wrapperDir, "build-manifest.json"), JSON.stringify(manifest));
  const wrapperZip = join(wrapperDir, "artifact.zip");
  await run("zip", ["-q", wrapperZip, "BotFleet-mac-arm64.zip", "build-manifest.json"], { cwd: wrapperDir });
  return { artifactBytes: await readFile(wrapperZip), manifest };
}

test("a framework-shaped bundle packed by ditto is accepted and unpacks with its links intact", { skip: macOnly }, async (t) => {
  const scratch = await fixture(t);
  const app = await stageBundle(join(scratch, "src"));
  const innerZip = await packBundle(app, join(scratch, "BotFleet-mac-arm64.zip"));

  const entries = await inspectArchive(innerZip, { label: "app bundle", symlinkRoot: BUNDLE_ROOT });
  // The old listing typed a link with a space in its name as a regular file.
  // It must come back as a link, with its real target read from the archive.
  const spaced = entries.find(({ name }) => name === `${FW}/Electron Framework.framework/Electron Framework`);
  assert.ok(spaced, "the spaced framework binary link is listed");
  assert.equal(spaced.mode.charAt(0), "l", "a link with a space in its name is typed as a link");
  assert.equal(spaced.target, "Versions/Current/Electron Framework");
  assert.equal(entries.filter(({ mode }) => mode.startsWith("l")).length, 6);

  const destination = join(scratch, "staging", "hosted");
  const built = await materializeBuild({ ...(await wrapBundle(scratch, innerZip)), commit: COMMIT, destination });
  assert.equal(built.appPath, join(destination, BUNDLE_ROOT));
  const current = join(built.appPath, "Contents/Frameworks/Squirrel.framework/Versions/Current");
  assert.ok((await lstat(current)).isSymbolicLink(), "Versions/Current is still a link after unpacking");
  assert.equal(await readlink(current), "A");
  assert.equal(
    await readFile(join(built.appPath, "Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"), "utf8"),
    "Electron Framework plist\n",
    "a file reads through the framework links",
  );
  // The private extraction directory is gone, and only the app is left.
  assert.deepEqual(await readdir(destination), [BUNDLE_ROOT]);
});

test("real archives with escaping links are refused before anything is written", { skip: macOnly }, async (t) => {
  const scratch = await fixture(t);
  for (const [label, linkPath, target, why] of [
    ["an absolute target", "Contents/abs", "/etc", /absolute target/],
    ["an escape via ../..", "Contents/Frameworks/esc", "../../../outside", /climbs with \.\./],
    ["a sibling outside the bundle", "Contents/sib", "../../Sibling.app/Contents", /climbs with \.\./],
  ]) {
    const root = await mkdtemp(join(scratch, "case-"));
    const app = await stageBundle(join(root, "src"));
    await symlink(target, join(app, linkPath));
    const innerZip = await packBundle(app, join(root, "BotFleet-mac-arm64.zip"));
    await assert.rejects(
      inspectArchive(innerZip, { label: "app bundle", symlinkRoot: BUNDLE_ROOT }),
      (error) => {
        assert.equal(error.cause, "unsafe-archive", label);
        assert.match(error.message, why, label);
        assert.match(error.message, new RegExp(escapeForRegExp(`${BUNDLE_ROOT}/${linkPath}`)), `${label} names the link`);
        return true;
      },
    );
  }
});

test("an entry written through a link in a real archive is refused, and nothing lands outside", { skip: macOnly }, async (t) => {
  const scratch = await fixture(t);
  const outside = join(scratch, "outside");
  await mkdir(outside);

  // Stage 1: a bundle whose link points out of it, packed by ditto.
  const first = await stageBundle(join(scratch, "stage1"));
  await symlink("../../outside", join(first, "Contents", "evil"));
  const innerZip = await packBundle(first, join(scratch, "BotFleet-mac-arm64.zip"));
  // Stage 2: append an innocent-looking file whose path runs through that link.
  // `zip` cannot hold both on one disk at once, so it comes from a second tree.
  const second = join(scratch, "stage2");
  await mkdir(join(second, BUNDLE_ROOT, "Contents", "evil"), { recursive: true });
  await writeFile(join(second, BUNDLE_ROOT, "Contents", "evil", "pwned"), "pwned\n");
  await run("zip", ["-q", "-y", innerZip, `${BUNDLE_ROOT}/Contents/evil/pwned`], { cwd: second });

  await assert.rejects(
    inspectArchive(innerZip, { label: "app bundle", symlinkRoot: BUNDLE_ROOT }),
    (error) => {
      assert.equal(error.cause, "unsafe-archive");
      assert.match(error.message, /BotFleet\.app\/Contents\/evil\/pwned \(written through the symlink entry BotFleet\.app\/Contents\/evil\)/);
      return true;
    },
  );

  // The full materialise path refuses it too, and writes nothing anywhere.
  const destination = join(scratch, "staging", "hosted");
  await assert.rejects(
    materializeBuild({ ...(await wrapBundle(scratch, innerZip)), commit: COMMIT, destination }),
    (error) => error.cause === "unsafe-archive",
  );
  assert.deepEqual(await readdir(outside), [], "nothing was written through the link");
  assert.deepEqual(await readdir(destination), [], "nothing was unpacked");
});

test("the unpacked tree is checked again on disk", { skip: posixOnly }, async (t) => {
  const scratch = await fixture(t);
  const app = await stageBundle(join(scratch, "good"));
  await assert.doesNotReject(assertExtractedBundleContained(app));

  // Whatever the archive listing said, a link that really resolves outside the
  // bundle, or nowhere, is refused before the bundle is moved.
  for (const [label, linkPath, target, why] of [
    ["an absolute target", "Contents/abs", scratch, /resolves outside the bundle/],
    ["a climbing target", "Contents/Frameworks/up", "../../..", /resolves outside the bundle/],
    ["a dangling target", "Contents/gone", "Nowhere/at/all", /dangling/],
  ]) {
    const bad = await stageBundle(await mkdtemp(join(scratch, "bad-")));
    await mkdir(dirname(join(bad, linkPath)), { recursive: true });
    await symlink(target, join(bad, linkPath));
    await assert.rejects(
      assertExtractedBundleContained(bad),
      (error) => {
        assert.equal(error.cause, "unsafe-archive", label);
        assert.match(error.message, why, label);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Choosing the newest commit with a green hosted build when no target is named
// ---------------------------------------------------------------------------

// Oldest to newest.  C0 is "installed" in most cases below; C4 is main's tip.
const C = ["1", "2", "3", "4", "5"].map((digit) => digit.repeat(40));
const SELECT_ENV = { GITHUB_TOKEN: "fixture-token" };

/**
 * A fetch that answers the three Actions endpoints the selection reads, and
 * records every URL it was asked for.  `green` is the commits that have a
 * successful run (newest-first as GitHub lists them); `tipRun` is what the
 * per-commit lookup of main's tip returns.
 */
function actionsFetch({ green = [], tipRun = null, expired = [], urls = [], fail = null } = {}) {
  const body = (value) => ({ ok: true, status: 200, json: async () => value });
  return async (url) => {
    const text = String(url);
    urls.push(text);
    if (fail) return fail(text);
    if (text.includes("status=success")) {
      return body({ workflow_runs: green.map((commit, index) => aRun({ id: 100 + index, head_sha: commit })) });
    }
    if (text.includes("head_sha=")) {
      return body({ workflow_runs: tipRun ? [aRun({ id: 7, ...tipRun })] : [] });
    }
    const match = /runs\/(\d+)\/artifacts/.exec(text);
    if (match) {
      const commit = green[Number(match[1]) - 100];
      return body({ artifacts: [anArtifact({ name: artifactNameFor(commit), expired: expired.includes(commit) })] });
    }
    throw new Error(`unexpected request ${text}`);
  };
}

const select = (candidates, options = {}) =>
  selectNewestGreenCommit({ candidates, tip: candidates[0], env: SELECT_ENV, ...options });

test("main's tip is chosen when its build is green", async () => {
  const urls = [];
  const found = await select([C[4], C[3], C[2]], { fetchImpl: actionsFetch({ green: [C[4], C[3]], urls }) });
  assert.equal(found.commit, C[4]);
  assert.equal(found.behind, 0);
  assert.equal(found.tipBuild, "succeeded");
  // The listing is one request for all of main's successful runs, then the
  // artifact of the commit chosen.  The tip's own state is not looked up
  // because nothing needs describing.
  assert.equal(urls.length, 2, urls.join("\n"));
  assert.match(urls[0], /\/actions\/workflows\/mac-commit-build\.yml\/runs\?branch=main&status=success&per_page=100$/);
  assert.match(urls[1], /\/actions\/runs\/100\/artifacts/);
});

test("a cancelled tip falls back to the newest earlier commit that is green", async () => {
  // Exactly the 2026-10-09 failure: the tip's build was cancelled by the next
  // push, and the commit before it had a green build.
  const found = await select([C[4], C[3], C[2]], {
    fetchImpl: actionsFetch({ green: [C[3], C[2]], tipRun: { head_sha: C[4], status: "completed", conclusion: "cancelled" } }),
  });
  assert.equal(found.commit, C[3]);
  assert.equal(found.behind, 1);
  assert.equal(found.tipBuild, "was cancelled");
});

test("the newest GREEN COMMIT wins, whatever order the runs finished in", async () => {
  // A re-run of an old commit can finish after a newer one, so GitHub lists the
  // older commit's run first.  Git order decides.
  const found = await select([C[4], C[3], C[2]], {
    fetchImpl: actionsFetch({ green: [C[2], C[3]], tipRun: { head_sha: C[4], status: "in_progress", conclusion: null } }),
  });
  assert.equal(found.commit, C[3]);
  assert.equal(found.behind, 1);
  assert.equal(found.tipBuild, "is still running");
});

test("a tip that is still queued, failed or has no build at all is described as such", async () => {
  for (const [tipRun, expected] of [
    [{ head_sha: C[4], status: "queued", conclusion: null }, "is still running"],
    [{ head_sha: C[4], status: "completed", conclusion: "failure" }, "failed"],
    [{ head_sha: C[4], status: "completed", conclusion: "timed_out" }, "timed out"],
    [null, "has no hosted build yet"],
  ]) {
    const found = await select([C[4], C[3]], { fetchImpl: actionsFetch({ green: [C[3]], tipRun }) });
    assert.equal(found.commit, C[3]);
    assert.equal(found.tipBuild, expected);
  }
});

test("a green run whose artifact has expired is skipped for the next candidate", async () => {
  const logs = [];
  const found = await select([C[4], C[3], C[2]], {
    fetchImpl: actionsFetch({ green: [C[4], C[3], C[2]], expired: [C[4]], tipRun: { head_sha: C[4], status: "completed", conclusion: "success" } }),
    log: (line) => logs.push(line),
  });
  assert.equal(found.commit, C[3]);
  assert.equal(found.behind, 1);
  assert.match(logs.join("\n"), /artifact is missing or expired/);
});

test("only runs the install path itself would accept count as green", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => String(url).includes("status=success")
      ? { workflow_runs: [aRun({ id: 1, head_sha: C[4], event: "pull_request" }), aRun({ id: 2, head_sha: C[3], event: "workflow_dispatch" })] }
      : String(url).includes("head_sha=")
        ? { workflow_runs: [] }
        : { artifacts: [anArtifact({ name: artifactNameFor(C[3]) })] },
  });
  const found = await select([C[4], C[3]], { fetchImpl });
  assert.equal(found.commit, C[3], "a pull_request run is not a build of main; a workflow_dispatch run is");
});

test("nothing green among the candidates is an answer, not an error", async () => {
  const found = await select([C[4], C[3]], {
    fetchImpl: actionsFetch({ green: [], tipRun: { head_sha: C[4], status: "in_progress", conclusion: null } }),
  });
  assert.equal(found.commit, null);
  assert.equal(found.tipBuild, "is still running");
});

test("only a handful of artifact lookups are made before giving up", async () => {
  const urls = [];
  const many = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0").repeat(20));
  const found = await select(many, { fetchImpl: actionsFetch({ green: many, expired: many, urls }) });
  assert.equal(found.commit, null);
  assert.equal(urls.filter((url) => url.includes("/artifacts")).length, 5);
});

test("a GitHub failure surfaces as a classified error the wrapper can fail open on", async () => {
  await assert.rejects(
    select([C[4]], { fetchImpl: actionsFetch({ fail: () => ({ ok: false, status: 403, json: async () => ({}) }) }) }),
    (error) => {
      assert.ok(error instanceof ResolutionError);
      assert.equal(error.cause, "rate-limited");
      // The message names the commit it was looking for, not a placeholder.
      assert.match(error.message, new RegExp(C[4]));
      return true;
    },
  );
});

// ---- Which commits are candidates: real git, because the floor is the point.

async function mainHistory(t, count = 5) {
  const dir = await fixture(t);
  const git = async (...args) => (await run("git", ["-C", dir, ...args])).stdout.trim();
  await run("git", ["init", "-q", "-b", "main", dir]);
  const commits = [];
  for (let index = 0; index < count; index += 1) {
    await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", `c${index}`);
    commits.push(await git("rev-parse", "HEAD"));
  }
  await git("update-ref", "refs/remotes/origin/main", commits.at(-1));
  return { dir, commits, git, gitSync: (args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim() };
}

test("candidates run from main's tip down to, but not including, the installed build", async (t) => {
  const { commits, gitSync } = await mainHistory(t);
  const [c0, c1, c2, c3, c4] = commits;
  const listed = listUpdateCandidates({ git: gitSync, installed: c1 });
  assert.deepEqual(listed.candidates, [c4, c3, c2], "the installed build and everything older is excluded");
  assert.equal(listed.tip, c4);
  assert.notEqual(listed.truncated, true);
  assert.deepEqual(listUpdateCandidates({ git: gitSync, installed: c3 }).candidates, [c4]);
  assert.ok(!listUpdateCandidates({ git: gitSync, installed: c0 }).candidates.includes(c0));
});

test("when the floor cannot be proven the selection steps aside rather than guess", async (t) => {
  const { commits, git, gitSync } = await mainHistory(t);
  const tip = commits.at(-1);
  assert.match(listUpdateCandidates({ git: gitSync, installed: null }).skip, /no source commit/);
  assert.match(listUpdateCandidates({ git: gitSync, installed: tip }).skip, /already main's tip/);
  assert.match(listUpdateCandidates({ git: gitSync, installed: "9".repeat(40) }).skip, /not an ancestor/);
  // A build from a commit that never reached main is not on main's history.
  await git("checkout", "-q", "-b", "side", commits[1]);
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "side");
  const sideCommit = await git("rev-parse", "HEAD");
  assert.match(listUpdateCandidates({ git: gitSync, installed: sideCommit }).skip, /not an ancestor/);
  await git("update-ref", "-d", "refs/remotes/origin/main");
  assert.match(listUpdateCandidates({ git: gitSync, installed: commits[0] }).skip, /origin\/main cannot be read/);
});

test("the candidate window is bounded and says when it was cut", async (t) => {
  const { commits, gitSync } = await mainHistory(t, 6);
  const listed = listUpdateCandidates({ git: gitSync, installed: commits[0], windowSize: 3 });
  assert.equal(listed.candidates.length, 3);
  assert.equal(listed.truncated, true);
  assert.equal(SELECTION_WINDOW, 100);
});

test("first-parent history is what is walked, so a merged side branch is never a candidate", async (t) => {
  const { commits, git, gitSync } = await mainHistory(t, 3);
  await git("checkout", "-q", "-b", "feature", commits[0]);
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "feature work");
  const feature = await git("rev-parse", "HEAD");
  await git("checkout", "-q", "main");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
  const merge = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/remotes/origin/main", merge);
  const listed = listUpdateCandidates({ git: gitSync, installed: commits[0] });
  assert.deepEqual(listed.candidates, [merge, commits[2], commits[1]]);
  assert.ok(!listed.candidates.includes(feature), "a commit only reachable through a merge was never pushed to main, so it has no build");
  // An installed build on the merged side branch: the mainline commits that do
  // not contain it are not an upgrade from it, so only the merge itself is.
  assert.deepEqual(listUpdateCandidates({ git: gitSync, installed: feature }).candidates, [merge]);
});

// ---- The whole decision.

test("selectUpdateTarget picks the tip when it is green and the earlier commit when it is not", async (t) => {
  const { commits, gitSync } = await mainHistory(t);
  const [c0, , c2, c3, c4] = commits;
  const common = { git: gitSync, installedCommit: c0, env: SELECT_ENV };

  const tipGreen = await selectUpdateTarget({ ...common, fetchImpl: actionsFetch({ green: [c4, c3] }) });
  assert.deepEqual([tipGreen.status, tipGreen.commit], ["selected", c4]);
  assert.match(tipGreen.message, new RegExp(`^Updating to ${c4.slice(0, 12)} \\(main's tip; its build succeeded\\)$`));

  const tipCancelled = await selectUpdateTarget({
    ...common,
    fetchImpl: actionsFetch({ green: [c3, c2], tipRun: { head_sha: c4, status: "completed", conclusion: "cancelled" } }),
  });
  assert.deepEqual([tipCancelled.status, tipCancelled.commit], ["selected", c3]);
  assert.equal(
    tipCancelled.message,
    `Updating to ${c3.slice(0, 12)} (main is 1 commit ahead; its build was cancelled)`,
  );

  const tipRunning = await selectUpdateTarget({
    ...common,
    fetchImpl: actionsFetch({ green: [c2], tipRun: { head_sha: c4, status: "in_progress", conclusion: null } }),
  });
  assert.deepEqual([tipRunning.status, tipRunning.commit], ["selected", c2]);
  assert.equal(
    tipRunning.message,
    `Updating to ${c2.slice(0, 12)} (main is 2 commits ahead; its build is still running)`,
  );
});

test("nothing newer than the installed build is green: a clear refusal, never the installed build", async (t) => {
  const { commits, gitSync } = await mainHistory(t);
  const [, c1, , , c4] = commits;
  // The installed commit (c1) and an older one are green; everything above is
  // not.  Choosing either would be a reinstall or a downgrade.
  const decision = await selectUpdateTarget({
    git: gitSync,
    installedCommit: c1,
    env: SELECT_ENV,
    fetchImpl: actionsFetch({ green: [c1, commits[0]], tipRun: { head_sha: c4, status: "in_progress", conclusion: null } }),
  });
  assert.equal(decision.status, "none");
  assert.match(decision.message, /^No newer hosted build to install\./);
  assert.match(decision.message, new RegExp(`installed build is ${c1.slice(0, 12)}`));
  assert.match(decision.message, new RegExp(`Main is at ${c4.slice(0, 12)}, 3 commits ahead`));
  assert.match(decision.message, /its build is still running/);
  assert.match(decision.message, /BOTFLEET_UPDATE_SOURCE=local/);
  assert.ok(!decision.message.includes("\n"), "the explanation is one line, because the wrapper hands it over in a variable");
});

test("a truncated window changes what is said about the span searched, never the distance to the chosen commit", async (t) => {
  // Six commits, a window of three: the installed build (c0) is further back
  // than the search looked.
  const { commits, gitSync } = await mainHistory(t, 6);
  const [c0, , , c3, c4, c5] = commits;
  const common = { git: gitSync, installedCommit: c0, env: SELECT_ENV, windowSize: 3 };

  // The chosen commit is two below the tip, and that count is exact: it is the
  // chosen commit's position counted down from the tip, so it is not "more
  // than" anything even though the window was cut.
  const selected = await selectUpdateTarget({
    ...common,
    fetchImpl: actionsFetch({ green: [c3], tipRun: { head_sha: c5, status: "in_progress", conclusion: null } }),
  });
  assert.deepEqual([selected.status, selected.commit, selected.behind, selected.truncated], ["selected", c3, 2, true]);
  assert.equal(selected.message, `Updating to ${c3.slice(0, 12)} (main is 2 commits ahead; its build is still running)`);

  // Nothing green in the window: the span between the installed build and the
  // tip is what is unsearched, so THAT count is a lower bound.
  const none = await selectUpdateTarget({
    ...common,
    fetchImpl: actionsFetch({ green: [], tipRun: { head_sha: c5, status: "in_progress", conclusion: null } }),
  });
  assert.equal(none.status, "none");
  assert.match(none.message, new RegExp(`Main is at ${c5.slice(0, 12)}, more than 3 commits ahead`));

  // A window that was not cut says nothing of the kind.
  const whole = await selectUpdateTarget({
    ...common,
    windowSize: 100,
    fetchImpl: actionsFetch({ green: [c4], tipRun: { head_sha: c5, status: "in_progress", conclusion: null } }),
  });
  assert.equal(whole.truncated, false);
  assert.equal(whole.message, `Updating to ${c4.slice(0, 12)} (main is 1 commit ahead; its build is still running)`);
});

test("the policy decides what 'nothing newer' means: local keeps the tip, auto falls back to it", async (t) => {
  const { commits, gitSync } = await mainHistory(t);
  const nothingGreen = actionsFetch({ green: [], tipRun: { head_sha: commits[4], status: "in_progress", conclusion: null } });
  const base = { git: gitSync, installedCommit: commits[0], fetchImpl: nothingGreen };

  const local = await selectUpdateTarget({ ...base, env: { ...SELECT_ENV, BOTFLEET_UPDATE_SOURCE: "local" } });
  assert.equal(local.status, "skip");
  assert.match(local.reason, /packages the commit on this Mac/);

  const auto = await selectUpdateTarget({ ...base, env: { ...SELECT_ENV, BOTFLEET_UPDATE_SOURCE: "auto" } });
  assert.equal(auto.status, "skip", "auto packages the tip locally when no hosted build is newer");

  // auto still prefers a hosted build over packaging when one exists.
  const autoGreen = await selectUpdateTarget({
    ...base,
    env: { ...SELECT_ENV, BOTFLEET_UPDATE_SOURCE: "auto" },
    fetchImpl: actionsFetch({ green: [commits[3]], tipRun: { head_sha: commits[4], status: "in_progress", conclusion: null } }),
  });
  assert.deepEqual([autoGreen.status, autoGreen.commit], ["selected", commits[3]]);

  // local never even asks GitHub.
  const urls = [];
  await selectUpdateTarget({ ...base, env: { ...SELECT_ENV, BOTFLEET_UPDATE_SOURCE: "local" }, fetchImpl: actionsFetch({ urls }) });
  assert.deepEqual(urls, []);
});

test("an installed build that is already the tip leaves the plain update path alone", async (t) => {
  const { commits, gitSync } = await mainHistory(t);
  const urls = [];
  const decision = await selectUpdateTarget({
    git: gitSync,
    installedCommit: commits[4],
    env: SELECT_ENV,
    fetchImpl: actionsFetch({ urls }),
  });
  assert.equal(decision.status, "skip");
  assert.deepEqual(urls, [], "nothing is looked up when there is nothing to choose");
});

test("the installed build is read from the app's build identity", async (t) => {
  const app = await fixture(t);
  const identity = join(app, "Contents/Resources/server/build-identity.json");
  await mkdir(dirname(identity), { recursive: true });
  await writeFile(identity, JSON.stringify({ sourceCommit: C[1] }));
  assert.equal(await readInstalledSourceCommit(app), C[1]);
  await writeFile(identity, JSON.stringify({ sourceCommit: "not-a-commit" }));
  assert.equal(await readInstalledSourceCommit(app), null);
  // Strict: a string of exactly 40 lowercase hex digits, nothing that merely
  // coerces to one.  `RegExp#test` stringifies its argument, so an array
  // holding a valid sha used to pass.
  for (const [label, sourceCommit] of [
    ["an array holding a valid sha", [C[1]]],
    ["a number", 1234567890],
    ["null", null],
    ["an object", { sha: C[1] }],
    ["39 digits", "a".repeat(39)],
    ["41 digits", "a".repeat(41)],
    ["uppercase hex", "A".repeat(40)],
    ["a sha with a trailing newline", `${C[1]}\n`],
    ["a sha with surrounding space", ` ${C[1]}`],
  ]) {
    await writeFile(identity, JSON.stringify({ sourceCommit }));
    assert.equal(await readInstalledSourceCommit(app), null, label);
  }
  await writeFile(identity, JSON.stringify(null));
  assert.equal(await readInstalledSourceCommit(app), null, "a manifest that is not an object");
  await writeFile(identity, JSON.stringify({ sourceCommit: C[1] }));
  assert.equal(await readInstalledSourceCommit(app), C[1]);
  await writeFile(identity, "{ torn");
  assert.equal(await readInstalledSourceCommit(app), null);
  assert.equal(await readInstalledSourceCommit(join(app, "missing")), null);
});
