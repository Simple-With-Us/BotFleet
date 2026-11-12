import { access, stat } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

import type { TaskAppRef, TaskWorkspaceContext } from "../shared/task-workspace-context.ts";
import { execCli } from "./procs.ts";
import { realOrResolved, validateBotCwd } from "./bot-cwd.ts";

const GIT_PROBE_TIMEOUT_MS = 1_500;
const GIT_PROBE_MAX_BUFFER = 64 * 1024;
const COMMIT_HASH = /^[0-9a-f]{40,64}$/;

export class TaskWorkspaceContextError extends Error {
  readonly code = "cwd_unavailable";

  constructor(cwd: string) {
    super(`Working directory is missing, inaccessible, or not a directory: ${cwd}.  Choose an accessible local directory and try again.`);
    this.name = "TaskWorkspaceContextError";
  }
}

async function assertAccessibleDirectory(cwd: string): Promise<void> {
  try {
    if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("not an absolute directory");
    await access(cwd, constants.R_OK | constants.X_OK);
  } catch {
    throw new TaskWorkspaceContextError(cwd);
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // A parent process may be operating on an unrelated repository.  Git facts
  // must describe the checked directory, not its inherited Git override.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

type GitProbeResult = { ok: true; value: string } | { ok: false; exitCode: unknown };

function gitProbe(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<GitProbeResult> {
  return new Promise((resolve) => {
    execCli("git", args, {
      cwd,
      env,
      timeout: GIT_PROBE_TIMEOUT_MS,
      maxBuffer: GIT_PROBE_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout) => resolve(error
      ? { ok: false, exitCode: "code" in error ? error.code : undefined }
      : { ok: true, value: stdout.trim() }));
  });
}

/** Capture Git labels without changing the explicit execution directory. */
export async function captureTaskWorkspaceContext(appRef: TaskAppRef, cwd: string): Promise<TaskWorkspaceContext> {
  await assertAccessibleDirectory(cwd);
  const env = gitEnv();
  const rootProbe = await gitProbe(cwd, ["rev-parse", "--show-toplevel"], env);
  let git: TaskWorkspaceContext["git"];
  if (rootProbe.ok && rootProbe.value && isAbsolute(rootProbe.value)) {
    const [branchProbe, headProbe] = await Promise.all([
      gitProbe(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], env),
      gitProbe(cwd, ["rev-parse", "--verify", "HEAD"], env),
    ]);
    // A detached branch and an unborn HEAD have normal Git exit codes.  An
    // interrupted or failed probe leaves all Git labels unavailable.
    const branchKnown = branchProbe.ok || branchProbe.exitCode === 1;
    const headKnown = headProbe.ok || headProbe.exitCode === 128;
    if (branchKnown && headKnown && (!headProbe.ok || COMMIT_HASH.test(headProbe.value))) {
      git = {
        checkoutRoot: rootProbe.value,
        branch: branchProbe.ok ? branchProbe.value : null,
        headCommit: headProbe.ok ? headProbe.value : null,
      };
    }
  }
  // The directory can disappear during a bounded probe.  A failed probe only
  // means Git facts are unavailable; a vanished execution directory is fatal.
  await assertAccessibleDirectory(cwd);
  const context: TaskWorkspaceContext = { kind: "local", appRef, cwd, capturedAt: Date.now() };
  if (git) context.git = git;
  return context;
}

/** Fail before claiming a provider turn if it cannot honor the local binding. */
export function taskWorkspaceExecutionError(
  context: TaskWorkspaceContext | undefined,
  driverKind: string,
  runOn?: string,
  executionCwd?: string | null,
): string | null {
  if (!context) return null;
  if (executionCwd !== context.cwd) return "this task has inconsistent App folder metadata — restore its original binding before continuing";
  if (runOn === "cloud" || driverKind === "grok" || driverKind === "boxAgent") {
    return "this task is bound to a local App folder — choose a model that runs in that folder";
  }
  try { accessSync(context.cwd, constants.R_OK | constants.X_OK); } catch {
    return "this task's App folder is unavailable — restore access before continuing";
  }
  const checked = validateBotCwd(context.cwd);
  if (!checked.ok) return checked.error;
  if (!checked.cwd || realOrResolved(checked.cwd) !== context.cwd) {
    return "this task's App folder has moved — restore its original folder before continuing";
  }
  return null;
}
