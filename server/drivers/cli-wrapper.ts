import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

import type {
  DriverCreateInput,
  ProviderAdapter,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
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
    
    const adapter: ProviderAdapter = {
      provider: "cli-wrapper",
      capabilities: {
        sessionModelSwitch: "unsupported",
      },
      async sendTurn(turnInput: SendTurnInput): Promise<TurnStartResult> {
        const turnId = newId();
        
        let args = [...config.args];
        if (config.passPromptAs === "arg") {
          args.push(turnInput.prompt);
        }

        const child = spawn(config.command, args, {
          cwd: turnInput.context.cwd ?? process.cwd(),
          env: { ...process.env, ...turnInput.environment },
          stdio: ["pipe", "pipe", "pipe"],
        });

        if (config.passPromptAs === "stdin") {
          child.stdin.write(turnInput.prompt);
          child.stdin.end();
        }

        child.stdout.on("data", (chunk: Buffer) => {
          turnInput.onEvent({
            eventId: newEventId(),
            turnId,
            type: "text",
            delta: chunk.toString("utf8"),
          });
        });

        child.stderr.on("data", (chunk: Buffer) => {
          turnInput.onEvent({
            eventId: newEventId(),
            turnId,
            type: "text",
            delta: `[stderr] ${chunk.toString("utf8")}`,
          });
        });

        child.on("close", (code) => {
          turnInput.onEvent({
            eventId: newEventId(),
            turnId,
            type: "turn.completed",
            usage: { inputTokens: 0, outputTokens: 0, roundTrips: 1 },
          });
        });

        child.on("error", (err) => {
          turnInput.onEvent({
            eventId: newEventId(),
            turnId,
            type: "turn.completed",
            error: { reason: "unknown", transient: false, detail: err.message },
          });
        });

        return { turnId };
      },
      async interruptTurn(threadId, turnId) {
        // Not implemented for simple CLI
      },
      async respondToRequest(threadId, requestId, decision) {
        return "unavailable";
      },
      async sendMidTurnMessage(threadId, turnId, message) {
        // Not implemented
      },
      async dispose() {
      }
    };

    return {
      instanceId,
      driverKind: "cli-wrapper",
      displayName,
      enabled: true,
      models: this.models,
      adapter,
      async snapshot(): Promise<ProviderSnapshot> {
        return {
          instanceId,
          driverKind: "cli-wrapper",
          displayName,
          enabled: true,
          config,
          models: { ...CliWrapperDriver.models },
        };
      },
      async dispose() {},
    };
  },
};
