import { allowsMultipleBotThreads, type ConversationMode } from "../../shared/conversation-mode";
import {
  taskWorkspaceMergeSkipReason,
  type TaskWorkspaceContext,
} from "../../shared/task-workspace-context";
import { threadIdForApp } from "./task-app-thread";

/** A bot, reduced to the fields a matrix cell, an App Deck chip, or a number
 * shortcut needs in order to choose a conversation. */
export interface AppThreadOpenBot {
  threadId?: string;
  tasks?: ReadonlyArray<{
    threadId: string;
    title?: string;
    workspaceContext?: TaskWorkspaceContext;
  }>;
}

/** `show` opens the conversation, `activate` makes a different one the open
 * conversation, and `refuse` leaves the open conversation alone. */
export type AppThreadOpenPlan =
  | { action: "show"; threadId: string | undefined; activate: boolean }
  | { action: "refuse"; message: string };

const UNTITLED_CONVERSATION = "New task";

function becauseClause(reason: string): string {
  if (reason === "belongs to another App") return "it belongs to a different App";
  if (reason === "runs in a different folder") return "it runs in a different folder";
  if (reason === "is bound to an App") return "it belongs to an App and the open conversation does not";
  if (reason === "is not bound to an App") return "it is not tied to an App and the open conversation is";
  return "it belongs to a different App or runs in a different folder";
}

/** What to say when Simple will not open a saved App conversation.
 *
 * The shape follows the Workspace Arrangement card: name the conversation,
 * say why it stays separate, say that nothing changed, and say what to do
 * next. */
export function simpleAppThreadRefusal(title: string, reason: string): string {
  const name = title.trim() || UNTITLED_CONVERSATION;
  const because = becauseClause(reason);
  return `“${name}” cannot be opened from here, because ${because}.\u00A0 Nothing was switched, and the open conversation stayed as it is.\u00A0 Switch to Projects in Settings to open it.`;
}

/** How a matrix cell, an App Deck chip, or a number shortcut opens a bot in an App.
 *
 * Projects may make that App conversation the open one, and Simple keeps the
 * open conversation where it is. */
export function planAppThreadOpen(input: {
  /** The loaded workspace arrangement, or null while /api/config has not
   * delivered one.  The gate protects a KNOWN Simple arrangement; when the
   * arrangement is unknown the open proceeds as it did before the gate
   * existed, rather than refusing a Projects user with advice that does not
   * apply. */
  mode: ConversationMode | null;
  bot: AppThreadOpenBot | null | undefined;
  appId: string;
}): AppThreadOpenPlan {
  const bot = input.bot;
  if (!bot) return { action: "show", threadId: undefined, activate: false };
  const threadId = threadIdForApp(bot, input.appId);
  const different = Boolean(threadId && threadId !== bot.threadId);
  if (!different || input.mode === null || allowsMultipleBotThreads(input.mode)) {
    return { action: "show", threadId, activate: different };
  }
  const tasks = bot.tasks ?? [];
  const target = tasks.find((task) => task.threadId === threadId);
  const open = tasks.find((task) => task.threadId === bot.threadId);
  // The open conversation already serves this App when it shares the App and the
  // folder:  there is no boundary to protect, and the skip reason would claim a
  // folder difference that does not exist.
  if (
    open?.workspaceContext?.appRef?.id === input.appId
    && open.workspaceContext?.cwd === target?.workspaceContext?.cwd
  ) {
    return { action: "show", threadId: bot.threadId, activate: false };
  }
  const reason = taskWorkspaceMergeSkipReason(target?.workspaceContext, open?.workspaceContext);
  return { action: "refuse", message: simpleAppThreadRefusal(target?.title ?? "", reason) };
}
