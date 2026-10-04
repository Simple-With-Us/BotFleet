import type { AppSettingsSection } from "@/state/store";

export interface SettingsSearchItem {
  id: string;
  sectionId: AppSettingsSection;
  sectionLabel: string;
  title: string;
  subtitle: string;
  keywords: string[];
  domId: string;
  badge?: string;
}

export const SETTINGS_SEARCH_ITEMS: SettingsSearchItem[] = [
  // --- General ---
  {
    id: "general:profile",
    sectionId: "general",
    sectionLabel: "General",
    title: "Profile",
    subtitle: "Shown in the sidebar. Saved as you go.",
    keywords: ["name", "email", "profile", "user", "display name", "identity", "account"],
    domId: "setting-general-profile",
    badge: "Account",
  },
  {
    id: "general:skin",
    sectionId: "general",
    sectionLabel: "General",
    title: "Skin",
    subtitle: "Applies instantly and is remembered on this machine.  System Auto uses Midnight when this computer is dark, and Studio when it is light.",
    keywords: ["skin", "appearance", "theme", "dark mode", "light mode", "midnight", "studio", "terminal", "system auto", "color", "styling"],
    domId: "setting-general-skin",
    badge: "Appearance",
  },
  {
    id: "general:conversationMode",
    sectionId: "general",
    sectionLabel: "General",
    title: "Workspace Arrangement",
    subtitle: "Simple is Grok-style: named bots with one conversation each, plus group threads.  Projects hide named bots and treat the room word as a category that any number of threads can sit under.",
    keywords: ["workspace arrangement", "arrangement", "workspace layout", "conversation mode", "simple", "projects", "threads", "categories", "merge extra threads", "layout", "mode"],
    domId: "setting-general-conversation-mode",
    badge: "Layout",
  },
  {
    id: "general:terminology",
    sectionId: "general",
    sectionLabel: "General",
    title: "Terminology",
    subtitle: "Choose what you prefer to call multi-bot shared spaces across the app. It applies on this computer and on your phone.",
    keywords: ["terminology", "rooms", "channels", "chats", "projects", "spaces", "custom", "singular", "plural", "naming", "vocabulary"],
    domId: "setting-general-terminology",
    badge: "Preferences",
  },
  {
    id: "general:roomTurnTimeout",
    sectionId: "general",
    sectionLabel: "General",
    title: "Channel Turns",
    subtitle: "Set one maximum duration for every bot turn in a channel.",
    keywords: ["channel turns", "turn duration", "timeout", "turn timeout", "time limit", "max duration", "seconds", "minutes", "budget", "limit"],
    domId: "setting-general-room-turn-timeout",
    badge: "Execution",
  },
  {
    id: "general:toolCalls",
    sectionId: "general",
    sectionLabel: "General",
    title: "Tool Calls & Tasks",
    subtitle: "Configure how tool executions and background tasks are displayed in the transcript.",
    keywords: ["tool calls", "tasks", "show tool calls", "summarize bot tasks", "chips", "bash", "search", "tools", "execution", "expandable summary"],
    domId: "setting-general-tool-calls",
    badge: "Display",
  },
  {
    id: "general:experimentalFeatures",
    sectionId: "general",
    sectionLabel: "General",
    title: "Experimental Features",
    subtitle: "Early features may change while we test them. They stay off unless you enable them.",
    keywords: ["experimental features", "teach a skill", "workflow recorder", "recorder", "teach", "skills", "experimental"],
    domId: "setting-general-experimental",
    badge: "Beta",
  },
  {
    id: "general:updates",
    sectionId: "general",
    sectionLabel: "General",
    title: "Updates",
    subtitle: "Check for updates, install updates, and automatic update checks.",
    keywords: ["updates", "check for updates", "install update", "auto update", "version", "feed", "commits", "updater", "upgrade", "download"],
    domId: "setting-general-updates",
    badge: "System",
  },
  {
    id: "general:updateNotifications",
    sectionId: "general",
    sectionLabel: "General",
    title: "Update Notifications",
    subtitle: "Show a small popup when a new version of BotFleet is available to download.",
    keywords: ["update notifications", "notifications", "popup", "banner", "alert", "update prompt"],
    domId: "setting-general-update-notifications",
    badge: "Notifications",
  },
  {
    id: "general:diagnostics",
    sectionId: "general",
    sectionLabel: "General",
    title: "Diagnostics",
    subtitle: "Versions, configuration on/off state and a redacted server log tail. Review the file before sharing it.",
    keywords: ["diagnostics", "export diagnostics", "logs", "log tail", "debug", "troubleshooting", "system report", "versions"],
    domId: "setting-general-diagnostics",
    badge: "System",
  },
  {
    id: "general:analytics",
    sectionId: "general",
    sectionLabel: "General",
    title: "Usage Analytics",
    subtitle: "Anonymous product events — app opened, which features get used. Never conversations, prompts, file contents, or bot output.",
    keywords: ["usage analytics", "analytics", "telemetry", "privacy", "tracking", "product events"],
    domId: "setting-general-analytics",
    badge: "Privacy",
  },

  // --- Connections ---
  {
    id: "connections:composioManaged",
    sectionId: "connections",
    sectionLabel: "Connections",
    title: "Connections",
    subtitle: "Connected apps use a connected-apps service via Composio when one is configured, or your own Composio project key.",
    keywords: ["connected apps via composio", "connected apps", "composio", "integrations", "oauth", "managed setup", "tools", "services"],
    domId: "setting-connections-composio",
    badge: "Integrations",
  },
  {
    id: "connections:transcription",
    sectionId: "connections",
    sectionLabel: "Connections",
    title: "Transcription & Voice",
    subtitle: "Audio transcription settings for voice input, local Whisper, or cloud models.",
    keywords: ["transcription", "voice", "whisper", "speech", "speech to text", "stt", "audio", "microphone", "mic", "groq", "openai whisper"],
    domId: "setting-connections-transcription",
    badge: "Voice",
  },
  {
    id: "connections:apiKeys",
    sectionId: "connections",
    sectionLabel: "Connections",
    title: "API Keys",
    subtitle: "Manage the keys your connected engines and services need.",
    keywords: ["api keys", "keys", "box", "opencode go", "deepseek", "minimax", "openai compatible", "custom api", "credentials", "tokens", "tts", "voice synthesis"],
    domId: "setting-connections-api-keys",
    badge: "API Keys",
  },
  {
    id: "connections:qdrant",
    sectionId: "connections",
    sectionLabel: "Connections",
    title: "Bot RAG & Shared Memory",
    subtitle: "Connect shared memory so bots can find relevant information.",
    keywords: ["qdrant", "rag", "vector", "database", "semantic search", "embeddings", "shared memory", "collection", "host", "port"],
    domId: "setting-connections-qdrant",
    badge: "Memory",
  },
  {
    id: "connections:customIngress",
    sectionId: "connections",
    sectionLabel: "Connections",
    title: "Custom Webhook Domain / Ingress",
    subtitle: "Choose a public address for incoming webhooks.",
    keywords: ["custom webhook domain", "ingress", "cloudflare tunnel", "public url", "trycloudflare", "free url", "webhook receiver", "domain", "tunnel"],
    domId: "setting-connections-ingress",
    badge: "Networking",
  },
  {
    id: "connections:selfHostComposio",
    sectionId: "connections",
    sectionLabel: "Connections",
    title: "Self-Host Connected Apps via Composio",
    subtitle: "Enter your own Composio project key for self-hosted connected apps.",
    keywords: ["self-host connected apps via composio", "self-host connected apps", "composio key", "project key", "custom composio"],
    domId: "setting-connections-selfhost-composio",
    badge: "Integrations",
  },
  {
    id: "connections:linq",
    sectionId: "connections",
    sectionLabel: "Connections",
    title: "Linq Settings",
    subtitle: "Connect Linq for SMS bot interactions, phone numbers, and messaging routes.",
    keywords: ["linq", "sms", "text messaging", "phone numbers", "bot routing", "webhooks"],
    domId: "setting-connections-linq",
    badge: "SMS",
  },

  // --- Remote Access ---
  {
    id: "remote:access",
    sectionId: "remote",
    sectionLabel: "Remote",
    title: "Remote Access",
    subtitle: "Open BotFleet on this Mac from another computer through your tunnel, and check that its address is reachable.",
    keywords: ["remote", "remote access", "remote url", "public url", "ingress", "tunnel", "reachability", "test connection", "health check", "cloudflare", "browser", "other computer"],
    domId: "setting-remote-access",
    badge: "Networking",
  },

  // --- Engines ---
  {
    id: "engines:clis",
    sectionId: "engines",
    sectionLabel: "Engines",
    title: "Engine CLIs",
    subtitle: "Choose the command-line app each engine runs or set a custom path.",
    keywords: ["engine clis", "engines", "cli", "binary", "executables", "claude cli", "codex cli", "grok cli", "minimax cli", "mcode cli", "mcode", "minimax code", "ascii.dev box", "box engine", "box.ascii.dev", "custom engine", "providers", "path override", "bypass permissions", "full auto"],
    domId: "setting-engines-clis",
    badge: "Engines",
  },
  {
    id: "engines:matrix",
    sectionId: "engines",
    sectionLabel: "Engines",
    title: "Engine Capabilities",
    subtitle: "Detailed comparison of files, terminal, computer use, web access, long context, and coordination per engine.",
    keywords: ["capabilities matrix", "engine capabilities", "features", "terminal", "files", "web access", "coordination", "matrix", "models comparison", "mcode", "minimax code", "computer use", "vision", "permissions"],
    domId: "setting-engines-matrix",
    badge: "Engines",
  },
  {
    id: "engines:addCustom",
    sectionId: "engines",
    sectionLabel: "Engines",
    title: "Add Engine",
    subtitle: "Connect an additional AI engine or local runner to BotFleet.",
    keywords: ["add engine", "custom engine", "acp driver", "custom cli", "new engine", "driver kind", "commandline", "local models", "local model", "ollama", "lm studio", "omlx", "local endpoint"],
    domId: "setting-engines-add-custom",
    badge: "Engines",
  },

  // --- Models ---
  {
    id: "models:fleet",
    sectionId: "models",
    sectionLabel: "Models",
    title: "Models",
    subtitle: "Every bot's model choices on one screen. Set workspace primary default and fallback chains.",
    keywords: ["fleet models", "models", "fallback", "primary model", "default model", "per bot", "chain", "sonnet", "gpt-4o", "gemini", "deepseek", "opus", "claude", "grok", "minimax", "mcode", "vision fallback"],
    domId: "setting-models-fleet",
    badge: "Models",
  },

  // --- Phone / Companion ---
  {
    id: "companion:pairing",
    sectionId: "companion",
    sectionLabel: "Phone",
    title: "Phone",
    subtitle: "Pair your phone with BotFleet to stay in touch on the go.",
    keywords: ["phone", "companion", "iphone", "ios", "qr code", "mobile", "pairing token", "gateway", "sidecar", "push notifications", "notifications"],
    domId: "setting-companion-pairing",
    badge: "Mobile",
  },

  // --- Computers ---
  {
    id: "computers:providers",
    sectionId: "computers",
    sectionLabel: "Computers",
    title: "Providers",
    subtitle: "The computer providers any bot in this workspace is allowed to use.  Disabling a provider here keeps every bot off it, no matter what a bot's own settings say.",
    keywords: ["providers", "computer providers", "ascii box", "self-hosted vps", "local vm", "this computer", "mac", "permissions", "host control", "desktop control", "sandboxes"],
    domId: "setting-computers-providers",
    badge: "Computers",
  },
  {
    id: "computers:matrix",
    sectionId: "computers",
    sectionLabel: "Computers",
    title: "Bots",
    subtitle: "Which providers every bot in this workspace has.  Per-bot edits live in each bot's settings; the matrix is the master view.",
    keywords: ["bots", "bot computer grants", "matrix", "grants", "apply to all", "permissions", "computer matrix"],
    domId: "setting-computers-matrix",
    badge: "Computers",
  },
  {
    id: "computers:localVm",
    sectionId: "computers",
    sectionLabel: "Computers",
    title: "Local VM",
    subtitle: "A shared or per-bot Cua Linux container sandbox on this computer for bots to browse and work in.",
    keywords: ["local vm", "runtime", "sandbox", "orbstack", "docker", "podman", "cua desktop", "container runtime", "safety and storage", "limits", "shared vm"],
    domId: "setting-computers-local-vm",
    badge: "Sandbox",
  },
  {
    id: "computers:sharedVpsVm",
    sectionId: "computers",
    sectionLabel: "Computers",
    title: "Shared VPS VM",
    subtitle: "The shared Cua Linux sandbox running on your VPS. Bots take turns using it one at a time.",
    keywords: ["shared vps vm", "vps sandbox", "shared vps", "remote sandbox", "vps container", "linux sandbox", "shared container", "tigervnc", "display"],
    domId: "setting-computers-shared-vps",
    badge: "Sandbox",
  },
  {
    id: "computers:cliCredentials",
    sectionId: "computers",
    sectionLabel: "Computers",
    title: "Host & CLI Integration",
    subtitle: "Manage CLI authentication and terminal access for bots using the Local VM.",
    keywords: ["host & cli integration", "host cli credentials", "credentials sync", "sync cli", "developer logins", "infisical", "ssh", "gitconfig", "docker config", "vps credentials", "vm credentials", "sandboxes", ".infisical", ".ssh", ".aws", ".gcloud", ".docker"],
    domId: "setting-computers-cli-credentials",
    badge: "Security",
  },
  {
    id: "computers:vpsConnection",
    sectionId: "computers",
    sectionLabel: "Computers",
    title: "VPS Connection",
    subtitle: "Configure SSH access for your Self-hosted VPS.",
    keywords: ["vps connection", "ssh", "ssh access", "host", "port", "ssh key", "username", "self-hosted vps", "remote server"],
    domId: "setting-computers-vps-connection",
    badge: "SSH",
  },
  {
    id: "computers:defaults",
    sectionId: "computers",
    sectionLabel: "Computers",
    title: "Default Bot Settings",
    subtitle: "Legacy defaults for newly created bots.",
    keywords: ["defaults", "legacy", "new bots", "allowed computers"],
    domId: "setting-computers-defaults",
    badge: "Computers",
  },

  // --- Usage ---
  {
    id: "usage:summary",
    sectionId: "usage",
    sectionLabel: "Usage",
    title: "Usage",
    subtitle: "Tokens and cost per bot, added up from every settled turn.  Click a bot to expand its sessions and see model, tokens in/out, $/turn, and the per-session cumulative.",
    keywords: ["usage", "token spend", "tokens", "cost", "billing", "input tokens", "output tokens", "cache", "spend", "session usage", "by model", "spend breakdown"],
    domId: "setting-usage-summary",
    badge: "Usage",
  },
  {
    id: "usage:speech",
    sectionId: "usage",
    sectionLabel: "Usage",
    title: "Speech Synthesis",
    subtitle: "Speech is measured in characters, not model tokens.  Counts include successful requests on this computer only.",
    keywords: ["speech synthesis", "characters", "voice generation", "audio requests", "tts usage", "minimax voice"],
    domId: "setting-usage-speech",
    badge: "Voice",
  },
  {
    id: "usage:pricing",
    sectionId: "usage",
    sectionLabel: "Usage",
    title: "Pricing Mode by Engine",
    subtitle: "What you actually pay on each engine.  Select your plan or enter a custom monthly cost so the estimate below matches what you pay.",
    keywords: ["pricing mode", "subscription", "plans", "codecaps", "usage monitor", "monthly cost", "per 1k", "rates", "auto-detect", "token plan"],
    domId: "setting-usage-pricing",
    badge: "Pricing",
  },
  {
    id: "usage:quotas",
    sectionId: "usage",
    sectionLabel: "Usage",
    title: "Engine Quotas",
    subtitle: "Live remaining usage for each engine.  Hover or click a row for the full remaining breakdown.",
    keywords: ["engine quotas", "subscription quota", "quota windows", "quota", "codecaps", "windows", "5-hour limit", "weekly limit", "reset time", "remaining percent", "status", "usage monitor"],
    domId: "setting-usage-quotas",
    badge: "Quotas",
  },
  {
    id: "usage:projection",
    sectionId: "usage",
    sectionLabel: "Usage",
    title: "API vs Subscription — What Your Workload Would Have Cost on PAYG",
    subtitle: "Compare estimated pay-as-you-go API rates against your active subscription plans.",
    keywords: ["cost projection", "api vs subscription", "what-if projection", "token cost comparison", "savings", "estimate"],
    domId: "setting-usage-projection",
    badge: "Analysis",
  },
  {
    id: "usage:monitor",
    sectionId: "usage",
    sectionLabel: "Usage",
    title: "Usage Monitor & Central Accounting",
    subtitle: "An optional telemetry stream reporting token consumption classified by model, project, and repository to a usage monitor you run.",
    keywords: ["usage monitor", "central accounting", "telemetry stream", "token telemetry", "endpoint", "accounting"],
    domId: "setting-usage-monitor",
    badge: "Telemetry",
  },

  // --- Observability ---
  {
    id: "observability:sentry",
    sectionId: "observability",
    sectionLabel: "Observability",
    title: "Diagnostics & Error Reporting",
    subtitle: "An optional Sentry stream that reports failed bot turns, console warnings and errors, and performance traces so problems surface without you tailing a log.",
    keywords: ["observability", "sentry", "diagnostics", "error reporting", "errors", "crashes", "dsn", "telemetry", "test event"],
    domId: "setting-observability-sentry",
    badge: "Monitoring",
  },
  {
    id: "observability:traces",
    sectionId: "observability",
    sectionLabel: "Observability",
    title: "Trace Sampling Rates",
    subtitle: "Separate sampling rates for AI operations, HTTP server requests, and UI interactions.",
    keywords: ["traces", "sampling", "ai traces", "http traces", "ui traces", "spans", "sample rate", "distributed tracing"],
    domId: "setting-observability-traces",
    badge: "Tracing",
  },
  {
    id: "observability:logs",
    sectionId: "observability",
    sectionLabel: "Observability",
    title: "Forward warnings and errors",
    subtitle: "Choose whether to send warnings and errors for troubleshooting.",
    keywords: ["logs", "server logs", "system health", "diagnostics logs", "log forwarding"],
    domId: "setting-observability-logs",
    badge: "Logs",
  },

  // --- Secrets ---
  {
    id: "secrets:infisical",
    sectionId: "secrets",
    sectionLabel: "Secrets",
    title: "Secret Store",
    subtitle: "Connect and check your shared secrets vault.",
    keywords: ["secrets", "infisical", "vault", "client id", "client secret", "project id", "credentials", "sync", "provenance", "api keys"],
    domId: "setting-secrets-infisical",
    badge: "Vault",
  },
];

