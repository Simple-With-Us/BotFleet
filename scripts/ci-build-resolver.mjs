// Resolve the signed macOS bundle that GitHub already built for a given commit.
//
// The owner ruled on 2026-10-01 that GitHub's Mac runners do the building for
// updates, always, with a local bypass.  `pnpm package:mac:local` is a 10-15
// minute electron-builder run on the same Mac that runs five to ten agent
// seats, and every recorded update failure was inside it: a probe timing out
// under load and a perfectly good binary being reported as corrupt.  This
// module replaces that step with a download.
//
// What it does NOT do is trust the download.  It checks the manifest's sha256
// and its recorded commit, and the caller still runs `validateBuiltBundle`,
// which demands the exact Developer ID team and the designated requirement.
// The signature is the security boundary; the manifest only guards the
// transfer.  A build that passed CI's own signature gate and packaged-server
// smoke test has still earned that second, independent check here, because
// the artifact crossed a network and landed on the machine that will run it.
//
// The download discipline is borrowed wholesale from prepare-cloudflared.mjs's
// `downloadRelease`, which exists because the Sep 17 outage traced to exactly
// this shape of call.  Retry a timeout; never retry a 404 that will still be a
// 404 in ten minutes.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_REPOSITORY = "jaywedgeworth22/BotFleet";
const WORKFLOW_FILE = "mac-commit-build.yml";

// The repository is public, so the Actions API can be read unauthenticated.
// An hourly anonymous budget exists and is small, but a machine installs a
// handful of updates a day, not hundreds; a token is still honoured when one
// is present so a busy or multi-Mac setup is not quietly throttled.
const API_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 3;
// An overall budget for the whole transfer, not per attempt.  Without it the
// worst case is 3 x 10 minutes inside prepareUpdate while the updater holds its
// lock — roughly twice as long as the local build this path replaced, on the
// path that now runs by default.  A slow link must not cost more than the thing
// it accelerates.
const DOWNLOAD_TOTAL_TIMEOUT_MS = 12 * 60 * 1000;
const DOWNLOAD_RETRY_DELAY_MS = 5_000;
// A real cap for every OTHER child this module runs.  `spawn` ignores the
// `maxBuffer` option that belongs to `execFile`, so passing one was silently
// doing nothing; `runBoundedText` caps the listing, and this caps the rest.
const MAX_CHILD_STDOUT_BYTES = 16 * 1024 * 1024;

/** GitHub's own "not finished yet" vocabulary.
 *
 *  Matching only the single literal `in_progress` once made the still-running
 *  branch dead for every other status a queued or waiting build actually
 *  reports, so an operator was told a running build had "failed".  The comment
 *  on `ResolutionError.conclusion` still records that this field is compared
 *  against raw statuses by consumers, so the set has to be raw statuses too. */
const STILL_RUNNING = new Set([
  "in_progress",
  "queued",
  "waiting",
  "pending",
  "requested",
  "waiting_for_runner",
  "requested_waiting",
]);
const MANIFEST_SCHEMA_VERSION = 1;
const FULL_COMMIT = /^[a-f0-9]{40}$/;

/** Where the bundle should come from.  `ci` is the default, per the ruling. */
export function updateSourcePolicy(env = process.env) {
  const value = (env.BOTFLEET_UPDATE_SOURCE ?? "ci").trim().toLowerCase();
  if (["ci", "auto", "local"].includes(value)) return value;
  throw new Error(`BOTFLEET_UPDATE_SOURCE must be ci, auto, or local (got "${value}")`);
}

export function artifactNameFor(commit) {
  return `botfleet-mac-${commit}`;
}

function apiBase(repository) {
  return `https://api.github.com/repos/${repository}`;
}

/**
 * A timeout is classified, never collapsed into "not found".  The distinction
 * is the whole reason this module exists: a starved host or a flaky tunnel
 * must not be reported as "CI has no build for this commit", because the
 * operator's response to those two is completely different.
 */
export function classifyResolutionFailure({ status, timedOut, spawnError } = {}) {
  if (spawnError) return "network-failed";
  if (timedOut) return "network-timed-out";
  if (status === 404) return "no-build";
  if (status === 403 || status === 429) return "rate-limited";
  if (status && status >= 500) return "github-unavailable";
  if (status === 401) return "unauthorized";
  return "unknown";
}

