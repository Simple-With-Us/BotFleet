/** Resolve which thread a bot should show for a given app.

 *  Prefers an explicit task bound to that app; falls back to the bot's active
 *  thread.  Used by openBotInApp and by keyboard jumps while an app is active,
 *  so ⌘1–9 cannot land on the wrong-app transcript. */
export function threadIdForApp(
  bot:
    | {
        threadId?: string;
        tasks?: ReadonlyArray<{
          threadId: string;
          workspaceContext?: { appRef?: { id: string } };
        }>;
      }
    | null
    | undefined,
  appId: string,
): string | undefined {
  if (!bot) return undefined;
  const explicit = (bot.tasks ?? []).find((t) => t.workspaceContext?.appRef?.id === appId);
  return explicit?.threadId ?? bot.threadId;
}
