// Grok driver — xAI chat-completions API with SSE streaming. Unlike the
// CLI drivers this one is transcript-replay: the server hands it the
// folded thread history each turn (SendTurnInput.transcript) and it emits
// true token-level content.delta events. Also supplies the instance's
// generateText (bot titles, thread names) — upstream's TextGeneration slot.
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
import { appendNative } from "./native.ts";
import { splitChatPrompt } from "./prompt-split.ts";
import { toolFields } from "../tool-fields.ts";

import { runTurnLoop, type TurnLoopDeps, type TurnUsage } from "./chat-completions/loop.ts";
import { toTurnUsage } from "./chat-completions/usage.ts";
import { httpErrorFor } from "./chat-completions/errors.ts";
import { capReplayedTranscript } from "./chat-completions/replay-cap.ts";

const DRIVER_KIND = "grok";
const DEFAULT_URL = "https://api.x.ai/v1";

// This is the xAI API catalog, which is separate from Grok Build's
// subscription CLI catalog in acp/grok.ts. The Build-only fast variant is
// intentionally absent here.
const MODELS = {
  default: "grok-4.7",
  options: [
    { id: "grok-4.7", label: "Grok 4.7" },
    { id: "grok-4.6", label: "Grok 4.6" },
    { id: "grok-4.5", label: "Grok 4.5" },
  ],
};

export interface GrokConfig {
  url: string;
  /** resolved at create-time from instance environment / app config */
  apiKeyEnv: string;
}

function decodeConfig(raw: unknown): GrokConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    url: typeof o.url === "string" ? o.url : DEFAULT_URL,
    apiKeyEnv: typeof o.apiKeyEnv === "string" ? o.apiKeyEnv : "XAI_API_KEY",
  };
}

