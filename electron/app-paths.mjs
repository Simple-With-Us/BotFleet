// Where the desktop app's own data lives on this machine.
//
// One resolver, because three call sites used to disagree: the harness
// child, the persist-on-exit policy, and the startup-session marker each
// spelled the path out on their own, and the application menu referred to a
// DATA_DIR constant that was never defined anywhere — so "Open Data Folder"
// and "Open Logs & Data Folder" both threw a ReferenceError the moment a
// person clicked them.
//
// The override is OMB_DATA_DIR, the same name the harness and the launchd
// wrapper use, so one machine can point the app and the server at the same
// directory.  An empty or whitespace-only override is treated as unset:
// `OMB_DATA_DIR=""` must not resolve to the current working directory.
import os from "node:os";
import path from "node:path";

export function botfleetDataDir(env = process.env, home = os.homedir()) {
  const override = typeof env.OMB_DATA_DIR === "string" ? env.OMB_DATA_DIR.trim() : "";
  return override || path.join(home, ".botfleet");
}
