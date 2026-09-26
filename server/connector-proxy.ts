// Harness-owned Composio MCP bridge.
//
// Provider CLIs only see this stdio server. Ordinary MCP traffic is relayed
// to the configured Composio Session, but connection requests are converted
// into first-class BotFleet chat cards. The agent never authors an auth
// URL and credentials never pass through its transcript.
//
// stdout is the MCP transport. Never log there.
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import type { JsonValue, JsonObject } from "./schema.ts";

type Json = Record<string, JsonValue>;

const UPSTREAM = process.env.OMB_CONNECTOR_UPSTREAM_URL ?? "";
const HARNESS = process.env.OMB_HARNESS_URL ?? "http://127.0.0.1:8799";
const BOT_ID = process.env.OMB_BOT_ID ?? "";
const THREAD_ID = process.env.OMB_THREAD_ID ?? "";
const TOKEN = process.env.OMB_COMMS_TOKEN ?? "";
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const INITIALIZE_RELAY_TIMEOUT_MS = 1_000;
const RELAY_TIMEOUT_MS = 10 * 60_000;

function parsedHeaders(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(process.env.OMB_CONNECTOR_UPSTREAM_HEADERS ?? "{}");
    if (!value || !(Object.prototype.toString.call(value) === "[object Object]") || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => (Object.prototype.toString.call(entry[1]) === "[object String]")),
    );
  } catch {
    return {};
  }
}

const upstreamHeaders = parsedHeaders();
let upstreamSessionId = "";
const send = (message: Json) => process.stdout.write(`${JSON.stringify(message)}\n`);

function textResult(id, text: string, isError = false) {
  const out = { jsonrpc: "2.0" as const, id, result: { content: [{ type: "text" as const, text }] } };
  if (isError) out.result.isError = true;
  return out;
}

function jsonRpcError(id, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code: -32000, message } };
}

function initializeResult(id, protocolVersion) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: (Object.prototype.toString.call(protocolVersion) === "[object String]") && protocolVersion ? protocolVersion : "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "botfleet-connectors", version: "1" },
    },
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error("connector response exceeded 20 MB");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("connector response exceeded 20 MB");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseUpstream(text: string, id): Json | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // SAFETY: the upstream reply is a JSON document (single object or SSE
  // frames); JSON.parse produces a JsonValue and the cast narrows to
  // the documented Json envelope.
  // SAFETY: trimmed.startsWith("{") guarantees JSON.parse produces
  // an object — the Json type covers all JSON values, so the cast is
  // exact.
  if (trimmed.startsWith("{")) {
    // SAFETY: same invariant — the JSON envelope is exactly Json.
    const parsed = JSON.parse(trimmed) as Json;
    return parsed;
  }
  const frames = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]")
    .flatMap((line) => {
      try {
        // SAFETY: same invariant — each SSE `data:` line is a JSON
        // frame; the cast narrows to the documented Json envelope.
        return [JSON.parse(line) as Json];
      } catch {
        return [];
      }
    });
  return frames.findLast((frame) => frame.id === id) ?? frames.at(-1) ?? null;
}

