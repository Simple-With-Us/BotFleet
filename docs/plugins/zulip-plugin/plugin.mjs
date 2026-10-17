// Zulip wake routing plugin.  An optional user-installed integration:
// the trusted host owns the listener, credentials, dedup, budgets, and
// wake execution; this plugin owns the Zulip routing policy.
//
// The host emits one envelope per qualifying message (already
// authenticated, deduplicated, and canonically fetched).  This plugin
// decides where it goes: qualifying DMs and explicit mentions route to
// the configured dispatcher inbox with enough source context to reply
// in the right realm, channel, topic, and thread under the right bot
// identity.  One decision, no approval chain: the receiving turn
// interprets the hint safely under the host's budgets and mount gates.
//
// Incoming message text is untrusted input and stays labeled as such;
// the host wraps the reply hint in nonce markers before the model sees
// it.  This plugin never sees credentials: settings here are routing
// knobs only.

function setting(host, key, fallback) {
  const value = host.settings.get(key);
  return value === undefined ? fallback : value;
}

function truncate(text, max) {
  const str = String(text ?? "");
  return str.length > max ? str.slice(0, max) + "…" : str;
}

export function onEvent({ event, host }) {
  const dispatcherBotId = setting(host, "dispatcherBotId", "");
  if (!dispatcherBotId) {
    return { action: "none", rationale: "no dispatcher configured" };
  }
  const ctx = event.context ?? {};
  const senderKind = ctx.senderKind ?? "peer";
  if (senderKind === "peer" && !setting(host, "allowPeerWakes", true)) {
    return { action: "none", rationale: "peer routing disabled" };
  }
  if (ctx.wakeReason === "followed" && !setting(host, "routeFollowedTopics", true)) {
    return { action: "none", rationale: "followed topics disabled" };
  }

  const refs = event.refs ?? {};
  const where = refs.channel ? `${refs.channel}/${refs.topic ?? "(no topic)"}` : `dm:${refs.conversationKey ?? ""}`;
  const summaries = ctx.chatSummaries ?? [];
  const candidates = summaries
    .slice(0, 5)
    .map((s) => `${s.botName} (${s.threadId}, ${s.messageCount} msgs)`)
    .join("; ");

  const hint = [
    `[ZULIP WAKE ${ctx.wakeReason ?? "message"} from ${senderKind}]`,
    `source: account=${event.source?.accountId ?? "?"} message=${refs.messageId ?? "?"} where=${where}`,
    refs.realm ? `realm=${refs.realm}` : null,
    candidates ? `open conversations: ${candidates}` : null,
    event.content?.text ? `message excerpt: ${truncate(event.content.text, 1000)}` : null,
    "Decide where this belongs (continue a listed conversation or start here) and reply via the Zulip connector.",
  ].filter(Boolean).join("\n");

  return {
    action: "requestWake",
    targetBotId: dispatcherBotId,
    confidence: senderKind === "owner" ? 0.95 : 0.8,
    rationale: `${ctx.wakeReason ?? "message"} from ${senderKind} in ${where}`,
    replyHint: truncate(hint, 2000),
  };
}

export function getHealth({ host }) {
  const dispatcherBotId = setting(host, "dispatcherBotId", "");
  if (!dispatcherBotId) {
    return { status: "degraded", detail: "dispatcherBotId is not configured" };
  }
  return { status: "ok", detail: `routing to ${dispatcherBotId}` };
}

export function runCommand({ command, host }) {
  if (command !== "zulip-health") return `unknown command "${command}"`;
  const health = getHealth({ host });
  const subs = "zulip.message -> dispatcher";
  return `Zulip wake routing: ${health.status} (${health.detail}). Subscriptions: ${subs}.`;
}