export const GrokDriver: ProviderDriver<GrokConfig> = {
  driverKind: DRIVER_KIND,
  // "(API)" distinguishes this key-billed driver from grokAgent, the CLI one
  // billed to the user's own XAI_API_KEY — the same shape as openai-compat.
  // Omitting access defaulted to "subscription" and put a BYOK engine above
  // the picker's Custom divider alongside Claude and Codex.
  metadata: { displayName: "Grok (API)", supportsMultipleInstances: true, access: "custom" },
  models: MODELS,
  decodeConfig,
  defaultConfig: () => decodeConfig({}),

  async create(input: DriverCreateInput<GrokConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;
    const apiKey = input.environment[config.apiKeyEnv] ?? process.env[config.apiKeyEnv] ?? "";
    const listeners = new Set<RuntimeEventListener>();
    const active = new Map<string, { abort: AbortController; turnId: string }>();

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

    const complete = async (
      messages: any[],
      model: string,
      opts: { stream: boolean; tools?: any[]; signal?: AbortSignal; onUsage?: (usage: TurnUsage) => void; onDelta?: (d: string, streamKind?: string) => void; onToolCallDelta?: (index: number, id?: string, name?: string, args?: string) => void },
    ): Promise<{ text: string; tool_calls?: any[]; usage: TurnUsage | null }> => {
      const res = await fetch(`${config.url}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, stream: opts.stream, ...(opts.stream ? { stream_options: { include_usage: true } } : {}), ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}) }),
        signal: opts.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(120_000)])
          : AbortSignal.timeout(120_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw httpErrorFor(res.status, body ? body.slice(0, 200) : "");
      }
      if (!opts.stream) {
        const json: any = await res.json();
        return {
          text: json.choices?.[0]?.message?.content ?? "",
          tool_calls: json.choices?.[0]?.message?.tool_calls,
          usage: json.usage
            ? toTurnUsage(json.usage)
            : null,
        };
      }
      let text = "";
      let usage: TurnUsage | null = null;
      let streamToolCalls: any[] = [];
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      const takeSseLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        const deltaObj = chunk.choices?.[0]?.delta;
        const delta = deltaObj?.content;
        const toolCallsDelta = Array.isArray(deltaObj?.tool_calls) ? deltaObj.tool_calls : undefined;
        
        if (delta) {
          text += delta;
          opts.onDelta?.(delta, "assistant_text");
        }
        if (toolCallsDelta) {
          for (const tc of toolCallsDelta) {
            const tcIndex = tc.index ?? 0;
            if (!streamToolCalls[tcIndex]) streamToolCalls[tcIndex] = { id: "", function: { name: "", arguments: "" } };
            // Only the arguments stream in fragments.  A provider that
            // repeats the id and the name on every chunk — several do — used
            // to accumulate `call_acall_acall_a` and `bashbashbash`, so the
            // settled call could never be matched to the step it opened.
            if (tc.id && !streamToolCalls[tcIndex].id) streamToolCalls[tcIndex].id = tc.id;
            if (tc.function?.name && !streamToolCalls[tcIndex].function.name) {
              streamToolCalls[tcIndex].function.name = tc.function.name;
            }
            if (tc.function?.arguments) streamToolCalls[tcIndex].function.arguments += tc.function.arguments;
            opts.onToolCallDelta?.(tcIndex, tc.id, tc.function?.name, tc.function?.arguments);
          }
        }
        if (chunk.usage) {
          usage = toTurnUsage(chunk.usage);
          opts.onUsage?.(usage);
        }
        if (chunk.error) {
          const status = chunk.error.code ?? chunk.error.status;
          if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) {
            throw httpErrorFor(status, "");
          }
          throw new Error("upstream reported a streaming error");
        }
      };
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            buf += decoder.decode();
            if (buf.trim()) takeSseLine(buf.trim());
            break;
          }
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            takeSseLine(line);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      return { text, usage, tool_calls: streamToolCalls.length > 0 ? streamToolCalls : undefined };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const openAiTools = (turn as any).tools ? (turn as any).tools.map((t: any) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
        },
      })) : undefined;
      const { threadId } = turn;
      if (!apiKey) throw new Error(`no xAI key — set ${config.apiKeyEnv} or config.json xai.key`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");
      const turnId = newId();
      const abort = new AbortController();
      // the backoff is scaled down in tests so a fake's transient failures
      // don't stall real seconds
      const retryScale = Number(process.env.FAKE_GROK_RETRY_SCALE ?? "1");
      active.set(threadId, { abort, turnId });

      // Only the stable half of the prompt heads the request; the volatile
      // half rides the newest user message, every request, so the resent
      // prefix stays byte-identical across a memory write (see
      // prompt-split.ts splitChatPrompt).
      const chat = splitChatPrompt(turn);
      const messages: any[] = [
        ...(chat.system ? [{ role: "system", content: chat.system }] : []),
        // Byte-cap and entry-cap the transcript before folding it in so a
        // long thread cannot ship its full history on every round — see
        // chat-completions/replay-cap.ts.
        ...capReplayedTranscript(turn.transcript).flatMap((m: any) => {
          const res = [];
          if (m.role === "assistant") {
            const assistantMsg: any = { role: "assistant", content: m.text || "" };
            if (m.toolCalls && m.toolCalls.length > 0) {
              assistantMsg.tool_calls = m.toolCalls.map((tc: any) => ({
                id: tc.id,
                type: "function",
                function: { name: tc.name, arguments: tc.arguments },
              }));
            }
            res.push(assistantMsg);
          } else {
            if (m.toolResults && m.toolResults.length > 0) {
              for (const tr of m.toolResults) {
                res.push({ role: "tool", tool_call_id: tr.id, content: tr.result });
              }
            } else {
              res.push({ role: "user", content: m.text });
            }
          }
          return res;
        }),
        { role: "user", content: chat.text },
      ];
      appendNative(threadId, { dir: "out", source: "xai.chat.completions", msg: { model: turn.model, messageCount: messages.length } });

      const model = turn.model ?? MODELS.default;
      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model });

      // Tool ids this turn has already opened a step for.  The stream
      // announces a call once and then keeps sending argument fragments for
      // it, and the settled reply repeats every call — without this a single
      // tool would open a dozen rows.
      const started = new Set<string>();

      const runRound: TurnLoopDeps["runRound"] = async (roundMessages, opts) => {
        appendNative(threadId, { dir: "out", source: "xai.chat.completions", msg: { model, messageCount: roundMessages.length, round: opts.round } });
        const { text, usage, tool_calls } = await complete(roundMessages, model, {
          stream: true,
          tools: openAiTools,
          signal: opts.signal,
          onUsage: (u) => opts.onUsage?.(u),
          onDelta: (delta) => {
            opts.onPublished?.();
            emit({ ...base(threadId, turnId), type: "content.delta", streamKind: "assistant_text", delta });
          },
          onToolCallDelta: (_index, id, name) => {
            if (!id || started.has(id)) return;
            started.add(id);
            opts.onPublished?.();
            emit({
              ...base(threadId, turnId),
              type: "item.started",
              itemType: "tool",
              itemId: id,
              title: name || "tool",
              ...toolFields(name, undefined),
            });
          },
        });
        appendNative(threadId, { dir: "in", source: "xai.chat.completions", msg: { textLength: text.length, toolCallsLength: tool_calls?.length ?? 0, usage, round: opts.round } });
        return { text, usage, toolCalls: tool_calls };
      };

      void runTurnLoop({
        base: () => base(threadId, turnId),
        emit,
        runRound,
        messages,
        // Only `timeoutMs` is read from this; the provider payload is built
        // separately above from name/description/parameters.
        tools: turn.tools,
        toolHost: turn.toolHost,
        requestApproval: turn.toolHost?.requestApproval
          ? (ask) => turn.toolHost!.requestApproval!(ask)
          : undefined,
        signal: abort.signal,
        startedToolIds: started,
        onSettled: () => active.delete(threadId),
        now: () => Date.now(),
        retryDelayScale: retryScale,
      });

      return { turnId };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return {
          state: "unavailable",
          reason: `no xAI API key — add {"xai":{"key":"xai-…"}} to ~/.botfleet/config.json or set ${config.apiKeyEnv}`,
        };
      }
      return { state: "available", authenticated: true, version: null };
    };

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName,
      enabled: input.enabled,
      models: MODELS,
      snapshot,
      adapter: {
        provider: DRIVER_KIND,
        capabilities: {
          sessionModelSwitch: "in-session",
          agentsMcp: true,
          toolLoop: true,
          localComputerMcp: true,
          replaysTranscript: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        respondToRequest: async () => "unavailable" as const, // this engine has no asks to answer
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => {
          for (const { abort } of active.values()) abort.abort();
        },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        const { text } = await complete([{ role: "user", content: prompt }], "grok-3-mini", { stream: false });
        return text;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