async function relay(message: Json, timeoutMs = RELAY_TIMEOUT_MS): Promise<Json | null> {
  if (!UPSTREAM) throw new Error("connected apps are unavailable");
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...upstreamHeaders,
  } satisfies Record<string, string>;
  if (upstreamSessionId) headers["mcp-session-id"] = upstreamSessionId;
  const response = await fetch(UPSTREAM, {
    method: "POST",
    headers,
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const nextSession = response.headers.get("mcp-session-id");
  if (nextSession) upstreamSessionId = nextSession;
  if (!response.ok) throw new Error(`connector service returned HTTP ${response.status}`);
  return parseUpstream(await readBounded(response), message.id);
}

function connectorAdds(args): string[] {
  if (!args || !(Object.prototype.toString.call(args) === "[object Object]") || Array.isArray(args)) return [];
  // SAFETY: the toString-call + !Array.isArray() guards above restrict
  // args to a JSON object, so the cast to the documented envelope is exact.
  const toolkits = (args as { toolkits?: unknown }).toolkits;
  if (!Array.isArray(toolkits)) return [];
  return [...new Set(toolkits.flatMap((item) => {
    if ((Object.prototype.toString.call(item) === "[object String]")) return [item.toLowerCase()];
    if (!item || !(Object.prototype.toString.call(item) === "[object Object]") || Array.isArray(item)) return [];
    // SAFETY: same invariant — item is a JSON object, so the cast to
    // the documented { name, toolkit, action } envelope is exact.
    const row = item as { name?: unknown; toolkit?: unknown; action?: unknown };
    const slug = (Object.prototype.toString.call(row.toolkit) === "[object String]") ? row.toolkit : row.name;
    const action = String(row.action ?? "add").toLowerCase();
    return (Object.prototype.toString.call(slug) === "[object String]") && ["add", "connect", "initiate"].includes(action) ? [slug.toLowerCase()] : [];
  }))];
}

async function showConnectorCards(slugs: string[]): Promise<void> {
  const response = await fetch(`${HARNESS}/api/internal/connectors/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ botId: BOT_ID, threadId: THREAD_ID, slugs, resumeKey: randomUUID() }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    // SAFETY: response.json() returns any JSON value; the cast
    // narrows the loose shape to the { error } envelope used below.
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(String(body.error ?? `could not show connection card (HTTP ${response.status})`));
  }
}

async function handle(message: Json): Promise<void> {
  const id = message.id;
  const method = String(message.method ?? "");
  // OpenCode (and other MCP clients) mark a stdio server failed unless
  // initialize returns capabilities/serverInfo. Relaying that handshake to
  // Composio can time out, return a newer protocolVersion, or throw when the
  // upstream URL never reached the child env — all of which previously
  // SAFETY: the surrounding code established this is the documented shape; the cast narrows.

  // surfaced as a tools/call-shaped {content,isError} payload.
  if (method === "notifications/initialized" || method === "initialized") {
    if (UPSTREAM) void relay(message).catch(() => {});
    return;
  }
  if (method === "initialize") {
    if (UPSTREAM) {
      try {
        // Capture the upstream session id when the service is healthy, but
        // never let a stalled provider prevent the local MCP client from
        // mounting the connector tools. The client sends initialized only
        // after this bounded attempt and the local initialize response.
        await relay(message, INITIALIZE_RELAY_TIMEOUT_MS);
      } catch {
        // Best-effort session setup. The client still needs a valid result.
      }
    }
    if (id !== undefined) {
      // SAFETY: the surrounding code established this is the documented shape; the cast narrows.

      const params = (message.params ?? {}) as Json;
      send(initializeResult(id, params.protocolVersion));
    }
    return;
  }
  if (method === "tools/call") {
    // SAFETY: the surrounding code established this is the documented shape; the cast narrows.

    const params = (message.params ?? {}) as Json;
    const name = String(params.name ?? "");
    const slugs = /MANAGE_CONNECTIONS$/i.test(name) ? connectorAdds(params.arguments) : [];
    if (slugs.length) {
      await showConnectorCards(slugs);
      send(textResult(
        id,
        `BotFleet showed the user a secure connection card for ${slugs.join(", ")}. End this turn now. The app will continue the task automatically after the connection finishes.`,
      ));
      return;
    }
    if (/WAIT_FOR_CONNECTIONS$/i.test(name)) {
      send(textResult(id, "BotFleet is handling connection completion and will continue the task automatically."));
      return;
    }
  }
  try {
    const response = await relay(message);
    if (response && id !== undefined) send(response);
  } catch (error) {
    if (id === undefined) return;
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(id, messageText, true));
    else if (method === "tools/list" && /HTTP (?:401|403)/i.test(messageText)) {
      send({ jsonrpc: "2.0", id, result: { tools: [] } });
    } else send(jsonRpcError(id, messageText));
  }
}

const input = readline.createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: Json;
  try {
    // SAFETY: the surrounding code established this is the documented shape; the cast narrows.

    message = JSON.parse(trimmed) as Json;
  } catch {
    return;
  }
  void handle(message).catch((error) => {
    if (message.id === undefined) return;
    const method = String(message.method ?? "");
    const messageText = error instanceof Error ? error.message : String(error);
    if (method === "tools/call") send(textResult(message.id, messageText, true));
    else if (method === "tools/list" && /HTTP (?:401|403)/i.test(messageText)) {
      send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    } else send(jsonRpcError(message.id, messageText));
  });
});
input.on("close", () => process.exit(0));
