import { describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";

// The desktop app's resolver is the other half of this contract: the app and the server must
// name one directory for the same environment, or a rig configured with padding splits them.
import { botfleetDataDir } from "../electron/app-paths.mjs";
import { dataDir, dataDirOverride } from "./data-dir.ts";

describe("the data directory resolver", () => {
  it("defaults to ~/.botfleet", () => {
    expect(dataDir({})).toBe(join(homedir(), ".botfleet"));
  });

  it("uses a set override verbatim, trimmed", () => {
    expect(dataDir({ OMB_DATA_DIR: "/Volumes/External/botfleet" })).toBe(
      "/Volumes/External/botfleet",
    );
    expect(dataDir({ OMB_DATA_DIR: "  /Volumes/External/botfleet  " })).toBe(
      "/Volumes/External/botfleet",
    );
  });

  it("treats an empty or blank override as unset, never as the working directory", () => {
    for (const value of ["", "   ", "\t\n"]) {
      expect(dataDirOverride(value)).toBe("");
      expect(dataDir({ OMB_DATA_DIR: value })).toBe(join(homedir(), ".botfleet"));
    }
    expect(dataDir({ OMB_DATA_DIR: undefined })).toBe(join(homedir(), ".botfleet"));
  });

  it("agrees with the desktop app for every case", () => {
    for (const value of [undefined, "", "   ", "/Volumes/External/botfleet", "  /tmp/rig  "]) {
      const env = value === undefined ? {} : { OMB_DATA_DIR: value };
      expect(dataDir(env)).toBe(botfleetDataDir(env, homedir()));
    }
  });
});
