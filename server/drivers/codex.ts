// Codex driver — upstream CodexDriver skeleton over agentcal's
// drivers/codex.js runtime: the official `codex` CLI headless over its
// app-server JSON-RPC protocol (newline-delimited JSON on stdio).
// Completion is a real `turn/completed` notification; approval requests
// arrive as in-process server→client JSON-RPC requests and surface as
// canonical request.opened events (answered via respondToRequest — no MCP
// proxy or unix socket needed, unlike claude). Verified against
// codex-cli 0.144.4 by agentcal.
//
// resumeCursor is the codex thread id; a later turn tries thread/resume and
// fails visibly when the native session cannot be restored.
import { homedir } from "node:os";

import { stripWorkspaceCredentialEnv } from "../config.ts";
import { computerProxyEnv } from "../container-computer.ts";
import { hostToolPrefix, turnComputerMounts } from "../computer-grants.ts";
import { describeSpawnFailure, execCli, killCliTree, spawnCli } from "../procs.ts";
import { SPAWNED_PROXIES } from "../proxy-paths.ts";

import type {
  DriverCreateInput,
  ProviderDriver,
  ProviderInstance,
  ProviderSnapshot,
  RuntimeEvent,
  RuntimeEventListener,
  SendTurnInput,
} from "../contracts.ts";
import { newEventId, newId } from "../contracts.ts";
import { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";
import { codexLocalProviderArgs } from "./local-inject.ts";
import { augmentedPath } from "../env-path.ts";
import { toolFields } from "../tool-fields.ts";
import { describeResult } from "../../shared/tool-activity.ts";
import { classifyError, computeBackoff, RETRY_MAX_ATTEMPTS } from "./retry.ts";
import { classifyResumeFailure, mayReplay, recoveryPromptFor } from "../resume-recovery.ts";
import { appendNative } from "./native.ts";

export { decodeCodexSelection, readCodexModelCatalog, STATIC_CODEX_MODELS } from "./codex-catalog.ts";

const DRIVER_KIND = "codex";

class CodexResumeError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The saved Codex session could not be resumed.  Start a fresh task or rewind this conversation to replay its visible history.",
      options,
    );
    this.name = "CodexResumeError";
  }
}

class CodexRpcError extends Error {
  code: unknown;

  constructor(error: { code?: unknown; message?: string }) {
    super(error.message ?? JSON.stringify(error));
    this.code = error.code;
  }
}

function missingNativeCodexThread(error: unknown, cursor: string): boolean {
  // Codex's local thread/resume rejection, verified with an empty native home.
  // A generic 404, auth error, timeout or prose mentioning a missing thread is
  // not evidence that the native history was lost. Unknown versions fail closed.
  return error instanceof CodexRpcError && error.code === -32600 &&
    error.message === `no rollout found for thread id ${cursor}`;
}


export interface CodexConfig {
  cli: string;
  fullAuto: boolean;
}

function decodeConfig(raw: unknown): CodexConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    cli: typeof o.cli === "string" ? o.cli : "codex",
    fullAuto: o.fullAuto === true,
  };
}

const QUESTION_TIMEOUT_NOTE = "No answer was given — use your best judgment.";
const DENY_TIMEOUT_NOTE =
  "BotFleet: nobody answered this permission request in time. Skip this action and finish what you can without it.";

type StdioMcpServer = { command: string; args: string[]; env: Record<string, string> };

function mountMcpServer(
  appServerArgs: string[],
  env: Record<string, string | undefined>,
  name: string,
  server: StdioMcpServer,
): void {
  Object.assign(env, server.env);
  const prefix = `mcp_servers.${name}`;
  appServerArgs.push(
    "-c", `${prefix}.command=${JSON.stringify(server.command)}`,
    "-c", `${prefix}.args=${JSON.stringify(server.args)}`,
    // Values stay in the child environment; argv contains names only so
    // credentials never appear in process listings or diagnostics.
    "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(server.env))}`,
    "-c", `${prefix}.default_tools_approval_mode="auto"`,
  );
}

