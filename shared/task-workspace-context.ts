import { z } from "zod";

/** An App home is an existing group, identified by its stable group ID. */
export const TaskAppRefSchema = z.object({ kind: z.literal("group"), id: z.string().max(128) }).strict();
export type TaskAppRef = z.infer<typeof TaskAppRefSchema>;

/** The wire shape of a task's App binding.  Strict: an App binding that
 * arrives with an unknown field is a contract change, not a binding.
 *
 * Every string is bounded.  A folder path is at most a PATH_MAX path, and a
 * commit is a hash, so a longer value is not a real path or a real commit —
 * it is data that arrived from somewhere else, and it has no business being
 * painted into a roster or carried into a merge. */
export const TaskWorkspaceContextSchema = z
  .object({
    kind: z.literal("local"),
    appRef: TaskAppRefSchema,
    cwd: z.string().max(4096),
    git: z
      .object({
        checkoutRoot: z.string().max(4096),
        branch: z.string().max(512).nullable(),
        headCommit: z.string().max(64).nullable(),
      })
      .strict()
      .optional(),
    capturedAt: z.number(),
  })
  .strict();

/** A descriptive snapshot.  `cwd` alone is the validated execution directory.
 *
 * The type is the schema's own inference, so the two can never drift. */
export type TaskWorkspaceContext = z.infer<typeof TaskWorkspaceContextSchema>;

/** Merging transcripts must not transfer automation aliases across App bindings.
 * Git labels and capture times are observations, not membership identities. */
export function taskWorkspaceContextsMatch(
  left: TaskWorkspaceContext | undefined,
  right: TaskWorkspaceContext | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.appRef.kind === right.appRef.kind
    && left.appRef.id === right.appRef.id && left.cwd === right.cwd;
}

/** Why a conversation could not be folded into another one.
 *
 * An App binding is a boundary, and so is a different folder inside the
 * same App: two conversations that run in different directories are two
 * different places, and a merge would carry one into the other.  The
 * wording names the actual difference, because "another App" is wrong for
 * a folder that changed inside the same App. */
export function taskWorkspaceMergeSkipReason(
  source: TaskWorkspaceContext | undefined,
  destination: TaskWorkspaceContext | undefined,
): string {
  if (!source) return "is not bound to an App";
  if (!destination) return "is bound to an App";
  if (source.appRef.id !== destination.appRef.id) return "belongs to another App";
  return "runs in a different folder";
}

/** One conversation judged against the thread that is open. */
export interface SimpleMergeThread {
  threadId: string;
  title?: string;
  workspaceContext?: TaskWorkspaceContext;
}

/** A bot or a room whose extra conversations might fold into the open one.
 * Direct-message rooms stay one conversation and are not part of the merge. */
export interface SimpleMergeOwner {
  threadId: string;
  dm?: boolean;
  tasks?: readonly SimpleMergeThread[];
}

/** A conversation the Simple-mode merge will not touch. */
export interface SimpleMergeConflict {
  threadId: string;
  title: string;
  reason: string;
}

const UNTITLED_CONVERSATION = "New task";

/** Extra conversations that cannot fold into the open one.
 *
 * Order follows the owners, then each owner's own list.  A direct-message
 * room is skipped: it has one conversation and the merge never touches it.
 * Matching conversations are omitted, so an empty result means the merge
 * can finish. */
export function simpleMergeConflicts(owners: readonly SimpleMergeOwner[]): SimpleMergeConflict[] {
  const conflicts: SimpleMergeConflict[] = [];
  for (const owner of owners) {
    if (owner.dm) continue;
    const into = owner.tasks?.find((task) => task.threadId === owner.threadId);
    for (const task of owner.tasks ?? []) {
      if (task.threadId === owner.threadId) continue;
      if (taskWorkspaceContextsMatch(task.workspaceContext, into?.workspaceContext)) continue;
      const title = task.title?.trim() || UNTITLED_CONVERSATION;
      conflicts.push({
        threadId: task.threadId,
        title,
        reason: taskWorkspaceMergeSkipReason(task.workspaceContext, into?.workspaceContext),
      });
    }
  }
  return conflicts;
}

/** A short label for the list next to a conversation that stays separate. */
export function simpleMergeConflictLabel(reason: string): string {
  switch (reason) {
    case "belongs to another App":
      return "different App";
    case "runs in a different folder":
      return "different folder";
    case "is bound to an App":
      return "tied to an App";
    case "is not bound to an App":
      return "not tied to an App";
    default:
      return "does not match";
  }
}

function quotedTitle(title: string): string {
  return `“${title}”`;
}

function namedConflicts(conflicts: readonly SimpleMergeConflict[]): string {
  const titles = conflicts.map((conflict) => quotedTitle(conflict.title));
  if (titles.length <= 1) return titles[0] ?? "A conversation";
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  const rest = titles.length - 2;
  return `${titles[0]}, ${titles[1]}, and ${rest} more`;
}

function becauseClause(conflicts: readonly SimpleMergeConflict[]): string {
  const singular = conflicts.length === 1;
  const reasons = new Set(conflicts.map((conflict) => conflict.reason));
  const reason = reasons.size === 1 ? conflicts[0]?.reason : undefined;
  if (reason === "belongs to another App") {
    return singular ? "it belongs to a different App" : "they belong to different Apps";
  }
  if (reason === "runs in a different folder") {
    return singular ? "it runs in a different folder" : "they run in different folders";
  }
  if (reason === "is bound to an App") {
    return singular
      ? "it belongs to an App and the open conversation does not"
      : "they belong to an App and the open conversation does not";
  }
  if (reason === "is not bound to an App") {
    return singular
      ? "it is not tied to an App and the open conversation is"
      : "they are not tied to an App and the open conversation is";
  }
  return singular
    ? "it belongs to a different App or runs in a different folder"
    : "they belong to a different App or run in a different folder";
}

/** What to tell a person when Merge All Threads cannot run.
 *
 * The workspace is left as it is.  Simple would hide any conversation the
 * merge skipped, so the switch does not happen and the sentence says what
 * to do instead. */
export function simpleMergeRefusal(conflicts: readonly SimpleMergeConflict[]): string {
  const lead = namedConflicts(conflicts);
  const because = becauseClause(conflicts);
  return `${lead} cannot be combined with the open conversation, because ${because}.\u00A0 Nothing was merged, and the workspace stayed as it is.\u00A0 You can switch to Simple without combining them, or stay here and open them.`;
}

/** A refusal with no names, for a conflict the server reported without a sentence. */
export const SIMPLE_MERGE_REFUSAL_GENERAL =
  "Some conversations cannot be combined, because they belong to a different App or run in a different folder.\u00A0 Nothing was merged, and the workspace stayed as it is.\u00A0 You can switch to Simple without combining them, or stay here and open them.";

const STATUS_LINE = /^\d{3}\b/;

/** The sentence a failed workspace-arrangement save may show.
 *
 * A server sentence is shown as it arrived.  A bare status line is not:
 * the person needs a reason and a next step, not a code. */
export function conversationModeFailureCopy(status: number | undefined, serverMessage: string | undefined): string {
  const message = serverMessage?.trim() ?? "";
  if (message && !STATUS_LINE.test(message)) return message;
  if (status === 409) return SIMPLE_MERGE_REFUSAL_GENERAL;
  return "That change could not be saved.\u00A0 Try again.";
}
