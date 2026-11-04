// Starts two real child processes for placement fixtures, a controller and a
// worker, and always stops what it started (BF-2642).  Each child gets only
// the environment the caller names, plus PATH, so a fixture cannot inherit the
// developer's data directory or credentials by accident.
import type { ChildProcess } from "node:child_process";
import { readdirSync } from "node:fs";

import { spawnDetached, waitForExit } from "./cleanup.ts";

export interface FixtureChildSpec {
  label: string;
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** Answers true once the child can take work. */
  ready: () => Promise<boolean>;
  timeoutMs?: number;
}

export interface FixtureChild {
  readonly label: string;
  readonly child: ChildProcess;
  stderr(): string;
  /** Safe to call more than once, and after the child has already exited. */
  stop(): Promise<void>;
}

const STDERR_LIMIT = 64 * 1024;

export async function startFixtureChild(spec: FixtureChildSpec): Promise<FixtureChild> {
  const env: NodeJS.ProcessEnv = { ...spec.env };
  if (process.env.PATH && !env.PATH) env.PATH = process.env.PATH;
  const child = spawnDetached(spec.command, [...spec.args], { cwd: spec.cwd, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (part: Buffer) => {
    if (stderr.length < STDERR_LIMIT) stderr += part.toString("utf8");
  });
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) await waitForExit(child, { signal: "SIGTERM" });
  };
  const deadline = Date.now() + (spec.timeoutMs ?? 30_000);
  // A probe that hangs must not outlive the deadline, and a child must not
  // outlive a probe that throws:  both would leave its ports and files held.
  const probe = async (): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now())); });
    try { return await Promise.race([spec.ready(), expiry]); } finally { clearTimeout(timer); }
  };
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${spec.label} exited before it was ready: ${stderr}`);
    }
    let ready: boolean;
    try {
      ready = await probe();
    } catch (error) {
      await stop();
      throw error;
    }
    if (ready) break;
    if (Date.now() >= deadline) {
      await stop();
      throw new Error(`${spec.label} was not ready in time: ${stderr}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { label: spec.label, child, stderr: () => stderr, stop };
}

export interface FixturePair {
  readonly controller: FixtureChild;
  readonly worker: FixtureChild;
  stop(): Promise<void>;
}

/** Starts the controller, then the worker.  A worker that cannot start stops the controller too. */
export async function startFixturePair(specs: { controller: FixtureChildSpec; worker: FixtureChildSpec }): Promise<FixturePair> {
  const controller = await startFixtureChild(specs.controller);
  let worker: FixtureChild;
  try {
    worker = await startFixtureChild(specs.worker);
  } catch (error) {
    await controller.stop();
    throw error;
  }
  return {
    controller, worker,
    stop: async () => {
      // The controller stops even when stopping the worker fails.
      try {
        await worker.stop();
      } finally {
        await controller.stop();
      }
    },
  };
}

/** The pids of every run `nonce-job.mjs` recorded for this nonce. */
export function nonceRuns(directory: string, nonce: string): number[] {
  const prefix = `${nonce}.`;
  return readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => /^([1-9]\d*)\.[0-9a-f-]{36}\.run$/.exec(name.slice(prefix.length)))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .sort((a, b) => a - b);
}
