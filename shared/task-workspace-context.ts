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
