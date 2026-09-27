// MiniMax driver — OpenAI-compatible chat/completions API with SSE streaming.
// Reads an API key from an instance, the environment, or the official
// mmx-cli config at ~/.mmx/config.json.
//
// API: https://api.minimax.io/v1/chat/completions
// Models: https://platform.minimax.io/docs/guides/models-intro

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

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
import { newEventId, newId } from "../contracts.ts";
import { appendNative } from "./native.ts";
import { splitChatPrompt } from "./prompt-split.ts";
import { toolFields } from "../tool-fields.ts";
import { classifyHttpError, httpErrorFor, type HttpErrorClassification } from "./chat-completions/errors.ts";
import { runTurnLoop, DEFAULT_TURN_LOOP_BUDGET, type ChatMessage, type TurnLoopDeps, type TurnUsage } from "./chat-completions/loop.ts";
import { costUsd, type ChatCompletionsPriceTable } from "./chat-completions/pricing.ts";
import { capReplayedTranscript } from "./chat-completions/replay-cap.ts";
import { genAiProvider, withChatSpan } from "../sentry-ai.ts";

const DRIVER_KIND = "minimax";
const API_KEY_ENV = "MINIMAX_API_KEY";
/** The one instance id the default fleet reserves for this driver, and so the
 * only one the workspace-wide key sources may reach.  Mirrors
 * `injectedEnvironment()`'s gate in server/config.ts. */
const RESERVED_INSTANCE_ID = "minimax";
const DEFAULT_URL = "https://api.minimax.io/v1";
const CN_URL = "https://api.minimaxi.com/v1";
// The GET /models probe backing both `snapshot()` and `refreshModels()` is
// cached for this long so a picker refresh (or the registry's periodic
// describe()) does not hammer the API — and shares ONE fetch between the
// two, per PR 10's "off the same fetch".
const SNAPSHOT_CACHE_MS = 60_000;
const SNAPSHOT_PROBE_TIMEOUT_MS = 8_000;
// A stall guard independent of the per-request ceiling `complete()` reads
// off `opts.signal`.  Unattended turns run at the full 900s wall-clock
// budget (see `sendTurn`'s `runTurnLoop` call below) so a slow-but-working
// stream has room to finish, but a CONNECTION that stops producing bytes
// entirely must not get to hold the bot busy for the full 900s before
// anything notices — that is exactly the failure board row bf77b434 (a
// MiniMax round stalling right after a tool call) tracks.  Measured
// against `reader.read()` resolving with a real chunk, not against parsed
// content: MiniMax can send frames this driver's `takeSseLine` does not
// turn into a delta (an empty `choices` array, an unparsed keep-alive),
// and "is the socket still moving" is the question, not "did the model
// say something new."  90–120s was the reviewed range on PR 625's
// follow-up; 120s errs toward not cutting off a merely-slow-but-live
// reasoning burst.
const STREAM_IDLE_TIMEOUT_MS = 120_000;

