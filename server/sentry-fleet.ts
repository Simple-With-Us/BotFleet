// Second Sentry client for the shared fleet-infra project.
//
// BotFleet's own crashes and gen_ai spans stay on `botfleet`.  This module
// mirrors one summary event per completed bot turn into fleet-infra so the
// fleet dashboard can see BotFleet next to Claude Code / Codex / the rest.
// The DSN is `SENTRY_FLEET_DSN` from Infisical or the environment — never a
// hardcoded secret, and never the product `SENTRY_DSN`.
//
// Inert when the DSN is missing.  Tests install a recording sink so this
// file never loads @sentry/node under vitest.
import { describeDsn } from "./sentry.ts";
import { secretSource } from "./secret-map.ts";

export type FleetTurnExport = {
  conversationId: string;
  threadId: string;
  provider: string;
  model?: string;
  ok: boolean;
  durationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cost?: number;
  costSource?: string;
  toolNames: string[];
  botId?: string;
  botName?: string;
};

export type FleetTags = {
  signal: string;
  platform: string;
  "gen_ai.system": string;
  "gen_ai.provider.name": string;
  "gen_ai.conversation.id": string;
  "botfleet.thread.id": string;
  "botfleet.ok": string;
  "gen_ai.request.model"?: string;
  "botfleet.cost.source"?: string;
  "botfleet.bot.id"?: string;
  "botfleet.bot.name"?: string;
};

export type FleetExtra = {
  "botfleet.turn.duration_ms": number;
  "botfleet.tool.count": number;
  "gen_ai.usage.input_tokens"?: number;
  "gen_ai.usage.output_tokens"?: number;
  "gen_ai.usage.input_tokens.cached"?: number;
  "gen_ai.usage.cost"?: number;
  "botfleet.cost.estimated_usd"?: number;
  "botfleet.tool.names"?: string;
  "gen_ai.input.messages"?: string;
  "gen_ai.output.messages"?: string;
};

export type FleetCapture = {
  message: string;
  tags: FleetTags;
  extra: FleetExtra;
};

export type FleetSink = {
  capture(event: FleetCapture): void;
};

export type FleetRuntimeState = {
  active: boolean;
  configured: boolean;
  host: string | null;
  projectId: string | null;
};

const DORMANT: FleetRuntimeState = {
  active: false,
  configured: false,
  host: null,
  projectId: null,
};

let sink: FleetSink | null = null;
let sinkFromTests = false;
let runtime: FleetRuntimeState = { ...DORMANT };
type FleetNodeClient = {
  captureEvent(event: {
    message: string;
    level: string;
    tags: FleetTags;
    extra: FleetExtra;
  }): void;
  close(timeout?: number): PromiseLike<boolean>;
  flush(timeout?: number): PromiseLike<boolean>;
};
let liveClient: FleetNodeClient | null = null;
let liveClientDsn: string | null = null;

export function sentryFleetDsnFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = (env.SENTRY_FLEET_DSN || "").trim();
  return raw || undefined;
}

export function sentryFleetDsnConfigured(cfg: { observability?: { sentryFleetDsn?: string } }): string | null {
  const raw = cfg.observability?.sentryFleetDsn?.trim();
  return raw || null;
}

/** Vault, then env, then the stored config field.  Same ordering as the
 * product DSN so a rotated Infisical value wins. */
export function resolveSentryFleetDsn(
  cfg: { observability?: { sentryFleetDsn?: string } },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (secretSource("observability.sentryFleetDsn") === "infisical") {
    return sentryFleetDsnConfigured(cfg);
  }
  return sentryFleetDsnFromEnv(env) ?? sentryFleetDsnConfigured(cfg);
}

function tagsFor(turn: FleetTurnExport): FleetTags {
  const tags: FleetTags = {
    signal: "agent",
    platform: "botfleet",
    "gen_ai.system": turn.provider,
    "gen_ai.provider.name": turn.provider,
    "gen_ai.conversation.id": turn.conversationId,
    "botfleet.thread.id": turn.threadId,
    "botfleet.ok": turn.ok ? "true" : "false",
  };
  if (turn.model) tags["gen_ai.request.model"] = turn.model;
  if (turn.costSource) tags["botfleet.cost.source"] = turn.costSource;
  if (turn.botId) tags["botfleet.bot.id"] = turn.botId;
  if (turn.botName) tags["botfleet.bot.name"] = turn.botName;
  return tags;
}

