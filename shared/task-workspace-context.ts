import { z } from "zod";

/** An App home is an existing group, identified by its stable group ID. */
export type TaskAppRef = { kind: "group"; id: string };

/** A descriptive snapshot.  `cwd` alone is the validated execution directory. */
export type TaskWorkspaceContext = {
  kind: "local";
  appRef: TaskAppRef;
  cwd: string;
  git?: {
    checkoutRoot: string;
    branch: string | null;
    headCommit: string | null;
  };
  capturedAt: number;
};

/** The wire shape of a task's App binding.  Strict: an App binding that
 * arrives with an unknown field is a contract change, not a binding. */
export const TaskWorkspaceContextSchema = z
  .object({
    kind: z.literal("local"),
    appRef: z.object({ kind: z.literal("group"), id: z.string() }).strict(),
    cwd: z.string(),
    git: z
      .object({
        checkoutRoot: z.string(),
        branch: z.string().nullable(),
        headCommit: z.string().nullable(),
      })
      .strict()
      .optional(),
    capturedAt: z.number(),
  })
  .strict();

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