// Plain MiniMax-M2.7 dropped: it billed the same $0.30/$1.20 per million as
// M3's own <=512K tier for a fifth of the context, so M3 strictly dominated
// it.  M2.7-highspeed stays — it is MiniMax's own faster-inference tier
// (see UTILITY_MODEL below) priced at $0.60/$2.40, genuinely different from
// M3's rate at any input size highspeed's own 204,800 context can hold.
const MODELS: ModelCatalog = {
  default: "MiniMax-M3",
  options: [
    { id: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000 },
    { id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 Highspeed", contextWindow: 204_800 },
  ],
};

/** Published MiniMax API rates, USD per million tokens, STANDARD service
 *  tier — this driver never sends `service_tier: "priority"`.  Source:
 *  https://platform.minimax.io/docs/guides/pricing-paygo, verified
 *  Tue, Sep 8, 2026.  MiniMax-M3's listed rates already reflect MiniMax's
 *  own "Permanent 50% off" discount, and M3 is the one model here with a
 *  published >512K-input-token tier at double the base rate — the tier
 *  list below is checked against each ROUND's own prompt size, which is
 *  how MiniMax itself bills a single request.
 *
 *  Must stay in lockstep with MINIMAX_PRICE_PER_MILLION in
 *  src/lib/minimax-prices.ts: the Vite client cannot import this file (it
 *  reads local files with node:fs), so that is a separately maintained
 *  display copy of the same numbers — the same relationship
 *  src/lib/deepseek-prices.ts has with its own driver.  A price CHANGE
 *  upstream is a data change nothing here can detect on its own; the
 *  coverage test in minimax-prices.test.ts only forces a decision when a
 *  MODEL is ADDED to the catalog with no row.  Treat a quarterly re-check
 *  against the pricing page above as the maintenance cost of having a
 *  cost column at all. */
export const MINIMAX_PRICE_PER_MILLION: ChatCompletionsPriceTable = {
  "MiniMax-M3": [
    { maxInputTokens: 512_000, input: 0.3, output: 1.2, cachedInput: 0.06 },
    { input: 0.6, output: 2.4, cachedInput: 0.12 },
  ],
  // Retired from MODELS.options above (dominated by M3), but priced still —
  // a bot whose saved selection or a typed custom slug still names this id
  // keeps real cost tracking instead of silently going unpriced.
  "MiniMax-M2.7": [{ input: 0.3, output: 1.2, cachedInput: 0.06 }],
  "MiniMax-M2.7-highspeed": [{ input: 0.6, output: 2.4, cachedInput: 0.06 }],
};

/** MiniMax's own API hosts — global and China — which are the only
 *  endpoints MINIMAX_PRICE_PER_MILLION describes.
 *
 *  `config.url` and MINIMAX_BASE_URL are supported overrides: an instance
 *  can be pointed at a gateway, a reseller, a proxy, or a self-hosted
 *  deployment.  None of those necessarily bills at MiniMax's published
 *  pay-as-you-go tariff — a reseller marks it up, an internal gateway may
 *  not charge per token at all — and a `cost` on turn.completed is stored
 *  and reported downstream as REAL spend.  So an endpoint this table does
 *  not describe gets no price table at all, which the loop turns into a
 *  null cost: an honest blank rather than a confident wrong number, the
 *  same reasoning that makes an unpriced MODEL null instead of 0.
 *
 *  Matched on host, not the whole URL: normalizedApiUrl has already forced
 *  the path to /v1 and stripped trailing slashes, and a differently-cased
 *  host is the same endpoint.  Anything unparseable is not MiniMax. */
const PRICED_API_HOSTS = new Set([new URL(DEFAULT_URL).host, new URL(CN_URL).host]);

export function isPricedMinimaxEndpoint(apiUrl: string): boolean {
  try {
    return PRICED_API_HOSTS.has(new URL(apiUrl).host.toLowerCase());
  } catch {
    return false;
  }
}

/** Titles and summaries (generateText) are a short, latency-sensitive round
 *  that never needs the flagship's 1M-token context — the highspeed variant
 *  is MiniMax's own faster-inference tier for exactly this shape of call.
 *  Fixed independent of `models.default`, which local mmx-cli config can
 *  repoint at any catalog model. */
const UTILITY_MODEL = "MiniMax-M2.7-highspeed";

/** MiniMax nests a cached-read count under `prompt_tokens_details`
 *  (verified against MiniMax's own example response, Sep 8, 2026):
 *  `{ prompt_tokens, completion_tokens, prompt_tokens_details:
 *  { cached_tokens } }`.  `cached_tokens` is a SUBSET of `prompt_tokens`,
 *  never additional to it. */
function toTurnUsage(raw: any): TurnUsage {
  const usage: TurnUsage = { input: raw?.prompt_tokens ?? 0, output: raw?.completion_tokens ?? 0 };
  const cached = raw?.prompt_tokens_details?.cached_tokens;
  if (Number.isFinite(cached)) usage.cachedInput = cached;
  return usage;
}

/** Thrown by `readChunkOrStall` when the SSE reader goes `STREAM_IDLE_TIMEOUT_MS`
 *  with no chunk.  The message deliberately contains "timed out" — that is
 *  the phrase `classifyError` (server/drivers/retry.ts) matches onto the
 *  `timeout` transient reason, so a stall before anything published rides
 *  the SAME up-to-three-attempt retry policy a slow-to-connect socket
 *  already gets, and a stall AFTER a delta published never retries because
 *  `published` is already true by then (loop.ts's retry guard) — replaying
 *  it would show the person text they already read twice. */
class StreamStallError extends Error {
  constructor(idleMs: number) {
    super(`MiniMax stream timed out: no data received for ${Math.round(idleMs / 1000)}s`);
    this.name = "StreamStallError";
  }
}

/** Races one `reader.read()` against an idle timer, so a connection that
 *  stops producing bytes fails in `idleMs`, not in whatever's left of the
 *  round's full request ceiling.  Every read that resolves — `done`
 *  included, the stream closing IS activity — gets a fresh window on the
 *  NEXT call; only true silence trips it.  The timer is `unref`'d so a
 *  turn nobody is waiting on cannot hold the process open, matching
 *  `unrefTimer` in chat-completions/loop.ts (not imported — that file's
 *  helper is module-private and this is a two-line duplicate, not a
 *  dependency worth adding). */
async function readChunkOrStall(reader: ReadableStreamDefaultReader<Uint8Array>, idleMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stall = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StreamStallError(idleMs)), idleMs);
    // Node's timer carries `unref`; the DOM's does not, and this file is
    // typed against both — declared type, not a cast, so nothing here
    // asserts past what `timer` actually is.
    const handle: { unref?: () => void } = timer;
    handle.unref?.();
  });
  try {
    return await Promise.race([reader.read(), stall]);
  } finally {
    clearTimeout(timer);
  }
}

/** Where `MinimaxConfig.url` came from.  "default" is the ONLY value that
 * means nothing chose a host: `url` is filled in unconditionally, so the
 * string alone cannot tell "not configured" apart from "configured as the
 * global host" — they are byte-identical, and guessing from that is what
 * silently re-pointed an endpoint the operator had typed. */
export type MinimaxUrlSource = "instance" | "workspace" | "environment" | "default";

export interface MinimaxConfig {
  url: string;
  urlSource: MinimaxUrlSource;
}