function extraFor(turn: FleetTurnExport): FleetExtra {
  const extra: FleetExtra = {
    "botfleet.turn.duration_ms": turn.durationMs,
    "botfleet.tool.count": turn.toolNames.length,
  };
  if (turn.inputTokens != null) extra["gen_ai.usage.input_tokens"] = turn.inputTokens;
  if (turn.outputTokens != null) extra["gen_ai.usage.output_tokens"] = turn.outputTokens;
  if (turn.cachedInputTokens != null) extra["gen_ai.usage.input_tokens.cached"] = turn.cachedInputTokens;
  if (turn.costSource === "estimated") {
    if (turn.cost != null) extra["botfleet.cost.estimated_usd"] = turn.cost;
  } else if (turn.cost != null) {
    extra["gen_ai.usage.cost"] = turn.cost;
  }
  if (turn.toolNames.length > 0) extra["botfleet.tool.names"] = turn.toolNames.join(",");
  return extra;
}

export function buildFleetCapture(turn: FleetTurnExport): FleetCapture {
  const model = turn.model || "unknown";
  return {
    message: `botfleet gen_ai ${turn.provider} ${model}`,
    tags: tagsFor(turn),
    extra: extraFor(turn),
  };
}

/** One summary event per completed bot turn.  No-op without a sink. */
export function exportFleetTurn(turn: FleetTurnExport): void {
  if (!sink) return;
  try {
    sink.capture(buildFleetCapture(turn));
  } catch {
    // Telemetry must never take down a turn.
  }
}

export function applySentryFleetConfig(dsn: string | null): FleetRuntimeState {
  if (sinkFromTests) {
    runtime = {
      active: true,
      configured: true,
      host: runtime.host,
      projectId: runtime.projectId,
    };
    return { ...runtime };
  }
  const parsed = dsn ? describeDsn(dsn) : null;
  if (!dsn || !parsed) {
    sink = null;
    void closeLiveClient();
    runtime = { ...DORMANT, configured: Boolean(dsn) };
    return { ...runtime };
  }
  runtime = {
    active: true,
    configured: true,
    host: parsed.host,
    projectId: parsed.projectId,
  };
  sink = liveFleetSink(dsn);
  return { ...runtime };
}

export function sentryFleetState(): FleetRuntimeState {
  return { ...runtime };
}

function liveFleetSink(dsn: string): FleetSink {
  // The live sink is a lazy closure so vitest importing this module never
  // pays the Node SDK tax.  A test replaces the sink outright.
  return {
    capture(event) {
      void captureWithLiveClient(dsn, event);
    },
  };
}

async function closeLiveClient(): Promise<void> {
  if (!liveClient) return;
  try {
    await liveClient.close(500);
  } catch {
    // Rotation or shutdown must not take the harness down.
  }
  liveClient = null;
  liveClientDsn = null;
}

async function ensureLiveClient(dsn: string): Promise<FleetNodeClient | null> {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") return null;
  if (liveClient && liveClientDsn === dsn) return liveClient;
  await closeLiveClient();
  try {
    const Sentry = await import("@sentry/node");
    const client = new Sentry.NodeClient({
      dsn,
      environment: (process.env.SENTRY_ENV || process.env.NODE_ENV || "production").trim() || "production",
      tracesSampleRate: 0,
      stackParser: Sentry.defaultStackParser,
      transport: Sentry.makeNodeTransport,
      integrations: [],
      dataCollection: {
        httpBodies: [],
        httpHeaders: { request: false, response: false },
        cookies: false,
        urlQueryParams: false,
      },
    });
    liveClient = {
      captureEvent(event) {
        client.captureEvent(event);
      },
      close(timeout) {
        return client.close(timeout);
      },
      flush(timeout) {
        return client.flush(timeout);
      },
    };
    liveClientDsn = dsn;
    return liveClient;
  } catch {
    return null;
  }
}

async function captureWithLiveClient(dsn: string, event: FleetCapture): Promise<void> {
  try {
    const client = await ensureLiveClient(dsn);
    if (!client) return;
    client.captureEvent({
      message: event.message,
      level: "info",
      tags: event.tags,
      extra: event.extra,
    });
  } catch {
    // A missing SDK or a refused DSN must not take the harness down.
  }
}

export function setFleetSinkForTests(next: FleetSink | null): void {
  sink = next;
  sinkFromTests = next !== null;
  runtime = next
    ? { active: true, configured: true, host: "test.invalid", projectId: "1" }
    : { ...DORMANT };
}

export function resetSentryFleetForTests(): void {
  sink = null;
  sinkFromTests = false;
  liveClient = null;
  liveClientDsn = null;
  runtime = { ...DORMANT };
}
