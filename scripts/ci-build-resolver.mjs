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
const DOWNLOAD_RETRY_DELAY_MS = 5_000;
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

function resolutionMessage({ cause, commit, status, repository, detail }) {
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
      return `GitHub rejected the credentials used to look up a build for ${sha} (HTTP ${status}).  Unset GITHUB_TOKEN to use the public repo anonymously.`;
    case "network-timed-out":
    case "network-failed":
      return (
        `Could not reach GitHub to fetch a build for ${sha} (${cause}${detail ? `: ${detail}` : ""}).  This is a ` +
        `network problem, NOT a missing build — re-run before assuming the commit was never built.`
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
      resolutionMessage({ cause, commit: "(unresolved)", status: response.status }),
      cause,
    );
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function requestBytes(url, { headers = {}, fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, label }) {
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
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
        lastError = new ResolutionError(`Downloading ${label} failed with HTTP ${response.status}`, cause);
        lastError.status = response.status;
        if (!retryable) throw lastError;
      } else {
        return Buffer.from(await response.arrayBuffer());
      }
    } catch (error) {
      if (error instanceof ResolutionError) {
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

/** The newest successful run for this exact commit, and nothing else. */
export function selectCommitRun(runs, commit) {
  return (
    (runs || []).find(
      (run) =>
        run?.head_sha === commit &&
        run?.conclusion === "success" &&
        (run?.event === "push" || run?.event === "workflow_dispatch"),
    ) || null
  );
}

export function findCommitArtifact(artifacts, commit) {
  const wanted = artifactNameFor(commit);
  return (artifacts || []).find((artifact) => artifact?.name === wanted && !artifact?.expired) || null;
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
  if (typeof manifest.artifact !== "string" || !manifest.artifact.endsWith(".zip")) {
    throw new ResolutionError(`Hosted build manifest names no zip artifact: ${manifest.artifact}`, "bad-manifest");
  }
  return { ...manifest, verifiedBytes: bytes.length };
}

function run(command, args, options) {
  return new Promise((done, fail) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", fail);
    child.once("close", (code) => (code === 0 ? done(stdout) : fail(new Error(`${command} exited ${code}: ${stderr.slice(0, 400)}`))));
  });
}

/**
 * Unpack the artifact zip, verify it, and leave a real `.app` directory.
 *
 * The outer zip is GitHub's artifact wrapper; the inner one is the bundle the
 * workflow produced with `ditto`, so it is unpacked with `ditto` too.  A plain
 * `unzip` of a sequestered bundle loses the resource fork, and the app would
 * differ from a locally built one in a way no signature check notices.
 */
export async function materializeBuild({ artifactBytes, commit, destination, manifest, fetchImpl = fetch, env = process.env }) {
  const scratch = await mkdtemp(join(tmpdir(), "botfleet-ci-build-"));
  try {
    const wrapper = join(scratch, "artifact.zip");
    const inner = join(scratch, manifest.artifact);
    const appPath = join(destination, "BotFleet.app");
    await writeFile(wrapper, artifactBytes, { mode: 0o600 });
    await mkdir(destination, { recursive: true, mode: 0o700 });
    // -j matters: GitHub nests every artifact entry inside a directory named
    // after the artifact, so without it the bundle lands one level down and
    // this lookup silently misses.
    await run("unzip", ["-q", "-j", "-o", wrapper, "-d", scratch]);
    const verified = verifyManifest(manifest, { commit, bytes: await readFile(inner) });
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
    const sawRun = (runs || []).some((item) => item?.head_sha === commit);
    const cause = sawRun ? "github-unavailable" : "no-build";
    throw new ResolutionError(
      resolutionMessage({ cause, commit, status: sawRun ? 200 : 404, repository }),
      cause,
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
    await run("unzip", ["-q", "-j", "-o", wrapper, "build-manifest.json", "-d", scratch]);
    manifest = JSON.parse(await readFile(join(scratch, "build-manifest.json"), "utf8"));
  } catch (error) {
    throw new ResolutionError(`Hosted build artifact has no readable build-manifest.json: ${error?.message}`, "bad-manifest");
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
  return materializeBuild({
    artifactBytes: bytes,
    commit,
    destination,
    manifest,
    fetchImpl,
    env,
  });
}
