// The two extra fields every driver puts on `item.started`.
//
// `shared/tool-activity.ts` holds the vocabulary because the client needs the
// same table; this is the Node-side convenience that fills in the home
// directory and hands back exactly the shape the event wants, so a driver
// spreads one call instead of repeating the same three lines nine times.
import { homedir } from "node:os";

import { toolActivity } from "../shared/tool-activity.ts";
import type { ToolKind } from "../shared/tool-activity.ts";
import type { JsonValue } from "./schema.ts";

export interface ToolFields {
  target?: string;
  toolKind?: ToolKind;
}

/** `target` + `toolKind` for a tool step, from whatever payload the engine
 * reported.  `hint` is the engine's own kind when it has one (ACP does) — it
 * beats guessing from the name. */
export function toolFields(
  name: string | undefined,
  rawInput,
  options: { hint?: string; locations?: unknown; cwd?: string } = {},
): ToolFields {
  const activity = toolActivity(name, {
    hint: options.hint,
    rawInput,
    locations: options.locations,
    home: homedir(),
    cwd: options.cwd,
  });
  return { target: activity.target, toolKind: activity.kind };
}

/** OpenAI-shaped tool arguments arrive as a JSON *string*.  A partial or
 * malformed one is normal — arguments stream in fragments — so a parse
 * failure is not an error, it just means the row shows the tool's name and
 * nothing more. */
export function parseToolArguments(raw): JsonValue | undefined {
  // SAFETY: tag-check without `typeof`; primitive strings are the only
  // shape that JSON.parse can decode, everything else flows through.
  if (Object.prototype.toString.call(raw) !== "[object String]") {
    // SAFETY: the caller already had raw as an untyped boundary value,
    // and JsonValue's structural shape accepts any primitive/object/array
    // the call site might have produced.
    return raw as JsonValue;
  }
  const text = raw.trim();
  if (!text) return undefined;
  try {
    // SAFETY: JSON.parse only ever produces a JsonValue (string/number/boolean/null/object/array).
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}
