import { execFileSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const HARNESS_API_VERSION = 1;

export function validBuildIdentity(value) {
  return value?.app === "botfleet" && Number.isInteger(value.apiVersion) && value.apiVersion > 0 &&
    typeof value.version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version) &&
    typeof value.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(value.sourceCommit) &&
    typeof value.sourceDirty === "boolean" &&
    (value.uiHash === null || (typeof value.uiHash === "string" && /^[a-f0-9]{64}$/.test(value.uiHash)));
}

/** Bind attachment to the actual static files, including assets referenced by index.html. */
export function hashStaticUi(directory) {
  if (!directory) return null;
  try {
    const hash = createHash("sha256");
    const walk = (relative) => {
      for (const entry of readdirSync(join(directory, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
        const name = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(name);
        else if (entry.isFile()) {
          const bytes = readFileSync(join(directory, name));
          hash.update(`${name.length}:${name}:${bytes.length}:`).update(bytes);
        } else throw new Error("unsupported static entry");
      }
    };
    readFileSync(join(directory, "index.html"));
    walk("");
    return hash.digest("hex");
  } catch { return null; }
}

/** Read build output only; never infer a packaged app's identity from its surroundings. */
export function readPackagedBuildIdentity(directory) {
  const value = JSON.parse(readFileSync(join(directory, "build-identity.json"), "utf8"));
  if (!validBuildIdentity(value)) throw new Error("BotFleet build identity is missing or invalid");
  return value;
}

/** Capture once at build/startup, so moving a checkout cannot relabel a live process.
 *
 * Pass `requireGit: true` when the identity is being stamped into a shipped
 * manifest: a build that writes this into `build-identity.json` must know its
 * real source commit, or the packaged app would ship a fabricated all-zeros
 * commit as provenance.  The server keeps the default for startup, where an
 * unavailable git is not a reason to refuse to boot. */
export function readSourceBuildIdentity(root, { requireGit = false } = {}) {
  // Git is not guaranteed to be on PATH: a checkout started from a GUI app, a
  // stripped container, or a test that scrubs PATH cannot run it.  That is not
  // a reason for the server to refuse to start, so an unavailable git reports
  // the commit as all zeros and the build as dirty.  Marking it dirty is what
  // makes this safe — `buildCompatibility` never calls two dirty builds
  // "matching", so an unknown commit can never read as agreement between a
  // stale UI bundle and this server.
  const unknownCommit = "0".repeat(40);
  let sourceCommit = unknownCommit;
  let sourceDirty = true;
  try {
    const git = (...args) => execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const head = git("rev-parse", "HEAD");
    if (/^[a-f0-9]{40}$/.test(head)) {
      sourceCommit = head;
      sourceDirty = git("status", "--porcelain", "--untracked-files=no").length > 0;
    }
  } catch (error) {
    // A dev checkout can start without git, but a build that stamps this into
    // build-identity.json must not: that manifest is the shipped provenance.
    if (requireGit) throw new Error(`cannot read git identity for ${root}: ${error?.message ?? error}`);
    /* otherwise git is absent, or this is not a checkout: the commit stays unknown */
  }
  const value = {
    app: "botfleet", version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    apiVersion: HARNESS_API_VERSION, sourceCommit, sourceDirty, uiHash: null,
  };
  // A manifest stamped into a shipped bundle must name a real commit: git ran
  // but reported no usable HEAD (shallow archive, corrupt repo), so the
  // all-zeros fallback would be fabricated provenance.
  if (requireGit && sourceCommit === unknownCommit) {
    throw new Error(`cannot read git identity for ${root}: git reported no usable HEAD`);
  }
  if (!validBuildIdentity(value)) throw new Error("BotFleet source identity is invalid");
  return value;
}

/** The owner nonce authenticates this local diagnostic route; it is never returned. */
export function authorizedRuntime(owner, authorization) {
  if (typeof authorization !== "string" || !/^Bearer [a-f0-9]{64}$/.test(authorization)) return false;
  const token = authorization.slice(7);
  return typeof owner?.nonce === "string" && owner.nonce.length === token.length &&
    timingSafeEqual(Buffer.from(token), Buffer.from(owner.nonce));
}

export function buildCompatibility(expected, actual) {
  if (!validBuildIdentity(expected) || !validBuildIdentity(actual) ||
      expected.apiVersion !== actual.apiVersion) return "incompatible";
  return !expected.sourceDirty && !actual.sourceDirty && expected.sourceCommit === actual.sourceCommit &&
    expected.uiHash !== null && expected.uiHash === actual.uiHash
    ? "matching" : "bundled-ui";
}
