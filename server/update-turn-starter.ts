import type { Message } from "./store.ts";

/** Only an attended prompt or a bot delegation belongs in the chat-turn
 * resume queue. Routine runs have their own snapshot and requeue path. */
export function lastInterruptedChatStarter(messages: readonly Message[]): Message | undefined {
  return [...messages].reverse().find((message) =>
    message.kind === "text" && Boolean(message.text?.trim()) &&
    (message.role === "user" || (message.role === "system" && message.automationSource === "delegation"))
  );
}

/** Restore only a link carried by the active delegated starter, never one
 * inferred from an older branch, a name, or an unvalidated group id. */
export function resumedDelegationChannel(
  starter: Message | undefined,
  targetBotId: string,
  channel: { id: string; dm?: boolean; memberIds: string[] } | undefined,
): string | undefined {
  if (starter?.role !== "system" || starter.kind !== "text" ||
      starter.automationSource !== "delegation" || !starter.text?.trim() ||
      !starter.from?.botId || !starter.comm?.groupId ||
      starter.comm.withBotId !== starter.from.botId ||
      channel?.id !== starter.comm.groupId || !channel.dm ||
      !channel.memberIds.includes(targetBotId) ||
      !channel.memberIds.includes(starter.from.botId)) return undefined;
  return channel.id;
}