function resolutionMessage({ cause, commit, status, repository, detail, conclusion, keyPreview }) {
  const sha = FULL_COMMIT.test(commit || "") ? commit : `${String(commit || "").slice(0, 12) || "unknown"} (not a full commit)`;
  switch (cause) {
    case "no-build":
      return (
        `No hosted build exists for ${sha} in ${repository}.  Builds run on every push to main, so either this ` +
        `commit predates the workflow or its run did not succeed.  Dispatch one with:  ` +
        `gh workflow run mac-commit-build.yml --repo ${repository} --ref ${sha}\n` +
        `Or update with BOTFLEET_UPDATE_SOURCE=local to package on this Mac instead.`
      );
    case "rate-limited":
      return (
        `GitHub rate-limited the build lookup for ${sha} (HTTP ${status}).  This is an API budget, not a missing ` +
        `build.  Set GITHUB_TOKEN to authenticate, or retry shortly.`
      );
    case "unauthorized":
      return keyPreview
        ? `GitHub rejected the configured key (${keyPreview}) while looking up a build for ${sha} (HTTP ${status}).  A key from another account or host is the usual cause.  Unset it to use the public repo anonymously.`
        : `GitHub rejected an anonymous request for ${sha} (HTTP ${status}), which should not happen on a public repo.  Set GITHUB_TOKEN to authenticate, or retry shortly.`;
    case "network-timed-out":
    case "network-failed":
      return (
        `Could not reach GitHub to fetch a build for ${sha} (${cause}${detail ? `: ${detail}` : ""}).  This is a ` +
        `network problem, NOT a missing build — re-run before assuming the commit was never built.`
      );
    case "build-failed":
      return (
        `A hosted build exists for ${sha} but it did not succeed${conclusion ? ` (${STILL_RUNNING.has(conclusion) ? "still running" : conclusion})` : ""}.  ` +
        `Re-run it, or update with BOTFLEET_UPDATE_SOURCE=local to package on this Mac.  Note that this ` +
        `workflow cancels superseded builds, so a build cancelled because a newer commit landed on main is expected.`
      );
    case "github-unavailable":
      return `GitHub returned HTTP ${status} while looking up a build for ${sha}.  This is a GitHub-side problem, not a missing build.`;
    default:
      return `Could not resolve a hosted build for ${sha} in ${repository}${status ? ` (HTTP ${status})` : ""}${detail ? `: ${detail}` : ""}.`;
  }
}

export class ResolutionError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "ResolutionError";
    this.cause = cause;
    /**
     * For cause "build-failed": the RAW workflow status — "in_progress", "cancelled",
     * "failure", "timed_out".  Consumers compare against these literals, so this
     * must be the status and not a human-readable label: the message prettifies
     * it separately, and a label here once made the still-running branch dead.
     */
    this.conclusion = undefined;
  }
}

async function requestJson(url, { headers = {}, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const cause = timedOut ? "network-timed-out" : "network-failed";
    throw new ResolutionError(
      resolutionMessage({ cause, commit: "(unresolved)", detail: error?.message }),
      cause,
    );
  }
  if (!response.ok) {
    const cause = classifyResolutionFailure({ status: response.status });
    const error = new ResolutionError(
      resolutionMessage({ cause, commit: "(unresolved)", status: response.status, keyPreview: maskedKeyPreview(headers) }),
      cause,
    );
    error.status = response.status;
    throw error;
  }
  let body;
  try {
    body = await response.json();
  } catch (error) {
    // A 200 with an HTML or truncated body is a real possibility behind a proxy
    // or during an incident, and a raw SyntaxError would escape classification
    // entirely: isRecoverableResolutionFailure sees a non-ResolutionError, the
    // operator is shown "SyntaxError: Unexpected token '<'", and the actual
    // cause is lost.  Say what happened instead.
    throw new ResolutionError(
      `GitHub returned HTTP ${response.status} for ${url} with a body that is not JSON (${error?.message || error})`,
      "bad-response",
    );
  }
  return body;
}

