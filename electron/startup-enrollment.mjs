import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { botfleetDataDir } from "./app-paths.mjs";

export const STARTUP_ENROLLMENT_FILE = "startup-enrollment.json";

const ENROLLMENT_ERROR = "BotFleet could not read its startup choice.\u00a0 Choose this Mac or Infisical server settings in Server Setup before continuing.";

/** This nonsecret preference grants startup permission, not a server address. */
export function parseStartupEnrollment(value) {
  if (
    Object.prototype.toString.call(value) !== "[object Object]" ||
    Object.keys(value).length !== 2 || !Object.hasOwn(value, "version") || value.version !== 1 ||
    !Object.hasOwn(value, "mode") || (value.mode !== "local" && value.mode !== "remote")
  ) {
    throw new Error(ENROLLMENT_ERROR);
  }
  return value.mode;
}

export function readStartupEnrollment(dataDir = botfleetDataDir()) {
  let fd;
  try {
    fd = fs.openSync(path.join(dataDir, STARTUP_ENROLLMENT_FILE), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024) throw new Error(ENROLLMENT_ERROR);
    return parseStartupEnrollment(JSON.parse(fs.readFileSync(fd, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(ENROLLMENT_ERROR);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function writeStartupEnrollment(mode, dataDir = botfleetDataDir()) {
  parseStartupEnrollment({ version: 1, mode });
  const temporary = path.join(dataDir, `.${STARTUP_ENROLLMENT_FILE}.${randomUUID()}`);
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, mode })}\n`, { flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, path.join(dataDir, STARTUP_ENROLLMENT_FILE));
  } catch {
    throw new Error(ENROLLMENT_ERROR);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Preserve the safe failure above. */ }
  }
}

/** Resolve consent before the injected remote reader can touch credentials. */
export async function resolveEnrolledServerTarget({
  readEnrollment = readStartupEnrollment,
  writeEnrollment = writeStartupEnrollment,
  chooseMode,
  readRemoteTarget,
  forceChoice = false,
  legacyFile = false,
  hasLegacyEnrollment = async () => false,
  interactive = true,
} = {}) {
  let mode;
  let persist = false;
  try {
    mode = forceChoice ? null : await readEnrollment();
    // A Mac enrolled before this choice existed keeps working: its Keychain
    // token was the owner's consent.  An explicit file always wins over it.
    if (mode === null && !forceChoice && await hasLegacyEnrollment()) mode = "remote";
    else if (mode === null && !forceChoice && !interactive) {
      // Smoke and headless launches cannot answer a dialog and must not
      // write a preference nobody chose: they run on this Mac, as before.
      return { mode: "local", source: "local-preference", legacyFile };
    } else if (mode === null) {
      mode = await chooseMode?.();
      if (mode === null || mode === undefined) {
        return { mode: "cancelled", source: "startup-enrollment", legacyFile };
      }
      parseStartupEnrollment({ version: 1, mode });
      persist = true;
    } else {
      parseStartupEnrollment({ version: 1, mode });
    }
    // Local needs no vault read, so its choice is saved now.  A remote choice
    // is saved only after the vault read works, so a Mac with no bootstrap
    // token is asked again instead of failing the same way on every launch.
    if (persist && mode === "local") await writeEnrollment(mode);
  } catch {
    return { mode: "error", source: "startup-enrollment", legacyFile, message: ENROLLMENT_ERROR };
  }
  if (mode === "local") return { mode: "local", source: "local-preference", legacyFile };
  const target = await readRemoteTarget();
  if (target?.source === "not-enrolled") {
    return {
      mode: "error",
      source: "infisical",
      legacyFile: target.legacyFile === true,
      message: "Infisical server settings are selected, but this Mac has no bootstrap token.\u00a0 Complete enrollment or choose this Mac in Server Setup.",
    };
  }
  if (persist && target?.mode !== "error") {
    try { await writeEnrollment(mode); } catch {
      return { mode: "error", source: "startup-enrollment", legacyFile, message: ENROLLMENT_ERROR };
    }
  }
  return target;
}
