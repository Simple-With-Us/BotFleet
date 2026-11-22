// The shared scoped Infisical reader, from the companion's side.
//
// The `fleet-secrets` command is retired fleet-wide.  The companion reads the
// APNs material through the shared reader, `infisical-scoped.py`, with the
// companion's own service-token account, and there is no other route:  no
// shared machine identity, no cached copy and no second reader.
//
// This module carries the same contract as scripts/lib/fleet-infisical-read.mjs:
// the reader is resolved the same way, the argument list is the same, and the
// exit codes mean the same thing.  It is a second copy of that contract
// because the packaged companion ships as dist-companion and cannot reach a
// file in the checkout.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/** The read worked and the value is in `value`. */
export const APNS_READ_OK = 0;
/** The command line was wrong. */
export const APNS_READ_USAGE = 2;
/** The name is absent from that folder. */
export const APNS_READ_ABSENT = 3;
/** The read was refused, or no reader is installed. */
export const APNS_READ_REFUSED = 4;

/** One scoped read.  The reason names what happened and never a value. */
export interface ApnsScopedRead {
  code: number;
  value: string | null;
  reason: string;
}

const execFileAsync = promisify(execFile);

/**
 * The reader path, in the order the reader is looked for:  the test seam
 * first, then the installed copy.
 */
export function apnsReaderPath(): string {
  const seam = process.env.FLEET_INFISICAL_READER?.trim();
  if (seam) return seam;
  return join(homedir(), "apps", "infisical-scoped", "infisical-scoped.py");
}

/**
 * One scoped read of the APNs material.
 *
 * The exit code follows the reader:  0 for a value, 3 for a name that is not
 * in that folder and 4 for a refused read.  A missing reader, a missing
 * python3 and an empty account are all refusals, and they are refused before
 * the reader runs, so a host without them fails closed at once.
 */
export async function readApnsScopedSecret(
  name: string,
  folder: string,
  account: string,
  timeoutMs: number,
): Promise<ApnsScopedRead> {
  if (!name || !folder) return { code: APNS_READ_USAGE, value: null, reason: "usage" };
  if (!account) return { code: APNS_READ_REFUSED, value: null, reason: "no-account" };
  const reader = apnsReaderPath();
  if (!existsSync(reader)) return { code: APNS_READ_REFUSED, value: null, reason: "reader-missing" };
  try {
    // `-I` keeps the reader isolated from the caller's PYTHONPATH and from the
    // current directory, so an unrelated file cannot stand in for it.
    const { stdout } = await execFileAsync(
      "python3",
      ["-I", reader, "get", name, "--folder", folder, "--project", "fleet-ops", "--account", account],
      { encoding: "utf8", timeout: timeoutMs },
    );
    return { code: APNS_READ_OK, value: stdout.replace(/\r?\n$/, ""), reason: "ok" };
  } catch (err) {
    const status = exitStatus(err);
    if (status === APNS_READ_ABSENT) return { code: APNS_READ_ABSENT, value: null, reason: "absent" };
    if (status === APNS_READ_USAGE) return { code: APNS_READ_USAGE, value: null, reason: "usage" };
    return { code: APNS_READ_REFUSED, value: null, reason: "refused" };
  }
}

/**
 * The exit status of a child that ended on a non-zero code.
 *
 * Node puts the status on the error's `code`, and a child that was killed
 * has none:  a missing status is a refused read, never an absent name.
 */
function exitStatus(err: unknown): number {
  if (err instanceof Error && "code" in err) {
    const status = Number(err.code);
    if (Number.isInteger(status)) return status;
  }
  return 0;
}
