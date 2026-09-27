import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accessHeaders, accessLoginHint, accessTokenState, type AccessTokenState } from "./recall-access.ts";
import { RECALL_CLI_TIMEOUT_MS, describeCliFailure } from "./cli-failure.ts";
import { redactSecretsInText } from "./redact.ts";

export const RECALL_STATUS_TIMEOUT_MS = 12_000;
export const RECALL_TOOL_TIMEOUT_MS = RECALL_CLI_TIMEOUT_MS;
/** Skip Tailscale.app startup and the 120s private Qdrant path in the local recall CLI. */
export const RECALL_SKIP_PRIVATE_ENV = "RECALL_SKIP_PRIVATE";

export function findRecallCli(): string | null {
  const candidates = [process.env.RECALL_CLI_PATH, join(homedir(), ".local", "bin", "recall"),
    "/opt/homebrew/bin/recall", "/usr/local/bin/recall"];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

/** An explicitly selected service is never bypassed by another local corpus. */
export function selectRecallTransport(url: string, cli: string | null): RecallStatus["source"] {
  return url ? "recall-service" : cli ? "recall-cli" : "unconfigured";
}

/** One deadline covers the child and its output pipes, including a stuck descendant. */
export function executeRecallCli(cli: string, args: string[], collection: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, stdout = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(stdout.trim());
    };
    const child = spawn(cli, args, {
      detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env,
        PATH: `${join(homedir(), ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`,
        [RECALL_SKIP_PRIVATE_ENV]: "1",
        ...(collection ? { QDRANT_FLEET_COLLECTION: collection } : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    const stop = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* The child may have exited just before the deadline. */ }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const collect = (target: "stdout" | "stderr", chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 4 * 1024 * 1024) { stop(); finish(new Error("recall CLI exceeded its output limit")); return; }
      if (target === "stdout") stdout += chunk; else stderr += chunk;
    };
    child.stdout.on("data", (chunk: string) => collect("stdout", chunk));
    child.stderr.on("data", (chunk: string) => collect("stderr", chunk));
    child.on("error", (error) => finish(error));
    child.on("close", (code, signal) => finish(code === 0
      ? (stderr && !stdout ? new Error(stderr.trim()) : null)
      : Object.assign(new Error("recall CLI failed"), { code, signal, stderr }), stdout));
    const timer = setTimeout(() => {
      if (settled) return;
      stop();
      finish(Object.assign(new Error(`recall CLI timed out after ${timeoutMs}ms`), { killed: true, signal: "SIGKILL" }));
    }, timeoutMs);
  });
}

/** Keep service credentials on the configured origin, including across redirects. */
export async function fetchRecall(url: string, options: RequestInit): Promise<Response> {
  let current = new URL(url);
  let request = { ...options, redirect: "manual" as const };
  for (let hop = 0; hop < 5; hop++) {
    const response = await fetch(current, request);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const next = new URL(location, current);
    const sameOrigin = next.origin === current.origin;
    const upgrade = current.protocol === "http:" && next.protocol === "https:" && next.hostname === current.hostname &&
      !current.port && !next.port;
    if ((!sameOrigin && !upgrade) || next.username || next.password || /\/cdn-cgi\/access\//i.test(next.pathname)) return response;
    await response.body?.cancel();
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && request.method === "POST")) {
      request = { ...request, method: "GET", body: undefined };
    }
    current = next;
  }
  throw new Error("Recall service redirected too many times");
}

export interface RecallStats {
  collection: string;
  points: number;
  backend_ok?: boolean;
  embedder_healthy?: boolean;
  status?: string;
  version?: string;
}

export function validateRecallStats(value: unknown, collection = ""): { stats?: RecallStats; error?: string } {
  if (!value || typeof value !== "object") return { error: "the service returned invalid statistics" };
  const data = value as Record<string, unknown>;
  if (data.error || data.ok === false || data.backend_ok === false || data.embedder_healthy === false ||
      (typeof data.status === "string" && !["green", "ok", "ready"].includes(data.status.toLowerCase()))) {
    return { error: "the recall backend or embedder is unavailable" };
  }
  if (typeof data.collection !== "string" || !data.collection || !Number.isSafeInteger(data.points) || Number(data.points) < 0 ||
      !(data.backend_ok === true || data.embedder_healthy === true)) {
    return { error: "the service did not provide valid collection and backend readiness statistics" };
  }
  if (collection && data.collection !== collection) return { error: "the service returned a different collection than configured" };
  return { stats: data as unknown as RecallStats };
}

