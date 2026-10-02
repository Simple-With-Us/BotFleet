// Bounding a runtime event before a view holds on to it.
//
// The Trajectory tab keeps a thread's recent steps in memory and asks the
// server for them over HTTP.  An `item.started` can carry a tool's full JSON
// arguments (a write_file with the whole file in it) and an `item.completed`
// can carry a long result, so a page of two thousand events is bounded by
// COUNT but not by SIZE.  Both halves clip with this one function — the server
// before it serialises the page, the client as it receives a live event — so
// what the tab shows never depends on which path an event took.
//
// Only long free-text fields are cut, and the cut is marked with an ellipsis
// so a reader knows the row is a headline rather than the whole record.  The
// event's shape, ids and timestamps are never touched, and `raw` (the
// provider's native payload, which the Inspector's Raw lens already serves) is
// dropped: nothing in a trajectory reads it.
import type { RuntimeEvent } from "../server/contracts.ts";
import { cutText } from "./text-format.ts";

/** Longest free-text field a trajectory keeps, in UTF-16 units. */
export const TRAJECTORY_FIELD_LIMIT = 2000;

function cut(value: string, limit: number): string {
  if (value.length <= limit) return value;
  // one unit is left for the ellipsis; `cutText` never ends on half a
  // surrogate pair
  return `${cutText(value, limit - 1)}…`;
}

/** The same event with each long text field clipped to `limit`.  Returns the
 * input object itself when nothing needed cutting, so a caller can hold the
 * common case without allocating. */
export function clipRuntimeEvent(event: RuntimeEvent, limit: number = TRAJECTORY_FIELD_LIMIT): RuntimeEvent {
  const withoutRaw = event.raw === undefined ? event : (() => {
    const { raw: _raw, ...rest } = event;
    return rest as RuntimeEvent;
  })();
  switch (withoutRaw.type) {
    case "item.started": {
      const title = typeof withoutRaw.title === "string" ? cut(withoutRaw.title, limit) : withoutRaw.title;
      const target = typeof withoutRaw.target === "string" ? cut(withoutRaw.target, limit) : withoutRaw.target;
      const args = typeof withoutRaw.arguments === "string" ? cut(withoutRaw.arguments, limit) : withoutRaw.arguments;
      if (title === withoutRaw.title && target === withoutRaw.target && args === withoutRaw.arguments) return withoutRaw;
      return { ...withoutRaw, title, target, arguments: args };
    }
    case "item.completed": {
      if (withoutRaw.itemType === "assistant_text") {
        const text = cut(withoutRaw.text, limit);
        return text === withoutRaw.text ? withoutRaw : { ...withoutRaw, text };
      }
      const detail = typeof withoutRaw.detail === "string" ? cut(withoutRaw.detail, limit) : withoutRaw.detail;
      const args = typeof withoutRaw.arguments === "string" ? cut(withoutRaw.arguments, limit) : withoutRaw.arguments;
      if (detail === withoutRaw.detail && args === withoutRaw.arguments) return withoutRaw;
      return { ...withoutRaw, detail, arguments: args };
    }
    case "request.opened": {
      const summary = cut(withoutRaw.summary, limit);
      return summary === withoutRaw.summary ? withoutRaw : { ...withoutRaw, summary };
    }
    case "runtime.error": {
      const message = cut(withoutRaw.message, limit);
      return message === withoutRaw.message ? withoutRaw : { ...withoutRaw, message };
    }
    case "turn.retrying": {
      const reason = cut(withoutRaw.reason, limit);
      return reason === withoutRaw.reason ? withoutRaw : { ...withoutRaw, reason };
    }
    case "context.injected": {
      // built one clipped line already; a record read back from disk is held to it too
      const preview = cut(withoutRaw.preview, limit);
      return preview === withoutRaw.preview ? withoutRaw : { ...withoutRaw, preview };
    }
    default:
      return withoutRaw;
  }
}
