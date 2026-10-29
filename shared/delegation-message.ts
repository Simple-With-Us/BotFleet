/** Bot-to-bot delegation markers and view model shared by server, desktop, and mobile. */

export const DELEGATION_PREFIX_START = "[Delegated by @";
export const DELEGATION_PREFIX_MID = ", another bot in this BotFleet workspace. Do the work and reply directly.]";

export interface DelegationMessageView {
  senderName: string;
  reason?: string;
  payload?: string;
  headline: string;
  subtitle?: string;
}

/** Check if a message represents a bot-to-bot delegation turn. */
export function isDelegationMessage(message: { role: "user" | "system" | "bot"; text?: string; automationSource?: string }): boolean {
  if (message.automationSource === "delegation") return true;
  if (message.role !== "user" && message.role !== "system") return false;
  const text = message.text ?? "";
  return text.startsWith(DELEGATION_PREFIX_START) && text.includes(DELEGATION_PREFIX_MID);
}

/** Parse a stored delegation prompt into the smaller view shown in chat. */
export function delegationMessageView(
  role: "user" | "system" | "bot",
  text: string,
  fromName?: string,
  automationSource?: string,
): DelegationMessageView | null {
  const trimmed = text.trim();
  if (!trimmed && automationSource !== "delegation") return null;

  if ((role === "user" || role === "system" || automationSource === "delegation") &&
      trimmed.startsWith(DELEGATION_PREFIX_START) && trimmed.includes(DELEGATION_PREFIX_MID)) {
    const midIndex = trimmed.indexOf(DELEGATION_PREFIX_MID);
    const senderName = trimmed.slice(DELEGATION_PREFIX_START.length, midIndex).trim();
    if (!senderName) return null;

    const afterPrefix = trimmed.slice(midIndex + DELEGATION_PREFIX_MID.length).trim();
    let reason: string | undefined;
    let payload = afterPrefix;

    const reasonMarker = "\n\n[Reason: ";
    const reasonIndex = afterPrefix.lastIndexOf(reasonMarker);
    if (reasonIndex !== -1 && afterPrefix.endsWith("]")) {
      reason = afterPrefix.slice(reasonIndex + reasonMarker.length, -1).trim();
      payload = afterPrefix.slice(0, reasonIndex).trim();
    }

    const firstLine = payload.split("\n").find((line) => line.trim()) ?? "";
    const headline = `Delegated by @${senderName}`;
    const subtitle = reason ? `Reason: ${reason}` : (firstLine ? firstLine.slice(0, 80) : undefined);

    return {
      senderName,
      reason,
      payload: payload || undefined,
      headline,
      subtitle,
    };
  }

  if (automationSource === "delegation") {
    const senderName = fromName || "Peer Bot";
    const firstLine = trimmed.split("\n").find((line) => line.trim()) ?? "";
    return {
      senderName,
      payload: trimmed || undefined,
      headline: `Delegated by @${senderName}`,
      subtitle: firstLine ? firstLine.slice(0, 80) : undefined,
    };
  }

  return null;
}

/** A row the live line can read without taking the whole transcript type. */
export interface DelegationProgressRow {
  role: "user" | "system" | "bot";
  kind?: string;
  tool?: { name?: string; target?: string };
  job?: unknown;
}

/** What the delegation card says while the bot does the work, and once it
 * has answered.  The scan stops at the next thing a person sent. */
export function delegationLiveLine(
  rows: readonly DelegationProgressRow[],
  index: number,
  busy: boolean,
): string | undefined {
  if (index < 0 || index >= rows.length) return undefined;
  let tools = 0;
  let last = "";
  let replied = false;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.role === "user") break;
    if (row.role === "system" && row.kind !== "activity") break;
    if (row.kind === "text" && row.role === "bot") {
      replied = true;
      continue;
    }
    if (row.kind !== "activity" || !row.tool || row.job) continue;
    const name = row.tool.name ?? "";
    if (name.startsWith("error:") || name.startsWith("notice:") || name.startsWith("retrying")) continue;
    tools += 1;
    const step = row.tool.target?.trim() || name.trim();
    if (step) last = step;
  }
  if (busy) {
    if (!last && tools === 0) return "Working";
    const count = `${tools} ${tools === 1 ? "tool" : "tools"}`;
    return last ? `Working · ${last} · ${count}` : `Working · ${count}`;
  }
  if (!replied && tools === 0) return undefined;
  if (tools === 0) return "Done";
  return `Done · ${tools} ${tools === 1 ? "tool" : "tools"}`;
}