export async function probeRecallService(url: string, headers: RequestInit["headers"], collection: string, signal: AbortSignal) {
  const get = async (path: string) => {
    const response = await fetchRecall(`${url}${path}`, { headers, signal });
    const gate = accessLoginHint(response);
    if (gate) throw Object.assign(new Error(gate), { accessGated: true });
    if (!response.ok) throw Object.assign(new Error(`the recall route answered HTTP ${response.status}`), { accessGated: [401, 403].includes(response.status) });
    return await response.json() as unknown;
  };
  // Public health can veto readiness, but only validated protected stats can establish it.
  const health = await get("/health");
  if (health && typeof health === "object" && (health as Record<string, unknown>).backend_ok === false) {
    throw new Error("the recall backend is unavailable");
  }
  const checked = validateRecallStats(await get("/recall/stats"), collection);
  if (!checked.stats) throw new Error(checked.error);
  return checked.stats;
}

export interface RecallSettings {
  url: string;
  apiKey: string;
  collection: string;
  accessClientId: string;
  accessClientSecret: string;
}

export interface RecallStatus {
  ready: boolean;
  configured: boolean;
  state: "unconfigured" | "degraded" | "ready";
  source: "recall-service" | "recall-cli" | "unconfigured";
  url: string | null;
  collection: string | null;
  checkedAt: number;
  lastSuccessAt: number | null;
  pointsCount?: number;
  backendOk?: boolean;
  embedderHealthy?: boolean;
  accessGated?: boolean;
  /** Whether the Cloudflare Access service token is whole.  Reported even on
   * a healthy probe, because half a pair sends no Access headers at all and
   * the panel needs to say so before the operator meets a login page. */
  accessTokenState?: AccessTokenState;
  error?: string;
}

const lastSuccesses = new Map<string, number>();
const pending = new Map<string, Promise<RecallStatus>>();
const MAX_SUCCESS_HISTORY = 64;

/** Coalesce simultaneous settings probes without caching failure as a permanent result. */
export function recallStatus(settings: RecallSettings, timeoutMs = RECALL_STATUS_TIMEOUT_MS): Promise<RecallStatus> {
  const cli = settings.url ? null : findRecallCli();
  const source = selectRecallTransport(settings.url, cli);
  const key = createHash("sha256").update(JSON.stringify([settings, cli])).digest("hex");
  const existing = pending.get(key);
  if (existing) return existing;
  const run = async (): Promise<RecallStatus> => {
    const base = { source, configured: source !== "unconfigured", url: settings.url || null,
      collection: settings.collection || null, checkedAt: Date.now(), lastSuccessAt: lastSuccesses.get(key) ?? null,
      accessTokenState: accessTokenState(settings.accessClientId, settings.accessClientSecret) };
    if (source === "unconfigured") return { ...base, ready: false, state: "unconfigured",
      error: "Bot RAG is not configured — set a Service URL in Settings" };
    try {
      let stats: RecallStats;
      if (source === "recall-cli" && cli) {
        let raw;
        try { raw = await executeRecallCli(cli, ["stats", "--json"], settings.collection, timeoutMs); }
        catch (error) { throw new Error(`Ran the local recall CLI (recall stats --json) and ${describeCliFailure(error, timeoutMs)}.`); }
        const checked = validateRecallStats(JSON.parse(raw), settings.collection);
        if (!checked.stats) throw new Error(checked.error);
        stats = checked.stats;
      } else {
        const headers: Record<string, string> = { ...accessHeaders(settings.accessClientId, settings.accessClientSecret) };
        if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
        stats = await probeRecallService(settings.url, headers, settings.collection, AbortSignal.timeout(timeoutMs));
      }
      const at = Date.now();
      lastSuccesses.delete(key);
      lastSuccesses.set(key, at);
      if (lastSuccesses.size > MAX_SUCCESS_HISTORY) lastSuccesses.delete(lastSuccesses.keys().next().value!);
      return { ...base, ready: true, state: "ready", checkedAt: at, lastSuccessAt: at,
        collection: stats.collection, pointsCount: stats.points, backendOk: true,
        ...(stats.embedder_healthy !== undefined ? { embedderHealthy: stats.embedder_healthy } : {}) };
    } catch (error) {
      return { ...base, ready: false, state: "degraded", checkedAt: Date.now(),
        ...(error && typeof error === "object" && "accessGated" in error && error.accessGated ? { accessGated: true } : {}),
        error: redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 400) };
    }
  };
  const promise = run().finally(() => { if (pending.get(key) === promise) pending.delete(key); });
  pending.set(key, promise);
  return promise;
}