export interface TextSegment {
  text: string;
  matched: boolean;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function segmentMatchText(text: string, query: string): TextSegment[] {
  const q = query.trim();
  if (!q) return [{ text, matched: false }];
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [{ text, matched: false }];
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
  const parts = text.split(pattern);
  return parts
    .filter((p) => p.length > 0)
    .map((part) => ({
      text: part,
      matched: words.some((w) => part.toLowerCase() === w.toLowerCase()),
    }));
}

export function sectionBodyHasVisibleItem(
  sectionId: AppSettingsSection,
  matchingItemIds: ReadonlySet<string>,
): boolean {
  return SETTINGS_SEARCH_ITEMS.some(
    (item) => item.sectionId === sectionId && matchingItemIds.has(item.id),
  );
}

export interface SettingsSearchResult {
  matchingSectionIds: Set<AppSettingsSection>;
  matchingItemIds: Set<string>;
  matchingItems: SettingsSearchItem[];
  itemsBySection: Record<AppSettingsSection, SettingsSearchItem[]>;
  matchCountBySection: Record<AppSettingsSection, number>;
  totalMatches: number;
}

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

  const itemsBySection = allSections.reduce<Record<AppSettingsSection, SettingsSearchItem[]>>((acc, sec) => {
    acc[sec] = [];
    return acc;
  }, {} as Record<AppSettingsSection, SettingsSearchItem[]>);

