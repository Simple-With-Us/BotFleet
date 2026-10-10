// Vitest setup — every test file gets a throwaway home directory so
// DATA_DIR (~/.botfleet) never touches the real one. os.homedir()
// reads HOME (POSIX) / USERPROFILE (Windows) at call time, and this file
// runs before any test module imports server/config.ts.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach } from "vitest";

import { containerRuntimeLockdownEnv } from "../container-runtime-guard.ts";
import { removeTempDir } from "./cleanup.ts";

const home = mkdtempSync(join(tmpdir(), "omb-test-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
// OMB_DATA_DIR is an intentional production override, but tests must never
// let it escape the throwaway home they are about to delete.
delete process.env.OMB_DATA_DIR;
// Do not let a developer's Hermes global config path leak into per-test homes.
delete process.env.HERMES_HOME;
// Container runtimes are OFF for every test process.  The Local VM container
// name derives from the OS username, not HOME, and docker/podman/orb talk to
// one machine-wide daemon, so a throwaway HOME does not isolate them: a test
// that turned the Local VM on once created (and orphaned) the owner's real
// `botfleet-computer-<user>` container.  server/container-runtime-guard.ts
// enforces this at the spawn layer; a suite that shadows `docker` with a
// script names its directory in BOTFLEET_CONTAINER_RUNTIME_FIXTURE_DIR, and a
// suite that boots a harness gets the same env from `spawnDetached`.
Object.assign(process.env, containerRuntimeLockdownEnv());
delete process.env.BOTFLEET_CONTAINER_RUNTIME_FIXTURE_DIR;

// The companion keeps its paired devices in its own directory, and resolves
// it from homedir() the same way — so the redirect above already covers it.
// Named explicitly all the same: the device tests delete this directory
// wholesale, and "it is safe because of a line in another file" is not the
// footing that delete should stand on.
process.env.OMB_COMPANION_DIR = join(home, ".botfleet-companion");

// SQLite keeps the database file open for the lifetime of its handle.
// Windows will not remove a directory containing an open database, so close
// the per-test handle before the next test resets its throwaway data dir.
const { closeMessageDb } = await import("../message-db.ts");
afterEach(closeMessageDb);

// Windows holds a directory that is a live process's cwd, and a just-killed
// CLI lets go a beat after the kill call returns — see removeTempDir.
afterAll(async () => {
  closeMessageDb();
  await removeTempDir(home);
});
