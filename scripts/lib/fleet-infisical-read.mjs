// Scoped Infisical reads for BotFleet, through the shared reader.
//
// The `fleet-secrets` command is retired fleet-wide. Every BotFleet read
// goes through `infisical-scoped.py`, the reader AFC installs at
// `~/apps/infisical-scoped/infisical-scoped.py`, and every read names the
// consumer's own service-token account. There is no other route:  no shared
// machine identity, no cached copy and no second reader.
//
// Usage:
//
//   import { readFleetSecret } from "../lib/fleet-infisical-read.mjs";
//   const got = readFleetSecret("ASC_KEY_ID", "/asc", "fleet-tools-mm-asc-ro");
//   if (got.code !== 0) return;      // 3 is absent, 4 is refused
//   const value = got.value;
//
// The value comes back to the caller and nowhere else:  it is never logged,
// never printed and never put in an argument. A host with no reader and no
// token fails closed with 4:  the read is refused, never hung and never
// answered from somewhere else.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The project every BotFleet read belongs to. */
export const FLEET_INFISICAL_PROJECT = "fleet-ops";

/** The read worked and the value is in `value`. */
export const FLEET_INFISICAL_OK = 0;
/** The command line was wrong. */
export const FLEET_INFISICAL_USAGE = 2;
/** The name is absent from that folder. */
export const FLEET_INFISICAL_ABSENT = 3;
/** The read was refused, or no reader is installed. */
export const FLEET_INFISICAL_REFUSED = 4;

/**
 * The reader path, in the order the reader is looked for:  the test seam
 * first, then the installed copy.
 *
 * @returns {string}
 */
export function fleetInfisicalReaderPath() {
  const seam = process.env.FLEET_INFISICAL_READER?.trim();
  if (seam) return seam;
  return join(homedir(), "apps", "infisical-scoped", "infisical-scoped.py");
}

/**
 * One scoped read.
 *
 * The exit code follows the reader:  0 for a value, 3 for a name that is not
 * in that folder and 4 for a refused read. A missing reader, a missing
 * python3 and an empty account are all refusals, and they are refused before
 * the reader runs, so a host without them fails closed at once.
 *
 * @param {string} name the secret's name
 * @param {string} folder the Infisical folder to read
 * @param {string} account the consumer's own service-token account
 * @param {string} [project] the Infisical project, fleet-ops by default
 * @param {number} [timeoutMs] the ceiling on the whole read
 * @returns {{ code: number, value: string | null, reason: string }}
 */
export function readFleetSecret(
  name,
  folder,
  account,
  project = FLEET_INFISICAL_PROJECT,
  timeoutMs = 45_000,
) {
  if (!name || !folder) {
    return { code: FLEET_INFISICAL_USAGE, value: null, reason: "usage" };
  }
  if (!account) {
    return { code: FLEET_INFISICAL_REFUSED, value: null, reason: "no-account" };
  }
  const reader = fleetInfisicalReaderPath();
  if (!existsSync(reader)) {
    return { code: FLEET_INFISICAL_REFUSED, value: null, reason: "reader-missing" };
  }
  let stdout = "";
  try {
    // `-I` keeps the reader isolated from the caller's PYTHONPATH and from the
    // current directory, so an unrelated file cannot stand in for it.
    stdout = execFileSync(
      "python3",
      ["-I", reader, "get", name, "--folder", folder, "--project", project, "--account", account],
      { encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch (err) {
    const status = Number(err?.status);
    if (status === FLEET_INFISICAL_ABSENT) {
      return { code: FLEET_INFISICAL_ABSENT, value: null, reason: "absent" };
    }
    if (status === FLEET_INFISICAL_USAGE) {
      return { code: FLEET_INFISICAL_USAGE, value: null, reason: "usage" };
    }
    return { code: FLEET_INFISICAL_REFUSED, value: null, reason: "refused" };
  }
  return { code: FLEET_INFISICAL_OK, value: stdout.replace(/\r?\n$/, ""), reason: "ok" };
}
