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

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

const DEFAULT_REPOSITORY = "Simple-With-Us/BotFleet";
const WORKFLOW_FILE = "mac-commit-build.yml";

// Workflow and artifact metadata on a public repo can be read without a token,
// within GitHub's anonymous API budget.  Downloading the artifact zip always
// requires authentication, even on a public repo.  GITHUB_TOKEN, GH_TOKEN, or
// a token from `gh auth login` is used when present; Finder launches expose a
// minimal PATH, so `authHeaders` also probes common `gh` install locations.
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
        ? `GitHub rejected the configured key (${keyPreview}) while fetching a hosted build for ${sha} (HTTP ${status}).  Actions artifact downloads require a GitHub token from this account.  Unset the wrong key, run \`gh auth login\` on this Mac, or set GITHUB_TOKEN, then retry.`
        : `GitHub returned HTTP ${status} while downloading a hosted build for ${sha}.  Actions artifact downloads require a GitHub token.  Run \`gh auth login\` on this Mac or set GITHUB_TOKEN, then retry the update.`;
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

async function requestJson(url, { headers = {}, fetchImpl = fetch, timeoutMs = API_TIMEOUT_MS, commit = "(unresolved)" } = {}) {
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
      resolutionMessage({ cause, commit, detail: error?.message }),
      cause,
    );
  }
  if (!response.ok) {
    const cause = classifyResolutionFailure({ status: response.status });
    const error = new ResolutionError(
      resolutionMessage({ cause, commit, status: response.status, keyPreview: maskedKeyPreview(headers) }),
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

async function requestBytes(url, { headers = {}, fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, totalTimeoutMs = DOWNLOAD_TOTAL_TIMEOUT_MS, label, commit }) {
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
            ? resolutionMessage({ cause, commit, status: response.status, keyPreview: maskedKeyPreview(headers) })
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

const GH_BIN_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
const GH_AUTH_TOKEN_TIMEOUT_MS = 5_000;

let ghAuthTokenCache = { resolved: false, token: "" };

/** Clears the cached `gh auth token` result.  Tests only. */
export function resetGhAuthCacheForTests() {
  ghAuthTokenCache = { resolved: false, token: "" };
}

function readGhAuthToken(execFileSyncImpl = execFileSync) {
  if (ghAuthTokenCache.resolved) return ghAuthTokenCache.token;
  ghAuthTokenCache.resolved = true;
  for (const ghPath of GH_BIN_CANDIDATES) {
    try {
      const stdout = execFileSyncImpl(ghPath, ["auth", "token"], {
        encoding: "utf8",
        timeout: GH_AUTH_TOKEN_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const token = String(stdout || "").trim();
      if (token) {
        ghAuthTokenCache.token = token;
        return token;
      }
    } catch {
      // Missing binary, logged-out gh, or timeout — try the next candidate.
    }
  }
  ghAuthTokenCache.token = "";
  return "";
}

export function authHeaders(env = process.env, { execFileSyncImpl } = {}) {
  const token = (env.GITHUB_TOKEN || env.GH_TOKEN || "").trim();
  if (token) return { authorization: `Bearer ${token}` };
  const ghToken = readGhAuthToken(execFileSyncImpl ?? execFileSync);
  return ghToken ? { authorization: `Bearer ${ghToken}` } : {};
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
 * The one directory in the bundle archive that may contain symlinks.  The
 * workflow packs the app with `--keepParent`, so every real entry lives under
 * it.  The only other top-level directory is ditto's `__MACOSX/` sidecar tree,
 * which holds ordinary files and never a link.
 */
export const BUNDLE_ROOT = "BotFleet.app";

/**
 * Paths as APFS compares them.  The default macOS volume is case-insensitive
 * and normalization-insensitive, so `A/LINK/payload` is written through an
 * entry called `a/link`.  A duplicate check or a "nothing under a link" check
 * that compared raw strings would be beaten by changing the case of one letter.
 */
function foldPath(path) {
  return path.normalize("NFD").toLowerCase().normalize("NFD");
}

/**
 * Why a symlink entry is refused, or null when it is a legitimate in-bundle link.
 *
 * A real Electron bundle always carries framework links:
 * `Versions/Current -> A`, `Resources -> Versions/Current/Resources`, and the
 * binary link beside them.  On 2026-10-08 the update to main 8ccf02725 was
 * refused because the first version of this guard treated every link as an
 * attack.  This rule admits them and still refuses every escape:
 *
 * - The link must sit strictly inside `BotFleet.app/`.  It may not sit at the
 *   archive root or under `__MACOSX/`, and it may not be `BotFleet.app` itself.
 * - Its target must have been read from the archive.  It must be non-empty,
 *   carry no NUL, be relative, and contain no `..` segment.
 *
 * That is provably contained on its own.  `BotFleet.app` itself is a real
 * directory, because a link by that name is refused.  Every step of resolving
 * a path under it either enters a directory or replaces a link with that
 * link's own directory plus more descending components, and that directory is
 * already under `BotFleet.app/`.  No step climbs, so however links compose,
 * nothing resolves above the bundle.  The caller's "nothing under a link" rule
 * is defence in depth on top: even if APFS folded a name differently from
 * `foldPath`, or ditto read a name differently from zipinfo, a write through a
 * link would still land inside the bundle, where the post-extraction walk and
 * codesign's sealed resources both see it.  Every framework link in the real
 * artifact fits this rule, and none of them needs `..`.
 *
 * A lexical check that allowed `..` would not be enough.  `Contents/b -> ..`
 * and `Contents/c -> b/../x` each look contained on paper, yet `c` resolves
 * outside the bundle, because the kernel applies `..` after following `b`.
 */
function symlinkRefusal(segments, target, symlinkRoot) {
  if (!symlinkRoot) return "symlink entry";
  if (segments.length < 2 || foldPath(segments[0]) !== foldPath(symlinkRoot)) {
    return `symlink entry outside ${symlinkRoot}/`;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- archive boundary: the lister leaves this undefined when a target could not be read.
  if (typeof target !== "string") return "symlink entry whose target could not be read";
  if (target === "") return "symlink entry with an empty target";
  if (target.includes("\0")) return "symlink entry whose target contains NUL";
  if (target.startsWith("/")) return `symlink entry with an absolute target ${JSON.stringify(target)}`;
  if (target.split("/").includes("..")) return `symlink entry whose target ${JSON.stringify(target)} climbs with ..`;
  return null;
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
 * do rather than a refusal we chose.  Every entry is therefore judged here,
 * directory entries included, before a single byte is written:
 *
 * - An absolute path or a `..` segment is refused.
 * - A duplicate name is refused, compared the way APFS compares names, because
 *   the second copy would replace whatever the first one made.
 * - An entry with a symlink entry as an ancestor is refused, so nothing is ever
 *   written THROUGH a link.  That is the Zip Slip that survives extraction: a
 *   link is created inside the tree, and a later, innocent-looking entry is
 *   written through it to wherever the link points.
 * - Device, FIFO, and socket entries are refused.
 * - A symlink entry is refused unless `symlinkRoot` names the bundle directory
 *   and the link passes `symlinkRefusal` above.  GitHub's artifact wrapper is
 *   checked with no `symlinkRoot`, so every link in it is still refused.
 *
 * Type comes from the archive, never from the name.  The `__MACOSX/._*`
 * sidecars are legitimate ordinary files that carry the resource fork
 * `--sequesterRsrc` exists to preserve, so guessing from names would refuse
 * every real build.
 */
export function assertSafeArchiveEntries(entries, { label = "artifact", symlinkRoot = null } = {}) {
  const unsafe = [];
  const seen = new Set();
  const links = new Map();
  const judged = [];
  for (const { name, mode, target } of entries) {
    const raw = String(name);
    const type = String(mode || "-").charAt(0);
    const clean = raw.replace(/\\/g, "/");
    if (clean.startsWith("/") || /^[A-Za-z]:/.test(clean)) {
      unsafe.push(`${raw} (absolute path)`);
      continue;
    }
    const segments = clean.split("/").filter((part) => part && part !== ".");
    if (segments.includes("..")) {
      unsafe.push(`${raw} (traverses out of the destination)`);
      continue;
    }
    if (segments.length === 0) {
      // `./` names the destination itself.  As a directory it carries nothing.
      // As anything else it would replace the destination.
      if (type !== "d") unsafe.push(`${JSON.stringify(raw)} (names the destination itself)`);
      continue;
    }
    if ("bcps".includes(type)) {
      unsafe.push(`${raw} (device, FIFO, or socket entry)`);
      continue;
    }
    const key = foldPath(segments.join("/"));
    if (seen.has(key)) {
      unsafe.push(`${raw} (duplicate entry)`);
      continue;
    }
    seen.add(key);
    judged.push({ raw, segments, type, target });
    if (type === "l") links.set(key, raw);
  }
  for (const { raw, segments, type, target } of judged) {
    // Nothing may be written through a link, whatever the link points at.
    let through = null;
    for (let depth = 1; depth < segments.length && through === null; depth += 1) {
      through = links.get(foldPath(segments.slice(0, depth).join("/"))) ?? null;
    }
    if (through !== null) {
      unsafe.push(`${raw} (written through the symlink entry ${through})`);
      continue;
    }
    if (type === "l") {
      const why = symlinkRefusal(segments, target, symlinkRoot);
      if (why) unsafe.push(`${raw} (${why})`);
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
 * TYPES come from `zipinfo -l`, matched to names by POSITION.  Both listings
 * walk the central directory in the same order, so row i of one is entry i of
 * the other.  Each typed row must end with its own name, and the row count must
 * equal the name count.  Any mismatch refuses the archive: we would not know
 * which entries are symlinks.  A symlink is the one entry type that changes
 * where later writes land.
 */
export async function listArchiveEntries(archivePath) {
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

  // Names are NOT trimmed.  An entry called ` x` or `x ` is a different path
  // from `x`, and trimming it would check one name and extract another.
  const names = nameList.split("\n").filter((line) => line !== "");
  if (names.length === 0) {
    throw new ResolutionError(
      `The hosted artifact's entry list came back empty, so its names cannot be checked; refusing to extract it`,
      "unsafe-archive",
    );
  }

  // A `zipinfo -l` row is `<mode> <version> <os> <size> <flags> <csize>
  // <method> <date> <time> <name>`.  The mode's first character is the type:
  // d directory, l symlink, - regular file, b/c/p/s special.  The mode is taken
  // as a whole token, so Unix modes and FAT-style attributes both read.
  //
  // The previous version took the NAME as the last whitespace-separated token
  // of a symlink row.  A link whose name contains a space, such as
  // `Electron Framework.framework/Versions/Current`, was recorded as
  // `Framework.framework/Versions/Current`, never matched, and was typed as a
  // regular file.  That is why the 2026-10-08 refusal named nine links and not
  // the fourteen the real bundle carries.  Pairing by position has no field
  // boundary in the name to get wrong.
  const typedRows = typeList.split("\n").filter((line) => /^[-dlbcps]\S*\s+\d+\.\d+\s+\S+\s+\d+\s/.test(line));
  if (typedRows.length !== names.length) {
    throw new ResolutionError(
      `The hosted artifact lists ${names.length} names but ${typedRows.length} typed entries, so its symlink entries cannot be ruled out; refusing to extract it`,
      "unsafe-archive",
    );
  }
  return names.map((name, index) => {
    const row = typedRows[index];
    if (!row.endsWith(` ${name}`)) {
      throw new ResolutionError(
        `The hosted artifact's typed listing does not line up with its names at entry ${index + 1}, so its symlink entries cannot be ruled out; refusing to extract it`,
        "unsafe-archive",
      );
    }
    return { name, mode: row.split(/\s/, 1)[0] };
  });
}

/**
 * More links than any real bundle carries.  The 8ccf02725 build has fourteen,
 * all framework links.  The cap bounds how many `unzip -p` reads a hostile
 * archive can make this resolver spawn while the updater holds its lock.
 */
const MAX_SYMLINK_ENTRIES = 256;
// PATH_MAX is 1024 on macOS, so a longer target is not a target.
const SYMLINK_TARGET_MAX_BYTES = 4096;
/**
 * The TOTAL wall-clock budget for reading every target, plus a per-read cap
 * and a concurrency limit.  A per-read timeout alone bounds nothing useful:
 * 256 links read one after another at 30 seconds each would hold the updater
 * lock for over two hours.  The real bundle's fourteen reads take about three
 * seconds in all, even on a heavily loaded Mac.
 */
const SYMLINK_READ_BUDGET_MS = 60_000;
const SYMLINK_READ_TIMEOUT_MS = 30_000;
const SYMLINK_READ_CONCURRENCY = 8;

function readTargetWithUnzip(archivePath, name, timeoutMs) {
  return runBoundedText("unzip", ["-p", archivePath, name], { timeoutMs, maxBytes: SYMLINK_TARGET_MAX_BYTES });
}

/**
 * Read each symlink entry's target from the archive, before anything is
 * extracted.  A zip stores a link's target as the entry's content, so
 * `unzip -p` prints it.
 *
 * The name goes to unzip as a PATTERN, so a name with wildcard characters could
 * read a different entry's content.  Such a link is left without a target, and
 * `assertSafeArchiveEntries` refuses a link it could not read.  So does a read
 * that fails, times out, or overruns the cap.  A name never starts with `-`,
 * because every link that can pass the check sits under `BotFleet.app/`.
 *
 * The bytes are decoded as UTF-8.  Decoding never creates or hides a `/`, a
 * `.`, or a NUL, because ASCII bytes always decode as themselves.  So the
 * checks on the decoded string hold for the bytes ditto will write.
 *
 * At most `concurrency` reads run at once, and no read is given longer than
 * what is left of `budgetMs`.  Each read also races one overall deadline, so
 * even a read that ignored its own timeout cannot stretch the wait.  Running
 * out of budget refuses the archive outright.  `readTarget` is injectable only
 * so a test can stand in a read that hangs.
 */
export async function readSymlinkTargets(archivePath, entries, {
  budgetMs = SYMLINK_READ_BUDGET_MS,
  concurrency = SYMLINK_READ_CONCURRENCY,
  readTarget = readTargetWithUnzip,
} = {}) {
  const links = entries.filter(({ mode }) => String(mode).startsWith("l"));
  if (links.length > MAX_SYMLINK_ENTRIES) {
    throw new ResolutionError(
      `The hosted artifact has ${links.length} symlink entries, more than the ${MAX_SYMLINK_ENTRIES} any real bundle needs; refusing to extract it`,
      "unsafe-archive",
    );
  }
  const queue = links.filter(({ name }) => !/[[\]*?\\]/.test(name) && !name.startsWith("-"));
  const deadline = Date.now() + budgetMs;
  const EXPIRED = Symbol("expired");
  let timer;
  const overall = new Promise((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), budgetMs);
  });
  let expired = false;
  const worker = async () => {
    while (queue.length && !expired) {
      const entry = queue.shift();
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        expired = true;
        return;
      }
      const outcome = await Promise.race([
        // A failed read is left unread on purpose.  An unread target is a
        // refusal, not a pass.
        readTarget(archivePath, entry.name, Math.min(SYMLINK_READ_TIMEOUT_MS, remaining)).then(
          (target) => ({ target }),
          () => ({}),
        ),
        overall,
      ]);
      if (outcome === EXPIRED) {
        expired = true;
        return;
      }
      if ("target" in outcome) entry.target = outcome.target;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker));
  } finally {
    clearTimeout(timer);
  }
  if (expired) {
    throw new ResolutionError(
      `Reading the hosted artifact's ${links.length} symlink targets took longer than ${budgetMs >= 1000 ? `${Math.round(budgetMs / 1000)}s` : `${budgetMs}ms`}; refusing to extract an archive that cannot be inspected in time`,
      "unsafe-archive",
    );
  }
  return entries;
}

/**
 * List an archive, read its link targets when links are allowed, and refuse it
 * unless every entry passes `assertSafeArchiveEntries`.  Nothing is extracted.
 */
export async function inspectArchive(archivePath, { label = "artifact", symlinkRoot = null } = {}) {
  const entries = await listArchiveEntries(archivePath);
  if (symlinkRoot) await readSymlinkTargets(archivePath, entries);
  return assertSafeArchiveEntries(entries, { label, symlinkRoot });
}

/**
 * The ground truth after extraction: every link ditto actually created must
 * resolve inside the bundle, and nothing else may be a device, FIFO, or socket.
 *
 * The pre-extraction checks read the archive through `zipinfo` and `unzip`, and
 * `ditto` is a different parser.  If the two ever disagree about a name, a
 * type, or a target, this walk sees what really landed on disk and refuses it
 * before the bundle is moved anywhere.  The walk reads with `lstat` and never
 * descends into a link, so every path it visits has only real directories
 * above it.  It cannot see a write that already escaped, which is why the
 * "nothing under a link" rule runs before extraction rather than here.
 */
export async function assertExtractedBundleContained(bundlePath) {
  const top = await lstat(bundlePath).catch(() => null);
  if (!top?.isDirectory()) {
    throw new ResolutionError(`The hosted app bundle did not unpack to a real ${BUNDLE_ROOT} directory`, "unsafe-archive");
  }
  const rootReal = await realpath(bundlePath);
  const shown = (path) => `${BUNDLE_ROOT}${path.slice(bundlePath.length)}`;
  const unsafe = [];
  const pending = [bundlePath];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        const target = await readlink(path);
        const resolved = await realpath(path).catch(() => null);
        if (resolved === null) {
          unsafe.push(`${shown(path)} -> ${target} (dangling)`);
        } else if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
          unsafe.push(`${shown(path)} -> ${target} (resolves outside the bundle)`);
        }
      } else if (info.isDirectory()) {
        pending.push(path);
      } else if (!info.isFile()) {
        unsafe.push(`${shown(path)} (device, FIFO, or socket)`);
      }
    }
  }
  if (unsafe.length) {
    throw new ResolutionError(
      `The unpacked hosted app bundle has ${unsafe.length} unsafe entr${unsafe.length === 1 ? "y" : "ies"}, refusing to install it: ${unsafe.slice(0, 5).join(", ")}`,
      "unsafe-archive",
    );
  }
}

/**
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
    // The wrapper is GitHub's, and it never holds a link, so every link in it
    // is still refused.
    await inspectArchive(wrapper, { label: "artifact" });
    // -j matters: GitHub nests every artifact entry inside a directory named
    // after the artifact, so without it the bundle lands one level down and
    // this lookup silently misses.
    await run("unzip", ["-q", "-j", "-o", wrapper, "-d", scratch]);
    const verified = verifyManifest(manifest, { commit, bytes: await readFile(inner) });
    // And again for the bundle, which is the archive that becomes an app here.
    // A real bundle carries framework links, so links under BotFleet.app/ are
    // allowed, and only with targets that stay inside it.
    await inspectArchive(inner, { label: "app bundle", symlinkRoot: BUNDLE_ROOT });
    // Unpack fresh: a leftover directory from a previous attempt would let
    // `ditto` merge into stale files instead of replacing them.
    await rm(appPath, { recursive: true, force: true });
    // Extract into a FRESH, private, empty directory that nothing else uses.
    // Nothing in it predates this archive, so the only links ditto can meet are
    // ones this archive made, and every one of those was checked above.
    // `ditto -x -k` extracts INTO its destination, and the zip's single
    // top-level entry is `BotFleet.app` (the workflow packs it with
    // --keepParent), so the app lands at `<extraction>/BotFleet.app`.
    const extraction = await mkdtemp(join(destination, ".extract-"));
    try {
      await run("ditto", ["-x", "-k", inner, extraction]);
      const extracted = join(extraction, BUNDLE_ROOT);
      await assertExtractedBundleContained(extracted);
      // Same directory, so the same volume: the move is a rename, never a copy.
      await rename(extracted, appPath);
    } finally {
      await rm(extraction, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
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
  execFileSyncImpl,
} = {}) {
  if (!FULL_COMMIT.test(commit || "")) {
    throw new ResolutionError(`Refusing to resolve a hosted build for a non-commit target: ${commit}`, "bad-target");
  }
  const headers = authHeaders(env, { execFileSyncImpl });
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
  const bytes = await requestBytes(`${artifact.archive_download_url}`, { headers, fetchImpl, label: artifact.name, commit });
  // The artifact wrapper is a zip holding the manifest and the bundle.
  const scratch = await mkdtemp(join(tmpdir(), "botfleet-ci-manifest-"));
  let manifest;
  try {
    const wrapper = join(scratch, "artifact.zip");
    await writeFile(wrapper, bytes, { mode: 0o600 });
    await inspectArchive(wrapper, { label: "artifact" });
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

// ---------------------------------------------------------------------------
// Choosing WHICH commit to install when the operator did not name one.
//
// `ubf` used to install origin/main's tip, and main moves faster than the
// hosted build finishes: every push cancels the build of the commit it
// supersedes, so the tip's build is usually queued or cancelled and the update
// failed with "did not succeed (cancelled)" even though a green build of a
// commit a few minutes older was sitting right there.  With no `--target`, the
// wrapper (scripts/update-botfleet.sh) now asks this module for the NEWEST
// commit on main whose hosted build succeeded and installs that, as long as it
// is newer than what is installed.  An explicit `--target` never comes here.
//
// This runs BEFORE the wrapper archives the updater, because the updater
// policy must come from the commit that is about to be installed.  So it is
// reachable only through exports of this file (the wrapper imports it with
// `node -e`), imports nothing but node: builtins, and fails OPEN: any doubt
// ends in "install the tip, as before", whose own download then reports the
// real problem in the usual way.
// ---------------------------------------------------------------------------

/** How many first-parent commits below main's tip are considered. */
export const SELECTION_WINDOW = 100;
/** Green runs whose artifact is checked before giving up on finding one. */
const SELECTION_ARTIFACT_CHECKS = 5;
/**
 * Each lookup gets far less than the 30 seconds an install-time request does.
 * The selection runs before the updater writes its first progress record, and
 * the harness gives up on a run with no record after two minutes (LAUNCH_GRACE_MS
 * in server/update-control.ts), so a slow GitHub must cost seconds here, not
 * minutes.  Running out of patience is harmless: the selection fails open to
 * the tip, whose own download then reports what is wrong.
 */
const SELECTION_REQUEST_TIMEOUT_MS = 10_000;
const BUILD_MANIFEST_RELATIVE = "Contents/Resources/server/build-identity.json";

/**
 * The commit the installed app was built from, or null when it cannot be
 * read.  Mirrors `installedBuildCommit` in update-botfleet-mac.mjs.
 *
 * Hand-checked rather than parsed with zod, for the same reason as
 * `assertWorkflowRun` above: the updater is bootstrapped from a `git archive`
 * of a few files into a temp directory with no node_modules, so this module can
 * import nothing but node: builtins.  The check is still strict on purpose: the
 * value must BE a string of exactly 40 lowercase hex digits.  `RegExp#test`
 * coerces its argument, so without the type check a one-element array holding a
 * valid sha would pass and be returned as if it were one.  Anything else is
 * "the installed build is unknown", which makes the selection step aside.
 */
export async function readInstalledSourceCommit(appPath) {
  try {
    const build = JSON.parse(await readFile(join(appPath, BUILD_MANIFEST_RELATIVE), "utf8"));
    const commit = build?.sourceCommit;
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- build-identity.json boundary parse; zod is unavailable in the updater bootstrap graph (see above).
    return typeof commit === "string" && FULL_COMMIT.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

function gitInCheckout(checkout) {
  return (args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
      // These are local reads that finish in milliseconds.  They run
      // synchronously, so the wrapper's watchdog cannot interrupt one: keep the
      // cap small enough that several in a row still fit inside it.
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: MAX_CHILD_STDOUT_BYTES,
    }).trim();
}

/**
 * The commits an update may choose among: main's first-parent history from the
 * tip down to, but NOT including, the installed build.
 *
 * First-parent because that is exactly the set of commits that were ever
 * pushed to main and so can have a hosted build at all.  Excluding everything
 * reachable from the installed commit is what keeps a selection from ever
 * choosing the installed build or anything older.  Returns `{ skip }` instead
 * of guessing whenever that floor cannot be established — no installed commit
 * on record, one this checkout has never seen, or one that is not an ancestor
 * of main — because without a floor a "newest green" choice could be a
 * downgrade.  Also skips when the installed build already IS the tip: there is
 * nothing to choose, and the plain update path (a reinstall under --force, or
 * a checkout catching up to the app) should run exactly as it always has.
 */
export function listUpdateCandidates({ git, installed, windowSize = SELECTION_WINDOW }) {
  let tip;
  try {
    tip = git(["rev-parse", "--verify", "origin/main^{commit}"]);
  } catch {
    return { skip: "origin/main cannot be read in the checkout" };
  }
  if (!FULL_COMMIT.test(tip)) return { skip: "origin/main did not resolve to a full commit" };
  if (!installed) return { tip, skip: "the installed build records no source commit" };
  if (installed === tip) return { tip, skip: "the installed build is already main's tip" };
  try {
    git(["cat-file", "-e", `${installed}^{commit}`]);
    git(["merge-base", "--is-ancestor", installed, tip]);
  } catch {
    return { tip, skip: "the installed build is not an ancestor of origin/main in this checkout" };
  }
  let chain;
  let descendants;
  try {
    chain = git(["rev-list", "--first-parent", "-n", String(windowSize), tip, `^${installed}`]).split("\n").filter(Boolean);
    descendants = new Set(git(["rev-list", "--ancestry-path", `${installed}..${tip}`]).split("\n").filter(Boolean));
  } catch {
    return { tip, skip: "the commits between the installed build and origin/main cannot be listed" };
  }
  // A mainline commit that does not contain the installed build is not an
  // upgrade from it (the installed build sits on a side branch that main merged
  // in).  Along the chain the commits that do contain it are a prefix, so
  // dropping the rest keeps every candidate's distance from the tip intact.
  const listed = chain.filter((commit) => descendants.has(commit));
  if (listed.length === 0 || listed[0] !== tip || !listed.every((commit) => FULL_COMMIT.test(commit))) {
    return { tip, skip: "the commits between the installed build and origin/main did not list cleanly" };
  }
  return { tip, candidates: listed, truncated: chain.length >= windowSize };
}

const short = (commit) => String(commit).slice(0, 12);
const plural = (count) => `${count} commit${count === 1 ? "" : "s"}`;

/** How main's tip build reads in a sentence ("its build ..."). */
async function describeTipBuild({ tip, repository, headers, fetchImpl }) {
  try {
    const runsUrl = `${apiBase(repository)}/actions/workflows/${WORKFLOW_FILE}/runs?head_sha=${tip}&per_page=20`;
    const attempted = anyRunForCommit(
      (await requestJson(runsUrl, { headers, fetchImpl, commit: tip, timeoutMs: SELECTION_REQUEST_TIMEOUT_MS }))?.workflow_runs,
      tip,
    );
    if (!attempted) return "has no hosted build yet";
    if (STILL_RUNNING.has(attempted.status)) return "is still running";
    switch (attempted.conclusion) {
      case "success": return "succeeded, but its artifact is not usable";
      case "cancelled": return "was cancelled";
      case "failure": return "failed";
      case "timed_out": return "timed out";
      default: return "did not succeed";
    }
  } catch {
    // Only the wording of a message depends on this; never the choice.
    return "could not be checked";
  }
}

/**
 * Walk `candidates` (newest first) and return the first whose hosted build
 * succeeded and whose artifact is still available.
 *
 * Git order decides, not run order: a re-run of an old commit can finish after
 * a newer one, and the newest COMMIT is what is wanted.  One listing of main's
 * successful runs answers for every candidate, so the cost is a single request
 * plus one artifact lookup for the commit actually chosen.
 */
export async function selectNewestGreenCommit({
  candidates,
  tip,
  repository = DEFAULT_REPOSITORY,
  fetchImpl = fetch,
  env = process.env,
  execFileSyncImpl,
  log = () => {},
}) {
  const headers = authHeaders(env, { execFileSyncImpl });
  const runsUrl = `${apiBase(repository)}/actions/workflows/${WORKFLOW_FILE}/runs?branch=main&status=success&per_page=100`;
  const runs = (await requestJson(runsUrl, { headers, fetchImpl, commit: tip, timeoutMs: SELECTION_REQUEST_TIMEOUT_MS }))?.workflow_runs;
  let checked = 0;
  for (let index = 0; index < candidates.length && checked < SELECTION_ARTIFACT_CHECKS; index += 1) {
    const commit = candidates[index];
    const green = selectCommitRun(runs, commit);
    if (!green) continue;
    checked += 1;
    const artifactsUrl = `${apiBase(repository)}/actions/runs/${green.id}/artifacts?per_page=100`;
    const artifacts = (await requestJson(artifactsUrl, { headers, fetchImpl, commit, timeoutMs: SELECTION_REQUEST_TIMEOUT_MS }))?.artifacts;
    if (!findCommitArtifact(artifacts, commit)) {
      log(`${short(commit)} has a successful hosted build but its artifact is missing or expired; looking further back.`);
      continue;
    }
    const tipBuild = index === 0 ? "succeeded" : await describeTipBuild({ tip, repository, headers, fetchImpl });
    return { commit, behind: index, tipBuild };
  }
  return { commit: null, behind: null, tipBuild: await describeTipBuild({ tip, repository, headers, fetchImpl }) };
}

/**
 * The whole decision, for the wrapper.  Resolves to one of:
 *
 *   { status: "selected", commit, message }  install this commit
 *   { status: "none", message }              nothing newer than the installed
 *                                            build has a hosted build (`ci`)
 *   { status: "skip", reason }               not applicable or not provable;
 *                                            install the tip as before
 *
 * `BOTFLEET_UPDATE_SOURCE=local` packages on this Mac, which can build any
 * commit, so it keeps the tip.  Under `auto`, "nothing newer" also keeps the
 * tip, because `auto` exists to fall back to a local package of it.
 */
export async function selectUpdateTarget({
  checkout,
  appPath = "/Applications/BotFleet.app",
  installedCommit,
  git,
  env = process.env,
  repository = DEFAULT_REPOSITORY,
  fetchImpl = fetch,
  execFileSyncImpl,
  windowSize = SELECTION_WINDOW,
  log = () => {},
} = {}) {
  const policy = updateSourcePolicy(env);
  if (policy === "local") {
    return { status: "skip", reason: "BOTFLEET_UPDATE_SOURCE=local packages the commit on this Mac, so there is no hosted build to choose" };
  }
  const installed = installedCommit === undefined ? await readInstalledSourceCommit(appPath) : installedCommit;
  const listed = listUpdateCandidates({ git: git ?? gitInCheckout(checkout), installed, windowSize });
  if (listed.skip) return { status: "skip", reason: listed.skip };
  const { tip, candidates, truncated } = listed;
  const found = await selectNewestGreenCommit({ candidates, tip, repository, fetchImpl, env, execFileSyncImpl, log });
  if (found.commit) {
    // `behind` is the chosen commit's position counted down from the tip, so it
    // is exact however long the installed build's history is.  Truncation only
    // limits how far BELOW the tip the search looked (the "none" message says
    // "more than N" because there the count is of the whole unsearched span),
    // so this count never gets a "more than".  `truncated` is passed on for
    // callers that want to say the installed build is further back still.
    const message = found.behind === 0
      ? `Updating to ${short(found.commit)} (main's tip; its build succeeded)`
      : `Updating to ${short(found.commit)} (main is ${plural(found.behind)} ahead; its build ${found.tipBuild})`;
    return { status: "selected", commit: found.commit, tip, behind: found.behind, truncated, message };
  }
  if (policy === "auto") {
    return { status: "skip", reason: "no hosted build is newer than the installed one; the tip will be packaged on this Mac" };
  }
  const ahead = `${truncated ? "more than " : ""}${plural(candidates.length)}`;
  return {
    status: "none",
    tip,
    message:
      `No newer hosted build to install.  The installed build is ${short(installed)}.  Main is at ${short(tip)}, ` +
      `${ahead} ahead, and its build ${found.tipBuild}.  None of the commits in between has a successful hosted build yet.  ` +
      `Wait for a build to finish, or update with BOTFLEET_UPDATE_SOURCE=local to package on this Mac.`,
  };
}
