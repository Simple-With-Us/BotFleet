import type { Message } from "./store.ts";

/** Only an attended prompt or a bot delegation belongs in the chat-turn
 * resume queue. Routine runs have their own snapshot and requeue path. */
export function lastInterruptedChatStarter(messages: readonly Message[]): Message | undefined {
  return [...messages].reverse().find((message) =>
    message.kind === "text" && Boolean(message.text?.trim()) &&
    (message.role === "user" || (message.role === "system" && message.automationSource === "delegation"))
  );
}
