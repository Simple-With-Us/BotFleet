import { z } from "zod";

import { TaskWorkspaceContextSchema } from "./task-workspace-context.ts";

/** The request body of the per-bot merge.
 *
 * Strict: an unknown key is a typo or contract drift, not a field to carry
 * along.  The thread id is bounded because it comes from a person. */
export const MergeThreadsBodySchema = z
  .object({
    intoThreadId: z.string().min(1).max(128),
  })
  .strict();
export type MergeThreadsBody = z.infer<typeof MergeThreadsBodySchema>;

/** One conversation that stayed behind, and why it could not move. */
export const MergeSkippedSchema = z
  .object({
    threadId: z.string(),
    title: z.string(),
    reason: z.string(),
  })
  .strict();
export type MergeSkipped = z.infer<typeof MergeSkippedSchema>;

/** A conversation as the roster needs it after a merge. */
export const MergeTaskSchema = z.object({
  threadId: z.string(),
  title: z.string(),
  createdAt: z.number(),
  /** When the conversation first spoke — the order a merge folds in. */
  startedAt: z.number().optional(),
  lastActivity: z.number().optional(),
  messageCount: z.number().optional(),
  workspaceContext: TaskWorkspaceContextSchema.optional(),
});
export type MergeTask = z.infer<typeof MergeTaskSchema>;

/** The bot as a merge leaves it.
 *
 * Only the fields a client needs to redraw the roster are modelled, and
 * the transcript is deliberately NOT one of them: a merged conversation
 * can hold far more than one event frame carries, so the transcript is
 * read from the paged endpoint instead.  Unknown fields are dropped
 * rather than rejected — the wire bot carries far more than the roster
 * needs, and rejecting it would make every merge a 400. */
export const MergeBotSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  tasks: z.array(MergeTaskSchema).optional(),
});
export type MergeBot = z.infer<typeof MergeBotSchema>;

/** What the merge route answers with. */
export const MergeAllBotTasksResponseSchema = z
  .object({
    bot: MergeBotSchema,
    merged: z.array(z.string()),
    skipped: z.array(MergeSkippedSchema),
  })
  .strict();
export type MergeAllBotTasksResponse = z.infer<typeof MergeAllBotTasksResponseSchema>;
