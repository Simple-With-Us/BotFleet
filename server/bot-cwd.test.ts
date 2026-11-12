import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { cwdConfinementError, protectedCwdDirs, validateBotCwd, validateConfinedCwd } from "./bot-cwd.ts";

const dir = mkdtempSync(join(tmpdir(), "omb-cwd-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("validateBotCwd", () => {
  it("accepts an existing absolute directory", () => {
    expect(validateBotCwd(dir)).toEqual({ ok: true, cwd: dir });
  });

  it("treats null and empty as clearing the folder", () => {
    expect(validateBotCwd(null)).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("")).toEqual({ ok: true, cwd: null });
    expect(validateBotCwd("   ")).toEqual({ ok: true, cwd: null });
  });

  it("expands a leading ~ to the home folder", () => {
    // compare against homedir() itself: a Windows home like C:\Users\RUNNER~1
    // legitimately contains "~", so "no ~ in the output" is not a valid check
    expect(validateBotCwd("~")).toEqual({ ok: true, cwd: resolve(homedir()) });
  });

  it("rejects relative paths, files, and missing folders with a reason", () => {
    expect(validateBotCwd("relative/path")).toEqual({ ok: false, error: expect.stringMatching(/absolute/) });
    const file = join(dir, "a-file.txt");
    writeFileSync(file, "x");
    expect(validateBotCwd(file)).toEqual({ ok: false, error: expect.stringMatching(/not a folder/) });
    expect(validateBotCwd(join(dir, "nope"))).toEqual({ ok: false, error: expect.stringMatching(/doesn't exist/) });
    expect(validateBotCwd(42)).toEqual({ ok: false, error: expect.stringMatching(/path/) });
  });
});

describe("cwdConfinementError", () => {
  // a throwaway "home" so the protected list is relative to something we own
  const home = mkdtempSync(join(tmpdir(), "omb-cwd-home-"));
  const dataDir = join(home, ".botfleet");
  const workspaces = join(dataDir, "workspaces");
  const project = join(home, "code", "project");
  const nested = join(project, "src");
  const ssh = join(home, ".ssh");
  for (const folder of [join(workspaces, "bot-1"), nested, ssh, join(home, "elsewhere")]) {
    mkdirSync(folder, { recursive: true });
  }
  const confinement = { roots: [project, workspaces], protectedDirs: protectedCwdDirs(home, dataDir) };
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it("allows a granted root and anything under it", () => {
    expect(cwdConfinementError(project, confinement)).toBeNull();
    expect(cwdConfinementError(nested, confinement)).toBeNull();
  });

  it("refuses a folder nobody on the computer granted", () => {
    expect(cwdConfinementError(join(home, "elsewhere"), confinement)).toMatch(/not one this computer already shares/);
    expect(cwdConfinementError(home, confinement)).toMatch(/not one this computer already shares/);
  });

  it("refuses key stores and the data directory, while the workspaces under it are a root", () => {
    expect(cwdConfinementError(ssh, confinement)).toMatch(/keys or BotFleet/);
    expect(cwdConfinementError(dataDir, confinement)).toMatch(/keys or BotFleet/);
    expect(cwdConfinementError(join(workspaces, "bot-1"), confinement)).toBeNull();
  });

  it("keeps a protected folder refused even when the whole home folder is a root", () => {
    const wide = { roots: [home], protectedDirs: protectedCwdDirs(home, dataDir) };
    expect(cwdConfinementError(join(home, "elsewhere"), wide)).toBeNull();
    expect(cwdConfinementError(ssh, wide)).toMatch(/keys or BotFleet/);
    expect(cwdConfinementError(join(ssh, "deeper"), wide)).toMatch(/keys or BotFleet/);
    // a root that IS a protected folder loses the tie
    const tied = { roots: [ssh], protectedDirs: protectedCwdDirs(home, dataDir) };
    expect(cwdConfinementError(ssh, tied)).toMatch(/keys or BotFleet/);
  });

  it("follows a symlink inside a root before deciding", () => {
    const link = join(project, "keys");
    try {
      symlinkSync(ssh, link, "dir");
    } catch {
      return; // no symlink permission on this runner
    }
    expect(cwdConfinementError(link, confinement)).toMatch(/keys or BotFleet/);
  });

  it("validateConfinedCwd keeps clearing and plain validation intact", () => {
    expect(validateConfinedCwd(null, confinement)).toEqual({ ok: true, cwd: null });
    expect(validateConfinedCwd("", confinement)).toEqual({ ok: true, cwd: null });
    expect(validateConfinedCwd("relative", confinement)).toEqual({ ok: false, error: expect.stringMatching(/absolute/) });
    expect(validateConfinedCwd(nested, confinement)).toEqual({ ok: true, cwd: nested });
    expect(validateConfinedCwd(ssh, confinement)).toEqual({ ok: false, error: expect.stringMatching(/keys or BotFleet/) });
  });
});
