import { spawn } from "node:child_process";

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

export interface CliWrapperConfig {
  command: string;
  args: string[];
  passPromptAs: "stdin" | "arg";
}

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
    const r = raw as Record<string, unknown>;
    return {
      command: typeof r?.command === "string" ? r.command : "echo",
      args: Array.isArray(r?.args) ? r.args.map(String) : [],
      passPromptAs: r?.passPromptAs === "stdin" ? "stdin" : "arg",
    };
  },
  async create(input: DriverCreateInput<CliWrapperConfig>): Promise<ProviderInstance> {
    const { config, instanceId, displayName } = input;
    const listeners = new Set<RuntimeEventListener>();

    const emit = (event: RuntimeEvent) => {
      for (const listener of listeners) {
        listener(event);
      }
    };

    const adapter: ProviderAdapter = {
      provider: "cli-wrapper",
      capabilities: {
        sessionModelSwitch: "unsupported",
      },
      async sendTurn(turnInput: SendTurnInput): Promise<TurnStartResult> {
        const turnId = newId();

        const args = [...config.args];
        if (config.passPromptAs === "arg") {
          args.push(turnInput.text);
        }

        const child = spawn(config.command, args, {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (config.passPromptAs === "stdin") {
          child.stdin.write(turnInput.text);
          child.stdin.end();
        }

        child.stdout.on("data", (chunk: Buffer) => {
          emit({
            eventId: newEventId(),
            provider: "cli-wrapper",
            providerInstanceId: instanceId,
            createdAt: new Date().toISOString(),
            turnId,
            threadId: turnInput.threadId,
            type: "content.delta",
            streamKind: "assistant_text",
            delta: chunk.toString("utf8"),
          });
        });

        child.stderr.on("data", (chunk: Buffer) => {
          emit({
            eventId: newEventId(),
            provider: "cli-wrapper",
            providerInstanceId: instanceId,
            createdAt: new Date().toISOString(),
            turnId,
            threadId: turnInput.threadId,
            type: "content.delta",
            streamKind: "assistant_text",
            delta: `[stderr] ${chunk.toString("utf8")}`,
          });
        });

        child.on("close", (code) => {
          emit({
            eventId: newEventId(),
            provider: "cli-wrapper",
            providerInstanceId: instanceId,
            createdAt: new Date().toISOString(),
            turnId,
            threadId: turnInput.threadId,
            type: "turn.completed",
            ok: code === 0,
            usage: { input: 0, output: 0 },
          });
        });

        child.on("error", (err) => {
          emit({
            eventId: newEventId(),
            provider: "cli-wrapper",
            providerInstanceId: instanceId,
            createdAt: new Date().toISOString(),
            turnId,
            threadId: turnInput.threadId,
            type: "turn.completed",
            ok: false,
            stopReason: err.message,
          });
        });

        return { turnId };
      },
      async interruptTurn() {
        // Not implemented for simple CLI
      },
      async respondToRequest() {
        return "unavailable";
      },
      hasSession: () => false,
      stopAll: async () => {},
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
        return {
          state: "available",
          authenticated: true,
          version: null,
        };
      },
      async dispose() {},
    };
  },
};
