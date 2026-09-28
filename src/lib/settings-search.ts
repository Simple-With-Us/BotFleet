import type { AppSettingsSection } from "@/state/store";

export interface SettingsSearchItem {
  id: string;
  sectionId: AppSettingsSection;
  title: string;
  subtitle: string;
  keywords: string[];
}

export const SETTINGS_SEARCH_ITEMS: SettingsSearchItem[] = [
  // --- General ---
  {
    id: "general:profile",
    sectionId: "general",
    title: "Profile",
    subtitle: "Shown in the sidebar. Saved as you go.",
    keywords: ["name", "email", "profile", "user", "display name", "identity", "account"],
  },
  {
    id: "general:skin",
    sectionId: "general",
    title: "Skin & Appearance",
    subtitle: "Applies instantly and is remembered on this machine. System Auto uses Midnight when this computer is dark, and Studio when it is light.",
    keywords: ["skin", "theme", "appearance", "dark mode", "light mode", "midnight", "studio", "terminal", "system auto", "color", "styling"],
  },
  {
    id: "general:conversationMode",
    sectionId: "general",
    title: "Workspace Layout",
    subtitle: "Simple is Grok-style: named bots with one conversation each, plus group threads. Projects hide named bots and treat the room word as a category that any number of threads can sit under.",
    keywords: ["workspace layout", "conversation mode", "simple", "projects", "threads", "categories", "merge extra threads", "layout", "mode"],
  },
  {
    id: "general:terminology",
    sectionId: "general",
    title: "Terminology",
    subtitle: "Choose what you prefer to call multi-bot shared spaces across the app. It applies on this computer and on your phone.",
    keywords: ["terminology", "rooms", "channels", "chats", "projects", "spaces", "custom", "singular", "plural", "naming", "vocabulary"],
  },
  {
    id: "general:roomTurnTimeout",
    sectionId: "general",
    title: "Channel Turns",
    subtitle: "Set one maximum duration for every bot turn in a channel.",
    keywords: ["channel turns", "turn duration", "timeout", "turn timeout", "time limit", "max duration", "seconds", "minutes", "budget", "limit"],
  },
  {
    id: "general:toolCalls",
    sectionId: "general",
    title: "Tool Calls & Tasks",
    subtitle: "Configure how tool executions and background tasks are displayed in the transcript.",
    keywords: ["tool calls", "tasks", "show tool calls", "summarize bot tasks", "chips", "bash", "search", "tools", "execution", "expandable summary"],
  },
  {
    id: "general:experimentalFeatures",
    sectionId: "general",
    title: "Experimental Features",
    subtitle: "Early features may change while we test them. They stay off unless you enable them.",
    keywords: ["experimental features", "teach a skill", "workflow recorder", "recorder", "teach", "skills", "experimental"],
  },
  {
    id: "general:updates",
    sectionId: "general",
    title: "Updates",
    subtitle: "Check for updates, install updates, and automatic update checks.",
    keywords: ["updates", "check for updates", "install update", "auto update", "version", "feed", "commits", "updater", "upgrade", "download"],
  },
  {
    id: "general:updateNotifications",
    sectionId: "general",
    title: "Update Notifications",
    subtitle: "Show a small popup when a new version of BotFleet is available to download.",
    keywords: ["update notifications", "notifications", "popup", "banner", "alert", "update prompt"],
  },
  {
    id: "general:diagnostics",
    sectionId: "general",
    title: "Diagnostics",
    subtitle: "Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it.",
    keywords: ["diagnostics", "export diagnostics", "logs", "log tail", "debug", "troubleshooting", "system report", "versions"],
  },
  {
    id: "general:analytics",
    sectionId: "general",
    title: "Usage Analytics",
    subtitle: "Anonymous product events — app opened, which features get used. Never conversations, prompts, file contents, or bot output.",
    keywords: ["usage analytics", "analytics", "telemetry", "privacy", "tracking", "product events"],
  },

  // --- Connections ---
  {
    id: "connections:composioManaged",
    sectionId: "connections",
    title: "Connected Apps",
    subtitle: "Connected apps use a connected-apps service when one is configured, or your own Composio project key.",
    keywords: ["connected apps", "composio", "integrations", "oauth", "managed setup", "tools", "services"],
  },
  {
    id: "connections:transcription",
    sectionId: "connections",
    title: "Transcription & Voice",
    subtitle: "Audio transcription settings for voice input, local Whisper, or cloud models.",
    keywords: ["transcription", "voice", "whisper", "speech", "speech to text", "stt", "audio", "microphone", "mic", "groq", "openai whisper"],
  },
  {
    id: "connections:apiKeys",
    sectionId: "connections",
    title: "API Keys",
    subtitle: "Service API keys for Box, OpenCode Go, DeepSeek, MiniMax, and OpenAI Compatible providers.",
    keywords: ["api keys", "keys", "box", "opencode go", "deepseek", "minimax", "openai compatible", "custom api", "credentials", "tokens", "tts", "voice synthesis"],
  },
  {
    id: "connections:qdrant",
    sectionId: "connections",
    title: "Bot RAG & Shared Memory",
    subtitle: "Connect Qdrant vector database for bot memory and semantic search.",
    keywords: ["qdrant", "rag", "vector", "database", "semantic search", "embeddings", "shared memory", "collection", "host", "port"],
  },
  {
    id: "connections:customIngress",
    sectionId: "connections",
    title: "Custom Webhook Domain / Ingress",
    subtitle: "Configure Cloudflare Tunnel public URL or TryCloudflare temporary pairing URL for incoming webhooks.",
    keywords: ["custom webhook domain", "ingress", "cloudflare tunnel", "public url", "trycloudflare", "free url", "webhook receiver", "domain", "tunnel"],
  },
  {
    id: "connections:selfHostComposio",
    sectionId: "connections",
    title: "Self-Host Connected Apps",
    subtitle: "Enter your own Composio project key for self-hosted connected apps.",
    keywords: ["self-host connected apps", "composio key", "project key", "custom composio"],
  },
  {
    id: "connections:linq",
    sectionId: "connections",
    title: "Linq Settings",
    subtitle: "Connect Linq for SMS bot interactions, phone numbers, and messaging routes.",
    keywords: ["linq", "sms", "text messaging", "phone numbers", "bot routing", "webhooks"],
  },

  // --- Remote Access ---
  {
    id: "remote:access",
    sectionId: "remote",
    title: "Remote Access",
    subtitle: "Reach BotFleet from the Companion phone app or route incoming webhooks when away from your desk.",
    keywords: ["remote access", "remote url", "public url", "ingress", "tunnel", "reachability", "test connection", "health check", "cloudflare", "companion"],
  },

  // --- Engines ---
  {
    id: "engines:clis",
    sectionId: "engines",
    title: "Engine CLIs",
    subtitle: "Which binary each engine runs. Detect installed command-line apps or specify custom paths.",
    keywords: ["engine clis", "engines", "cli", "binary", "executables", "claude cli", "codex cli", "grok cli", "minimax cli", "custom engine", "providers", "path override"],
  },
  {
    id: "engines:matrix",
    sectionId: "engines",
    title: "Engine Capabilities Matrix",
    subtitle: "Overview of files, terminal, computer use, web access, long context, and coordination per engine.",
    keywords: ["capabilities matrix", "engine capabilities", "features", "terminal", "files", "web access", "coordination", "matrix", "models comparison"],
  },

  // --- Models ---
  {
    id: "models:fleet",
    sectionId: "models",
    title: "Fleet Models",
    subtitle: "Every bot's model choices on one screen. Set workspace primary default and fallback chains.",
    keywords: ["fleet models", "models", "fallback", "primary model", "default model", "per bot", "chain", "sonnet", "gpt-4o", "gemini", "deepseek", "opus", "claude", "grok", "minimax"],
  },

  // --- Phone / Companion ---
  {
    id: "companion:pairing",
    sectionId: "companion",
    title: "Companion Phone App",
    subtitle: "Pair your iPhone with BotFleet via QR code, local token, or mobile gateway.",
    keywords: ["phone", "companion", "iphone", "ios", "qr code", "mobile", "pairing token", "gateway", "sidecar", "push notifications", "notifications"],
  },

  // --- Computers ---
  {
    id: "computers:providers",
    sectionId: "computers",
    title: "Computer Providers",
    subtitle: "Choose which computer providers this workspace allows (ASCII.dev Box, Self-Hosted VPS, Local VM, This Computer).",
    keywords: ["computer providers", "ascii box", "self-hosted vps", "local vm", "this computer", "mac", "permissions", "host control", "desktop control"],
  },
  {
    id: "computers:matrix",
    sectionId: "computers",
    title: "Bot Computer Grants",
    subtitle: "Which providers every bot in this workspace has. Matrix of bot computer access.",
    keywords: ["bot computer grants", "bots", "matrix", "grants", "apply to all", "permissions", "computer matrix"],
  },
  {
    id: "computers:localVm",
    sectionId: "computers",
    title: "Local VM Runtime",
    subtitle: "Local Cua Linux container sandbox (OrbStack, Docker, Podman). Download Cua Desktop, start VM, configure durable storage.",
    keywords: ["local vm", "sandbox", "orbstack", "docker", "podman", "cua desktop", "container runtime", "safety and storage", "limits", "shared vm"],
  },
  {
    id: "computers:sharedVpsVm",
    sectionId: "computers",
    title: "Shared VPS VM",
    subtitle: "The shared Cua Linux sandbox running on your VPS. Bots take turns using it one at a time.",
    keywords: ["shared vps vm", "vps sandbox", "shared vps", "remote sandbox", "vps container", "linux sandbox", "shared container"],
  },
  {
    id: "computers:vpsConnection",
    sectionId: "computers",
    title: "VPS Connection (SSH)",
    subtitle: "Configure SSH host, username, port, and key for your Self-hosted VPS.",
    keywords: ["vps connection", "ssh", "ssh access", "host", "port", "ssh key", "username", "self-hosted vps", "remote server"],
  },
  {
    id: "computers:defaults",
    sectionId: "computers",
    title: "New Bots Computer Defaults",
    subtitle: "Legacy defaults for newly created bots.",
    keywords: ["defaults", "legacy", "new bots", "allowed computers"],
  },

  // --- Usage ---
  {
    id: "usage:summary",
    sectionId: "usage",
    title: "Usage & Token Spend",
    subtitle: "Cumulative token usage, cost per model, and token totals across sessions.",
    keywords: ["usage", "tokens", "cost", "billing", "input tokens", "output tokens", "cache", "spend", "session usage", "by model"],
  },
  {
    id: "usage:pricing",
    sectionId: "usage",
    title: "Pricing Mode by Engine",
    subtitle: "What you pay on each engine. Select your plan, auto-detect from CodeCaps or Usage Monitor, or enter custom monthly costs.",
    keywords: ["pricing mode", "subscription", "plans", "codecaps", "usage monitor", "monthly cost", "per 1k", "rates", "auto-detect"],
  },
  {
    id: "usage:quotas",
    sectionId: "usage",
    title: "Subscription Quota & Windows",
    subtitle: "Live subscription quota windows read from CodeCaps / Usage Monitor.",
    keywords: ["quota", "codecaps", "windows", "5-hour limit", "weekly limit", "reset time", "remaining percent", "status"],
  },

  // --- Observability ---
  {
    id: "observability:sentry",
    sectionId: "observability",
    title: "Observability & Sentry",
    subtitle: "Error monitoring, Sentry DSN, telemetry status, test error event emission.",
    keywords: ["observability", "sentry", "errors", "crashes", "dsn", "diagnostics", "telemetry", "test event"],
  },
  {
    id: "observability:traces",
    sectionId: "observability",
    title: "Trace Sampling Rates",
    subtitle: "Separate sampling rates for AI operations, HTTP server requests, and UI interactions.",
    keywords: ["traces", "sampling", "ai traces", "http traces", "ui traces", "spans", "sample rate"],
  },
  {
    id: "observability:logs",
    sectionId: "observability",
    title: "Server Logs & Diagnostics",
    subtitle: "Log forwarding, error reporting, and system health status.",
    keywords: ["logs", "server logs", "system health", "diagnostics logs"],
  },

  // --- Secrets ---
  {
    id: "secrets:infisical",
    sectionId: "secrets",
    title: "Infisical Secrets Vault",
    subtitle: "Manage centralized secret keys, Infisical Client ID, Secret, Project ID, and sync status.",
    keywords: ["secrets", "infisical", "vault", "client id", "client secret", "project id", "credentials", "sync", "provenance"],
  },
];