async function requestBytes(url, { headers = {}, fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, totalTimeoutMs = DOWNLOAD_TOTAL_TIMEOUT_MS, label }) {
  let lastError = null;
  const budgetDeadline = Date.now() + totalTimeoutMs;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    const remaining = budgetDeadline - Date.now();
    if (remaining <= 0) break;
    // Each attempt gets what is left of the budget, never more.
    timeoutMs = Math.min(timeoutMs, remaining);
    try {
      const response = await fetchImpl(url, {
        headers,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // A 404 or any other client error will not become a 200 by waiting, so
        // fail immediately and let the operator read the real reason instead of
        // sitting through a three-minute retry that cannot help.  429 and 5xx
        // are the cases a retry genuinely can fix.
        const cause = classifyResolutionFailure({ status: response.status });
        const retryable = response.status === 429 || response.status >= 500;
        lastError = new ResolutionError(
          cause === "unauthorized"
            ? resolutionMessage({ cause, commit: "(unresolved)", status: response.status, keyPreview: maskedKeyPreview(headers) })
            : `Downloading ${label} failed with HTTP ${response.status}`,
          cause,
        );
        lastError.status = response.status;
        if (!retryable) {
          // Mark it before throwing: this throw happens inside the try, so the
          // catch below would otherwise treat a 400 or a 410 as an unknown
          // network error and spend all three attempts on a status that cannot
          // change, delaying the real reason by 15 seconds.
          lastError.fatal = true;
          throw lastError;
        }
      } else {
        return Buffer.from(await response.arrayBuffer());
      }
    } catch (error) {
      if (error instanceof ResolutionError) {
        // A client error that is not one of the three causes worth naming is
        // still fatal once `requestBytes` has decided it cannot be retried.
        if (error.fatal) throw error;
        if (error.cause === "no-build" || error.cause === "rate-limited" || error.cause === "unauthorized") throw error;
        lastError = error;
      } else {
        const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
        lastError = new ResolutionError(`Downloading ${label} failed (${timedOut ? "timed out" : error?.message})`, timedOut ? "network-timed-out" : "network-failed");
      }
    }
    if (attempt < DOWNLOAD_ATTEMPTS) {
      await new Promise((done) => setTimeout(done, DOWNLOAD_RETRY_DELAY_MS * attempt));
    }
  }
  throw lastError || new ResolutionError(`Downloading ${label} failed`, "unknown");
}

