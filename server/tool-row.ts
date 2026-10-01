// The transcript row a tool step becomes, as the harness folds the step's
// `item.started` and `item.completed` events into the store (server/index.ts).
//
// Pulled out of the bus handler so the fold can be tested on its own: the
// completion REPLACES the whole tool object, and every field set at start has
// to be carried across by hand.  One left out once blanked the target of
// every completed row; a helper step that lost its parent would silently
// stop nesting.
import type { Message } from "./store.ts";
import type { ToolKind } from "../shared/tool-activity.ts";

export type ToolRow = NonNullable<Message["tool"]>;

/** What `item.started` reports about a tool step. */
export interface ToolStartedFields {
  title?: string;
  target?: string;
  toolKind?: ToolKind;
  itemId?: string;
  turnId?: string;
  parentItemId?: string;
}

/** The row an `item.started` opens.  `spoken` is the narration call mode
 * reads aloud, folded in once so the phrase and the chip never drift. */
export function startedToolRow(event: ToolStartedFields, spoken: string | undefined): ToolRow {
  return {
    name: event.title ?? "tool",
    spoken,
    target: event.target,
    kind: event.toolKind,
    // the keys that find this step's full input and output in the side
    // store when its row is opened (server/item-io-store.ts); short ids,
    // never the payload
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    // a helper's step names the row it nests under (jobs P0)
    parentItemId: event.parentItemId,
  };
}

/** The row once `item.completed` lands for it.  The whole tool object is
 * replaced, so the fields set at start are carried across. */
export function completedToolRow(
  existing: ToolRow | undefined,
  event: { ok: boolean; detail?: string },
  durationMs: number | undefined,
): ToolRow {
  return {
    name: existing?.name ?? "tool",
    ok: event.ok,
    spoken: existing?.spoken,
    target: existing?.target,
    kind: existing?.kind,
    itemId: existing?.itemId,
    turnId: existing?.turnId,
    parentItemId: existing?.parentItemId,
    // a step's own words about what came back; only worth the row when it
    // failed, or when nothing named the target
    detail: event.detail ?? existing?.detail,
    durationMs,
  };
}
