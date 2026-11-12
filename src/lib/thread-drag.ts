/** A conversation dragged between bots or rooms.  A private MIME type
 * rather than text/plain so a stray text drop cannot be mistaken for one
 * of ours.  text/plain is also written so Chromium lists the drag in
 * dataTransfer.types during dragover (custom types are often omitted). */
export const THREAD_DRAG_TYPE = "application/x-botfleet-thread";

export type ThreadDragKind = "bot" | "group";

export interface ThreadDrag {
  threadId: string;
  fromId: string;
  fromKind: ThreadDragKind;
}

export function serializeThreadDrag(drag: ThreadDrag): string {
  return JSON.stringify(drag);
}

export function parseThreadDrag(raw: string | undefined | null): ThreadDrag | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const { threadId, fromId, fromKind, fromGroupId } = parsed as Partial<ThreadDrag> & {
      fromGroupId?: string;
    };
    const id = typeof fromId === "string" ? fromId : typeof fromGroupId === "string" ? fromGroupId : null;
    const kind: ThreadDragKind | null =
      fromKind === "bot" || fromKind === "group" ? fromKind : id && !fromId ? "group" : null;
    if (typeof threadId !== "string" || !id || !kind) return null;
    return { threadId, fromId: id, fromKind: kind };
  } catch {
    return null;
  }
}

export function readThreadDragEvent(event: { dataTransfer?: DataTransfer | null }): ThreadDrag | null {
  const transfer = event.dataTransfer;
  const parsed = parseThreadDrag(
    transfer?.getData(THREAD_DRAG_TYPE) || transfer?.getData("text/plain"),
  );
  return parsed ?? activeThreadDrag;
}

/** Chromium empties getData during dragover.  The live session is the
 * source of truth while a drag is in the air. */
let activeThreadDrag: ThreadDrag | null = null;

export function beginThreadDrag(drag: ThreadDrag): string {
  activeThreadDrag = drag;
  return serializeThreadDrag(drag);
}

export function endThreadDrag(): void {
  activeThreadDrag = null;
}

export function currentThreadDrag(): ThreadDrag | null {
  return activeThreadDrag;
}

export function threadDragTypes(event: { dataTransfer?: DataTransfer | null }): boolean {
  if (activeThreadDrag) return true;
  const types = Array.from(event.dataTransfer?.types ?? []);
  return types.includes(THREAD_DRAG_TYPE) || types.includes("text/plain");
}