function authHeaders(env = process.env) {
  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

/**
 * A credential is never printed, and a 401 that does not say WHICH credential is
 * not much of a diagnosis — the usual cause is a key from another account or a
 * different host, and the first eight and last four characters are enough to
 * tell that apart from the key the operator meant.  Anything too short to mask
 * safely is reported as short rather than shown.
 */
export function maskedKeyPreview(headers = {}) {
  const value = String(headers?.authorization || headers?.Authorization || "").trim();
  const token = value.replace(/^(?:bearer|token)\s*/i, "").trim();
  if (!token) return null;
  if (token.length <= 12) return "a key too short to identify safely";
  return `${token.slice(0, 8)}…${token.slice(-4)}`;
}

/**
 * Shape checks for the two GitHub responses this module reads.
 *
 * Hand-written rather than zod on purpose, and that is not a shortcut: the
 * updater bootstraps itself by archiving a five-file graph into a temp directory
 * with no node_modules beside it (see update-botfleet.sh), so it cannot import a
 * third-party validator at all.  Every other module in that graph imports
 * nothing but node: builtins.  The intent of the rule — never read a field off
 * an untrusted response without checking its shape — is met explicitly; adding
 * zod would break updater bootstrap on every Mac.
 */
/* oxlint-disable anti-slop/no-runtime-typeof -- hand-written GitHub Actions boundary parse; zod is unavailable in the updater bootstrap graph (see comment above). */
function assertWorkflowRun(value) {
  const conclusion = value?.conclusion;
  if (typeof value?.id !== "number" ||
      typeof value?.head_sha !== "string" ||
      (conclusion !== null && typeof conclusion !== "string") ||
      typeof value?.status !== "string" ||
      typeof value?.event !== "string") {
    return null;
  }
  return value;
}

function assertArtifact(value) {
  if (typeof value?.id !== "number" ||
      typeof value?.name !== "string" ||
      typeof value?.expired !== "boolean" ||
      typeof value?.archive_download_url !== "string") {
    return null;
  }
  return value;
}
/* oxlint-enable anti-slop/no-runtime-typeof */

/** The newest attempt at this commit, for diagnosis when none succeeded. */
function anyRunForCommit(runs, commit) {
  return Array.isArray(runs) ? runs.find((item) => item?.head_sha === commit) || null : null;
}

/** The newest successful run for this exact commit, and nothing else. */
export function selectCommitRun(runs, commit) {
  if (!Array.isArray(runs)) return null;
  return (
    runs
      .map(assertWorkflowRun)
      .find((run) => run && run.head_sha === commit && run.conclusion === "success" &&
        (run.event === "push" || run.event === "workflow_dispatch")) || null
  );
}

export function findCommitArtifact(artifacts, commit) {
  if (!Array.isArray(artifacts)) return null;
  const wanted = artifactNameFor(commit);
  return artifacts.map(assertArtifact).find((item) => item && item.name === wanted && !item.expired) || null;
}

/**
 * Verify the manifest against the bytes actually downloaded.  A manifest that
 * names a different commit is a resolver bug or a tampered artifact; either
 * way, refusing is the only safe answer, because the caller's signature check
 * would still pass on a perfectly signed build of the WRONG commit.
 */
export function verifyManifest(manifest, { commit, bytes }) {
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ResolutionError(`Hosted build manifest has an unsupported schemaVersion: ${manifest?.schemaVersion}`, "bad-manifest");
  }
  if (manifest.commit !== commit) {
    throw new ResolutionError(
      `Hosted build manifest names commit ${String(manifest.commit).slice(0, 12)}, not the requested ${commit.slice(0, 12)}`,
      "bad-manifest",
    );
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (manifest.sha256 !== digest) {
    throw new ResolutionError(
      `Hosted build artifact does not match its manifest sha256 (expected ${String(manifest.sha256).slice(0, 12)}, got ${digest.slice(0, 12)})`,
      "checksum-mismatch",
    );
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- manifest field boundary parse (same bootstrap constraint as assertWorkflowRun).
  if (typeof manifest.artifact !== "string" || !manifest.artifact.endsWith(".zip")) {
    throw new ResolutionError(`Hosted build manifest names no zip artifact: ${manifest.artifact}`, "bad-manifest");
  }
  // The same name check `materializeBuild` applies to the path, so a manifest
  // cannot pass verification here and be refused later at the path it builds.
  manifestArtifactName(manifest);
  return { ...manifest, verifiedBytes: bytes.length };
}

function run(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    // Raw child stderr is untrusted output that can carry a path, an argument, or
    // a token.  Drain it so the child can never block on a full pipe, and
    // discard it: the exit code is the diagnosis, stderr stays on this machine.
    child.stderr.resume();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      // Nothing this module runs is chatty, so a child that reaches this is
      // misbehaving and is stopped rather than allowed to exhaust memory while
      // the updater holds its lock.
      if (stdout.length > MAX_CHILD_STDOUT_BYTES) {
        child.kill("SIGKILL");
        fail(new Error(`${command} produced more than ${MAX_CHILD_STDOUT_BYTES} bytes of stdout`));
      }
    });
    child.once("error", fail);
    child.once("close", (code) => (code === 0 ? done(stdout) : fail(new Error(`${command} exited with code ${code}`))));
  });
}

/**
 * The artifact name is the one field of a network-fetched manifest that becomes
 * a filesystem path, so it is reduced to a plain basename here rather than at
 * the point of use.  The workflow names the bundle `BotFleet-mac-arm64.zip`,
 * so a strict pattern costs nothing and keeps a manifest from naming something
 * outside the scratch directory it was unpacked into.  The sha256 check still
 * guards the bytes themselves; this only keeps the name a name.
 */
export function manifestArtifactName(manifest) {
  const name = manifest?.artifact;
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- manifest field boundary parse (same bootstrap constraint as assertWorkflowRun).
  if (typeof name !== "string" || !/^[\w.-]+\.zip$/.test(name)) {
    throw new ResolutionError(`Hosted build manifest names no zip artifact: ${name}`, "bad-manifest");
  }
  return name;
}

/**
 * Refuse an archive whose entries would escape the destination.
 *
 * The manifest's `artifact` field is a network-supplied FILENAME and is checked
 * to be a plain basename.  The archive's ENTRY NAMES are the other, larger
 * untrusted input and were not checked at all: an entry named
 * `../../../../.ssh/authorized_keys` is the actual Zip Slip vector, and the
 * basename check says nothing about it.
 *
 * `ditto` refuses some of these, but relying on the extractor's behaviour is not
 * a check — it varies by version, and the failure would be whatever it happens to
 * do rather than a refusal we chose.  Every entry is therefore resolved against
 * the destination and rejected if it lands outside, before a single byte is
 * written.  Absolute paths, `..` segments, and symlink entries are all refused:
 * a symlink entry is a Zip Slip that survives extraction, because the link is
 * created in the tree and a LATER entry can then be written through it.
 */
