import type { ChildProcess } from "node:child_process";
import { homedir } from "node:os";

import { z } from "zod";

import type {
  DriverCreateInput,
  ProviderAdapter,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
  TurnStartResult,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { stripWorkspaceCredentialEnv } from "../config.ts";
import { augmentedPath } from "../env-path.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";

/** The longest prompt that may ride in argv.  ARG_MAX is megabytes on Linux
 * but the whole Windows command line is one 32KB buffer, and a prompt that
 * long means the caller inlined a transcript that `passPromptAs: "stdin"`
 * exists for (claude.ts carries the same rule in a comment).  Over the cap
 * the turn fails in words instead of an E2BIG spawn error nobody can read. */
const MAX_PROMPT_ARG_BYTES = 32_000;

/** Runtime config is a contract boundary, so it is parsed rather than
 * asserted.  Every field defaults, so an instance saved with no config still
 * decodes; a field saved with the wrong type is rejected, and registry.ts
 * turns that rejection into a shadow entry whose reason is this error. */
export const CliWrapperConfigSchema = z.object({
  command: z.string().min(1).default("echo"),
  args: z.array(z.string()).default([]),
  passPromptAs: z.enum(["stdin", "arg"]).default("arg"),
});

export type CliWrapperConfig = z.infer<typeof CliWrapperConfigSchema>;

export const CliWrapperDriver: ProviderDriver<CliWrapperConfig> = {
  driverKind: "cli-wrapper",
  metadata: {
    displayName: "Generic CLI Wrapper",
    supportsMultipleInstances: true,
  },
  models: {
    default: "default",
    options: [{ id: "default", label: "Default CLI" }],
  },
  defaultConfig(): CliWrapperConfig {
    return { command: "echo", args: ["CLI Wrapper not configured"], passPromptAs: "arg" };
  },
  decodeConfig(raw: unknown): CliWrapperConfig {
    return CliWrapperConfigSchema.parse(raw ?? {});
  },
  async create(input: DriverCreateInput<CliWrapperConfig>): Promise<ProviderInstance> {
    const { config, instanceId, displayName } = input;
    const listeners = new Set<RuntimeEventListener>();
    // Every child this instance spawned, keyed by thread, so an interrupt or
    // a teardown can reach the process instead of leaking it for the life of
    // the server.
    const children = new Map<string, ChildProcess>();

    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    // The wrapped CLI is somebody else's program.  It gets the PATH the app
    // resolves CLIs with plus the instance's own approved environment, and
    // none of the harness's credentials — pi.ts and codex.ts build theirs the
    // same way.  Inheriting all of process.env would hand an arbitrary
    // binary every provider key and webhook secret the server holds.
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...input.environment,
        PATH: augmentedPath(),
      };
      stripWorkspaceCredentialEnv(env);
      return env;
    };

    const killThread = (threadId: string): void => {
      const child = children.get(threadId);
      if (!child) return;
      children.delete(threadId);
      try {
        killCliTree(child);
      } catch {
        // Already gone, or never got a pid.  The turn is settled either way.
      }
    };

    // One probe per instance, so the snapshot reports whether the configured
    // command actually resolves instead of a hardcoded "available" that fails
    // only at turn time (pi.ts probes the same way at pi.ts:975).
    let probePromise: Promise<ProviderSnapshot> | null = null;
    const probeCommand = (): Promise<ProviderSnapshot> => {
      if (!probePromise) {
        probePromise = new Promise<ProviderSnapshot>((resolve) => {
          execCli(config.command, ["--version"], { env: childEnv(), timeout: 10_000 }, (err, stdout) => {
            if (!err) {
              const version = stdout.trim().split("\n")[0] || null;
              resolve({ state: "available", authenticated: true, version });
              return;
            }
            const failure = describeSpawnFailure(err as NodeJS.ErrnoException, config.command);
            resolve({ state: "unavailable", reason: failure.message });
          });
        });
      }
      return probePromise;
    };

    const adapter: ProviderAdapter = {
      provider: "cli-wrapper",
      capabilities: {
        sessionModelSwitch: "unsupported",
      },
      async sendTurn(turnInput: SendTurnInput): Promise<TurnStartResult> {
        const turnId = newId();
        const { threadId } = turnInput;

        const base = () => ({
          eventId: newEventId(),
          provider: "cli-wrapper" as const,
          providerInstanceId: instanceId,
          createdAt: new Date().toISOString(),
          turnId,
          threadId,
        });

        // Every driver opens its turn here, and sentry-ai.ts opens the
        // gen_ai.invoke_agent span on this event, so without it the driver
        // is untraced and index.ts's turnStats.started is skipped.
        emit({ ...base(), type: "turn.started" });

        // One terminal event per turn, whichever of `error` and `close` lands
        // first: a failed spawn fires BOTH, and a second turn.completed
        // re-runs the harness settle path and the failover chain (codex.ts
        // guards the same way).
        let settled = false;
        const settle = (ok: boolean, stopReason?: string): void => {
          if (settled) return;
          settled = true;
          children.delete(threadId);
          emit({
            ...base(),
            type: "turn.completed",
            ok,
            usage: { input: 0 },
            ...(stopReason ? { stopReason } : {}),
          });
        };

        const args = [...config.args];
        if (config.passPromptAs === "arg") {
          const bytes = Buffer.byteLength(turnInput.text, "utf8");
          if (bytes > MAX_PROMPT_ARG_BYTES) {
            settle(
              false,
              `prompt is ${bytes} bytes, over the ${MAX_PROMPT_ARG_BYTES}-byte argument limit — set passPromptAs to "stdin"`,
            );
            return { turnId };
          }
          args.push(turnInput.text);
        }

        let child: ChildProcess;
        try {
          // spawnCli, not raw spawn: it resolves the Windows executable
          // (libuv ignores PATHEXT, so a bare "claude" never finds
          // claude.cmd), applies windowsHide, and attaches the stdin error
          // handler that keeps a dead child's EPIPE from killing the harness.
          child = spawnCli(config.command, args, {
            cwd: turnInput.cwd ?? homedir(),
            env: childEnv(),
            stdio: ["pipe", "pipe", "pipe"],
          });
        } catch (err) {
          settle(false, err instanceof Error ? err.message : String(err));
          return { turnId };
        }
        children.set(threadId, child);

        if (config.passPromptAs === "stdin") {
          child.stdin?.write(turnInput.text);
          child.stdin?.end();
        }

        child.stdout?.on("data", (chunk: Buffer) => {
          emit({
            ...base(),
            type: "content.delta",
            streamKind: "assistant_text",
            delta: chunk.toString("utf8"),
          });
        });

        child.stderr?.on("data", (chunk: Buffer) => {
          emit({
            ...base(),
            type: "content.delta",
            streamKind: "assistant_text",
            delta: `[stderr] ${chunk.toString("utf8")}`,
          });
        });

        child.on("close", (code) => settle(code === 0));

        child.on("error", (err) => {
          // ENOENT on a CLI the user typed is a setup problem, not a crash,
          // and this is the wording the rest of the product uses for it.
          settle(false, describeSpawnFailure(err as NodeJS.ErrnoException, config.command).message);
        });

        return { turnId };
      },
      async interruptTurn(threadId) {
        killThread(threadId);
      },
      async respondToRequest() {
        return "unavailable";
      },
      hasSession: () => false,
      stopAll: async () => {
        for (const threadId of [...children.keys()]) killThread(threadId);
      },
      onEvent: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    return {
      instanceId,
      driverKind: "cli-wrapper",
      displayName,
      enabled: input.enabled,
      models: CliWrapperDriver.models,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        return probeCommand();
      },
      async dispose() {
        await adapter.stopAll();
        listeners.clear();
      },
    };
  },
};
