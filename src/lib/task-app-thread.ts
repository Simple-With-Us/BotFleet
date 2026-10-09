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

type AppContextBot = NonNullable<Parameters<typeof threadIdForApp>[0]> & { id: string };

export interface AppContextInput {
  /** The App highlighted in the deck, if any. */
  selectedAppId: string | null;
  /** The sidebar selection: a bot id or a group id. */
  selectedId: string | null | undefined;
  /** `selectedId` differs from the value the previous decision saw. */
  selectionChanged: boolean;
  groups: ReadonlyArray<{ id: string; dm?: boolean }>;
  bots: ReadonlyArray<AppContextBot>;
  /** The thread pinned on screen, or null when none is pinned. */
  viewedThreadId: string | null;
}

export interface AppContextDecision {
  selectedAppId: string | null;
  /** Close the fleet matrix overview in favour of the selected chat. */
  yieldMatrix: boolean;
}

/** The thread a bot shows: the pinned one, else its active thread.  The pin is
 *  cleared when a task switch lands on the selected bot ("the pin is stale, the
 *  active thread just changed"), so a null pin means "the active thread". */
export function shownThreadId(bot: { threadId?: string }, viewedThreadId: string | null): string | undefined {
  return viewedThreadId ?? bot.threadId;
}

/** Decide, from the current selection, whether the highlighted App stays and
 *  whether the matrix overview closes.
 *
 *  Two mistakes lived in the effect this replaces.  It read a null pin as "the
 *  user left the App", but the task-switch ack that `openBotInApp` triggers
 *  nulls the pin on purpose, so the App highlight and the app-scoped keyboard
 *  routing were cleared as soon as the switch landed.  And it closed the matrix
 *  overview on every run, including runs caused by an SSE frame replacing the
 *  `bots` array, so the overview snapped back to the chat.  The overview now
 *  yields only when the selection itself changed. */
export function resolveAppContext(input: AppContextInput): AppContextDecision {
  const yieldMatrix = input.selectionChanged && Boolean(input.selectedId);
  const unchanged: AppContextDecision = { selectedAppId: input.selectedAppId, yieldMatrix };
  if (!input.selectedAppId) return unchanged;
  const group = input.groups.find((candidate) => candidate.id === input.selectedId);
  // An App is a group: selecting one keeps itself highlighted.
  if (group && !group.dm) return unchanged;
  const bot = input.bots.find((candidate) => candidate.id === input.selectedId);
  if (!bot) return unchanged;
  const appThread = threadIdForApp(bot, input.selectedAppId);
  // A new selection counts only when it pinned the App's thread (openBotInApp does).  The same
  // selection after an ack or a frame has no pin, and means the bot's active thread.
  const shown = input.selectionChanged ? input.viewedThreadId : shownThreadId(bot, input.viewedThreadId);
  const inApp = Boolean(shown) && shown === appThread;
  return { selectedAppId: inApp ? input.selectedAppId : null, yieldMatrix };
}