export function assertSafeArchiveEntries(entries, { label = "artifact" } = {}) {
  const unsafe = [];
  for (const { name, mode } of entries) {
    const clean = String(name).replace(/\\/g, "/");
    if (!clean || clean.endsWith("/")) continue; // directory entries carry no payload
    if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
      unsafe.push(`${name} (absolute path)`);
      continue;
    }
    const segments = clean.split("/").filter((part) => part && part !== ".");
    if (segments.includes("..")) {
      unsafe.push(`${name} (traverses out of the destination)`);
      continue;
    }
    // A symlink entry is a Zip Slip that survives extraction: the link is created
    // inside the tree and a LATER entry is then written THROUGH it, so the entry
    // name can look perfectly innocent.  Type comes from the archive, not from the
    // name — `__MACOSX/._*` sidecars are legitimate (they carry the resource fork
    // that --sequesterRsrc exists to preserve) and are ordinary files, so
    // guessing from the name would refuse every real build.
    if (String(mode || "").startsWith("l")) {
      unsafe.push(`${name} (symlink entry)`);
    }
  }
  if (unsafe.length) {
    throw new ResolutionError(
      `Hosted ${label} has ${unsafe.length} unsafe archive entr${unsafe.length === 1 ? "y" : "ies"}, refusing to extract: ${unsafe.slice(0, 5).join(", ")}`,
      "unsafe-archive",
    );
  }
  return entries;
}

/**
 * Read a child process's stdout with a hard cap, failing if the cap is passed.
 *
 * `run` accumulates stdout into a string with no limit and, because it uses
 * `spawn` rather than `execFile`, its `maxBuffer` option is silently ignored —
 * so a hostile archive with a million entries would have had this resolver
 * building an unbounded string in memory, which is a denial-of-service vector in
 * the updater on the owner's machine.  Anything past ARCHIVE_LIST_MAX_BYTES is
 * refused rather than truncated: a partial listing is exactly the thing that
 * must not be used to decide an archive is safe.
 */
const ARCHIVE_LIST_MAX_BYTES = 32 * 1024 * 1024;

