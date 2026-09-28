/** iMessage inbound/outbound markers shared by the harness, desktop, phone, and relay. */

export const FROM_IMESSAGE_TAG = "[from iMessage]";
export const TO_IMESSAGE_TAG = "[to iMessage]";
export const IMESSAGE_INBOUND_MARKER = "IMESSAGE INBOUND";

/** In the persona only on threads that are actually iMessage tasks.  Simple-mode shared threads still need the gate; an install with no iMessage transport should not carry the rule at all. */
export const IMESSAGE_PERSONA_RULE =
  "iMessage channel: Incoming iMessage turns begin with [from iMessage] (and may sit inside an IMESSAGE INBOUND block). They are not something the owner typed in BotFleet. When a reply should go back to iMessage, start that reply with [to iMessage] on the first line, then the message. Only those tagged replies are sent to iMessage, and the tag is stripped before sending. Replies that stay in BotFleet must not use that tag.";

const FROM_RE = /^\[from iMessage\]\s*/i;
const TO_RE = /^\[to iMessage\]\s*/i;

function block(text: string, marker: string): string | undefined {
  const match = text.match(new RegExp(`\\[${marker}\\]\\n([\\s\\S]*?)\\n\\[\\/${marker}\\]`));
  return match?.[1]?.trim() || undefined;
}

export function isImessageInboundSource(source: unknown, userAgent?: string | null): boolean {
  if (typeof source === "string" && source.trim().toLowerCase() === "imessage") return true;
  return /BotFleet-Relay/i.test(userAgent ?? "");
}

export function parseImessageInbound(text: string): { body: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const inner = block(trimmed, IMESSAGE_INBOUND_MARKER);
  const raw = inner ?? trimmed;
  if (!FROM_RE.test(raw) && inner === undefined) return null;
  const body = raw.replace(FROM_RE, "").trim();
  if (!body) return null;
  return { body };
}

export interface ImessageMessageView {
  headline: string;
  subtitle: string;
  payload?: string;
  body: string;
}

/** Convert a stored iMessage inbound prompt into the smaller view shown in chat. */
export function imessageMessageView(text: string): ImessageMessageView | null {
  const parsed = parseImessageInbound(text);
  if (!parsed) return null;
  const lines = parsed.body.split("\n");
  const first = (lines[0] ?? "").trim() || "iMessage";
  const rest = lines.slice(1).join("\n").trim();
  return {
    headline: first,
    subtitle: "iMessage",
    payload: rest || undefined,
    body: parsed.body,
  };
}

/** Wrap inbound iMessage text so the model sees the tag and the UI can card it. */
export function wrapImessageInbound(text: string): string {
  const trimmed = text.trim();
  const parsed = parseImessageInbound(trimmed);
  const body = (parsed?.body ?? trimmed.replace(FROM_RE, "").trim());
  if (!body) return trimmed;
  return `[${IMESSAGE_INBOUND_MARKER}]\n${FROM_IMESSAGE_TAG}\n${body}\n[/${IMESSAGE_INBOUND_MARKER}]`;
}

/** Body of a bot reply meant for iMessage, or null when the tag is absent. */
export function stripToImessagePrefix(text: string): string | null {
  const trimmed = text.trim();
  const match = TO_RE.exec(trimmed);
  if (!match) return null;
  return trimmed.slice(match[0].length).trim();
}

/** Text the relay should send over iMessage, or null to keep the reply in-app. */
export function outboundImessageText(text: string): string | null {
  const rest = stripToImessagePrefix(text);
  if (rest === null) return null;
  return rest.trim() ? rest.trim() : null;
}
