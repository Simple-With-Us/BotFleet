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

/** Capture once at build/startup, so moving a checkout cannot relabel a live process. */
export function readSourceBuildIdentity(root) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  const value = {
    app: "botfleet", version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
    apiVersion: HARNESS_API_VERSION, sourceCommit: git("rev-parse", "HEAD"),
    sourceDirty: git("status", "--porcelain", "--untracked-files=no").length > 0,
    uiHash: null,
  };
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