export interface SettingsSearchResult {
  matchingSectionIds: Set<AppSettingsSection>;
  matchingItemIds: Set<string>;
  matchCountBySection: Record<AppSettingsSection, number>;
  totalMatches: number;
}

/**
 * Searches all settings items (subheadings, descriptions, options, and keywords).
 * If query is empty, returns all sections and all items as matching.
 */
export function searchSettings(rawQuery: string): SettingsSearchResult {
  const query = rawQuery.trim().toLowerCase();
  const allSections: AppSettingsSection[] = [
    "general",
    "connections",
    "remote",
    "engines",
    "models",
    "companion",
    "computers",
    "usage",
    "observability",
    "secrets",
  ];

  const matchingSectionIds = new Set<AppSettingsSection>();
  const matchingItemIds = new Set<string>();
  const matchCountBySection = allSections.reduce<Record<AppSettingsSection, number>>((acc, sec) => {
    acc[sec] = 0;
    return acc;
  }, {} as Record<AppSettingsSection, number>);

  if (!query) {
    for (const sec of allSections) matchingSectionIds.add(sec);
    for (const item of SETTINGS_SEARCH_ITEMS) matchingItemIds.add(item.id);
    return {
      matchingSectionIds,
      matchingItemIds,
      matchCountBySection,
      totalMatches: SETTINGS_SEARCH_ITEMS.length,
    };
  }

  // Tokenize query words so multi-word search works nicely
  const queryWords = query.split(/\s+/).filter(Boolean);

  for (const item of SETTINGS_SEARCH_ITEMS) {
    const titleLower = item.title.toLowerCase();
    const subtitleLower = item.subtitle.toLowerCase();
    const keywordsLower = item.keywords.map((k) => k.toLowerCase());

    const matches = queryWords.every((word) =>
      titleLower.includes(word) ||
      subtitleLower.includes(word) ||
      keywordsLower.some((k) => k.includes(word)),
    );

    if (matches) {
      matchingItemIds.add(item.id);
      matchingSectionIds.add(item.sectionId);
      matchCountBySection[item.sectionId] = (matchCountBySection[item.sectionId] ?? 0) + 1;
    }
  }

  return {
    matchingSectionIds,
    matchingItemIds,
    matchCountBySection,
    totalMatches: matchingItemIds.size,
  };
}
