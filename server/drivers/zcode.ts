// ZCode (z.ai's GLM Coding Plan agent) as a BotFleet engine: the `zcode`
// CLI in its own documented headless mode, one process per turn.
//
// Headless contract (apps/zcode-cli/docs/usage/13-automation.md in
// zai-org/ZCode): `zcode --prompt <text> --cwd <dir> --mode yolo
// --disallowed-tools "AskUserQuestion EnterPlanMode ExitPlanMode"
// --output-format stream-json --no-color` writes one JSON event per line and
// closes with a `{type:"result", response, usage, sessionId, ...}` line.
// Headless mode cannot answer the interactive ask tools, which is why the
// recipe removes them; nothing here synthesizes an answer the model was
// waiting for.
//
// Session continuity: the result line's sessionId is the resume handle the
// harness persists as resumeCursor; the next turn passes `--resume <id>`.
//
// Billing: turns ride the GLM Coding Plan subscription behind the local
// ZCode sign-in (~/.zcode/v2/credentials.json, written by the desktop app's
// Connect flow), not an API key. Stray Z_AI/GLM/BIGMODEL key env vars are
// stripped from the child so an inherited key cannot silently flip billing
// off the subscription (the same rule kimi.ts applies to MOONSHOT/KIMI keys).
//
// Verified against zai-org/ZCode: packages/cli/src/prompt-command.ts (result
// line shape, terminator semantics), packages/bootstrap/src/zcode-protocol/
// session-mapper.ts (event types + model.streaming payload kinds), and
// packages/shared/src/official-glm-model-id.ts (built-in model ids).

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { stripWorkspaceCredentialEnv } from "../config.ts";
import { applyLaunchIdentity } from "../launch-identity.ts";
import { augmentedPath } from "../env-path.ts";
import { toolFields } from "../tool-fields.ts";
import { describeResult } from "../../shared/tool-activity.ts";
import { captureInput, captureOutput } from "../../shared/item-io.ts";
import {
  classifyVersionProbeFailure,
  describeSpawnFailure,
  killCliTree,
  LastKnownAnswer,
  logProbeFailure,
  spawnCli,
} from "../procs.ts";
import { STDERR_EXCERPT_HEAD, STDERR_EXCERPT_TAIL, stderrExcerpt } from "../stderr-excerpt.ts";

import { newEventId, newId } from "../contracts.ts";
import type {
  DriverCreateInput,
  ModelCatalog,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { z } from "zod";

import { isJsonString, schemaIssue } from "../schema.ts";
import { appendNative } from "./native.ts";

const DRIVER_KIND = "zcodeAgent";
const PROVIDER_LABEL = "ZCode";

/** ZCode's built-in Coding Plan models (packages/shared/src/
 *  official-glm-model-id.ts; the docs name GLM-5.3 and GLM-5.3-Flash as the
 *  built-ins). Ids are passed to `--model` verbatim. */
const ZCODE_MODELS: ModelCatalog = {
  default: "GLM-5.3",
  options: [
    { id: "GLM-5.3", label: "GLM-5.3" },
    { id: "GLM-5.3-Flash", label: "GLM-5.3 Flash" },
  ],
};

/** Keys that would silently move a turn off the Coding Plan subscription and
 *  onto metered API billing if inherited.  The ACP driver
 *  (`server/drivers/acp/zcode.ts`) strips this same list from its bridge
 *  child, so the two engines cannot drift. */
export const ZCODE_CREDENTIAL_ENV = [
  "Z_AI_API_KEY",
  "ZAI_API_KEY",
  "GLM_API_KEY",
  "BIGMODEL_API_KEY",
  "ZHIPUAI_API_KEY",
  "ZHIPU_API_KEY",
];

const DEFAULT_CLI = "zcode";

const ZCODE_CONFIG_SCHEMA = z
  .object({
    // An empty saved cli ("" or whitespace) predates validation; fall back to
    // the default rather than breaking engine creation.
    cli: z.string().trim().min(1).catch(DEFAULT_CLI),
  })
  .partial()
  .passthrough();
type ZcodeConfigInput = z.input<typeof ZCODE_CONFIG_SCHEMA>;

interface ZcodeConfig {
  cli: string;
}

function decodeConfig(raw: ZcodeConfigInput | null | undefined): ZcodeConfig {
  const parsed = ZCODE_CONFIG_SCHEMA.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`zcode: ${schemaIssue(parsed.error, "invalid engine config")}`);
  return { cli: parsed.data.cli ?? "zcode" };
}