interface LocalMiniMaxConfig {
  apiKey: string;
  url: string;
  defaultModel: string;
}

const localConfigSchema = z.object({
  api_key: z.string().optional(),
  region: z.enum(["global", "cn"]).optional(),
  base_url: z.string().optional(),
  default_text_model: z.string().optional(),
});

const driverConfigSchema = z.object({
  url: z.string().optional(),
  // instanceConfigs() (server/config.ts) stamps this on exactly the entries
  // it resolved a url onto from the workspace setting, so the driver can tell
  // a workspace-wide endpoint apart from one this instance carries WITHOUT
  // comparing the two values.
  urlSource: z.string().optional(),
});

/** server/config.ts's `WORKSPACE_URL_SOURCE`: the marker instanceConfigs()
 * writes and stripInjectedDefaults() removes again before anything persists.
 * Reproduced as a literal rather than imported because server/config.ts is
 * the layer above this one and must not become a dependency of it. */
const WORKSPACE_URL_SOURCE = "workspace";

function normalizedApiUrl(value: string): string {
  const root = value.trim().replace(/\/+$/, "");
  return root.endsWith("/v1") ? root : `${root}/v1`;
}

// Resolution order: instance env → process env → official mmx-cli config.
// Empty higher-priority values are skipped instead of masking a real key.
// One shared resolver so no future lane (snapshot probe, a shared
// chat-completions base, …) can drift on which key is the MiniMax key.
//
// The last two are WORKSPACE-WIDE and reserved-instance only, for exactly the
// reason openai-compat.ts gates its own process.env lookup on
// `instanceId !== "openaiCompat"`: process.env is process-wide, not
// per-instance, and ~/.mmx/config.json is one file for the whole machine. A
// second MiniMax connection points at whatever endpoint the operator typed in
// — the China host, a gateway, a reseller — so letting it fall through to
// either would send the workspace's real MiniMax key to that endpoint as a
// Bearer token. A non-reserved instance gets a key only from its own isolated
// instance environment, which injectedEnvironment() fills from that
// instance's own `config.key` (and nothing else, by the same gate).
export function resolveMinimaxCredentials(
  environment: Record<string, string>,
  local: Pick<LocalMiniMaxConfig, "apiKey">,
  instanceId: string,
): string {
  const own = environment[API_KEY_ENV]?.trim();
  if (own) return own;
  if (instanceId !== RESERVED_INSTANCE_ID) return "";
  return process.env[API_KEY_ENV]?.trim() || local.apiKey;
}

export function loadLocalMiniMaxConfig(home = homedir()): LocalMiniMaxConfig {
  try {
    const raw = localConfigSchema.parse(JSON.parse(readFileSync(join(home, ".mmx", "config.json"), "utf8")));
    const region = raw.region === "cn" ? "cn" : "global";
    const configuredUrl = raw.base_url?.trim()
      ? raw.base_url
      : region === "cn" ? CN_URL : DEFAULT_URL;
    return {
      apiKey: raw.api_key?.trim() ?? "",
      url: normalizedApiUrl(configuredUrl),
      defaultModel: raw.default_text_model?.trim() ?? "",
    };
  } catch {
    return { apiKey: "", url: DEFAULT_URL, defaultModel: "" };
  }
}

// ProviderDriver supplies untrusted config as unknown; the schema below is
// the I/O boundary that converts it to the driver's concrete contract.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export function decodeMinimaxConfig(raw: unknown): MinimaxConfig {
  const parsed = driverConfigSchema.safeParse(raw ?? {});
  const config = parsed.success ? parsed.data : {};
  const ownUrl = config.url?.trim();
  const envUrl = process.env.MINIMAX_BASE_URL?.trim();
  // Provenance, decided here once, where all three inputs are still
  // distinguishable.  Downstream only ever sees the resolved string, and a
  // resolved string that happens to equal DEFAULT_URL is ambiguous forever
  // after.
  const urlSource: MinimaxUrlSource = ownUrl
    ? (config.urlSource === WORKSPACE_URL_SOURCE ? "workspace" : "instance")
    : envUrl
      ? "environment"
      : "default";
  return {
    url: normalizedApiUrl(ownUrl || envUrl || DEFAULT_URL),
    urlSource,
  };
}