async function runBoundedText(command, args, { timeoutMs = 60_000, maxBytes = ARCHIVE_LIST_MAX_BYTES } = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks = [];
  let total = 0;
  let overflow = false;
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  try {
    await new Promise((done, fail) => {
      child.stdout.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.resume();
      child.once("error", fail);
      child.once("close", (code) => (code === 0 ? done() : fail(new Error(`${command} exited with code ${code}`))));
    });
  } finally {
    clearTimeout(timer);
  }
  if (overflow) {
    throw new ResolutionError(
      `The hosted artifact's entry list exceeds ${maxBytes} bytes; refusing to extract an archive whose entries cannot be fully inspected`,
      "unsafe-archive",
    );
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Every entry in an archive, with its type, or a refusal to extract it.
 *
 * NAMES come from `zipinfo -1`, which prints one entry per line and nothing
 * else.  The first version parsed `zipinfo -l` with a regex, and that was a hole
 * exactly where it mattered: a crafted entry name could fail the pattern, so
 * the entry was silently DROPPED and never checked — a traversal named
 * `../..` or an absolute path could therefore slip past the guard by being
 * shaped so the parser could not read it.  A line-oriented listing has no field
 * boundaries to get wrong, so every name is necessarily checked.
 *
 * TYPES come from `zipinfo -l` and are matched by name.  If that listing cannot
 * be read, the archive is refused: we would not know which entries are symlinks,
 * and a symlink entry is a Zip Slip that survives extraction.
 */
async function listArchiveEntries(archivePath) {
  let nameList;
  let typeList;
  try {
    [nameList, typeList] = await Promise.all([
      runBoundedText("zipinfo", ["-1", archivePath]),
      runBoundedText("zipinfo", ["-l", archivePath]),
    ]);
  } catch (error) {
    throw new ResolutionError(
      `Could not list the hosted artifact's entries before extracting it (${error?.message || error}); refusing to extract an archive that cannot be inspected`,
      "unsafe-archive",
    );
  }

  const names = nameList.split("\n").map((line) => line.trim()).filter(Boolean);
  if (names.length === 0) {
    throw new ResolutionError(
      `The hosted artifact's entry list came back empty, so its names cannot be checked; refusing to extract it`,
      "unsafe-archive",
    );
  }

  // The permission string's first character is the type: d directory,
  // l symlink, - regular file.  The first character alone is matched, so a
  // name that contains spaces or odd characters cannot shift the columns and
  // make a line unparseable — which was the original hole.
  const symlinks = new Set();
  let typedLines = 0;
  for (const line of typeList.split("\n")) {
    const match = line.match(/^([-dlbcps])[-rwxsStT]{9}\s+(.*)$/);
    if (!match) continue;
    typedLines += 1;
    // The NAME is the last field, not the rest of the line.  A `zipinfo -l`
    // row is `-rw-r--r--  3.0 unx  123 tx  defN 26-Jan-01 12:00 some/path`,
    // so capturing group 2 whole stored the whole tail — permissions, sizes,
    // dates and the name — in the set.  `symlinks.has(name)` then never
    // matched, so every symlinked entry was recorded as a plain file and the
    // archive check passed on the exact thing it exists to catch.
    if (match[1] === "l") {
      const name = match[2].trim().split(/\s+/).pop();
      if (name) symlinks.add(name);
    }
  }
  // Zero PARSED type lines means the format is not what we expect, so we cannot
  // tell a symlink from a regular file and must refuse.  A parsed listing with
  // no symlinks in it is an ordinary archive and is fine — that distinction is
  // the whole point, and conflating them would refuse every real build.
  if (typedLines === 0) {
    throw new ResolutionError(
      `Could not read the hosted artifact's entry types, so its symlink entries cannot be ruled out; refusing to extract it`,
      "unsafe-archive",
    );
  }

  return names.map((name) => ({ name, mode: symlinks.has(name) ? "lrwxrwxrwx" : "-rw-r--r--" }));
}/**
 * Unpack the artifact zip, verify it, and leave a real `.app` directory.
 *
 * The outer zip is GitHub's artifact wrapper; the inner one is the bundle the
 * workflow produced with `ditto`, so it is unpacked with `ditto` too.  A plain
 * `unzip` of a sequestered bundle loses the resource fork, and the app would
 * differ from a locally built one in a way no signature check notices.
 */
export async function materializeBuild({ artifactBytes, commit, destination, manifest }) {
  const scratch = await mkdtemp(join(tmpdir(), "botfleet-ci-build-"));
  try {
    const wrapper = join(scratch, "artifact.zip");
    // Validate before the name reaches a path: `join` collapses `..`, so a
    // traversing name would otherwise read and extract outside `scratch`.
    const inner = join(scratch, manifestArtifactName(manifest));
    const appPath = join(destination, "BotFleet.app");
    await writeFile(wrapper, artifactBytes, { mode: 0o600 });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    // Inspect the archive's own entry names before extracting either of them.
    // `manifestArtifactName` checks the network-supplied FILENAME, which is one
    // untrusted input; the entry names are the other and larger one, and an
    // entry called ../../.ssh/authorized_keys is the actual Zip Slip vector.
    assertSafeArchiveEntries(await listArchiveEntries(wrapper), { label: "artifact" });
    // -j matters: GitHub nests every artifact entry inside a directory named
    // after the artifact, so without it the bundle lands one level down and
    // this lookup silently misses.
    await run("unzip", ["-q", "-j", "-o", wrapper, "-d", scratch]);
    const verified = verifyManifest(manifest, { commit, bytes: await readFile(inner) });
    // And again for the bundle, which is the archive that becomes an app here.
    assertSafeArchiveEntries(await listArchiveEntries(inner), { label: "app bundle" });
    // Unpack fresh: a leftover directory from a previous attempt would let
    // `ditto` merge into stale files instead of replacing them.
    await rm(appPath, { recursive: true, force: true });
    // Extract to the *parent*, not to the app path.  `ditto -x -k` extracts
    // INTO its destination, and the zip's single top-level entry is
    // `BotFleet.app` (the workflow packs it with --keepParent), so naming the
    // app as the destination would produce BotFleet.app/BotFleet.app.
    await run("ditto", ["-x", "-k", inner, destination]);
    return { appPath, manifest: verified };
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

/**
 * Find, download, verify, and unpack the hosted build for `commit`.  Returns
 * the path to a real `.app` directory that `validateBuiltBundle` can then hold
 * to the same signature and identity standard as a locally built one.
 */
export async function downloadBuiltBundle({
  commit,
  destination,
  repository = DEFAULT_REPOSITORY,
  fetchImpl = fetch,
  env = process.env,
  log = () => {},
} = {}) {
  if (!FULL_COMMIT.test(commit || "")) {
    throw new ResolutionError(`Refusing to resolve a hosted build for a non-commit target: ${commit}`, "bad-target");
  }
  const headers = authHeaders(env);
  const runsUrl = `${apiBase(repository)}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${commit}&per_page=20`;
  const runs = (await requestJson(runsUrl, { headers, fetchImpl }))?.workflow_runs;
  const run_ = selectCommitRun(runs, commit);
  if (!run_) {
    // A run that exists for this commit but failed, was cancelled, or is still
    // running is NOT a GitHub outage.  Reporting it as one sent the operator to
    // retry something retrying cannot fix, and — because the cause was not
    // no-build — isRecoverableResolutionFailure also blocked the `auto`
    // fallback that exists for exactly this case.  A build this workflow
    // cancelled because a newer commit landed on main is the expected case
    // here, not a failure.
    const attempted = anyRunForCommit(runs, commit);
    if (attempted) {
      // The raw workflow status, NOT a prettified label: isRecoverableResolutionFailure
      // compares this against ["cancelled", "in_progress"], and it previously
      // received "still running" instead, so the still-running branch was dead
      // code and a hosted build that had not finished yet blocked the update
      // outright under `auto` — the one transient case that most needs patience.
      const conclusion = attempted.status === "in_progress"
        ? "in_progress"
        : attempted.conclusion || "unknown";
      const failure = new ResolutionError(
        resolutionMessage({ cause: "build-failed", commit, conclusion, repository }),
        "build-failed",
      );
      // Carried on the error so the caller can tell an expected cancellation
      // from a build that actually rejected the commit.  Only the first is a
      // legitimate reason to package on this Mac; the second is a signal, and
      // silently building it locally would be a deceptively successful install.
      failure.conclusion = conclusion;
      throw failure;
    }
    throw new ResolutionError(
      resolutionMessage({ cause: "no-build", commit, status: 404, repository }),
      "no-build",
    );
  }
  const artifacts = (await requestJson(`${apiBase(repository)}/actions/runs/${run_.id}/artifacts?per_page=100`, { headers, fetchImpl }))?.artifacts;
  const artifact = findCommitArtifact(artifacts, commit);
  if (!artifact) {
    throw new ResolutionError(
      resolutionMessage({ cause: "no-build", commit, status: 404, repository }) +
        `  The run completed but its artifact is missing or older than its 30-day retention.\n`,
      "no-build",
    );
  }
  log(`Using hosted build run ${run_.id} for ${commit.slice(0, 12)} (${artifact.name})`);
  const bytes = await requestBytes(`${artifact.archive_download_url}`, { headers, fetchImpl, label: artifact.name });
  // The artifact wrapper is a zip holding the manifest and the bundle.
  const scratch = await mkdtemp(join(tmpdir(), "botfleet-ci-manifest-"));
  let manifest;
  try {
    const wrapper = join(scratch, "artifact.zip");
    await writeFile(wrapper, bytes, { mode: 0o600 });
    assertSafeArchiveEntries(await listArchiveEntries(wrapper), { label: "artifact" });
    await run("unzip", ["-q", "-j", "-o", wrapper, "build-manifest.json", "-d", scratch]);
    manifest = JSON.parse(await readFile(join(scratch, "build-manifest.json"), "utf8"));
  } catch (error) {
    // Only wrap what is genuinely "could not read the manifest".  A
    // ResolutionError from `assertSafeArchiveEntries` means the archive
    // contains something that must not be extracted — an unsafe-archive
    // refusal.  Re-labelling that `bad-manifest` told an operator their build
    // was simply missing a file when the real answer was "this artifact
    // contains a path or link we refuse to unpack", which is the one message
    // in this file that must not be blurred.
    if (error instanceof ResolutionError) throw error;
    throw new ResolutionError(`Hosted build artifact has no readable build-manifest.json: ${error?.message}`, "bad-manifest");
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  return materializeBuild({
    artifactBytes: bytes,
    commit,
    destination,
    manifest,
  });
}