function zcodeEnvironment(source: Record<string, string | undefined>) {
  const env: typeof source = { ...source, PATH: augmentedPath() };
  stripWorkspaceCredentialEnv(env);
  for (const key of ZCODE_CREDENTIAL_ENV) delete env[key];
  return env;
}

function zcodeCredentialsPath(env: Record<string, string | undefined>): string {
  const base = env.ZCODE_DATA_BASE_DIR || env.HOME || env.USERPROFILE || "";
  return join(base, ".zcode", "v2", "credentials.json");
}

function zcodeAuthenticated(env: Record<string, string | undefined>): boolean {
  return existsSync(zcodeCredentialsPath(env));
}

/** The stream-json line shapes this driver reads (prompt-command.ts +
 *  session-mapper.ts), decoded at the stdout boundary. Unknown event types
 *  and fields pass through untouched. */
const ZCODE_USAGE_SCHEMA = z
  .object({
    // Per-field catches: one mistyped optional field degrades to undefined
    // instead of failing the whole line (which used to swallow the result
    // terminator and fail the turn as exit_before_result).
    inputTokens: z.number().optional().catch(undefined),
    outputTokens: z.number().optional().catch(undefined),
    cacheReadTokens: z.number().optional().catch(undefined),
    cacheWriteTokens: z.number().optional().catch(undefined),
    reasoningTokens: z.number().optional().catch(undefined),
  })
  .passthrough();

const ZCODE_PAYLOAD_SCHEMA = z
  .object({
    kind: z.string().optional().catch(undefined),
    delta: z.string().optional().catch(undefined),
    toolCallId: z.string().optional().catch(undefined),
    callId: z.string().optional().catch(undefined),
    id: z.string().optional().catch(undefined),
    toolName: z.string().optional().catch(undefined),
    name: z.string().optional().catch(undefined),
    input: z.unknown().optional(),
    args: z.unknown().optional(),
    arguments: z.unknown().optional(),
    output: z.unknown().optional(),
    result: z.unknown().optional(),
    error: z.unknown().optional(),
    message: z.string().optional().catch(undefined),
  })
  .passthrough();

const ZCODE_STREAM_LINE_SCHEMA = z
  .object({
    type: z.string().optional().catch(undefined),
    sessionId: z.string().optional().catch(undefined),
    turnId: z.string().optional().catch(undefined),
    payload: ZCODE_PAYLOAD_SCHEMA.optional().catch(undefined),
    // result line (the stream terminator)
    response: z.string().optional().catch(undefined),
    usage: ZCODE_USAGE_SCHEMA.optional().catch(undefined),
  })
  .passthrough();

type ZcodeStreamLine = z.infer<typeof ZCODE_STREAM_LINE_SCHEMA>;
type ZcodeStreamUsage = ZcodeStreamLine["usage"];

interface ZcodeTurnUsage {
  input: number;
  output: number;
  cachedInput?: number;
  reasoning?: number;
}

/** ModelUsage semantics (packages/contracts ModelUsage): cache reads and
 *  writes are folded into the input figure when no explicit inputTokens
 *  arrives, and cachedInput is reported as the subset. */
