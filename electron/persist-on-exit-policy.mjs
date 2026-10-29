import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const FILE_NAME = "persist-on-exit.policy";

/** A strict local override lets Control change the quit policy while the harness is offline. */
export function readPersistOnExitPolicy(dataDir) {
  try {
    const value = readFileSync(join(dataDir, FILE_NAME), "utf8");
    if (value === "true\n") return true;
    if (value === "false\n") return false;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return null;
}

export function writePersistOnExitPolicy(dataDir, value) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = join(dataDir, FILE_NAME);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, value ? "true\n" : "false\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
