import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { captureTaskWorkspaceContext, TaskWorkspaceContextError, taskWorkspaceExecutionError } from "./task-workspace-context.ts";

const scratchDirs: string[] = [];
const appRef = { kind: "group" as const, id: "existing-app-group" };

function fixture(): string {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "botfleet-task-context-")));
  scratchDirs.push(cwd);
  return cwd;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
  }).trim();
}

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("captureTaskWorkspaceContext", () => {
  it("keeps the chosen subdirectory while describing its Git checkout", async () => {
    const checkoutRoot = fixture();
    git(checkoutRoot, "init", "-b", "fixture-branch");
    writeFileSync(join(checkoutRoot, "README.md"), "fixture\n");
    git(checkoutRoot, "add", "README.md");
    git(checkoutRoot, "commit", "-m", "Fixture commit");
    const cwd = join(checkoutRoot, "nested", "work");
    mkdirSync(cwd, { recursive: true });

    const before = Date.now();
    const context = await captureTaskWorkspaceContext(appRef, cwd);

    expect(context.kind).toBe("local");
    expect(context.appRef).toEqual(appRef);
    expect(context.cwd).toBe(cwd);
    if (!context.git) throw new Error("Expected Git metadata for the fixture checkout");
    // Windows Git may use long names and forward slashes while the fixture
    // retains an 8.3 path alias.  Native realpath resolves both spellings.
    expect(realpathSync.native(context.git.checkoutRoot)).toBe(realpathSync.native(checkoutRoot));
    expect(context.git.branch).toBe("fixture-branch");
    expect(context.git.headCommit).toBe(git(checkoutRoot, "rev-parse", "HEAD"));
    expect(context.capturedAt).toBeGreaterThanOrEqual(before);
    expect(context.capturedAt).toBeLessThanOrEqual(Date.now());
  });

  it("keeps a non-Git directory without inventing Git facts", async () => {
    const cwd = fixture();
    const context = await captureTaskWorkspaceContext(appRef, cwd);

    expect(context.cwd).toBe(cwd);
    expect(context.git).toBeUndefined();
  });

  it("rejects a missing execution directory with an actionable error", async () => {
    const cwd = join(fixture(), "missing");

    await expect(captureTaskWorkspaceContext(appRef, cwd)).rejects.toMatchObject({
      name: "TaskWorkspaceContextError",
      code: "cwd_unavailable",
    } satisfies Partial<TaskWorkspaceContextError>);
  });
});

describe("taskWorkspaceExecutionError", () => {
  it("allows a local binding only while its exact execution directory is available", async () => {
    const cwd = fixture();
    const context = await captureTaskWorkspaceContext(appRef, cwd);
    expect(taskWorkspaceExecutionError(context, "claudeAgent", undefined, cwd)).toBeNull();
    expect(taskWorkspaceExecutionError(context, "claudeAgent", undefined, cwd + "/other")).toMatch(/inconsistent/);
    rmSync(cwd, { recursive: true });
    expect(taskWorkspaceExecutionError(context, "claudeAgent", undefined, cwd)).toMatch(/unavailable/);
  });

  it("refuses engines and cloud turns that discard the local execution directory", async () => {
    const cwd = fixture();
    const context = await captureTaskWorkspaceContext(appRef, cwd);
    for (const driver of ["grok", "boxAgent"]) {
      expect(taskWorkspaceExecutionError(context, driver, undefined, cwd)).toMatch(/local App folder/);
    }
    expect(taskWorkspaceExecutionError(context, "claudeAgent", "cloud", cwd)).toMatch(/local App folder/);
    expect(taskWorkspaceExecutionError(undefined, "grok", "cloud")).toBeNull();
    expect(context.cwd).toBe(cwd);
  });
});