function buildTurnUsage(usage: ZcodeStreamUsage, input: number | undefined): ZcodeTurnUsage | undefined {
  if (!usage || input === undefined) return undefined;
  const out: ZcodeTurnUsage = { input, output: usage.outputTokens ?? 0 };
  if (usage.cacheReadTokens) out.cachedInput = usage.cacheReadTokens;
  if (usage.reasoningTokens) out.reasoning = usage.reasoningTokens;
  return out;
}

const VERSION_PROBE_TIMEOUT_MS = 20000;

// The official desktop app ships the CLI as a node bundle inside the app
// (executable, node shebang) but installs no PATH wrapper — resolve it
// where the app puts it. Only the user-facing `zcode` CLI is a candidate;
// the app bundle's internal agent binaries are not a supported entrypoint.
const BUNDLED_CLI_CANDIDATES =
  process.platform === "darwin"
    ? [
        "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        join(homedir(), "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
      ]
    : [];

/** One `--version` run: version stdout when the CLI exits 0 within the
 *  timeout, else an error explaining the miss. A candidate that cannot
 *  answer `--version` is not a usable headless CLI. */
function probeVersion(
  cli: string,
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<{ version: string | null; error: Error | null }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawnCli>;
    try {
      child = spawnCli(cli, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env });
    } catch (error) {
      // SAFETY: spawnCli throws Error instances synchronously on a bad spawn.
      resolve({ version: null, error: error as Error });
      return;
    }
    let out = "";
    let done = false;
    const finish = (value: { version: string | null; error: Error | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (out += c));
    child.stderr?.resume();
    const timer = setTimeout(() => {
      try {
        killCliTree(child);
      } catch {
        /* ignore */
      }
      finish({
        version: null,
        error: Object.assign(new Error(`\`${cli}\` did not exit within ${timeoutMs}ms`), { timedOut: true }),
      });
    }, timeoutMs);
    timer.unref?.();
    child.on("error", (error) => finish({ version: null, error }));
    child.on("close", (code) =>
      finish({
        version: code === 0 ? out.trim() || null : null,
        error: code === 0 && out.trim() ? null : Object.assign(new Error(`exit ${code}`), { code }),
      }),
    );
  });
}

