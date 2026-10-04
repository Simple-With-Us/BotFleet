import type { TaskWorkspaceContext } from "../../shared/task-workspace-context";

export type TaskWorkspaceLabelProps = {
  context: TaskWorkspaceContext;
  appName?: string;
  groupNoun: string;
};

export function TaskWorkspaceLabel({ context, appName, groupNoun }: TaskWorkspaceLabelProps) {
  const savedName = appName ?? `Unavailable ${groupNoun} (${context.appRef.id})`;
  const accessibleLabel = `Saved ${groupNoun}: ${savedName}.  Folder: ${context.cwd}`;

  return (
    <div
      role="group"
      className="min-w-0 shrink-0 border-b border-hairline/40 bg-app px-4 py-2 text-[11px] leading-relaxed text-ink-secondary [overflow-wrap:anywhere]"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <span className="font-medium capitalize">{groupNoun}: </span>
      <span>{savedName}</span>
      <span aria-hidden="true">{"\u00A0 · \u00A0"}</span>
      <span className="font-medium">Folder: </span>
      <code className="[overflow-wrap:anywhere]">{context.cwd}</code>
    </div>
  );
}