export const MinimaxDriver: ProviderDriver<MinimaxConfig> = {
  driverKind: DRIVER_KIND,
  // This driver spawns no CLI — the only thing it ever reads from mmx is
  // ~/.mmx/config.json (loadLocalMiniMaxConfig above), and only as one of
  // three key sources. "MiniMax CLI" told users to install and debug a
  // binary that has no bearing on whether a turn works.
  metadata: { displayName: "MiniMax", supportsMultipleInstances: true },
  models: MODELS,
  install: {
    docsUrl: "https://platform.minimax.io/docs/token-plan/minimax-cli",
    // What this driver actually needs is a key, not a CLI install: set
    // MINIMAX_API_KEY, or point it at ~/.mmx/config.json (written by
    // `mmx auth login`, for anyone who already has that CLI for other
    // reasons). Neither requires Node or npm on this machine.
    apiKeyOnly: true,
    signInCommand: `Set ${API_KEY_ENV} to a MiniMax API key, or run \`mmx auth login --api-key YOUR_MINIMAX_API_KEY\` to write one to ~/.mmx/config.json`,
    command: {
      darwin: `Get a MiniMax API key at https://platform.minimax.io and set ${API_KEY_ENV} (or run \`mmx auth login\` if you already use the mmx CLI — this driver just reads the config file it writes)`,
      linux: `Get a MiniMax API key at https://platform.minimax.io and set ${API_KEY_ENV} (or run \`mmx auth login\` if you already use the mmx CLI — this driver just reads the config file it writes)`,
      win32: `Get a MiniMax API key at https://platform.minimax.io and set ${API_KEY_ENV} (or run \`mmx auth login\` if you already use the mmx CLI — this driver just reads the config file it writes)`,
    },
  },
  decodeConfig: decodeMinimaxConfig,
  defaultConfig: () => decodeMinimaxConfig({}),

  async create(input: DriverCreateInput<MinimaxConfig>): Promise<ProviderInstance> {
    const { instanceId, config } = input;

    const local = loadLocalMiniMaxConfig();
    const apiKey = resolveMinimaxCredentials(input.environment, local, instanceId);
    // ~/.mmx/config.json is ONE file for the whole machine, so its endpoint is
    // a workspace-wide default and reaches only the reserved instance — the
    // same gate resolveMinimaxCredentials applies to the key it sits beside.
    // Without it, a connection whose operator typed exactly the default URL
    // was silently redirected to whatever region or custom base_url that file
    // names, and its own key was sent there.
    //
    // It is a DEFAULT, so it yields to any host that was actually chosen, and
    // that question is answered by PROVENANCE, never by comparing the url to
    // DEFAULT_URL: an operator who pins this connection to the global host in
    // Settings types the very string the unset state resolves to, and a value
    // comparison silently re-pointed them at whatever region that file names.
    const isReservedInstance = instanceId === RESERVED_INSTANCE_ID;
    const apiUrl = isReservedInstance && config.urlSource === "default" ? local.url : config.url;
    // What the operator can actually DO about a missing or refused key here.
    // The workspace remedies — MINIMAX_API_KEY, `mmx auth login` — reach only
    // the reserved instance, so telling a connection the operator added to
    // try either one sends them somewhere that cannot help.
    //
    // Settings → API Keys cannot help either: that panel renders one row per
    // WORKSPACE engine id ("minimax", "openaiCompat"), and by the very gate
    // above, the key in that row can never reach an added connection.  There
    // is no per-instance key field anywhere in the app today, so the only
    // control that changes an added connection's key is deleting and re-adding
    // it in Settings → Engines.  Naming a remedy that does not exist is worse
    // than naming none.
    const keylessRemedy = isReservedInstance
      ? `set ${API_KEY_ENV} or run mmx auth login --api-key …`
      : "delete and re-add this connection in Settings \u2192 Engines with a key";
    const rejectedRemedy = isReservedInstance
      ? `run mmx auth login --api-key … or update ${API_KEY_ENV}`
      : "delete and re-add this connection in Settings \u2192 Engines with a working key";
    // Resolved once, from the endpoint this instance actually calls, so a
    // gateway or proxy never gets MiniMax's own tariff reported as its
    // authoritative spend.
    const pricesApply = isPricedMinimaxEndpoint(apiUrl);
    // The live catalog `refreshModels` replaces from GET /models.  MODELS —
    // the hand-maintained static table — stays the fallback for as long as
    // that fetch has never succeeded, so a new model still needs no code
    // change once the endpoint lists it.
    let models = local.defaultModel && MODELS.options.some((model) => model.id === local.defaultModel)
      ? { ...MODELS, default: local.defaultModel }
      : MODELS;

    const listeners = new Set<RuntimeEventListener>();
    // Held for the WHOLE turn — every round and every tool call — and dropped
    // only by the loop's finally.  That is what makes Stop work between
    // rounds and mid-tool, where it used to be a silent no-op.
    const active = new Map<string, { abort: AbortController; turnId: string; startedAt: number }>();

    const emit = (event: RuntimeEvent) => {
      for (const l of listeners) l(event);
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
      opts: {
        stream: boolean;
        tools?: any[];
        signal?: AbortSignal;
        onDelta?: (d: string, streamKind?: "assistant_text" | "reasoning_text") => void;
        onToolCallDelta?: (index: number, id?: string, name?: string, args?: string) => void;
        onUsage?: (usage: TurnUsage) => void;
        // Guards a WIDENED per-request ceiling only — see STREAM_IDLE_TIMEOUT_MS.
        // Undefined (the interactive-turn default) leaves reading plain: the
        // turn loop's own idle clock (`requestIdleMs`, fed by `onChunk`)
        // already bounds total silence there.  Only the unattended caller
        // (900s ceiling, loop idle clock off) sets this, because that is
        // the path where a stalled connection would otherwise sit
        // unnoticed for a long time.
        idleTimeoutMs?: number;
        /** Raw-bytes liveness for the turn loop's idle clock
         *  (`requestIdleMs` in chat-completions/loop.ts). */
        onChunk?: () => void;
      },
    ): Promise<{ text: string; reasoning: string; tool_calls?: any[]; usage: TurnUsage | null }> => {
      // When the caller supplies a signal it already carries the request
      // deadline (the turn loop arms one per round).  A second timer here
      // would race it and make a timeout indistinguishable from a provider
      // error at the point where the loop has to name the exit.  Callers
      // with no signal — generateText for titles and summaries — keep the
      // driver's own 180s ceiling.
      const signal = opts.signal ?? AbortSignal.timeout(180_000);
      const body = {
        model,
        messages,
        stream: opts.stream,
        reasoning_split: true,
        stream_options: opts.stream ? { include_usage: true } : undefined,
        ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
      };
      const res = await fetch(`${apiUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // A classified status becomes a ProviderError the loop keys off of
        // (`error:<code>` stopReason; `setup: true` on invalid_credentials);
        // an unmapped status stays a plain Error, exactly as before.  The
        // headers travel with it so the loop can read the real status and
        // MiniMax's own `Retry-After` instead of regexing this message.
        throw httpErrorFor(res.status, body, res.headers);
      }
      // headers are progress too: the socket answered
      opts.onChunk?.();

      if (!opts.stream) {
        const json: any = await res.json();
        const msg = json.choices?.[0]?.message;
        return {
          text: typeof msg?.content === "string" ? msg.content : "",
          reasoning: typeof msg?.reasoning_content === "string" ? msg.reasoning_content : "",
          tool_calls: msg?.tool_calls,
          usage: json.usage ? toTurnUsage(json.usage) : null,
        };
      }

      // SSE streaming — identical to grok.ts pattern
      let text = "";
      let reasoning = "";
      let usage: TurnUsage | null = null;
      const streamToolCalls: any[] = [];
      if (!res.body) throw new Error("MiniMax returned no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // One line of an SSE frame. Assumes the caller already trimmed it —
      // both call sites below do, including the final flush, so a trailing
      // `data:` line with no terminating newline is parsed the same as one
      // that had one instead of being silently dropped.
      const takeSseLine = (line: string) => {
        if (!line.startsWith("data:")) return;
        const data = line.slice(5).trim();
        if (data === "[DONE]" || !data) return;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          return;
        }
        const delta = chunk.choices?.[0]?.delta;
        const contentDelta = typeof delta?.content === "string" ? delta.content : undefined;
        const reasoningDelta = typeof delta?.reasoning_content === "string" ? delta.reasoning_content : undefined;
        const toolCallsDelta = Array.isArray(delta?.tool_calls) ? delta.tool_calls : undefined;

        // MiniMax sends reasoning_split: true, which is why reasoning
        // arrives as its own delta field — read it the way openai-compat
        // does, or a reply that is entirely reasoning renders as an empty
        // turn (no text, no reasoning, nothing for the model to show).
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          opts.onDelta?.(reasoningDelta, "reasoning_text");
        }
        if (contentDelta) {
          text += contentDelta;
          opts.onDelta?.(contentDelta, "assistant_text");
        }
        if (toolCallsDelta) {
          for (const tc of toolCallsDelta) {
            const index = tc.index ?? 0;
            if (!streamToolCalls[index]) {
              streamToolCalls[index] = { id: "", type: "function", function: { name: "", arguments: "" } };
            }
            // First-write-wins on id and name. Only the arguments stream in
            // fragments — a provider that repeats the id and name on every
            // chunk (MiniMax does) used to overwrite a partial name
            // fragment with the next one instead of concatenating it,
            // truncating a fragmented tool name; see the identical fix and
            // comment in openai-compat.ts.
            if (tc.id && !streamToolCalls[index].id) streamToolCalls[index].id = tc.id;
            if (tc.function?.name && !streamToolCalls[index].function.name) {
              streamToolCalls[index].function.name = tc.function.name;
            }
            if (tc.function?.arguments) streamToolCalls[index].function.arguments += tc.function.arguments;
            opts.onToolCallDelta?.(index, streamToolCalls[index].id, tc.function?.name, tc.function?.arguments);
          }
        }
        if (chunk.usage) {
          usage = toTurnUsage(chunk.usage);
          opts.onUsage?.(usage);
        }
      };

      try {
        for (;;) {
          const { done, value } = opts.idleTimeoutMs
            ? await readChunkOrStall(reader, opts.idleTimeoutMs)
            : await reader.read();
          if (!done) opts.onChunk?.();
          if (done) {
            // Flush whatever is left in the decoder and the line buffer.
            // MiniMax's stream_options.include_usage frame — the one
            // carrying usage — can arrive as the final line with no
            // trailing newline; without this flush it was silently dropped.
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
      }
      return { text, reasoning, usage, tool_calls: streamToolCalls.length > 0 ? streamToolCalls : undefined };
    };

    const sendTurn = async (turn: SendTurnInput) => {
      const openAiTools = turn.tools && turn.tools.length > 0
        ? turn.tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
            },
          }))
        : undefined;
      const { threadId } = turn;
      // Validation throws SYNCHRONOUSLY out of sendTurn, before the loop
      // exists, so startTurn's catch runs in milliseconds exactly as it does
      // for a CLI driver — error chip, watchdog settled, bot idle, all three
      // queue drains.  A rejection here must never become a resolved turn
      // that nothing ever settles.
      if (!apiKey) throw new Error(`no MiniMax key — ${keylessRemedy}`);
      if (active.has(threadId)) throw new Error("a turn is already running on this thread");

      const turnId = newId();
      const abort = new AbortController();
      active.set(threadId, { abort, turnId, startedAt: Date.now() });
      const model = turn.model || models.default;
      // Round 1's prefix.  The loop owns this array from here and only ever
      // APPENDS to it, so rounds 2..N re-send a byte-identical prefix.
      // The transcript is byte-capped and entry-count-capped first so a
      // long thread cannot grow past the model's prompt window or the
      // provider's per-request size — see chat-completions/replay-cap.ts.
      const cappedTranscript = capReplayedTranscript(turn.transcript);
      // Only the stable half of the prompt heads the request; the volatile
      // half rides the newest user message, every request, so the resent
      // prefix stays byte-identical across a memory write (see
      // prompt-split.ts splitChatPrompt).
      const chat = splitChatPrompt(turn);
      const messages: ChatMessage[] = [
        ...(chat.system ? [{ role: "system" as const, content: chat.system }] : []),
        ...cappedTranscript.flatMap((m): ChatMessage[] => {
          const res: ChatMessage[] = [];
          if (m.role === "assistant") {
            const assistantMsg: ChatMessage = { role: "assistant", content: m.text || "" };
            if (m.toolCalls && m.toolCalls.length > 0) {
              assistantMsg.tool_calls = m.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
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
        ...(chat.text ? [{ role: "user" as const, content: chat.text }] : []),
      ];

      emit({ ...base(threadId, turnId), type: "turn.started" });
      emit({ ...base(threadId, turnId), type: "session.started", sessionId: null, model });

      // Tool ids this turn has already opened a step for.  The stream
      // announces a call once and then keeps sending argument fragments for
      // it, and the settled reply repeats every call — without this a single
      // tool would open a dozen rows.  Shared with the loop so a call the
      // stream announced is not announced again when the round settles.
      const started = new Set<string>();

      const runRound: TurnLoopDeps["runRound"] = async (roundMessages, opts) => {
        appendNative(threadId, {
          dir: "out",
          source: "minimax.chat.completions",
          msg: { model, messageCount: roundMessages.length, round: opts.round, attempt: opts.attempt },
        });
        // One gen_ai.chat span per model round, nested under the
        // gen_ai.invoke_agent span turn.started already opened generically
        // (bus.subscribe → observeRuntimeEvent, driver-agnostic).  The
        // nesting is real trace-tree parentage, not just the shared
        // gen_ai.conversation.id both spans also carry: withChatSpan looks
        // the open turn span up by thread id and passes it as parentSpan,
        // because observeRuntimeEvent opens that span with
        // startInactiveSpan and never enters it as the ACTIVE span, so a
        // round started here would otherwise attach to whatever happened to
        // be active — in this detached turn loop, nothing.  Tool spans are
        // NOT duplicated here with recordExecutedTools: the loop below
        // already emits real item.started/item.completed for every call —
        // with a real outcome, not an assumed ok:true — and
        // observeRuntimeEvent turns those into execute_tool spans on its
        // own.  recordExecutedTools exists for a driver that does not emit
        // item.started at all; calling it here would double every tool
        // span.
        const { text, reasoning, usage, tool_calls } = await withChatSpan(
          { model, conversationId: threadId, taskId: turnId, provider: genAiProvider(DRIVER_KIND) },
          ({ recordUsage }) =>
            complete(roundMessages, model, {
              stream: true,
              tools: openAiTools,
              signal: opts.signal,
              // Only the unattended path gets a per-request ceiling wide
              // enough (900s, below) for a stalled connection to go
              // unnoticed for a long time — see STREAM_IDLE_TIMEOUT_MS and
              // the `budget` comment on this turn's runTurnLoop call.
              idleTimeoutMs: turn.unattended ? STREAM_IDLE_TIMEOUT_MS : undefined,
              // Every raw chunk feeds the loop's idle clock, which is what
              // bounds silence on the interactive path now that its hard
              // ceiling is the loop's default rather than 180s.
              onChunk: opts.onChunk,
              // `onPublished` before every emit that reaches the bus: it
              // is what tells the loop this round can no longer be
              // retried, because a replay would show the person text they
              // have already read.  Both stream callbacks report it —
              // a tool call announced off the stream is as unrepeatable
              // as a text delta.
              onDelta: (delta, streamKind = "assistant_text") => {
                opts.onPublished?.();
                emit({ ...base(threadId, turnId), type: "content.delta", streamKind, delta });
              },
              onToolCallDelta: (_index, id, name, args) => {
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
                  arguments: args,
                });
              },
              // Forwarded straight to the loop's own live channel — see the
              // `onUsage` doc on `TurnLoopDeps.runRound` — and to the chat
              // span so a round that errors mid-stream after several chunks
              // still has its usage recorded on the gen_ai.chat span.
              onUsage: (u) => {
                recordUsage(u);
                opts.onUsage?.(u);
              },
            }),
        );
        appendNative(threadId, {
          dir: "in",
          source: "minimax.chat.completions",
          msg: {
            textLength: text.length,
            reasoningLength: reasoning.length,
            usage,
            round: opts.round,
            attempt: opts.attempt,
            toolCalls: tool_calls?.length ?? 0,
          },
        });
        // A reply that is entirely reasoning (no assistant text) still
        // needs to render as something — fall back to the reasoning text
        // rather than settling a silently empty turn.  The loop is what
        // turns a non-empty `text` into the `item.completed` event and
        // into the next round's assistant-message prefix, so folding the
        // fallback in here is what makes both of those honour it too.
        const replyText = text.trim() ? text : reasoning;
        return { text: replyText, usage, toolCalls: tool_calls };
      };

      // Detached, exactly as every CLI driver runs its turn: sendTurn
      // resolves at DISPATCH so markTaskDispatched and the rewind clear are
      // not deferred to the end of the loop.  runTurnLoop never rejects — it
      // emits one turn.completed on every exit and resolves with which one.
      void runTurnLoop({
        base: () => base(threadId, turnId),
        emit,
        runRound,
        messages,
        // Only `timeoutMs` is read from this; the provider payload is built
        // separately above from name/description/parameters.
        tools: turn.tools,
        // Unattended turns (webhook- or resource-triggered) may need much
        // longer than the interactive ceiling (180s when PR 625 landed) to
        // stream a full reasoning and code response, such as the Compiler
        // bot analysing a CI failure.  BOTFLEET-V (board row bf77b434)
        // showed the Compiler failing this shape of turn at 180s repeatedly.  Use the wall-clock budget as
        // the per-request ceiling so a genuinely slow-but-live stream can
        // finish instead of being cut off mid-answer.  This is a SEPARATE
        // policy from efficiency-and-connectivity.md's "180s timeout
        // treated as silence" note (PR #533) — that is alert-silencing
        // for the timeout that still fires at 180s; this changes when it
        // fires at all.  See docs/efficiency-and-connectivity.md's
        // "Unattended Request Ceiling" section for the fuller writeup and
        // why only MiniMax has this override today.  A stalled CONNECTION
        // (as opposed to a slow but live one) is still caught well before
        // 900s by `readChunkOrStall`'s STREAM_IDLE_TIMEOUT_MS below.
        //
        // Interactive turns take the loop's shared defaults: a hard ceiling
        // plus an idle clock fed by `onChunk`, so a slow-but-live stream is
        // no longer cut off at 180s while a silent one still ends in 120s.
        // The unattended path keeps `readChunkOrStall` as its ONLY idle
        // guard for now (`requestIdleMs: 0`): it retries a pre-output stall
        // as a transient `timeout`, which the loop's own idle clock does
        // not, and retiring it waits until the shared clock has run in
        // production.
        budget: turn.unattended
          ? { requestTimeoutMs: DEFAULT_TURN_LOOP_BUDGET.wallClockMs, requestIdleMs: 0 }
          : undefined,
        toolHost: turn.toolHost,
        // The harness's permission broker, carried across on the same
        // per-turn service object caller identity rides on.  The driver
        // does nothing with it but hand it over: the loop owns the clock
        // and the host owns the policy.
        requestApproval: turn.toolHost?.requestApproval
          ? (ask) => turn.toolHost!.requestApproval!(ask)
          : undefined,
        signal: abort.signal,
        startedToolIds: started,
        onSettled: () => active.delete(threadId),
        // Priced from the SAME `model` every round of this turn ran
        // against, but ONE ROUND AT A TIME: the loop calls this once per
        // round with that round's own usage and sums the answers, never
        // once at the end with the turn's cumulative totals.  That is what
        // MiniMax-M3's >512K-input tier needs — MiniMax bills each REQUEST
        // against its own size, so a turn of several base-tier rounds must
        // not be repriced as one doubled-tier request.  See computeCost's
        // own doc on TurnLoopDeps.
        //
        // Omitted outright, not left to return null per round, when this
        // instance points at an endpoint MiniMax's published rates do not
        // describe — see isPricedMinimaxEndpoint.  The loop reads an absent
        // computeCost as "no price table wired up" and emits a null cost.
        computeCost: pricesApply
          ? (usage) => costUsd(usage, MINIMAX_PRICE_PER_MILLION, model)
          : undefined,
      });

      return { turnId };
    };

    // One GET /models fetch, cached for SNAPSHOT_CACHE_MS, shared by
    // `snapshot()` and `refreshModels()` — "off the same fetch" per PR 10.
    interface ModelsProbe {
      ok: boolean;
      status?: number;
      classification?: HttpErrorClassification;
      rows?: unknown[];
    }
    let cachedProbe: { at: number; result: Promise<ModelsProbe> } | null = null;
    // The last snapshot a probe actually confirmed (reachable, whether
    // capped or not).  Kept across a network failure so a transient DNS
    // blip or timeout does not flip a working key to Unavailable in the
    // picker — only a real 401/403 does that.
    let lastGoodSnapshot: ProviderSnapshot | null = null;

    const probeModels = (): Promise<ModelsProbe> => {
      const now = Date.now();
      if (cachedProbe && now - cachedProbe.at < SNAPSHOT_CACHE_MS) return cachedProbe.result;
      const result = (async (): Promise<ModelsProbe> => {
        try {
          const res = await fetch(`${apiUrl}/models`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(SNAPSHOT_PROBE_TIMEOUT_MS),
          });
          if (!res.ok) return { ok: false, status: res.status, classification: classifyHttpError(res.status) };
          const json: unknown = await res.json().catch(() => null);
          const rows: unknown[] = Array.isArray(json)
            ? json
            : Array.isArray((json as { data?: unknown })?.data)
              ? ((json as { data: unknown[] }).data)
              : [];
          return { ok: true, status: res.status, rows };
        } catch {
          // network failure: DNS, offline, or past the 8s timeout ceiling
          return { ok: false };
        }
      })();
      cachedProbe = { at: now, result };
      return result;
    };

    const refreshModels = async (): Promise<void> => {
      if (!apiKey) return;
      const probe = await probeModels();
      // Keep the current catalog on anything but a clean 2xx list — MODELS
      // stays the fallback for as long as the fetch has never succeeded.
      if (!probe.ok || !probe.rows) return;
      const seen = new Set<string>();
      const options: ModelCatalog["options"] = [];
      for (const row of probe.rows) {
        const id = typeof (row as { id?: unknown })?.id === "string" ? (row as { id: string }).id : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        // Preserve the hand-written label/contextWindow for a model MODELS
        // already knows about; a genuinely new model gets its id as the
        // label rather than nothing.
        const known = MODELS.options.find((m) => m.id === id);
        options.push({ id, label: known?.label ?? id, contextWindow: known?.contextWindow });
      }
      if (options.length === 0) return; // an empty or malformed list keeps the current catalog
      const keptDefault = options.find((o) => o.id === models.default)?.id;
      models = { default: keptDefault ?? options[0].id, options };
    };

    const snapshot = async (): Promise<ProviderSnapshot> => {
      if (!apiKey) {
        return { state: "unavailable", reason: `no MiniMax API key — ${keylessRemedy}` };
      }
      const probe = await probeModels();
      if (probe.ok) {
        const fresh: ProviderSnapshot = { state: "available", authenticated: true, version: null, billing: "metered" };
        lastGoodSnapshot = fresh;
        return fresh;
      }
      if (probe.classification?.code === "invalid_credentials") {
        return {
          state: "unavailable",
          reason: `MiniMax key rejected (HTTP ${probe.status}) — ${rejectedRemedy}`,
        };
      }
      if (probe.classification?.code === "quota_or_region_restriction") {
        const capped: ProviderSnapshot = {
          state: "available",
          authenticated: true,
          version: null,
          billing: "metered",
          quota: { capped: true },
        };
        lastGoodSnapshot = capped;
        return capped;
      }
      // A 5xx, a 404, or the probe never reaching the network at all: never
      // flip a working key to Unavailable on a blip.  Report the last state
      // a probe actually confirmed, or the old optimistic default before
      // the first probe has ever completed.
      return lastGoodSnapshot ?? { state: "available", authenticated: true, version: null, billing: "metered" };
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
        // localComputerMcp: true allows mounting host computer tools (bash, files)
        // for MiniMax turns, routed through the turn tool host with permission broker
        // approval cards.
        // toolLoop: this driver runs the harness tool loop inside sendTurn and
        // emits exactly one turn.started / turn.completed pair per user turn,
        // the way every CLI driver does — so the harness hands it a toolHost
        // and dispatches it on the same one line it uses for Claude.
        // replaysTranscript: this driver builds its OpenAI messages array
        // from `turn.transcript` every round, so the harness must not also
        // inline the same history into the turn text — see turn-context.ts.
        capabilities: {
          sessionModelSwitch: "in-session",
          agentsMcp: true,
          toolLoop: true,
          replaysTranscript: true,
          localComputerMcp: true,
        },
        sendTurn,
        interruptTurn: async (threadId) => active.get(threadId)?.abort.abort(),
        // Insurance the single try/finally should make unreachable: if this
        // ever returns a thread, the loop leaked one, and that is worth
        // knowing.  Aborting settles the turn through the same finally, so
        // even the sweep produces exactly one terminal event.
        sweepStuckTurns: async (olderThanMs: number) => {
          const cutoff = Date.now() - olderThanMs;
          const stuck: string[] = [];
          for (const [threadId, entry] of active) {
            if (entry.startedAt > cutoff) continue;
            stuck.push(threadId);
            entry.abort.abort();
          }
          return stuck;
        },
        respondToRequest: async (): Promise<"unavailable"> => "unavailable",
        hasSession: (threadId) => active.has(threadId),
        stopAll: async () => { for (const { abort } of active.values()) abort.abort(); },
        onEvent: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      generateText: async (prompt: string) => {
        // Titles and summaries never need the flagship's 1M-token context —
        // see UTILITY_MODEL's own comment — and are fixed to it independent
        // of `models.default`, which local mmx-cli config can repoint.
        const { text, reasoning } = await complete([{ role: "user", content: prompt }], UTILITY_MODEL, {
          stream: false,
        });
        return text.trim() ? text : reasoning;
      },
      dispose: async () => {
        for (const { abort } of active.values()) abort.abort();
        listeners.clear();
      },
    };
  },
};
