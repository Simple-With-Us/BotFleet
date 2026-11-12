// Bot RAG & recall MCP proxy — spawned as an MCP server inside bot processes
// (via the "qdrant" integration). Connects BotFleet bots to whatever shared
// vector memory service the operator configures (lessons, preferences,
// infrastructure runbooks, and decisions). There is no built-in endpoint and
// no built-in collection: unconfigured means the tools report that and do
// nothing. Exposes canonical recall tools and backward-compatible aliases:
//
//   recall_search(query, limit?, category?, app?, source?, seat?, since_days?, per_doc?)
//   recall_contribute(text, category, app?, seat?, title?, url?, force?)
//   recall_stats()
//   qdrant_search(query, limit?, collection?, filter?)
//   qdrant_store(text, title?, metadata?, collection?)
//   qdrant_get_context(topic, limit?)
//   qdrant_list_collections()
//
// Speaks raw JSON-RPC 2.0 over stdio matching BotFleet proxy conventions.
import readline from "node:readline";
import type { RecallSettings } from "../recall-transport.ts";
import { recallContributeWith, recallSearchWith, recallStatsWith } from "../recall-tools.ts";
import { redactSecretsInText } from "../redact.ts";

// No default endpoint ships with BotFleet: the operator points this at their
// own service in Settings (or via env), and an empty value means "off".
const RECALL_SETTINGS: RecallSettings = {
  url: (
    process.env.OMB_RECALL_URL ||
    process.env.RECALL_URL ||
    process.env.OMB_QDRANT_URL ||
    process.env.QDRANT_URL ||
    ""
  ).trim().replace(/\/+$/, ""),
  apiKey:
    process.env.OMB_RECALL_API_KEY ||
    process.env.RECALL_API_KEY ||
    process.env.OMB_QDRANT_API_KEY ||
    process.env.QDRANT_API_KEY ||
    "",
  collection: (
    process.env.OMB_RECALL_COLLECTION ||
    process.env.RECALL_COLLECTION ||
    process.env.OMB_QDRANT_COLLECTION ||
    process.env.QDRANT_COLLECTION ||
    ""
  ).trim(),
  // A Cloudflare Access service token, when the operator's recall service is
  // published behind Access.  Access ignores a bearer credential outright, so
  // without this pair every request to such a host comes back as a redirect
  // to a login page — which reads like an outage.  Sent ALONGSIDE the
  // bearer, not instead of it: a deployment may gate at the edge, the
  // origin, or both.
  accessClientId: (
    process.env.OMB_RECALL_ACCESS_CLIENT_ID ||
    process.env.OMB_QDRANT_ACCESS_CLIENT_ID ||
    process.env.CF_ACCESS_CLIENT_ID ||
    ""
  ),
  accessClientSecret: (
    process.env.OMB_RECALL_ACCESS_CLIENT_SECRET ||
    process.env.OMB_QDRANT_ACCESS_CLIENT_SECRET ||
    process.env.CF_ACCESS_CLIENT_SECRET ||
    ""
  ),
};

export const NOT_CONFIGURED_MESSAGE =
  "Bot RAG is not configured — set a Service URL in Settings";

const BOT_NAME = process.env.OMB_BOT_NAME || "Bot";
const AGENT_SEAT = process.env.AGENT_SEAT || BOT_NAME.toUpperCase();
const DEFAULT_SEAT = BOT_NAME || AGENT_SEAT;

