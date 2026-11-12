// Release-only public metadata resolution; no generic CI fallback or machine identity.
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isUnresolvedReference, listSecretsRaw } from "./infisical-fetch.mjs";

export const NATIVE_UPDATE_NAMES = ["BOTFLEET_NATIVE_UPDATE_FEED_URL", "BOTFLEET_NATIVE_UPDATE_PUBLIC_KEY"];
export const NATIVE_UPDATE_PROJECT = "836aebe2-c8f7-4e09-978e-7e3e82500bce";
const FAILURE = "Native update release configuration could not be verified against canonical Infisical metadata.";

export function validNativeUpdatePublicKey(value) {
  return /^[A-Za-z0-9+/]{43}=$/.test(value) &&
    Buffer.from(value, "base64").length === 32 && Buffer.from(value, "base64").toString("base64") === value;
}

function validFeed(value) {
  if (!value.startsWith("https://") || /[\\#]/.test(value) ||
      /^https:\/\/[^/?#]*@/.test(value)) return false;
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || code === 127) return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}

export async function resolveNativeUpdateReleaseConfig({ env = {}, fetchImpl = fetch, allowUnconfigured = false } = {}) {
  const mirrors = NATIVE_UPDATE_NAMES.map((name) => env[`MIRROR_${name}`] ?? "");
  if (allowUnconfigured && mirrors.every((value) => value === "")) {
    return Object.fromEntries(NATIVE_UPDATE_NAMES.map((name) => [name, ""]));
  }
  const token = String(env.INFISICAL_NATIVE_RELEASE_READ_TOKEN ?? "").trim();
  if (!token) throw new Error(FAILURE);
  let canonical;
  try {
    canonical = await listSecretsRaw({ siteUrl: "https://app.infisical.com", token,
      projectId: NATIVE_UPDATE_PROJECT, environment: "prod", secretPath: "/",
      names: NATIVE_UPDATE_NAMES, fetchImpl, log: () => {} });
  } catch {
    // Request errors may echo credentials or response bodies; never forward them.
    throw new Error(FAILURE);
  }
  const values = NATIVE_UPDATE_NAMES.map((name) => canonical.get(name) ?? "");
  if (values.some((value) => !value || isUnresolvedReference(value)) ||
      !validFeed(values[0]) || !validNativeUpdatePublicKey(values[1]) ||
      mirrors.some((value, index) => value !== "" && value !== values[index])) {
    throw new Error(FAILURE);
  }
  return Object.fromEntries(NATIVE_UPDATE_NAMES.map((name, index) => [name, values[index]]));
}

export async function writeNativeUpdateReleaseConfig({ output, writeFileImpl = writeFileSync, ...options }) {
  const values = await resolveNativeUpdateReleaseConfig(options);
  // One exclusive write after both values pass; no partial exports on validation failure.
  writeFileImpl(output, NATIVE_UPDATE_NAMES.map((name) => `${name}=${values[name]}\n`).join(""),
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  return values;
}

function isEntryModule() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}

if (isEntryModule()) {
  const args = process.argv.slice(2);
  if (args[0] !== "--output" || !args[1] ||
      (args.length !== 2 && !(args.length === 3 && args[2] === "--allow-unconfigured"))) {
    console.error("usage: native-update-release-config.mjs --output PATH [--allow-unconfigured]");
    process.exitCode = 1;
  } else {
    writeNativeUpdateReleaseConfig({ output: args[1], env: process.env,
      allowUnconfigured: args.includes("--allow-unconfigured") }).catch(() => {
      console.error(FAILURE);
      process.exitCode = 1;
    });
  }
}