export const ZcodeDriver: ProviderDriver<ZcodeConfig> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: PROVIDER_LABEL,
    supportsMultipleInstances: true,
    access: "custom",
    // Mirrors the `capabilities` block in `create` below.
    channelWiring: { agentsMcp: false, computerMcp: false, composioMcp: false, localComputerMcp: false, images: false },
  },
  install: {
    // The `zcode` command ships with the desktop app (its "CLI distribution");
    // there is no official standalone installer one-liner.
    docsUrl: "https://zcode.z.ai/en/docs/install",
  },
  models: ZCODE_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<ZcodeConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const listeners = new Set<RuntimeEventListener>();
    // one active turn per thread
    const active = new Map<string, { stop: () => void; turnId: string }>();

    // CLI resolution: an explicit config.cli wins. The default probes PATH
    // first, then the desktop app's bundled CLI — each candidate must answer
    // `--version` to count. ZCODE_BUNDLED_CLI replaces the candidate list
    // (driver tests point it at the fake CLI).
    const cliOverride = input.environment.ZCODE_BUNDLED_CLI || null;
    let resolvedCli: string | null = config.cli === DEFAULT_CLI ? null : config.cli;
    let resolving: Promise<string> | null = null;
    const resolveCli = (): Promise<string> => {
      if (resolvedCli !== null) return Promise.resolve(resolvedCli);
      resolving ??= (async () => {
        const env = zcodeEnvironment({ ...process.env, ...input.environment });
        const candidates = cliOverride !== null ? [cliOverride] : [DEFAULT_CLI, ...BUNDLED_CLI_CANDIDATES];
        for (const candidate of candidates) {
          const probe = await probeVersion(candidate, env, 5000);
          if (probe.version !== null) {
            resolvedCli = candidate;
            return candidate;
          }
        }
        // Nothing answered: fall back to the default name so the snapshot's
        // failure names `zcode` with the install docs.
        resolvedCli = DEFAULT_CLI;
        return DEFAULT_CLI;
      })();
      return resolving;
    };

    const emit = (event: RuntimeEvent) => {
      for (const l of Array.from(listeners)) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      providerInstanceId: instanceId,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      // Reserve the slot synchronously: the awaits below would otherwise let
      // a second sendTurn on the same thread pass the guard above.
      active.set(threadId, { stop: () => {}, turnId });
      let settled = false;

      const message = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;
      const args = [
        "--prompt", message,
        "--output-format", "stream-json",
        "--no-color",
        // The vendor's headless recipe: unattended runs cannot answer the
        // interactive ask tools, so they are taken away rather than faked.
        "--mode", "yolo",
        "--disallowed-tools", "AskUserQuestion EnterPlanMode ExitPlanMode",
      ];
      if (turn.model) args.push("--model", turn.model);
      const resumeCursor = isJsonString(turn.resumeCursor) && turn.resumeCursor ? turn.resumeCursor : null;
      if (resumeCursor) args.push("--resume", resumeCursor);
      // The CLI resolves its workspace from --cwd, not from the spawn cwd.
      if (turn.cwd) args.push("--cwd", turn.cwd);

      let cli: string;
      let child: ReturnType<typeof spawnCli>;
      try {
        cli = await resolveCli();
        child = spawnCli(cli, args, {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: turn.cwd,
          env: applyLaunchIdentity(zcodeEnvironment({ ...process.env, ...input.environment }), turn.launchIdentity),
        });
      } catch (err) {
        active.delete(threadId);
        throw err;
      }

      let buf = "";
      let assistantText = "";
      let sessionId: string | null = null;
      let sawResult = false;
      // Bounded stderr head + tail: an undrained stderr pipe would block the
      // child on its own write and hang the turn (pi.ts's lesson).
      let stderrHead = "";
      let stderrTail = "";
      let stderrTotal = 0;
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTotal += chunk.length;
        if (stderrHead.length < STDERR_EXCERPT_HEAD) {
          const room = STDERR_EXCERPT_HEAD - stderrHead.length;
          stderrHead += chunk.slice(0, room);
          chunk = chunk.slice(room);
        }
        if (chunk) stderrTail = (stderrTail + chunk).slice(-STDERR_EXCERPT_TAIL);
      });
      const stderrSummary = () =>
        stderrTotal <= stderrHead.length + stderrTail.length
          ? stderrExcerpt(stderrHead + stderrTail)
          : stderrExcerpt(`${stderrHead}\n${stderrTail}`);

      const flushAssistantText = () => {
        const text = assistantText;
        assistantText = "";
        if (!text.trim()) return;
        emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text });
      };

      const settle = (
        ok: boolean,
        stopReason?: string | null,
        usage?: ZcodeStreamUsage,
      ) => {
        if (settled) return;
        settled = true;
        flushAssistantText();
        const input = usage
          ? usage.inputTokens ?? ((usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0))
          : undefined;
        const usageField = buildTurnUsage(usage, input);
        const stop = stopReason ?? (ok ? "end_turn" : "failed");
        emit(
          usageField
            ? { ...base(threadId, turnId), type: "turn.completed", ok, stopReason: stop, usage: usageField }
            : { ...base(threadId, turnId), type: "turn.completed", ok, stopReason: stop },
        );
        try {
          killCliTree(child);
        } catch {
          /* already gone */
        }
        active.delete(threadId);
      };

      const fail = (stopReason: string, message: string) => {
        if (settled) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message: message.slice(0, 2_000) });
        settle(false, stopReason);
      };

      const stop = () => {
        try {
          killCliTree(child);
        } catch {
          /* ignore */
        }
        // A person stopped this turn: interrupted, not a success.
        settle(false, "interrupted");
      };
      active.set(threadId, { stop, turnId });

      const noteSession = (candidate: string | null | undefined) => {
        if (sessionId || !candidate) return;
        sessionId = candidate;
        emit({ ...base(threadId, turnId), type: "session.started", sessionId, model: turn.model ?? null });
      };

      // A CLI that omits call ids still gets a stable fallback id, scoped to
      // a single started/result pair: the entry is consumed by the first
      // completion that claims it, so a repeated same-name tool gets a fresh
      // id instead of conflating two invocations under one row.
      const fallbackToolItemIds = new Map<string, string>();
      const toolItemId = (payload: NonNullable<ZcodeStreamLine["payload"]>, phase: "start" | "finish") => {
        const explicit = payload.toolCallId ?? payload.callId ?? payload.id;
        if (explicit !== undefined && explicit !== null) return String(explicit);
        const toolName = payload.toolName || "tool";
        const existing = fallbackToolItemIds.get(toolName);
        if (existing !== undefined) {
          if (phase === "finish") fallbackToolItemIds.delete(toolName);
          return existing;
        }
        const created = newId();
        fallbackToolItemIds.set(toolName, created);
        return created;
      };

      const onLine = (line: ZcodeStreamLine) => {
        appendNative(threadId, { dir: "in", source: "zcode.stream", msg: line });
        noteSession(line.sessionId);
        switch (line.type) {
          case "model.streaming": {
            const payload = line.payload;
            if (!payload) return;
            if (payload.kind === "text_delta" && payload.delta !== undefined) {
              assistantText += payload.delta;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: payload.delta });
            } else if (payload.kind === "reasoning_delta" && payload.delta !== undefined) {
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta: payload.delta });
            }
            // tool_input_* fragments are preview stream; the tool.updated
            // lifecycle below owns the transcript rows.
            return;
          }
          case "tool.updated": {
            const payload = line.payload;
            if (!payload) return;
            if (payload.kind === "started" || payload.kind === "scheduled") {
              flushAssistantText();
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: toolItemId(payload, "start"),
                title: String(payload.toolName ?? payload.name ?? "tool").slice(0, 80),
                ...toolFields(payload.toolName ?? payload.name, payload.input ?? payload.args ?? payload.arguments),
                ...captureInput(payload.input ?? payload.args ?? payload.arguments),
              });
            } else if (payload.kind === "result" || payload.kind === "error") {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: toolItemId(payload, "finish"),
                ok: payload.kind === "result",
                detail: describeResult(payload.output ?? payload.result ?? payload.error),
                ...captureOutput(payload.output ?? payload.result ?? payload.error),
              });
            }
            return;
          }
          case "turn.failed": {
            const payloadMessage = line.payload?.message;
            const message = payloadMessage && payloadMessage.trim() ? payloadMessage : "zcode turn failed";
            fail("failed", message);
            return;
          }
          case "result": {
            // The terminator: nothing may follow it on the stream.
            sawResult = true;
            const response = line.response;
            if (response && response.trim() && !assistantText.trim()) {
              // No streamed deltas (or they were flushed by tool rows): the
              // final text still lands as one transcript item.
              assistantText = response;
            }
            settle(true, "end_turn", line.usage);
            return;
          }
          default:
            return;
        }
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          try {
            // Boundary stays zod-decoded.  The line schema already treats
            // payload/usage as optional and unknown-typed fields pass through,
            // so a mistyped optional field can no longer swallow the line -
            // including the result terminator - the way a strict whole-line
            // schema did.  Non-JSON lines are still skipped.
            const parsed = ZCODE_STREAM_LINE_SCHEMA.safeParse(JSON.parse(line));
            if (parsed.success) onLine(parsed.data);
          } catch {
            /* skip non-JSON line */
          }
        }
      });
      child.on("error", (err) => {
        // SAFETY: a ChildProcess "error" event delivers the spawn errno exception.
        const spawnFailure = describeSpawnFailure(err as NodeJS.ErrnoException, cli);
        if (settled) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", message: spawnFailure.message, setup: spawnFailure.setup });
        settle(false);
      });
      child.on("close", (code, signal) => {
        // Trailing stdout without a final newline still carries the result
        // line; drain it before judging the turn.
        if (buf.trim()) {
          try {
            const parsed = ZCODE_STREAM_LINE_SCHEMA.safeParse(JSON.parse(buf));
            if (parsed.success) onLine(parsed.data);
          } catch {
            /* skip non-JSON tail */
          }
          buf = "";
        }
        // A close without the result line is a failed turn, never a hang;
        // "close" fires after stderr drained, so the excerpt is whole.
        if (sawResult) {
          settle(true);
          return;
        }
        fail("exit_before_result", `zcode exited ${code ?? signal ?? "unexpectedly"} before its result line${stderrSummary() ? `: ${stderrSummary()}` : ""}`);
      });

      emit({ ...base(threadId, turnId), type: "turn.started" });
      return { turnId };
    };

    // Last good `--version`, so one probe that runs out of time on a busy
    // Mac does not flip a working zcode to "not installed".
    const lastKnownVersion = new LastKnownAnswer<string>();
    const snapshot = async (): Promise<ProviderSnapshot> => {
      const versionOrder = lastKnownVersion.begin();
      const startedAt = Date.now();
      const cli = await resolveCli();
      const probed = await probeVersion(
        cli,
        zcodeEnvironment({ ...process.env, ...input.environment }),
        VERSION_PROBE_TIMEOUT_MS,
      );
      let version = probed.version;
      if (version) {
        lastKnownVersion.record(version, versionOrder);
      } else {
        const elapsed = Date.now() - startedAt;
        logProbeFailure(instanceId, `${cli} --version`, probed.error, elapsed);
        const failure = classifyVersionProbeFailure(probed.error, cli, input.displayName || PROVIDER_LABEL, elapsed, VERSION_PROBE_TIMEOUT_MS);
        const remembered = failure.kind === "transient" ? lastKnownVersion.get() : null;
        if (remembered) {
          version = remembered;
        } else {
          if (failure.kind !== "transient") lastKnownVersion.forget(versionOrder);
          return failure.kind === "transient"
            ? { state: "unavailable", transient: true, reason: failure.reason }
            : { state: "unavailable", reason: failure.reason };
        }
      }
      // ZCode keeps its sign-in in its own data root and has no sign-in
      // subcommand to probe, so read the file its Connect flow writes.
      const authenticated = zcodeAuthenticated({ ...process.env, ...input.environment });
      const available: ProviderSnapshot = { state: "available", version, authenticated };
      // Turns ride the GLM Coding Plan behind the local sign-in, so a
      // reported cost is notional.
      if (authenticated) available.billing = "subscription";
      return available;
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      get models() {
        return ZCODE_MODELS;
      },
      refreshModels: async () => {},
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          // Model is a per-turn --model flag; a resumed session takes the
          // next turn's value, matching the other spawn-per-turn CLIs.
          sessionModelSwitch: "in-session",
          agentsMcp: false,
          computerMcp: false,
          composioMcp: false,
          phoneMcp: false,
          qdrantMcp: false,
          localComputerMcp: false,
          images: false,
          // The headless recipe runs yolo with the ask tools removed: steps
          // stream as tool.updated rows review can watch, but the engine
          // never pauses to ask.
          reviewHook: "after",
          backgroundJobs: "none",
          helpers: "none",
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.stop(),
        // Headless zcode never opens an ask (the interactive tools are
        // disallowed), so there is nobody to take an answer.
        respondToRequest: async () => "unavailable",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { stop } of active.values()) stop();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      dispose: async () => {
        for (const { stop } of active.values()) stop();
        listeners.clear();
      },
    };
  },
};