export const CodexDriver: ProviderDriver<CodexConfig> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Codex", supportsMultipleInstances: true },
  install: {
    command: {
      darwin: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      win32: "npm install -g @openai/codex",
    },
    needsNode: true,
    docsUrl: "https://github.com/openai/codex",
    signInCommand: "codex login",
  },
  models: STATIC_CODEX_MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<CodexConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const childEnv = (): Record<string, string | undefined> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        ...input.environment,
        PATH: augmentedPath(),
        NPM_CONFIG_LOGLEVEL: "error",
      };
      // The CLI owns its own ChatGPT login; a leaked API key silently flips
      // billing to pay-as-you-go (agentcal).
      delete env.OPENAI_API_KEY;
      // The harness process may hold workspace credentials (xai/box/voice
      // keys, env-injected at boot); none of them are this CLI's to see.
      stripWorkspaceCredentialEnv(env);
      return env;
    };
    const catalogEnv = childEnv();
    let models = STATIC_CODEX_MODELS;
    const refreshModels = async () => {
      try {
        const resolved = await readCodexModelCatalog(catalogEnv, fetch, config.cli);
        if (resolved.options.length) models = resolved;
      } catch {
        // Keep the last usable catalog when a local provider is down.
      }
    };
    await refreshModels();
    const listeners = new Set<RuntimeEventListener>();
    interface Turn {
      stop: () => void;
      turnId: string;
      asks: Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>;
    }
    const active = new Map<string, Turn>();
    // codex thread ids this instance started in asking mode.  See the resume
    // decision in `sendTurn`: a sandbox is fixed at thread/start, so a later
    // host-control turn can only reuse a thread it knows was started brokered.
    const brokeredThreads = new Set<string>();

    const emit = (event: RuntimeEvent) => {
      for (const l of [...listeners]) l(event);
    };
    const base = (threadId: string, turnId: string) => ({
      eventId: newEventId(),
      provider: DRIVER_KIND,
      threadId,
      turnId,
      createdAt: new Date().toISOString(),
    });

    const sendTurn = async (turn: SendTurnInput) => {
      // One driver instance serves many threads. Interrupt state belongs to
      // this turn so activity elsewhere cannot cancel or revive its retry.
      let stopRequested = false;
      const { threadId } = turn;
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      // Host control means the user's real desktop — the Local VM and a VPS
      // also arrive as stdio mounts, but they are isolated and carry no
      // scope.  A full-auto instance keeps its yolo switch for everything
      // else, but a turn that can click on this computer runs brokered: the
      // app-server is started on-request inside workspace-write, and every
      // approval reaches the harness, where the bot's Auto policy and the
      // destructive, sensitive and unattended guards decide.  That is what
      // `localComputerMcp: true` promises in server/contracts.ts, and what
      // lets a full-auto bot mount this computer at all.  The ACP core and
      // claude drivers already do exactly this; codex computed
      // `controlsHost` and spent it only on tagging the card's scope.
      //
      // Reached from a room as well as a 1:1 chat since the room lane started
      // resolving computers, so a full-auto Codex bot with This Computer now
      // asks in BOTH lanes.
      const controlsHost = hostToolPrefix(turnComputerMounts(turn.integrations)) !== null;
      const brokered = controlsHost && config.fullAuto;
      const turnFullAuto = config.fullAuto && !brokered;
      // a retry relaunches the whole app-server; the backoff is scaled down in
      // tests so a fake's transient failures don't stall real seconds
      const retryScale = Number(process.env.FAKE_CODEX_RETRY_SCALE ?? "1");
      // A missing native session is established before any prompt is sent.
      // Keep its rebuilt prompt across app-server relaunches: a fresh process
      // has no native history, and recomputing from turn.text loses it.
      let recoveredMissingSession = false;
      let rebuiltFromReplay = false;
      let promptText = turn.system ? `${turn.system}\n\n${turn.text}` : turn.text;

      const launchAttempt = async (attempt: number): Promise<void> => {
        const env = childEnv();
        const appServerArgs = ["app-server", ...codexLocalProviderArgs(env, turn.model)];
        if (turn.integrations?.composio) {
          mountMcpServer(appServerArgs, env, "botfleet_connectors", turn.integrations.composio);
        }
        if (turn.integrations?.agents) {
          mountMcpServer(appServerArgs, env, "agents", turn.integrations.agents);
        }
        // One server per granted computer. This was an if/else if, which
        // handed a bot holding two desktops exactly one of them.
        for (const mount of turnComputerMounts(turn.integrations)) {
          if (mount.box) {
            const proxyEnv = computerProxyEnv(mount.box);
            mountMcpServer(appServerArgs, env, mount.name, {
              command: process.execPath,
              args: [SPAWNED_PROXIES.computer],
              env: {
                ELECTRON_RUN_AS_NODE: "1",
                OGB_BOX_ID: proxyEnv.OGB_BOX_ID ?? "",
                OGB_BOX_TOKEN: proxyEnv.OGB_BOX_TOKEN ?? "",
                // who-is-driving endpoint, so a person taking the wheel in the
                // panel pauses this bot's hands mid-turn
                OMB_CONTROL_URL: proxyEnv.OMB_CONTROL_URL ?? "",
                OMB_CONTROL_TOKEN: proxyEnv.OMB_CONTROL_TOKEN ?? "",
              },
            });
          } else if (mount.stdio) {
            // The host daemon, the isolated Local VM, and a VPS desktop all
            // arrive as a direct Cua Driver stdio MCP server.
            mountMcpServer(appServerArgs, env, mount.name, mount.stdio);
          }
        }
        if (turn.integrations?.phone) {
          const bridge = turn.integrations.phone;
          Object.assign(env, bridge.env);
          const prefix = "mcp_servers.botfleet_phone";
          appServerArgs.push(
            "-c", `${prefix}.command=${JSON.stringify(bridge.command)}`,
            "-c", `${prefix}.args=${JSON.stringify(bridge.args)}`,
            "-c", `${prefix}.env_vars=${JSON.stringify(Object.keys(bridge.env))}`,
            "-c", `${prefix}.default_tools_approval_mode="auto"`,
          );
        }
        if (turn.integrations?.qdrant) {
          mountMcpServer(appServerArgs, env, "qdrant", turn.integrations.qdrant);
        }

        const child = spawnCli(config.cli, appServerArgs, {
          cwd: turn.cwd ?? homedir(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });

      let abandoned = false;
      const state = {
        settled: false,
        lastText: "",
        sawStreamDelta: false,
        // codex reports token usage as a running THREAD total; the harness
        // wants this turn's figure, so the last report is banked on settle
        usage: undefined as { input: number; output: number; cachedInput?: number } | undefined,
      };

      const asks = new Map<string, (behavior: "allow" | "deny" | "answer", message?: string, source?: "user" | "timeout" | "system") => void>();
      let nextId = 1;
      const rpcPending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

      const send = (obj: unknown) => {
        try {
          child.stdin.write(JSON.stringify(obj) + "\n");
        } catch {}
        appendNative(threadId, { dir: "out", source: "codex.app-server", msg: obj });
      };
      const request = (method: string, params: unknown, timeoutMs = 60_000) =>
        new Promise<any>((resolve, reject) => {
          const id = nextId++;
          // a wedged app-server can accept stdin and never reply; without this
          // the handshake await hangs forever and the bot stays busy for good
          const timer = setTimeout(() => {
            if (rpcPending.delete(id)) reject(new Error(`codex ${method} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
          rpcPending.set(id, {
            resolve: (v) => {
              clearTimeout(timer);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timer);
              reject(e);
            },
          });
          send({ jsonrpc: "2.0", id, method, params });
        });

      const stop = () => {
        stopRequested = true;
        killCliTree(child);
      };

      const settle = (ok: boolean, stopReason: string | null) => {
        if (state.settled) return;
        state.settled = true;
        for (const finish of [...asks.values()]) finish("deny", "BotFleet: the turn ended", "system");
        for (const p of rpcPending.values()) p.reject(new Error("turn settled"));
        rpcPending.clear();
        active.delete(threadId);
        emit({ ...base(threadId, turnId), type: "turn.completed", ok, stopReason, cost: null, ...(state.usage ? { usage: state.usage } : {}) });
        stop(); // the app-server never exits on its own
      };

      // server→client approval request → canonical request.opened
      // Host-scope tagging mirrors claude.ts: when this turn mounts the real
      // Mac (not a VM), every card carries approvalScope so the harness's
      // local-computer-block backstop applies to remembered always-allows.
      const handleServerRequest = (msg: any) => {
        const method = msg.method as string;
        const params = msg.params ?? {};
        const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
        const isMcpElicitation =
          method === "mcpServer/elicitation/request" &&
          params?._meta?.codex_approval_kind === "mcp_tool_call";
        const isQuestion = method === "item/tool/requestUserInput";
        const mcpTool = isMcpElicitation
          ? String(params.message ?? "").match(/tool \"([^\"]+)\"/)?.[1]
          : undefined;
        const tool =
          isMcpElicitation
            ? (mcpTool ?? "mcp")
            : method === "item/fileChange/requestApproval" || method === "applyPatchApproval"
            ? "edit"
            : isQuestion
              ? "ask_user"
              : "shell";
        if (turnFullAuto && !isQuestion) {
          return send({
            jsonrpc: "2.0",
            id: msg.id,
            result: isMcpElicitation
              ? { action: "accept", content: {} }
              : { decision: legacy ? "approved" : "accept" },
          });
        }
        const requestId = newId();
        const summary =
          isMcpElicitation && typeof params.message === "string"
            ? params.message
            : typeof params.command === "string"
            ? params.command
            : Array.isArray(params.questions)
              ? params.questions.map((q: any) => q.question ?? q.header).filter(Boolean).join(" · ")
              : typeof params.reason === "string"
                ? params.reason
                : tool;
        const choices = isQuestion
          ? (params.questions?.[0]?.options ?? []).map((o: any) => o.label).slice(0, 5)
          : undefined;
        const finish = (behavior: "allow" | "deny" | "answer", message?: string, source: "user" | "timeout" | "system" = "user") => {
          if (!asks.delete(requestId)) return;
          clearTimeout(timer);
          if (isQuestion) {
            const answers: Record<string, { answers: string[] }> = {};
            for (const q of Array.isArray(params.questions) ? params.questions : []) {
              answers[q.id] = { answers: [message || QUESTION_TIMEOUT_NOTE] };
            }
            send({ jsonrpc: "2.0", id: msg.id, result: { answers } });
          } else {
            send({
              jsonrpc: "2.0",
              id: msg.id,
              result: isMcpElicitation
                ? behavior === "allow"
                  ? { action: "accept", content: {} }
                  : { action: "decline" }
                : { decision: behavior === "allow" ? (legacy ? "approved" : "accept") : legacy ? "denied" : "decline" },
            });
          }
          emit({ ...base(threadId, turnId), type: "request.resolved", requestId, behavior, source });
        };
        const timer = setTimeout(
          () => (isQuestion ? finish("answer", QUESTION_TIMEOUT_NOTE, "timeout") : finish("deny", DENY_TIMEOUT_NOTE, "timeout")),
          15 * 60_000,
        );
        timer.unref?.();
        asks.set(requestId, finish);
        emit({
          ...base(threadId, turnId),
          type: "request.opened",
          requestId,
          requestType: isQuestion ? "question" : "permission",
          tool,
          summary,
          choices,
          approvalScope: controlsHost ? "local-computer" : undefined,
        });
      };

      const handleNotification = (msg: any) => {
        const p = msg.params ?? {};
        switch (msg.method) {
          // token-level chat text; the item/completed frame follows with the
          // whole message, so its delta is only a fallback when none streamed
          case "item/agentMessage/delta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) {
              state.sawStreamDelta = true;
              emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
            }
            break;
          }
          case "item/reasoning/textDelta":
          case "item/reasoning/summaryTextDelta": {
            const delta = typeof p.delta === "string" ? p.delta : "";
            if (delta) emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "reasoning_text", delta });
            break;
          }
          case "item/started": {
            const item = p.item ?? {};
            const title =
              item.type === "commandExecution"
                ? String(item.command ?? "shell")
                : item.type === "fileChange"
                  ? "edit"
                  : item.type === "mcpToolCall"
                    ? (item.tool ?? item.name ?? "mcp")
                    : item.type === "webSearch"
                      ? "web_search"
                      : null;
            if (title) {
              // the app-server names the file it changed and the query it
              // searched; a row that says only "edit" makes the reader open
              // the diff to learn which file
              emit({
                ...base(threadId, turnId),
                type: "item.started",
                itemType: "tool",
                itemId: item.id,
                title,
                ...toolFields(title, item, { cwd: turn.cwd }),
              });
            }
            break;
          }
          case "item/completed": {
            const item = p.item ?? {};
            if (item.type === "agentMessage") {
              if (item.text?.trim()) {
                state.lastText = item.text;
                if (!state.sawStreamDelta) {
                  emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta: item.text });
                }
                state.sawStreamDelta = false;
                emit({ ...base(threadId, turnId), type: "item.completed", itemType: "assistant_text", text: item.text });
              }
            } else if (["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(item.type)) {
              emit({
                ...base(threadId, turnId),
                type: "item.completed",
                itemType: "tool",
                itemId: item.id,
                ok: item.status !== "failed" && item.status !== "declined",
                detail: describeResult(item.aggregatedOutput ?? item.output ?? item.result ?? item.error),
              });
            } else if (item.type === "reasoning") {
              emit({ ...base(threadId, turnId), type: "item.updated", itemType: "reasoning", tokens: null });
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            // `last` is the most recent turn when the server sends it;
            // `total` is the thread so far — a fresh app-server per turn
            // makes that this turn's figure too
            const turnUsage = p.tokenUsage?.last ?? p.tokenUsage?.total;
            // codex's inputTokens already includes cachedInputTokens; the
            // cached share is carried alongside so the UI can say how much
            // of a turn was context re-read rather than new text
            if (turnUsage) {
              state.usage = {
                input: turnUsage.inputTokens ?? 0,
                output: turnUsage.outputTokens ?? 0,
                ...(typeof turnUsage.cachedInputTokens === "number"
                  ? { cachedInput: turnUsage.cachedInputTokens }
                  : {}),
              };
            }
            const t = p.tokenUsage?.total;
            if (t) {
              emit({
                ...base(threadId, turnId),
                type: "thread.token-usage.updated",
                input: t.inputTokens ?? 0,
                output: t.outputTokens ?? 0,
                ...(typeof t.cachedInputTokens === "number"
                  ? { cachedInput: t.cachedInputTokens }
                  : {}),
              });
            }
            break;
          }
          case "turn/completed": {
            const t = p.turn ?? {};
            settle(t.status === "completed", t.status === "completed" ? null : (t.error?.message ?? t.status ?? "failed"));
            break;
          }
          case "error":
            // shape drift: 0.144 sends {message}, 0.139 nests it under
            // {error:{message}} — surface either (agentcal armor)
            {
              const message = p.message ?? p.error?.message;
              if (message) emit({ ...base(threadId, turnId), type: "runtime.error", message: String(message).slice(0, 400) });
            }
            break;
        }
      };

      let buf = "";
      // decode as UTF-8 across chunk boundaries — a raw `buf += chunk` splits
      // multibyte characters that straddle two reads and corrupts the text
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let msg: any;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          appendNative(threadId, { dir: "in", source: "codex.app-server", msg });
          if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
            const pend = rpcPending.get(msg.id);
            if (pend) {
              rpcPending.delete(msg.id);
              msg.error ? pend.reject(new CodexRpcError(msg.error)) : pend.resolve(msg.result);
            }
          } else if (msg.id !== undefined && msg.method) {
            handleServerRequest(msg);
          } else if (msg.method) {
            handleNotification(msg);
          }
        }
      });

      let stderr = "";
      child.stderr.on("data", (c) => {
        stderr += c;
        if (stderr.length > 8192) stderr = stderr.slice(-8192);
      });
      child.on("error", (e) => {
        if (abandoned) return;
        emit({ ...base(threadId, turnId), type: "runtime.error", ...describeSpawnFailure(e, config.cli) });
        settle(false, "spawn_error");
      });
      child.on("close", (code) => {
        if (abandoned) return;
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message: `codex exited ${code} before turn/completed${stderr ? `: ${stderr.trim().slice(-300)}` : ""}`,
          });
          settle(false, "exit_before_result");
        }
      });

      active.set(threadId, { stop, turnId, asks });
      // Relaunching the app-server is still the same logical turn. Keep the
      // active process current on every attempt, but announce the turn once.
      if (attempt === 0) emit({ ...base(threadId, turnId), type: "turn.started" });

      let promptSubmitted = false;
      let promptAccepted = false;
      // handshake + kickoff; a transient failure (5xx/overloaded/reset) gets
      // one relaunch of the whole app-server after backoff — but only when
      // nothing streamed yet, and never for auth/shape errors or interrupts
      try {
        await request("initialize", { clientInfo: { name: "botfleet", version: "2" } });
        send({ jsonrpc: "2.0", method: "initialized", params: {} });
        const resumeCursor = typeof turn.resumeCursor === "string" ? turn.resumeCursor : null;
        // `thread/resume` keeps the sandbox and approval policy the thread was
        // STARTED with, so resuming a thread that was started full-auto would
        // quietly hand this host-control turn danger-full-access and
        // approvalPolicy "never" — no cards at all, the exact hole the
        // brokered path closes.  A brokered turn therefore resumes only a
        // thread this instance is known to have started brokered, and
        // otherwise starts a fresh one.  The cost is one lost codex-side
        // continuation per instance restart, for full-auto bots that also
        // hold this computer; the alternative is an unbrokered host turn.
        const cursor = brokered && !(resumeCursor && brokeredThreads.has(resumeCursor)) ? null : resumeCursor;
        let codexThreadId: string | null = null;
        let startedModel: string | null = null;
        if (cursor && !recoveredMissingSession) {
          try {
            const resumed = await request("thread/resume", { threadId: cursor });
            codexThreadId = resumed?.thread?.id ?? cursor;
          } catch (error) {
            const failure = classifyResumeFailure({
              attempted: true,
              rejected: error instanceof CodexRpcError,
              promptSubmitted,
              producedOutput: state.sawStreamDelta,
            });
            // Protocol-state gate (mayReplay) — never an error-text regex — decides
            // whether this turn may be sent again on a fresh native thread.
            if (
              recoveredMissingSession ||
              stopRequested ||
              state.settled ||
              !turn.recoveryText?.trim() ||
              !missingNativeCodexThread(error, cursor) ||
              !mayReplay(failure)
            ) {
              throw new CodexResumeError({ cause: error });
            }
            recoveredMissingSession = true;
            const rebuild = recoveryPromptFor({
              recoveryText: turn.recoveryText,
              currentText: turn.text,
              failure,
            });
            rebuiltFromReplay = rebuild.replayed;
            promptText = turn.system ? `${turn.system}\n\n${rebuild.text}` : rebuild.text;
          }
        }
        if (!codexThreadId) {
          const selection = decodeCodexSelection(turn.model);
          const started = await request("thread/start", {
            cwd: turn.cwd ?? homedir(),
            model: selection.model,
            ...(selection.modelProvider ? { modelProvider: selection.modelProvider } : {}),
            sandbox: turnFullAuto ? "danger-full-access" : "workspace-write",
            approvalPolicy: turnFullAuto ? "never" : "on-request",
            ephemeral: false,
          });
          codexThreadId = started?.thread?.id ?? null;
          startedModel = started?.model ?? null;
          // Remember which threads are safe for a later brokered turn to
          // resume.  Only a brokered start is recorded, so an unknown cursor
          // (a restart, or a thread started before this fix) is treated as
          // full-auto and replaced rather than trusted.
          if (brokered && codexThreadId) brokeredThreads.add(codexThreadId);
        }
        emit({
          ...base(threadId, turnId),
          type: "session.started",
          sessionId: codexThreadId,
          model: startedModel ?? turn.model ?? null,
          ...(rebuiltFromReplay ? { rebuilt: true } : {}),
        });
        promptSubmitted = true;
        await request("turn/start", {
          threadId: codexThreadId,
          input: [{ type: "text", text: promptText }],
          // Spread, not `effort: turn.effort ?? null`. Probed against
          // codex-cli 0.146.0: null is indistinguishable from an absent key
          // — both leave the thread's current effort alone, emitting no
          // thread/settings/updated, and thread/resume reads the old value
          // back. The app-server offers no way to clear a level either:
          // "" is rejected outright and thread/start takes no effort at
          // all. So a thread keeps the last level it was sent until it is
          // sent another, and choosing Default lands on the bot's next new
          // thread rather than the current one.
          ...(turn.effort ? { effort: turn.effort } : {}),
        });
        promptAccepted = true;
      } catch (e) {
        const resumeFailure = e instanceof CodexResumeError;
        const failure = resumeFailure && e.cause !== undefined
          ? e.cause instanceof Error
            ? e.cause
            : { text: String(e.cause) }
          : e instanceof Error
            ? e
            : { text: String(e) };
        const failureMessage = failure instanceof Error
          ? failure.message
          : "text" in failure
            ? failure.text
            : String(failure);
        const message = resumeFailure && failureMessage !== e.message
          ? `${e.message}  ${failureMessage}`
          : failureMessage;
        const needsAuth = /(?:\b401\b|unauthorized|missing bearer|authentication required)/i.test(failureMessage);
        const verdict = classifyError(failure);
        // A rejected RPC proves turn/start did not accept the prompt. A
        // timeout, connection loss or error after acceptance cannot prove
        // that; never replay a possibly acted-on turn in those cases.
        const safeToRelaunch = !promptAccepted && (!promptSubmitted || e instanceof CodexRpcError);
        if (!state.settled && !needsAuth && verdict.transient && safeToRelaunch && attempt < RETRY_MAX_ATTEMPTS - 1 && state.sawStreamDelta === false) {
          const delayMs = computeBackoff(attempt);
          attempt++;
          emit({
            ...base(threadId, turnId),
            type: "turn.retrying",
            attempt,
            delayMs,
            reason: verdict.reason,
          });
          // This app-server never exits by itself. Retire the failed attempt
          // and silence its late handlers before the replacement launches.
          abandoned = true;
          killCliTree(child);
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(1, Math.round(delayMs * retryScale)));
            timer.unref?.();
          });
          if (!stopRequested) {
            void launchAttempt(attempt).catch(() => {});
          } else {
            settle(false, "interrupted");
          }
          return;
        }
        if (!state.settled) {
          emit({
            ...base(threadId, turnId),
            type: "runtime.error",
            message,
            ...(needsAuth ? { setup: true } : {}),
          });
          settle(false, needsAuth ? "auth_required" : resumeFailure ? "resume_failed" : "rpc_error");
        }
      }
    };

    void launchAttempt(0).catch(() => {});
    return { turnId };
  };

  const snapshot = async (): Promise<ProviderSnapshot> => {
    const env = childEnv();
    const version = await new Promise<string | null>((resolve) => {
      execCli(config.cli, ["--version"], { timeout: 8000, env }, (err, stdout) =>
        resolve(err ? null : stdout.trim()),
      );
    });
    if (!version) return { state: "unavailable", reason: `\`${config.cli}\` CLI not found` };
    const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
    if (match && (parseInt(match[1]) === 0 && parseInt(match[2]) < 151)) {
      return { state: "unavailable", reason: `Codex CLI is out of date (needs 0.151.0+). Run \`npm install -g @openai/codex\`` };
    }
    const authenticated = await new Promise<boolean>((resolve) => {
      execCli(config.cli, ["login", "status"], { timeout: 8000, env }, (err, stdout, stderr) =>
        resolve(!err && /^logged in\b/im.test(`${stdout}\n${stderr ?? ""}`)),
      );
    });
    // childEnv drops OPENAI_API_KEY on purpose — turns run on the ChatGPT login
    return { state: "available", version, authenticated, billing: "subscription" };
  };

  return {
    instanceId,
    driverKind: DRIVER_KIND,
    displayName: input.displayName,
    enabled: input.enabled,
    get models() {
      return models;
    },
    refreshModels,
    snapshot,
    adapter: {
      provider: DRIVER_KIND,
      capabilities: {
        sessionModelSwitch: "unsupported",
        computerMcp: true,
        localComputerMcp: true,
        composioMcp: true,
        agentsMcp: true,
        phoneMcp: true,
        qdrantMcp: true,
        images: true,
        effortLevels: ["low", "medium", "high", "xhigh", "max"],
      },
      sendTurn,
      interruptTurn: async (threadId) => active.get(threadId)?.stop(),
      respondToRequest: async (threadId, requestId, decision) => {
        const turn = active.get(threadId);
        const finish = turn?.asks.get(requestId);
        if (!finish) return "unavailable"; // settled, timed out, or turn gone
        finish(decision.behavior, decision.message, "user");
        return decision.behavior === "allow" ? "allowed-once" : decision.behavior === "answer" ? "answered" : "rejected";
      },
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
