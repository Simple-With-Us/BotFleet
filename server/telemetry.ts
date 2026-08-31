import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";

export interface TelemetryTurnParams {
  botId: string;
  botName: string;
  threadId: string;
  taskTitle?: string;
  cwd?: string | null;
  instanceId: string;
  modelId?: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number | null;
  latencyMs?: number;
  success?: boolean;
}

export interface TelemetryStatus {
  enabled: boolean;
  ingestUrl: string;
  totalSent: number;
  totalFailed: number;
  lastAckAt: string | null;
  lastError: string | null;
}

const DEFAULT_INGEST_URL = "https://usage.jays.services";
const INGEST_PATH = "/api/ingest/usage";

function loadSecretKey(keyName: string): string | undefined {
  return process.env[keyName]?.trim();
}

export function inferProject(cwd?: string | null, botName?: string, taskTitle?: string): string {
  const normCwd = (cwd || "").toLowerCase();
  const normBot = (botName || "").toLowerCase();
  const normTask = (taskTitle || "").toLowerCase();

  if (normCwd.includes("congress-antigravity") || normCwd.includes("congress-trade") || normBot.includes("congress") || normTask.includes("congress")) {
    return "congress-trade";
  }
  if (normCwd.includes("socratic-trade") || normCwd.includes("socratic") || normBot.includes("socratic") || normTask.includes("socratic")) {
    return "socratic-trade";
  }
  if (normCwd.includes("botfleet") || normCwd.includes("openmausbot") || normBot.includes("botfleet")) {
    return "botfleet";
  }
  if (normCwd.includes("ai-fleet-coordinator") || normBot.includes("fleet-coordinator") || normTask.includes("fleet coordinator")) {
    return "ai-fleet-coordinator";
  }
  if (normCwd.includes("fleet-ops") || normCwd.includes("fleetops") || normBot.includes("fleet-ops") || normTask.includes("fleet ops")) {
    return "fleet-ops";
  }
  if (normCwd.includes("dealdex") || normBot.includes("dealdex") || normTask.includes("dealdex")) {
    return "dealdex";
  }
  if (normCwd.includes("contactlogo") || normCwd.includes("contact-logo") || normBot.includes("contactlogo") || normTask.includes("contactlogo")) {
    return "contactlogo";
  }
  if (normCwd.includes("autorotate") || normCwd.includes("auto-rotate") || normBot.includes("autorotate") || normTask.includes("autorotate")) {
    return "autorotate";
  }
  if (normCwd.includes("usage-monitor") || normBot.includes("usage-monitor") || normTask.includes("usage-monitor")) {
    return "usage-monitor";
  }

  if (cwd && cwd !== homedir() && cwd !== "/") {
    const base = basename(cwd).toLowerCase().replace(/[^a-z0-9._-]/g, "-");
    if (base.length > 0) return base;
  }

  return "general";
}

export function inferProviderAndService(instanceId: string, modelId?: string): { provider: string; service: string } {
  const inst = (instanceId || "").toLowerCase();
  const model = (modelId || "").toLowerCase();

  if (inst.includes("deepseek") || model.includes("deepseek")) {
    return { provider: "deepseek", service: modelId || "unknown" };
  }
  if (inst.includes("grok") || model.includes("grok")) {
    return { provider: "xai", service: modelId || "unknown" };
  }
  if (inst.includes("claude") || model.includes("claude") || model.includes("sonnet")) {
    return { provider: "anthropic", service: modelId || "unknown" };
  }
  if (inst.includes("codex") || model.includes("gpt") || model.includes("o1") || model.includes("o3")) {
    return { provider: "openai", service: modelId || "unknown" };
  }
  if (inst.includes("antigravity") || model.includes("gemini")) {
    return { provider: "google-ai", service: modelId || "unknown" };
  }
  if (inst.includes("cursor")) {
    return { provider: "cursor", service: modelId || "unknown" };
  }
  if (inst.includes("kimi") || model.includes("moonshot")) {
    return { provider: "moonshot", service: modelId || "unknown" };
  }

  return { provider: instanceId || "custom", service: modelId || instanceId || "unknown" };
}

