// Per-bot Composio connector tool grants — which of a bot's connected
// services it may actually call tools on, and which specific tools within
// each. Shared by the server (validation in bot-profile.ts, enforcement in
// connector-verdict.ts), the store (the BotRecord field), and the Settings
// UI (the grants editor in SettingsPanel.tsx).
//
// A bot with no connectorTools record keeps the legacy all-tools behavior
// (every connected service, every tool) — adding this field must not change
// anything for a bot nobody has edited. An explicit record restricts to
// exactly what it names; the empty record `{}` denies every connected-app
// tool while leaving the rest of the bot untouched.

/** One service's connector tool grant: `"*"` widens to every tool on the
 * service, an explicit list names exact tools. An empty list is invalid —
 * omit the service entirely to deny it, the same way an absent
 * connectorTools record means "not restricted at all". */
export interface ConnectorToolGrant {
  tools: "*" | string[];
}

/** Lowercased Composio service slug, e.g. `gmail`. */
export const CONNECTOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,80}$/;
/** Composio tool names are upper-snake, e.g. `GMAIL_SEND_EMAIL`. */
export const CONNECTOR_TOOL_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

/** Upper bounds keep a grants patch from becoming a persistence blob; they
 * sit far above any real service's tool count. */
export const CONNECTOR_SLUGS_MAX = 64;
export const CONNECTOR_TOOLS_PER_SERVICE_MAX = 500;