  if (!query) {
    for (const sec of allSections) matchingSectionIds.add(sec);
    for (const item of SETTINGS_SEARCH_ITEMS) {
      matchingItemIds.add(item.id);
      itemsBySection[item.sectionId].push(item);
    }
    return {
      matchingSectionIds,
      matchingItemIds,
      matchingItems: [...SETTINGS_SEARCH_ITEMS],
      itemsBySection,
      matchCountBySection,
      totalMatches: SETTINGS_SEARCH_ITEMS.length,
    };
  }

  const queryWords = query.split(/\s+/).filter(Boolean);

  interface ScoredItem {
    item: SettingsSearchItem;
    score: number;
  }
  const scoredItems: ScoredItem[] = [];

  for (const item of SETTINGS_SEARCH_ITEMS) {
    const titleLower = item.title.toLowerCase();
    const subtitleLower = item.subtitle.toLowerCase();
    const keywordsLower = item.keywords.map((k) => k.toLowerCase());
    const sectionLabelLower = item.sectionLabel.toLowerCase();

    // Must match all query words somewhere across title, subtitle, keywords, or section
    const matchesAllWords = queryWords.every((word) =>
      titleLower.includes(word) ||
      subtitleLower.includes(word) ||
      keywordsLower.some((k) => k.includes(word)) ||
      sectionLabelLower.includes(word),
    );

    if (matchesAllWords) {
      let score = 0;

      // Exact title match
      if (titleLower === query) score += 100;
      else if (titleLower.startsWith(query)) score += 50;
      else if (titleLower.includes(query)) score += 30;

      // Word matches in title
      for (const w of queryWords) {
        if (titleLower.includes(w)) score += 15;
      }

      // Exact keyword matches
      if (keywordsLower.includes(query)) score += 35;
      for (const k of keywordsLower) {
        if (k.startsWith(query)) score += 20;
        else if (k.includes(query)) score += 10;
        for (const w of queryWords) {
          if (k.includes(w)) score += 5;
        }
      }

      // Subtitle match
      if (subtitleLower.includes(query)) score += 10;
      for (const w of queryWords) {
        if (subtitleLower.includes(w)) score += 3;
      }

      // Section match
      if (sectionLabelLower.includes(query)) score += 8;

      scoredItems.push({ item, score });
    }
  }

  // Sort descending by score
  scoredItems.sort((a, b) => b.score - a.score);
  const matchingItems = scoredItems.map((s) => s.item);

  for (const item of matchingItems) {
    matchingItemIds.add(item.id);
    matchingSectionIds.add(item.sectionId);
    matchCountBySection[item.sectionId] = (matchCountBySection[item.sectionId] ?? 0) + 1;
    itemsBySection[item.sectionId].push(item);
  }

  return {
    matchingSectionIds,
    matchingItemIds,
    matchingItems,
    itemsBySection,
    matchCountBySection,
    totalMatches: matchingItems.length,
  };
}