class UsageTelemetryManager {
  private totalSent = 0;
  private totalFailed = 0;
  private lastAckAt: string | null = null;
  private lastError: string | null = null;

  private getIngestConfig(): { baseUrl: string; token: string } | null {
    const rawUrl = process.env.USAGE_MONITOR_INGEST_URL || DEFAULT_INGEST_URL;
    let baseUrl = rawUrl.trim().replace(/\/+$/, "");
    if (baseUrl.endsWith(INGEST_PATH)) {
      baseUrl = baseUrl.slice(0, -INGEST_PATH.length).replace(/\/+$/, "");
    }

    const token =
      process.env.USAGE_MONITOR_INGEST_TOKEN?.trim() ||
      process.env.USAGE_INGEST_TOKEN?.trim() ||
      loadSecretKey("USAGE_MONITOR_INGEST_TOKEN") ||
      loadSecretKey("USAGE_INGEST_TOKEN");

    if (!baseUrl || !token) return null;
    return { baseUrl, token };
  }

  getStatus(): TelemetryStatus {
    const config = this.getIngestConfig();
    return {
      enabled: config !== null,
      ingestUrl: config ? `${config.baseUrl}${INGEST_PATH}` : `${DEFAULT_INGEST_URL}${INGEST_PATH}`,
      totalSent: this.totalSent,
      totalFailed: this.totalFailed,
      lastAckAt: this.lastAckAt,
      lastError: this.lastError,
    };
  }

  trackTurn(params: TelemetryTurnParams): void {
    const config = this.getIngestConfig();
    if (!config) return;

    const { provider, service } = inferProviderAndService(params.instanceId, params.modelId);
    const project = inferProject(params.cwd, params.botName, params.taskTitle);
    const inTokens = Math.max(0, Math.round(params.inputTokens || 0));
    const outTokens = Math.max(0, Math.round(params.outputTokens || 0));
    const cachedTokens = Math.max(0, Math.round(params.cachedInputTokens || 0));
    const quantity = inTokens + outTokens;

    const eventId = `bf:${provider}:${params.botId}:${Date.now()}:${randomUUID().slice(0, 8)}`;
    const label = (params.taskTitle || params.botName || "turn").slice(0, 160);

    const event = {
      eventId,
      environment: process.env.NODE_ENV === "production" ? "production" : "operator",
      provider,
      service,
      project,
      label,
      billingMode: params.costUsd != null ? "actual" : "estimated",
      metricType: "usage",
      quantity: quantity > 0 ? quantity : 1,
      unit: "token",
      requests: 1,
      costUsd: params.costUsd != null && Number.isFinite(params.costUsd) ? params.costUsd : undefined,
      confidence: params.costUsd != null ? "actual" : "estimated",
      occurredAt: new Date().toISOString(),
      metadata: {
        botName: params.botName,
        botId: params.botId,
        threadId: params.threadId,
        inputTokens: inTokens,
        outputTokens: outTokens,
        cachedInputTokens: cachedTokens,
        cwd: params.cwd || null,
        latencyMs: params.latencyMs || 0,
        success: params.success !== false,
      },
    };

    const batch = {
      schemaVersion: 2,
      producerId: "botfleet",
      producerInstanceId: hostname(),
      events: [event],
    };

    const endpoint = `${config.baseUrl}${INGEST_PATH}`;

    void fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify(batch),
      signal: AbortSignal.timeout(5000),
    })
      .then(async (res) => {
        if (res.ok) {
          this.totalSent += 1;
          this.lastAckAt = new Date().toISOString();
          this.lastError = null;
        } else {
          this.totalFailed += 1;
          const text = await res.text().catch(() => "");
          this.lastError = `HTTP ${res.status}: ${text.slice(0, 200)}`;
          console.warn(`[telemetry] Usage Monitor returned status ${res.status} (${this.lastError})`);
        }
      })
      .catch((err) => {
        this.totalFailed += 1;
        this.lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[telemetry] Usage Monitor dispatch failed: ${this.lastError}`);
      });
  }
}

export const telemetry = new UsageTelemetryManager();