const TOOLS = [
  {
    name: "recall_search",
    description:
      "Search the configured shared knowledge corpus (lessons, preferences, infrastructure facts, decisions, runbooks, and notes). Hybrid dense + keyword search with cross-encoder reranking.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural-language question, topic, or search keywords" },
        limit: { type: "number", description: "Maximum number of relevant results to return (default: 5, max: 20)" },
        category: {
          type: "string",
          enum: ["lesson", "preference", "infrastructure", "decision", "runbook", "note", "finding", "doc"],
          description: "Restrict results to one category",
        },
        app: { type: "string", description: "Filter by lowercase app slug (e.g. botfleet, docs, research)" },
        source: {
          type: "string",
          enum: ["board", "effort-log", "apple-note", "doc", "skill", "memory", "agent-contribution"],
          description: "Filter by document source",
        },
        seat: { type: "string", description: "Filter by author seat tag (the bot or agent that wrote it)" },
        since_days: { type: "number", description: "Only return content created in the last N days" },
        per_doc: { type: "number", description: "Best N chunks to return per document (default: 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "recall_contribute",
    description:
      "Store a reusable piece of knowledge, lesson learned, preference, infrastructure fact, or runbook into the configured shared memory corpus so other bots and seats can retrieve it.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The content or lesson to contribute (40 to 4000 characters)" },
        category: {
          type: "string",
          enum: ["lesson", "preference", "infrastructure", "decision", "runbook"],
          description: "The knowledge category",
        },
        app: { type: "string", description: "Target app slug (default: botfleet)" },
        seat: { type: "string", description: "Author seat or bot identifier (defaults to this bot's name)" },
        title: { type: "string", description: "Optional title or concise summary" },
        url: { type: "string", description: "Optional source link (PR, board item, commit, or doc URL)" },
        force: { type: "boolean", description: "Store even if a near-duplicate contribution already exists" },
      },
      required: ["text", "category"],
    },
  },
  {
    name: "recall_stats",
    description: "Check the health, status, and point counts of the configured shared memory corpus.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  // Backward-compatible aliases for existing prompts and tests:
  {
    name: "qdrant_search",
    description: "Search the configured shared vector database and knowledge base for relevant documents or memories.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        limit: { type: "number", description: "Maximum results (default: 5)" },
        collection: { type: "string", description: "Target collection (defaults to the configured collection)" },
        filter: { type: "object", description: "Optional metadata filters" },
      },
      required: ["query"],
    },
  },
  {
    name: "qdrant_store",
    description: "Store a new document, note, or lesson in the configured shared vector database.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content to store" },
        title: { type: "string", description: "Optional title" },
        metadata: { type: "object", description: "Optional metadata" },
        collection: { type: "string", description: "Target collection (defaults to the configured collection)" },
      },
      required: ["text"],
    },
  },
  {
    name: "qdrant_get_context",
    description: "Retrieve synthesized context and prior learnings on a specific topic from shared memory.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", description: "The topic or question to gather context about" },
        limit: { type: "number", description: "Max memories to include (default: 5)" },
      },
      required: ["topic"],
    },
  },
  {
    name: "qdrant_list_collections",
    description: "List the status of the configured shared vector database and collections.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function recallSearch(args: Record<string, unknown>): Promise<string> {
  return (await recallSearchWith(RECALL_SETTINGS, args)).text;
}

async function recallContribute(args: Record<string, unknown>): Promise<string> {
  return (await recallContributeWith(RECALL_SETTINGS, DEFAULT_SEAT, args)).text;
}

async function recallStats(): Promise<string> {
  return (await recallStatsWith(RECALL_SETTINGS)).text;
}

async function handleToolCall(name: string, args: Record<string, unknown>): Promise<string> {
  if (args.collection && String(args.collection) !== RECALL_SETTINGS.collection) {
    return "Bot RAG cannot select a different collection for one call; select the service and collection in Settings.";
  }
  switch (name) {
    case "recall_search":
    case "qdrant_search":
      return recallSearch(args);

    case "recall_contribute":
      return recallContribute(args);

    case "qdrant_store": {
      const metadata = args.metadata && typeof args.metadata === "object" ? (args.metadata as Record<string, unknown>) : {};
      const category = (metadata.category as string) || "lesson";
      const app = (metadata.app as string) || "botfleet";
      return recallContribute({
        text: args.text,
        title: args.title,
        category,
        app,
      });
    }

    case "qdrant_get_context": {
      const topic = String(args.topic || "").trim();
      return recallSearch({ query: topic, limit: args.limit || 5 });
    }

    case "recall_stats":
    case "qdrant_list_collections":
      return recallStats();

    default:
      return `Unknown tool: ${name}`;
  }
}

// ── JSON-RPC Stdio Loop ────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(msg: Record<string, unknown>) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function ok(id: unknown, result: unknown) {
  send({ jsonrpc: "2.0", id, result });
}

function error(id: unknown, code: number, message: string) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let parsed: any;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = parsed;

  if (method === "initialize") {
    return ok(id, {
      protocolVersion: String(params?.protocolVersion ?? "2024-11-05"),
      capabilities: { tools: {} },
      serverInfo: { name: "botfleet-qdrant-rag", version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "tools/list") {
    return ok(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = (params?.arguments && typeof params.arguments === "object") ? params.arguments : {};
    try {
      const output = await handleToolCall(name, args);
      return ok(id, {
        content: [{ type: "text", text: output }],
      });
    } catch (err) {
      const message = redactSecretsInText(err instanceof Error ? err.message : String(err)).slice(0, 400);
      return ok(id, {
        content: [{ type: "text", text: `Tool error: ${message}` }],
        isError: true,
      });
    }
  }

  if (method === "ping") {
    return ok(id, {});
  }

  if (id !== undefined) {
    return error(id, -32601, `Method not found: ${method}`);
  }
});
