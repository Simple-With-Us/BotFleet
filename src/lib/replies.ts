import type { Message } from "@/state/store";

export function replySnippet(text: string, limit = 160): string {
  const clean = text
    .replace(/<attached-image\s+path="[^"]*"\s*\/>/g, "[image]")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** The label for a `role: "system"` auto-delivered instruction — used as
 * both the work card's headline and the reply-quote author.  Prefers the
 * persisted `automationSource`; a row from before that field existed falls
 * back to sniffing the resource-trigger marker in the stored text, and
 * otherwise reads as "Scheduled Run" (a real schedule fire, the only case
 * that label was ever accurate for — a manual Run Now or a resource-pressure
 * alert is neither "scheduled" nor a "routine"). */
export function automationSourceLabel(source: string | undefined, body: string): string {
  switch (source) {
    case "resource":
      return "Resource Alert";
    case "manual":
      return "Run Now";
    case "webhook":
      return "Webhook";
    case "schedule":
      return "Scheduled Run";
    case "delegation":
      return "Delegated Task";
    default:
      if (body.startsWith("[Delegated by @") || body.includes("another bot in this BotFleet workspace")) {
        return "Delegated Task";
      }
      return body.includes("[UNTRUSTED RESOURCE SAMPLE]") ? "Resource Alert" : "Scheduled Run";
  }
}

export function replyAuthor(message: Message, fallback = "Assistant"): string {
  // a peer bot's ask_bot reply is also `role: "user"` (it aligns right like
  // any other user-role message) — "You" is only for what the human typed
  if (message.role === "system") return automationSourceLabel(message.automationSource, message.text ?? "");
  return message.role === "user" && !message.from?.botId ? "You" : (message.from?.name ?? fallback);
}
